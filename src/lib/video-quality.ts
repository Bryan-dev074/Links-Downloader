import type { DownloadVariant } from '../types'

const PREFIX_PROBE_BYTES = 512 * 1024
const SUFFIX_PROBE_BYTES = 1024 * 1024
const MAX_FULL_RESPONSE_BYTES = 2 * 1024 * 1024

interface BoxView {
  start: number
  dataStart: number
  end: number
  type: string
}

export interface VideoProbeResult {
  width?: number
  height?: number
  fps?: number
  codec?: string
  hasAudio?: boolean
  audioCodec?: string
  audioProfile?: string
  audioBitrateBps?: number
  audioSampleRateHz?: number
  audioChannels?: number
  videoDurationSeconds?: number
  audioDurationSeconds?: number
  avDurationDeltaSeconds?: number
  audioSyncIssue?: boolean
  videoBitrateBps?: number
}

interface MediaTiming {
  timescale: number
  durationSeconds?: number
}

export interface ProbeVideoOptions {
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  preferMediaElement?: boolean
}

function readAscii(view: DataView, offset: number, length: number): string {
  if (offset < 0 || offset + length > view.byteLength) return ''
  let value = ''
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(view.getUint8(offset + index))
  }
  return value
}

function readBox(view: DataView, start: number, limit = view.byteLength): BoxView | undefined {
  if (start < 0 || start + 8 > limit) return undefined
  const size32 = view.getUint32(start)
  const type = readAscii(view, start + 4, 4)
  let headerSize = 8
  let size = size32

  if (size32 === 1) {
    if (start + 16 > limit) return undefined
    const size64 = view.getBigUint64(start + 8)
    if (size64 > BigInt(Number.MAX_SAFE_INTEGER)) return undefined
    size = Number(size64)
    headerSize = 16
  } else if (size32 === 0) {
    size = limit - start
  }

  if (size < headerSize || start + size > limit) return undefined
  return { start, dataStart: start + headerSize, end: start + size, type }
}

function childBoxes(view: DataView, parent: BoxView): BoxView[] {
  const boxes: BoxView[] = []
  let cursor = parent.dataStart
  while (cursor + 8 <= parent.end) {
    const box = readBox(view, cursor, parent.end)
    if (!box) break
    boxes.push(box)
    if (box.end <= cursor) break
    cursor = box.end
  }
  return boxes
}

function childBox(view: DataView, parent: BoxView, type: string): BoxView | undefined {
  return childBoxes(view, parent).find((box) => box.type === type)
}

function findContainedBox(view: DataView, type: string): BoxView | undefined {
  for (let offset = 4; offset + 4 <= view.byteLength; offset += 1) {
    if (readAscii(view, offset, 4) !== type) continue
    const box = readBox(view, offset - 4)
    if (box?.type === type) return box
  }
  return undefined
}

function handlerType(view: DataView, trak: BoxView): string | undefined {
  const mdia = childBox(view, trak, 'mdia')
  const hdlr = mdia ? childBox(view, mdia, 'hdlr') : undefined
  if (!hdlr || hdlr.dataStart + 12 > hdlr.end) return undefined
  return readAscii(view, hdlr.dataStart + 8, 4)
}

function sampleTable(view: DataView, trak: BoxView): BoxView | undefined {
  const mdia = childBox(view, trak, 'mdia')
  const minf = mdia ? childBox(view, mdia, 'minf') : undefined
  return minf ? childBox(view, minf, 'stbl') : undefined
}

function firstSampleEntry(view: DataView, trak: BoxView): BoxView | undefined {
  const stbl = sampleTable(view, trak)
  const stsd = stbl ? childBox(view, stbl, 'stsd') : undefined
  if (!stsd || stsd.dataStart + 8 > stsd.end) return undefined
  const entryCount = view.getUint32(stsd.dataStart + 4)
  if (entryCount < 1) return undefined
  return readBox(view, stsd.dataStart + 8, stsd.end)
}

