import { describe, expect, it } from 'vitest'
import { parseMp4VideoMetadata } from './video-quality'

function ascii(value: string): Uint8Array {
  return Uint8Array.from([...value].map((character) => character.charCodeAt(0)))
}

function join(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.byteLength
  }
  return output
}

function box(type: string, ...payloads: Uint8Array[]): Uint8Array {
  const payload = join(...payloads)
  const output = new Uint8Array(payload.byteLength + 8)
  new DataView(output.buffer).setUint32(0, output.byteLength)
  output.set(ascii(type), 4)
  output.set(payload, 8)
  return output
}

function uint32(value: number): Uint8Array {
  const output = new Uint8Array(4)
  new DataView(output.buffer).setUint32(0, value)
  return output
}

function syntheticAudioTrack(
  durationTicks = 441_000,
  sampleRateHz = 44_100,
  audioSpecificConfig: Uint8Array<ArrayBufferLike> = Uint8Array.from([0x12, 0x10]),
): Uint8Array {
  const hdlrPayload = new Uint8Array(12)
  hdlrPayload.set(ascii('soun'), 8)

  const mdhdPayload = new Uint8Array(24)
  const mdhdView = new DataView(mdhdPayload.buffer)
  mdhdView.setUint32(12, 44_100)
  mdhdView.setUint32(16, durationTicks)

  const audioSamplePayload = new Uint8Array(28)
  const audioSampleView = new DataView(audioSamplePayload.buffer)
  audioSampleView.setUint16(16, 2)
  audioSampleView.setUint32(24, sampleRateHz * 65_536)
  const esds = box(
    'esds',
    new Uint8Array(4),
    // DecoderSpecificInfo: AudioSpecificConfig 0x1210 = AAC-LC, 44.1 kHz, estéreo.
    Uint8Array.from([0x05, audioSpecificConfig.byteLength]),
    audioSpecificConfig,
  )
  const sampleEntry = box('mp4a', audioSamplePayload, esds)
  const stsd = box('stsd', new Uint8Array(4), uint32(1), sampleEntry)
  const stts = box('stts', new Uint8Array(4), uint32(1), uint32(100), uint32(durationTicks / 100))
  const stsz = box('stsz', new Uint8Array(4), uint32(1_600), uint32(100))
  const stbl = box('stbl', stsd, stts, stsz)
  const minf = box('minf', stbl)
  return box('trak', box('tkhd', new Uint8Array(80)), box(
    'mdia',
    box('mdhd', mdhdPayload),
    box('hdlr', hdlrPayload),
    minf,
  ))
}

function syntheticVideoMp4(
  width = 720,
  height = 1280,
  timescale = 30_000,
  sampleDelta = 1_000,
): ArrayBuffer {
  const tkhdPayload = new Uint8Array(80)
  const tkhdView = new DataView(tkhdPayload.buffer)
  tkhdView.setUint32(tkhdPayload.byteLength - 8, width * 65_536)
  tkhdView.setUint32(tkhdPayload.byteLength - 4, height * 65_536)

  const hdlrPayload = new Uint8Array(12)
  hdlrPayload.set(ascii('vide'), 8)

  const mdhdPayload = new Uint8Array(24)
  new DataView(mdhdPayload.buffer).setUint32(12, timescale)

  const sampleEntry = box('hvc1', new Uint8Array(16))
  const stsd = box('stsd', new Uint8Array(4), uint32(1), sampleEntry)
  const stts = box('stts', new Uint8Array(4), uint32(1), uint32(300), uint32(sampleDelta))
  const stbl = box('stbl', stsd, stts)
  const minf = box('minf', stbl)
  const mdia = box('mdia', box('mdhd', mdhdPayload), box('hdlr', hdlrPayload), minf)
  const trak = box('trak', box('tkhd', tkhdPayload), mdia)
  const file = join(box('ftyp', ascii('isom')), box('moov', trak))
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer
}

function syntheticAudiovisualMp4(
  audioDurationTicks = 441_000,
  sampleRateHz = 44_100,
  audioSpecificConfig?: Uint8Array<ArrayBufferLike>,
): ArrayBuffer {
  const videoOnly = new Uint8Array(syntheticVideoMp4())
  const videoMoov = new DataView(videoOnly.buffer).getUint32(12)
  const videoTrackStart = 12 + 8
  const videoTrack = videoOnly.slice(videoTrackStart, 12 + videoMoov)
  const file = join(
    box('ftyp', ascii('isom')),
    box(
      'moov',
      videoTrack,
      syntheticAudioTrack(audioDurationTicks, sampleRateHz, audioSpecificConfig),
    ),
  )
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer
}

describe('inspección MP4', () => {
  it('lee resolución, codec y FPS del track de video', () => {
    expect(parseMp4VideoMetadata(syntheticVideoMp4())).toMatchObject({
      width: 720,
      height: 1280,
      codec: 'HEVC',
      fps: 30,
      hasAudio: false,
      videoDurationSeconds: 10,
    })
  })

  it('verifica codec, perfil, bitrate y sincronización de la pista de audio', () => {
    expect(parseMp4VideoMetadata(syntheticAudiovisualMp4())).toMatchObject({
      width: 720,
      height: 1280,
      hasAudio: true,
      audioCodec: 'AAC',
      audioProfile: 'AAC-LC',
      audioBitrateBps: 128_000,
      audioSampleRateHz: 44_100,
      audioChannels: 2,
      videoDurationSeconds: 10,
      audioDurationSeconds: 10,
      avDurationDeltaSeconds: 0,
      audioSyncIssue: false,
    })
  })

  it('detecta una pista que terminaría desincronizada', () => {
    expect(parseMp4VideoMetadata(syntheticAudiovisualMp4(529_200))).toMatchObject({
      videoDurationSeconds: 10,
      audioDurationSeconds: 12,
      avDurationDeltaSeconds: 2,
      audioSyncIssue: true,
    })
  })

  it('muestra la frecuencia efectiva de HE-AAC y no la frecuencia núcleo', () => {
    const metadata = parseMp4VideoMetadata(syntheticAudiovisualMp4(
      441_000,
      22_050,
      Uint8Array.from([0xeb, 0x8a, 0x08, 0x00]),
    ))

    expect(metadata).toMatchObject({
      audioCodec: 'AAC',
      audioProfile: 'HE-AACv2',
      audioSampleRateHz: 44_100,
      audioChannels: 2,
    })
  })

  it('devuelve undefined cuando no existe un moov completo', () => {
    expect(parseMp4VideoMetadata(new Uint8Array([1, 2, 3, 4]).buffer)).toBeUndefined()
  })

  it('rechaza dimensiones y FPS fuera de límites seguros', () => {
    const metadata = parseMp4VideoMetadata(syntheticVideoMp4(20_000, 1280, 300_000, 1_000))
    expect(metadata).toMatchObject({ height: 1280, hasAudio: false })
    expect(metadata?.width).toBeUndefined()
    expect(metadata?.fps).toBeUndefined()
  })
})
