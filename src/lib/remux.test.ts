import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamTargetChunk } from 'mediabunny'
import { remuxVideoWithBetterAudio, type RemuxProgress } from './remux'

interface PacketSpec {
  timestamp: number
  duration: number
  data: Uint8Array
}

interface TrackSpec {
  codec: string | null
  decoderConfig: Record<string, unknown> | null
  start: number
  end: number
  rotation?: number
  packets: PacketSpec[]
}

interface AddedPacket {
  packet: PacketSpec
  metadata?: { decoderConfig?: Record<string, unknown> }
}

interface MockMediaState {
  targetVideo: TrackSpec
  donorVideo: TrackSpec
  donorAudio: TrackSpec
  videoAdds: AddedPacket[]
  audioAdds: AddedPacket[]
  videoClosed: boolean
  audioClosed: boolean
  inputsCreated: number
  inputsDisposed: number
  outputCanceled: number
  outputFinalized: number
  afterVideoAdd?: () => void
}

const state = vi.hoisted<MockMediaState>(() => ({
  targetVideo: {
    codec: 'hevc',
    decoderConfig: { codec: 'hvc1.1.6.L93.B0', codedWidth: 720, codedHeight: 1280 },
    start: 0,
    end: 1,
    rotation: 0,
    packets: [],
  },
  donorVideo: {
    codec: 'avc',
    decoderConfig: { codec: 'avc1.64001f', codedWidth: 576, codedHeight: 1024 },
    start: 0,
    end: 1,
    packets: [],
  },
  donorAudio: {
    codec: 'aac',
    decoderConfig: { codec: 'mp4a.40.2', numberOfChannels: 2, sampleRate: 44_100 },
    start: -0.04,
    end: 1,
    packets: [],
  },
  videoAdds: [],
  audioAdds: [],
  videoClosed: false,
  audioClosed: false,
  inputsCreated: 0,
  inputsDisposed: 0,
  outputCanceled: 0,
  outputFinalized: 0,
}))

vi.mock('mediabunny', () => {
  function mockTrack(spec: TrackSpec) {
    return {
      __spec: spec,
      getCodec: async () => spec.codec,
      getDecoderConfig: async () => spec.decoderConfig,
      getRotation: async () => spec.rotation ?? 0,
      getFirstTimestamp: async () => spec.start,
      computeDuration: async () => spec.end,
    }
  }

  function clonePacket(packet: PacketSpec, changes?: Partial<PacketSpec>): PacketSpec & {
    clone: (nextChanges?: Partial<PacketSpec>) => PacketSpec
  } {
    return {
      ...packet,
      ...changes,
      clone(nextChanges) {
        return clonePacket(this, nextChanges)
      },
    }
  }

  class UrlSource {
    readonly url: string

    constructor(url: string | URL) {
      this.url = String(url)
    }
  }

  class Input {
    readonly source: UrlSource

    constructor(options: { source: UrlSource }) {
      this.source = options.source
      state.inputsCreated += 1
    }

    async getPrimaryVideoTrack() {
      return mockTrack(this.source.url.includes('high') ? state.targetVideo : state.donorVideo)
    }

    async getPrimaryAudioTrack() {
      return this.source.url.includes('high') ? null : mockTrack(state.donorAudio)
    }

    dispose() {
      state.inputsDisposed += 1
    }
  }

  class EncodedPacketSink {
    readonly track: ReturnType<typeof mockTrack>

    constructor(track: ReturnType<typeof mockTrack>) {
      this.track = track
    }

    async *packets() {
      for (const packet of this.track.__spec.packets) yield clonePacket(packet)
    }
  }

  class EncodedVideoPacketSource {
    readonly codec: string

    constructor(codec: string) {
      this.codec = codec
    }

    async add(packet: PacketSpec, metadata?: AddedPacket['metadata']) {
      state.videoAdds.push({ packet, metadata })
      state.afterVideoAdd?.()
    }

    close() {
      state.videoClosed = true
    }
  }

  class EncodedAudioPacketSource {
    readonly codec: string

    constructor(codec: string) {
      this.codec = codec
    }

    async add(packet: PacketSpec, metadata?: AddedPacket['metadata']) {
      state.audioAdds.push({ packet, metadata })
    }

    close() {
      state.audioClosed = true
    }
  }

  class BufferTarget {
    buffer: ArrayBuffer | null = null
  }

  class StreamTarget {
    readonly writable: WritableStream<StreamTargetChunk>

    constructor(writable: WritableStream<StreamTargetChunk>) {
      this.writable = writable
    }
  }

  class Mp4OutputFormat {
    getSupportedVideoCodecs() {
      return ['avc', 'hevc']
    }

    getSupportedAudioCodecs() {
      return ['aac']
    }
  }

  class Output {
    readonly target: BufferTarget | StreamTarget

    constructor(options: { target: BufferTarget | StreamTarget }) {
      this.target = options.target
    }

    addVideoTrack() {}

    addAudioTrack() {}

    async start() {}

    async cancel() {
      state.outputCanceled += 1
    }

    async finalize() {
      state.outputFinalized += 1
      if (this.target instanceof BufferTarget) {
        this.target.buffer = new Uint8Array([0, 1, 2, 3, 4]).buffer
        return
      }

      const writer = this.target.writable.getWriter()
      await writer.write({ type: 'write', position: 0, data: new Uint8Array([0, 1, 2]) })
      await writer.write({ type: 'write', position: 3, data: new Uint8Array([3, 4]) })
      await writer.close()
    }
  }

  return {
    BufferTarget,
    EncodedAudioPacketSource,
    EncodedPacketSink,
    EncodedVideoPacketSource,
    Input,
    MP4: {},
    Mp4OutputFormat,
    Output,
    StreamTarget,
    UrlSource,
  }
})

