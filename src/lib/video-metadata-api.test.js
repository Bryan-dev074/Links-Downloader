import { describe, expect, it } from 'vitest'
import metadataHandler, {
  isAllowedTokCdnUrl,
  parseMp4VideoMetadata,
} from '../../api/video-metadata.js'

function ascii(value) {
  return Uint8Array.from([...value].map((character) => character.charCodeAt(0)))
}

function join(...parts) {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.byteLength
  }
  return output
}

function uint32(value) {
  const output = new Uint8Array(4)
  new DataView(output.buffer).setUint32(0, value)
  return output
}

function box(type, ...payloads) {
  const payload = join(...payloads)
  const output = new Uint8Array(payload.byteLength + 8)
  new DataView(output.buffer).setUint32(0, output.byteLength)
  output.set(ascii(type), 4)
  output.set(payload, 8)
  return output
}

function track(handler, timescale, duration, sampleEntry, sampleCount, sampleDelta, sampleSize) {
  const handlerPayload = new Uint8Array(12)
  handlerPayload.set(ascii(handler), 8)
  const mediaHeader = new Uint8Array(24)
  const mediaHeaderView = new DataView(mediaHeader.buffer)
  mediaHeaderView.setUint32(12, timescale)
  mediaHeaderView.setUint32(16, duration)
  const sampleDescription = box('stsd', new Uint8Array(4), uint32(1), sampleEntry)
  const timeToSample = box(
    'stts',
    new Uint8Array(4),
    uint32(1),
    uint32(sampleCount),
    uint32(sampleDelta),
  )
  const sampleSizes = box('stsz', new Uint8Array(4), uint32(sampleSize), uint32(sampleCount))
  return box(
    'trak',
    box('tkhd', new Uint8Array(80)),
    box(
      'mdia',
      box('mdhd', mediaHeader),
      box('hdlr', handlerPayload),
      box('minf', box('stbl', sampleDescription, timeToSample, sampleSizes)),
    ),
  )
}

function audiovisualMp4({
  sampleRateHz = 44_100,
  audioSpecificConfig = Uint8Array.from([0x12, 0x10]),
} = {}) {
  const videoPayload = new Uint8Array(80)
  const videoView = new DataView(videoPayload.buffer)
  videoView.setUint32(videoPayload.byteLength - 8, 720 * 65_536)
  videoView.setUint32(videoPayload.byteLength - 4, 1280 * 65_536)
  const video = track('vide', 30_000, 300_000, box('avc1', new Uint8Array(16)), 300, 1_000, 10_000)
  // Reemplaza el tkhd vacío por dimensiones reales.
  video.set(videoPayload, 16)

  const audioPayload = new Uint8Array(28)
  const audioView = new DataView(audioPayload.buffer)
  audioView.setUint16(16, 2)
  audioView.setUint32(24, sampleRateHz * 65_536)
  const esds = box(
    'esds',
    new Uint8Array(4),
    Uint8Array.from([0x05, audioSpecificConfig.byteLength]),
    audioSpecificConfig,
  )
  const audio = track(
    'soun',
    44_100,
    441_000,
    box('mp4a', audioPayload, esds),
    100,
    4_410,
    1_600,
  )
  const file = join(box('ftyp', ascii('isom')), box('moov', video, audio))
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength)
}

describe('respaldo de metadatos en Vercel', () => {
  it('acepta únicamente HTTPS MP4 en el host exacto del CDN', () => {
    expect(isAllowedTokCdnUrl('https://v16.tokcdn.com/path/video.mp4?token=abc')).toBe(true)
    expect(isAllowedTokCdnUrl('https://tokcdn.com/video.mp4')).toBe(false)
    expect(isAllowedTokCdnUrl('https://v19.tokcdn.com/video.mp4')).toBe(false)
    expect(isAllowedTokCdnUrl('https://tokcdn.com.evil.test/video.mp4')).toBe(false)
    expect(isAllowedTokCdnUrl('https://evil-tokcdn.com/video.mp4')).toBe(false)
    expect(isAllowedTokCdnUrl('http://v16.tokcdn.com/video.mp4')).toBe(false)
    expect(isAllowedTokCdnUrl('https://user@v16.tokcdn.com/video.mp4')).toBe(false)
    expect(isAllowedTokCdnUrl('https://v16.tokcdn.com:444/video.mp4')).toBe(false)
    expect(isAllowedTokCdnUrl('https://v16.tokcdn.com/video.jpg')).toBe(false)
    expect(isAllowedTokCdnUrl('https://v16.tokcdn.com./video.mp4')).toBe(false)
    expect(isAllowedTokCdnUrl('https://v16.tokcdn.com/video.mp4#fragment')).toBe(false)
  })

  it('rechaza métodos y destinos no permitidos antes de consultar la red', async () => {
    const post = await metadataHandler.fetch(new Request('https://app.test/api/video-metadata', {
      method: 'POST',
    }))
    const invalid = await metadataHandler.fetch(new Request(
      'https://app.test/api/video-metadata?url=https%3A%2F%2F127.0.0.1%2Fsecret',
    ))

    expect(post.status).toBe(405)
    expect(post.headers.get('allow')).toBe('GET')
    expect(invalid.status).toBe(400)
  })

  it('el respaldo de Vercel devuelve también la calidad de audio del MP4', () => {
    expect(parseMp4VideoMetadata(audiovisualMp4())).toMatchObject({
      width: 720,
      height: 1280,
      codec: 'H.264',
      fps: 30,
      hasAudio: true,
      audioCodec: 'AAC',
      audioProfile: 'AAC-LC',
      audioBitrateBps: 128_000,
      audioSampleRateHz: 44_100,
      audioChannels: 2,
      audioSyncIssue: false,
    })
  })

  it('el respaldo interpreta la frecuencia de salida de HE-AACv2', () => {
    expect(parseMp4VideoMetadata(audiovisualMp4({
      sampleRateHz: 22_050,
      audioSpecificConfig: Uint8Array.from([0xeb, 0x8a, 0x08, 0x00]),
    }))).toMatchObject({
      audioProfile: 'HE-AACv2',
      audioSampleRateHz: 44_100,
      audioChannels: 2,
    })
  })
})
