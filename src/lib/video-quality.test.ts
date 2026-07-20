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

function syntheticVideoMp4(): ArrayBuffer {
  const tkhdPayload = new Uint8Array(80)
  const tkhdView = new DataView(tkhdPayload.buffer)
  tkhdView.setUint32(tkhdPayload.byteLength - 8, 720 * 65_536)
  tkhdView.setUint32(tkhdPayload.byteLength - 4, 1280 * 65_536)

  const hdlrPayload = new Uint8Array(12)
  hdlrPayload.set(ascii('vide'), 8)

  const mdhdPayload = new Uint8Array(24)
  new DataView(mdhdPayload.buffer).setUint32(12, 30_000)

  const sampleEntry = box('hvc1', new Uint8Array(16))
  const stsd = box('stsd', new Uint8Array(4), uint32(1), sampleEntry)
  const stts = box('stts', new Uint8Array(4), uint32(1), uint32(300), uint32(1000))
  const stbl = box('stbl', stsd, stts)
  const minf = box('minf', stbl)
  const mdia = box('mdia', box('mdhd', mdhdPayload), box('hdlr', hdlrPayload), minf)
  const trak = box('trak', box('tkhd', tkhdPayload), mdia)
  const file = join(box('ftyp', ascii('isom')), box('moov', trak))
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer
}

describe('inspección MP4', () => {
  it('lee resolución, codec y FPS del track de video', () => {
    expect(parseMp4VideoMetadata(syntheticVideoMp4())).toEqual({
      width: 720,
      height: 1280,
      codec: 'HEVC',
      fps: 30,
    })
  })

  it('devuelve undefined cuando no existe un moov completo', () => {
    expect(parseMp4VideoMetadata(new Uint8Array([1, 2, 3, 4]).buffer)).toBeUndefined()
  })
})