function dimensions(view: DataView, trak: BoxView): Pick<VideoProbeResult, 'width' | 'height'> {
  const tkhd = childBox(view, trak, 'tkhd')
  if (!tkhd || tkhd.end - 8 < tkhd.dataStart) return {}
  const width = view.getUint32(tkhd.end - 8) / 65_536
  const height = view.getUint32(tkhd.end - 4) / 65_536
  return {
    width: width > 0 && width <= 16_384 ? Math.round(width) : undefined,
    height: height > 0 && height <= 16_384 ? Math.round(height) : undefined,
  }
}

function codecName(sampleEntry: string): string | undefined {
  const codecs: Record<string, string> = {
    avc1: 'H.264',
    avc3: 'H.264',
    hvc1: 'HEVC',
    hev1: 'HEVC',
    av01: 'AV1',
    vp09: 'VP9',
  }
  return codecs[sampleEntry]
}

function codec(view: DataView, trak: BoxView): string | undefined {
  const entry = firstSampleEntry(view, trak)
  return entry ? codecName(entry.type) : undefined
}

function mediaTiming(view: DataView, trak: BoxView): MediaTiming | undefined {
  const mdia = childBox(view, trak, 'mdia')
  const mdhd = mdia ? childBox(view, mdia, 'mdhd') : undefined
  if (!mdhd || mdhd.dataStart + 4 > mdhd.end) return undefined
  const version = view.getUint8(mdhd.dataStart)
  if (version !== 0 && version !== 1) return undefined
  const timescaleOffset = mdhd.dataStart + (version === 1 ? 20 : 12)
  const durationOffset = timescaleOffset + 4
  const durationBytes = version === 1 ? 8 : 4
  if (durationOffset + durationBytes > mdhd.end) return undefined
  const timescale = view.getUint32(timescaleOffset)
  if (timescale <= 0) return undefined
  const rawDuration = version === 1
    ? view.getBigUint64(durationOffset)
    : BigInt(view.getUint32(durationOffset))
  const maximum = BigInt(Number.MAX_SAFE_INTEGER)
  const durationSeconds = rawDuration > 0n && rawDuration <= maximum
    ? Number(rawDuration) / timescale
    : undefined
  return {
    timescale,
    durationSeconds: durationSeconds && Number.isFinite(durationSeconds)
      ? Math.round(durationSeconds * 1000) / 1000
      : undefined,
  }
}

function framesPerSecond(view: DataView, trak: BoxView): number | undefined {
  const timescale = mediaTiming(view, trak)?.timescale
  const stbl = sampleTable(view, trak)
  const stts = stbl ? childBox(view, stbl, 'stts') : undefined
  if (!timescale || !stts || stts.dataStart + 8 > stts.end) return undefined

  const entryCount = view.getUint32(stts.dataStart + 4)
  let cursor = stts.dataStart + 8
  let samples = 0
  let ticks = 0
  for (let index = 0; index < entryCount && cursor + 8 <= stts.end; index += 1) {
    const sampleCount = view.getUint32(cursor)
    const sampleDelta = view.getUint32(cursor + 4)
    samples += sampleCount
    ticks += sampleCount * sampleDelta
    cursor += 8
  }
  if (samples <= 0 || ticks <= 0) return undefined
  const value = (samples * timescale) / ticks
  return Number.isFinite(value) && value >= 1 && value <= 240
    ? Math.round(value * 100) / 100
    : undefined
}

function sampleDurationSeconds(view: DataView, trak: BoxView): number | undefined {
  const timing = mediaTiming(view, trak)
  const stbl = sampleTable(view, trak)
  const stts = stbl ? childBox(view, stbl, 'stts') : undefined
  if (!timing || !stts || stts.dataStart + 8 > stts.end) return timing?.durationSeconds

  const entryCount = view.getUint32(stts.dataStart + 4)
  let cursor = stts.dataStart + 8
  let ticks = 0n
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 8 > stts.end) return timing.durationSeconds
    ticks += BigInt(view.getUint32(cursor)) * BigInt(view.getUint32(cursor + 4))
    cursor += 8
  }
  if (ticks <= 0n || ticks > BigInt(Number.MAX_SAFE_INTEGER)) return timing.durationSeconds
  const duration = Number(ticks) / timing.timescale
  return Number.isFinite(duration) && duration > 0
    ? Math.round(duration * 1000) / 1000
    : timing.durationSeconds
}