function packet(timestamp: number, duration: number, value: number): PacketSpec {
  return { timestamp, duration, data: new Uint8Array([value]) }
}

function options(overrides: Partial<Parameters<typeof remuxVideoWithBetterAudio>[0]> = {}) {
  return {
    videoUrl: 'https://cdn.example/high.mp4',
    audioUrl: 'https://cdn.example/standard.mp4',
    videoSizeBytes: 2 * 1024 * 1024,
    audioSizeBytes: 3 * 1024 * 1024,
    ...overrides,
  }
}

beforeEach(() => {
  state.targetVideo = {
    codec: 'hevc',
    decoderConfig: { codec: 'hvc1.1.6.L93.B0', codedWidth: 720, codedHeight: 1280 },
    start: 0,
    end: 1,
    rotation: 0,
    packets: [packet(0, 0.04, 10), packet(0.04, 0.04, 11)],
  }
  state.donorVideo = {
    codec: 'avc',
    decoderConfig: { codec: 'avc1.64001f', codedWidth: 576, codedHeight: 1024 },
    start: 0,
    end: 1,
    packets: [],
  }
  state.donorAudio = {
    codec: 'aac',
    decoderConfig: { codec: 'mp4a.40.2', numberOfChannels: 2, sampleRate: 44_100 },
    start: -0.04,
    end: 1,
    packets: [packet(-0.04, 0.02, 20), packet(-0.02, 0.02, 21), packet(0, 0.02, 22)],
  }
  state.videoAdds = []
  state.audioAdds = []
  state.videoClosed = false
  state.audioClosed = false
  state.inputsCreated = 0
  state.inputsDisposed = 0
  state.outputCanceled = 0
  state.outputFinalized = 0
  state.afterVideoAdd = undefined
})

describe('remuxVideoWithBetterAudio', () => {
  it('copia los paquetes y conserva el pre-roll sin cambiar la sincronía', async () => {
    const progress: RemuxProgress[] = []

    const result = await remuxVideoWithBetterAudio(options({
      onProgress: (update) => progress.push(update),
    }))

    expect(result.bytes).toBe(5)
    expect(result.blob).toBeInstanceOf(Blob)
    expect(result.blob?.type).toBe('video/mp4')
    expect(state.videoAdds.map(({ packet: added }) => added.timestamp)).toEqual([0.04, 0.08])
    expect(state.audioAdds.map(({ packet: added }) => added.timestamp)).toEqual([0, 0.02, 0.04])
    expect(state.videoAdds[0]?.packet.data).toBe(state.targetVideo.packets[0]?.data)
    expect(state.audioAdds[0]?.packet.data).toBe(state.donorAudio.packets[0]?.data)
    expect(state.videoAdds[0]?.metadata?.decoderConfig).toBe(state.targetVideo.decoderConfig)
    expect(state.audioAdds[0]?.metadata?.decoderConfig).toBe(state.donorAudio.decoderConfig)
    expect(state.videoClosed).toBe(true)
    expect(state.audioClosed).toBe(true)
    expect(state.outputFinalized).toBe(1)
    expect(progress.at(-1)).toEqual({ phase: 'completed', percent: 100 })
  })

  it('rechaza combinar dos versiones con relojes diferentes', async () => {
    state.donorVideo.end = 1.4

    await expect(remuxVideoWithBetterAudio(options())).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      message: 'Las dos versiones del video no comparten la misma duración.',
    })
    expect(state.videoAdds).toHaveLength(0)
    expect(state.audioAdds).toHaveLength(0)
  })

  it('limita la ruta Blob antes de reservar memoria en teléfonos', async () => {
    await expect(remuxVideoWithBetterAudio(options({
      videoSizeBytes: 40 * 1024 * 1024,
      audioSizeBytes: 30 * 1024 * 1024,
    }))).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' })
    expect(state.inputsCreated).toBe(0)
  })

  it('escribe por streaming y devuelve el tamaño final sin crear un Blob', async () => {
    const chunks: StreamTargetChunk[] = []
    const writable = new WritableStream<StreamTargetChunk>({
      write(chunk) {
        chunks.push(chunk)
      },
    })

    const result = await remuxVideoWithBetterAudio(options({ outputWritable: writable }))

    expect(result).toEqual({ bytes: 5 })
    expect(chunks).toHaveLength(2)
    expect(chunks[1]).toMatchObject({ position: 3 })
  })

  it('cancela inputs y output si el usuario aborta durante el remux', async () => {
    const controller = new AbortController()
    state.afterVideoAdd = () => controller.abort('user')

    await expect(remuxVideoWithBetterAudio(options({ signal: controller.signal }))).rejects
      .toMatchObject({ code: 'ABORTED' })
    expect(state.outputCanceled).toBe(1)
    expect(state.inputsDisposed).toBeGreaterThanOrEqual(2)
    expect(state.outputFinalized).toBe(0)
  })

  it('no abre recursos si la señal ya estaba cancelada', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(remuxVideoWithBetterAudio(options({ signal: controller.signal }))).rejects
      .toMatchObject({ code: 'ABORTED' })
    expect(state.inputsCreated).toBe(0)
  })
})