function audioCodecName(sampleEntry: string): string | undefined {
  const codecs: Record<string, string> = {
    mp4a: 'AAC',
    Opus: 'Opus',
    opus: 'Opus',
    '.mp3': 'MP3',
    alac: 'ALAC',
    'ac-3': 'AC-3',
    'ec-3': 'E-AC-3',
  }
  return codecs[sampleEntry]
}

function descriptorPayload(
  view: DataView,
  descriptorOffset: number,
  limit: number,
): { start: number; end: number } | undefined {
  let cursor = descriptorOffset + 1
  let length = 0
  for (let index = 0; index < 4; index += 1) {
    if (cursor >= limit) return undefined
    const value = view.getUint8(cursor)
    cursor += 1
    length = (length << 7) | (value & 0x7f)
    if ((value & 0x80) === 0) {
      return length >= 0 && cursor + length <= limit
        ? { start: cursor, end: cursor + length }
        : undefined
    }
  }
  return undefined
}

interface AacConfig {
  profile?: string
  sampleRateHz?: number
  channels?: number
}

function parseAacConfig(view: DataView, start: number, end: number): AacConfig | undefined {
  let bitOffset = 0
  const bitLength = (end - start) * 8
  const readBits = (count: number): number | undefined => {
    if (count < 1 || bitOffset + count > bitLength) return undefined
    let value = 0
    for (let index = 0; index < count; index += 1) {
      const absoluteBit = bitOffset + index
      const byte = view.getUint8(start + Math.floor(absoluteBit / 8))
      value = (value << 1) | ((byte >> (7 - (absoluteBit % 8))) & 1)
    }
    bitOffset += count
    return value
  }
  const readAudioObjectType = (): number | undefined => {
    const base = readBits(5)
    if (base === undefined) return undefined
    if (base !== 31) return base
    const extension = readBits(6)
    return extension === undefined ? undefined : 32 + extension
  }
  const sampleRates = [
    96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000,
    22_050, 16_000, 12_000, 11_025, 8_000, 7_350,
  ]
  const readSampleRate = (): number | undefined => {
    const index = readBits(4)
    if (index === undefined) return undefined
    if (index === 15) return readBits(24)
    return sampleRates[index]
  }

  const audioObjectType = readAudioObjectType()
  const baseSampleRate = readSampleRate()
  const channelConfiguration = readBits(4)
  if (audioObjectType === undefined) return undefined
  const profiles: Record<number, string> = {
    2: 'AAC-LC',
    5: 'HE-AAC',
    29: 'HE-AACv2',
    42: 'xHE-AAC',
  }
  let effectiveSampleRate = baseSampleRate
  if (audioObjectType === 5 || audioObjectType === 29) {
    // SBR/PS declara primero la frecuencia núcleo y después la frecuencia de
    // salida. Mostrar la primera haría parecer que un audio de 44.1 kHz es 22 kHz.
    effectiveSampleRate = readSampleRate() ?? baseSampleRate
  }
  return {
    profile: profiles[audioObjectType],
    sampleRateHz: effectiveSampleRate,
    channels: channelConfiguration && channelConfiguration <= 2
      ? channelConfiguration
      : undefined,
  }
}

function aacConfig(view: DataView, entry: BoxView): AacConfig | undefined {
  // `esds` vive dentro del AudioSampleEntry. Buscarlo acotado al entry también
  // cubre las extensiones QuickTime v1/v2 sin asumir un offset incorrecto.
  let esds: BoxView | undefined
  for (let offset = entry.dataStart + 20; offset + 4 <= entry.end; offset += 1) {
    if (readAscii(view, offset, 4) !== 'esds') continue
    const candidate = readBox(view, offset - 4, entry.end)
    if (candidate?.type === 'esds') {
      esds = candidate
      break
    }
  }
  if (!esds) return undefined

  // DecoderSpecificInfo (tag 0x05) contiene AudioSpecificConfig. Normalmente
  // mide 2–5 bytes; el límite evita confundir un byte de bitrate con un descriptor.
  for (let offset = esds.dataStart + 4; offset + 3 <= esds.end; offset += 1) {
    if (view.getUint8(offset) !== 0x05) continue
    const payload = descriptorPayload(view, offset, esds.end)
    if (!payload || payload.end - payload.start < 2 || payload.end - payload.start > 8) continue
    const config = parseAacConfig(view, payload.start, payload.end)
    if (config) return config
  }
  return undefined
}

function audioSampleMetadata(
  view: DataView,
  trak: BoxView,
): Pick<
  VideoProbeResult,
  'audioCodec' | 'audioProfile' | 'audioSampleRateHz' | 'audioChannels'
> {
  const entry = firstSampleEntry(view, trak)
  if (!entry) return {}
  const audioCodec = audioCodecName(entry.type)
  const config = entry.type === 'mp4a' ? aacConfig(view, entry) : undefined
  const audioProfile = config?.profile
  if (entry.dataStart + 28 > entry.end) {
    return {
      audioCodec,
      audioProfile,
      audioSampleRateHz: config?.sampleRateHz,
      audioChannels: config?.channels,
    }
  }
  const channels = view.getUint16(entry.dataStart + 16)
  const sampleRate = view.getUint32(entry.dataStart + 24) / 65_536
  return {
    audioCodec,
    audioProfile,
    audioChannels: channels > 0 && channels <= 32 ? channels : config?.channels,
    audioSampleRateHz: config?.sampleRateHz ?? (
      sampleRate >= 8_000 && sampleRate <= 768_000 ? Math.round(sampleRate) : undefined
    ),
  }
}

function trackPayloadBytes(view: DataView, trak: BoxView): number | undefined {
  const stbl = sampleTable(view, trak)
  const stsz = stbl ? childBox(view, stbl, 'stsz') : undefined
  if (!stsz || stsz.dataStart + 12 > stsz.end) return undefined
  const uniformSampleSize = view.getUint32(stsz.dataStart + 4)
  const sampleCount = view.getUint32(stsz.dataStart + 8)
  if (sampleCount === 0) return undefined
  if (uniformSampleSize > 0) {
    const total = uniformSampleSize * sampleCount
    return Number.isSafeInteger(total) ? total : undefined
  }

  let cursor = stsz.dataStart + 12
  let total = 0
  for (let index = 0; index < sampleCount; index += 1) {
    if (cursor + 4 > stsz.end) return undefined
    total += view.getUint32(cursor)
    if (!Number.isSafeInteger(total)) return undefined
    cursor += 4
  }
  return total > 0 ? total : undefined
}

function trackBitrate(view: DataView, trak: BoxView, durationSeconds?: number): number | undefined {
  const bytes = trackPayloadBytes(view, trak)
  if (!bytes || !durationSeconds || durationSeconds <= 0) return undefined
  const bitrate = (bytes * 8) / durationSeconds
  return Number.isFinite(bitrate) && bitrate > 0 ? Math.round(bitrate) : undefined
}

function audioSyncMetadata(
  videoDurationSeconds?: number,
  audioDurationSeconds?: number,
): Pick<VideoProbeResult, 'avDurationDeltaSeconds' | 'audioSyncIssue'> {
  if (!videoDurationSeconds || !audioDurationSeconds) return {}
  const delta = Math.abs(videoDurationSeconds - audioDurationSeconds)
  const referenceDuration = Math.max(videoDurationSeconds, audioDurationSeconds)
  // AAC suele añadir unas milésimas de relleno. Solo marcamos diferencias perceptibles.
  const tolerance = Math.max(0.25, Math.min(1, referenceDuration * 0.01))
  return {
    avDurationDeltaSeconds: Math.round(delta * 1000) / 1000,
    audioSyncIssue: delta > tolerance,
  }
}

/** Extrae metadatos del track de video sin decodificar ni modificar el archivo. */
export function parseMp4VideoMetadata(buffer: ArrayBuffer): VideoProbeResult | undefined {
  const view = new DataView(buffer)
  const moov = findContainedBox(view, 'moov')
  if (!moov) return undefined
  const videoTrack = childBoxes(view, moov)
    .filter((box) => box.type === 'trak')
    .find((trak) => handlerType(view, trak) === 'vide')
  if (!videoTrack) return undefined

  const audioTrack = childBoxes(view, moov)
    .filter((box) => box.type === 'trak')
    .find((trak) => handlerType(view, trak) === 'soun')
  const videoDurationSeconds = sampleDurationSeconds(view, videoTrack)
  const audioDurationSeconds = audioTrack ? sampleDurationSeconds(view, audioTrack) : undefined
  const audioMetadata = audioTrack ? audioSampleMetadata(view, audioTrack) : {}

  const result: VideoProbeResult = {
    ...dimensions(view, videoTrack),
    codec: codec(view, videoTrack),
    fps: framesPerSecond(view, videoTrack),
    videoBitrateBps: trackBitrate(view, videoTrack, videoDurationSeconds),
    hasAudio: Boolean(audioTrack),
    ...audioMetadata,
    videoDurationSeconds,
    audioDurationSeconds,
    audioBitrateBps: audioTrack
      ? trackBitrate(view, audioTrack, audioDurationSeconds)
      : undefined,
    ...audioSyncMetadata(videoDurationSeconds, audioDurationSeconds),
  }
  return result.width || result.height || result.codec || result.hasAudio !== undefined
    ? result
    : undefined
}

async function fetchProbeRange(
  url: string,
  range: string,
  options: ProbeVideoOptions,
): Promise<ArrayBuffer | undefined> {
  const response = await (options.fetchImpl ?? fetch)(url, {
    method: 'GET',
    mode: 'cors',
    credentials: 'omit',
    headers: { Range: range },
    signal: options.signal,
  })
  if (!response.ok) return undefined

  const declaredLength = Number(response.headers.get('content-length'))
  if (
    response.status !== 206
    && Number.isFinite(declaredLength)
    && declaredLength > MAX_FULL_RESPONSE_BYTES
  ) {
    await response.body?.cancel()
    return undefined
  }

  if (!response.body) {
    const buffer = await response.arrayBuffer()
    return buffer.byteLength <= MAX_FULL_RESPONSE_BYTES ? buffer : undefined
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let totalBytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    totalBytes += value.byteLength
    if (totalBytes > MAX_FULL_RESPONSE_BYTES) {
      await reader.cancel()
      return undefined
    }
    const owned = new Uint8Array(value.byteLength)
    owned.set(value)
    chunks.push(owned)
  }
  const output = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output.buffer
}

function probeWithMediaElement(
  url: string,
  signal?: AbortSignal,
): Promise<VideoProbeResult | undefined> {
  if (typeof document === 'undefined' || signal?.aborted) return Promise.resolve(undefined)

  return new Promise((resolve) => {
    const video = document.createElement('video')
    let settled = false
    const finish = (result?: VideoProbeResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      video.removeEventListener('loadedmetadata', onMetadata)
      video.removeEventListener('error', onError)
      video.removeAttribute('src')
      video.load()
      video.remove()
      resolve(result)
    }
    const onMetadata = () => {
      const width = video.videoWidth
      const height = video.videoHeight
      finish(width > 0 && height > 0 ? { width, height } : undefined)
    }
    const onError = () => finish()
    const onAbort = () => finish()
    const timer = setTimeout(() => finish(), 8_000)

    video.preload = 'metadata'
    video.muted = true
    video.playsInline = true
    video.hidden = true
    video.addEventListener('loadedmetadata', onMetadata, { once: true })
    video.addEventListener('error', onError, { once: true })
    signal?.addEventListener('abort', onAbort, { once: true })
    document.body.append(video)
    video.src = url
    video.load()
  })
}

function isTokCdnUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    const hostname = parsed.hostname.toLowerCase()
    return (
      parsed.protocol === 'https:'
      && !parsed.username
      && !parsed.password
      && !parsed.port
      && !parsed.hash
      && hostname === 'v16.tokcdn.com'
      && parsed.pathname.toLowerCase().endsWith('.mp4')
    )
  } catch {
    return false
  }
}

async function probeWithMetadataEndpoint(
  videoUrl: string,
  options: ProbeVideoOptions,
): Promise<VideoProbeResult | undefined> {
  if (typeof window === 'undefined' || !isTokCdnUrl(videoUrl) || options.signal?.aborted) {
    return undefined
  }

  try {
    const endpoint = new URL('/api/video-metadata', window.location.origin)
    endpoint.searchParams.set('url', videoUrl)
    const response = await (options.fetchImpl ?? fetch)(endpoint, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: options.signal,
    })
    if (!response.ok) return undefined
    const payload: unknown = await response.json()
    if (!payload || typeof payload !== 'object') return undefined
    const metadata = payload as Record<string, unknown>
    const width = typeof metadata.width === 'number' ? metadata.width : undefined
    const height = typeof metadata.height === 'number' ? metadata.height : undefined
    const fps = typeof metadata.fps === 'number' ? metadata.fps : undefined
    const codec = typeof metadata.codec === 'string' ? metadata.codec : undefined
    const hasAudio = typeof metadata.hasAudio === 'boolean' ? metadata.hasAudio : undefined
    const audioCodec = typeof metadata.audioCodec === 'string' ? metadata.audioCodec : undefined
    const audioProfile = typeof metadata.audioProfile === 'string' ? metadata.audioProfile : undefined
    const audioBitrateBps = typeof metadata.audioBitrateBps === 'number'
      ? metadata.audioBitrateBps
      : undefined
    const audioSampleRateHz = typeof metadata.audioSampleRateHz === 'number'
      ? metadata.audioSampleRateHz
      : undefined
    const audioChannels = typeof metadata.audioChannels === 'number'
      ? metadata.audioChannels
      : undefined
    const videoDurationSeconds = typeof metadata.videoDurationSeconds === 'number'
      ? metadata.videoDurationSeconds
      : undefined
    const audioDurationSeconds = typeof metadata.audioDurationSeconds === 'number'
      ? metadata.audioDurationSeconds
      : undefined
    const avDurationDeltaSeconds = typeof metadata.avDurationDeltaSeconds === 'number'
      ? metadata.avDurationDeltaSeconds
      : undefined
    const audioSyncIssue = typeof metadata.audioSyncIssue === 'boolean'
      ? metadata.audioSyncIssue
      : undefined
    const videoBitrateBps = typeof metadata.videoBitrateBps === 'number'
      ? metadata.videoBitrateBps
      : undefined
    if (!width || !height || width > 16_384 || height > 16_384) return undefined
    return {
      width,
      height,
      fps,
      codec,
      hasAudio,
      audioCodec,
      audioProfile,
      audioBitrateBps,
      audioSampleRateHz,
      audioChannels,
      videoDurationSeconds,
      audioDurationSeconds,
      avDurationDeltaSeconds,
      audioSyncIssue,
      videoBitrateBps,
    }
  } catch {
    return undefined
  }
}

/** Lee como máximo 1.5 MB por variante usando Range; si CORS falla, no bloquea la descarga. */
export async function probeMp4Video(
  url: string,
  options: ProbeVideoOptions = {},
): Promise<VideoProbeResult | undefined> {
  if (options.preferMediaElement) {
    const [browserMetadata, serverMetadata] = await Promise.all([
      probeWithMediaElement(url, options.signal),
      probeWithMetadataEndpoint(url, options),
    ])
    return serverMetadata ?? browserMetadata
  }
  try {
    const prefix = await fetchProbeRange(url, `bytes=0-${PREFIX_PROBE_BYTES - 1}`, options)
    const prefixMetadata = prefix ? parseMp4VideoMetadata(prefix) : undefined
    if (prefixMetadata) return prefixMetadata

    const suffix = await fetchProbeRange(url, `bytes=-${SUFFIX_PROBE_BYTES}`, options)
    const suffixMetadata = suffix ? parseMp4VideoMetadata(suffix) : undefined
    if (suffixMetadata) return suffixMetadata
  } catch {
    // Un <video> puede leer dimensiones cross-origin sin exponer sus bytes a JavaScript.
  }
  return probeWithMediaElement(url, options.signal)
}

function tierRank(variant: DownloadVariant): number {
  if (variant.providerTier === 'source') return 3
  if (variant.providerTier === 'hd') return 2
  if (variant.providerTier === 'compatible') return 1
  return 0
}

function audioIntegrityRank(variant: DownloadVariant): number {
  if (variant.audioSyncIssue === true || variant.hasAudio === false) return 0
  // Los metadatos desconocidos se conservan como potencialmente sanos. No se
  // debe castigar una fuente solo porque su CDN haya bloqueado la inspección.
  if (variant.hasAudio !== true || !variant.audioBitrateBps) return 2
  const minimumHealthyBitrate = variant.audioChannels === 1 ? 32_000 : 48_000
  return variant.audioBitrateBps >= minimumHealthyBitrate ? 2 : 1
}

function resolutionRank(variant: DownloadVariant): number {
  if (variant.width && variant.height) return variant.width * variant.height
  return 0
}

function fpsRank(variant: DownloadVariant): number {
  if (variant.fps !== undefined) return Math.round(variant.fps)
  return 0
}

function knownNumberRank(value?: number): number {
  return value && Number.isFinite(value) && value > 0 ? value : 0
}

function descending(left: number, right: number): number {
  return right - left
}

/**
 * Orden audiovisual: primero descarta audio roto o excesivamente comprimido;
 * luego compara resolución, FPS, pistas reales y por último la etiqueta del proveedor.
 * Una variante no verificable nunca se trata como si estuviera dañada.
 */
export function compareVideoQuality(left: DownloadVariant, right: DownloadVariant): number {
  const leftAudioIntegrity = audioIntegrityRank(left)
  const rightAudioIntegrity = audioIntegrityRank(right)
  if (leftAudioIntegrity !== rightAudioIntegrity) {
    return rightAudioIntegrity - leftAudioIntegrity
  }

  const resolutionDifference = descending(resolutionRank(left), resolutionRank(right))
  if (resolutionDifference !== 0) return resolutionDifference

  const fpsDifference = descending(fpsRank(left), fpsRank(right))
  if (fpsDifference !== 0) return fpsDifference

  const audioBitrateDifference = descending(
    knownNumberRank(left.audioBitrateBps),
    knownNumberRank(right.audioBitrateBps),
  )
  if (audioBitrateDifference !== 0) return audioBitrateDifference

  const videoBitrateDifference = descending(
    knownNumberRank(left.videoBitrateBps),
    knownNumberRank(right.videoBitrateBps),
  )
  if (videoBitrateDifference !== 0) return videoBitrateDifference

  const sourceDifference = tierRank(right) - tierRank(left)
  if (sourceDifference !== 0) return sourceDifference

  const bitrateDifference = (right.bitrateBps ?? 0) - (left.bitrateBps ?? 0)
  if (bitrateDifference !== 0) return bitrateDifference
  const sizeDifference = (right.sizeBytes ?? 0) - (left.sizeBytes ?? 0)
  if (sizeDifference !== 0) return sizeDifference
  return left.id.localeCompare(right.id)
}

export function estimateBitrate(sizeBytes?: number, durationSeconds?: number): number | undefined {
  if (!sizeBytes || !durationSeconds || durationSeconds <= 0) return undefined
  return Math.round((sizeBytes * 8) / durationSeconds)
}
