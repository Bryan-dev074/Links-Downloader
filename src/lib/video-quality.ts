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

function dimensions(view: DataView, trak: BoxView): Pick<VideoProbeResult, 'width' | 'height'> {
  const tkhd = childBox(view, trak, 'tkhd')
  if (!tkhd || tkhd.end - 8 < tkhd.dataStart) return {}
  const width = view.getUint32(tkhd.end - 8) / 65_536
  const height = view.getUint32(tkhd.end - 4) / 65_536
  return {
    width: width > 0 ? Math.round(width) : undefined,
    height: height > 0 ? Math.round(height) : undefined,
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
  const mdia = childBox(view, trak, 'mdia')
  const minf = mdia ? childBox(view, mdia, 'minf') : undefined
  const stbl = minf ? childBox(view, minf, 'stbl') : undefined
  const stsd = stbl ? childBox(view, stbl, 'stsd') : undefined
  if (!stsd || stsd.dataStart + 16 > stsd.end) return undefined
  return codecName(readAscii(view, stsd.dataStart + 12, 4))
}

function mediaTimescale(view: DataView, trak: BoxView): number | undefined {
  const mdia = childBox(view, trak, 'mdia')
  const mdhd = mdia ? childBox(view, mdia, 'mdhd') : undefined
  if (!mdhd || mdhd.dataStart + 4 > mdhd.end) return undefined
  const version = view.getUint8(mdhd.dataStart)
  const offset = mdhd.dataStart + (version === 1 ? 20 : 12)
  if (offset + 4 > mdhd.end) return undefined
  const timescale = view.getUint32(offset)
  return timescale > 0 ? timescale : undefined
}

function framesPerSecond(view: DataView, trak: BoxView): number | undefined {
  const timescale = mediaTimescale(view, trak)
  const mdia = childBox(view, trak, 'mdia')
  const minf = mdia ? childBox(view, mdia, 'minf') : undefined
  const stbl = minf ? childBox(view, minf, 'stbl') : undefined
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
  return Number.isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : undefined
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

  const result: VideoProbeResult = {
    ...dimensions(view, videoTrack),
    codec: codec(view, videoTrack),
    fps: framesPerSecond(view, videoTrack),
  }
  return result.width || result.height || result.codec ? result : undefined
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
    if (!width || !height || width > 16_384 || height > 16_384) return undefined
    return { width, height, fps, codec }
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

function pixelCount(variant: DownloadVariant): number {
  return (variant.width ?? 0) * (variant.height ?? 0)
}

function tierRank(variant: DownloadVariant): number {
  if (variant.providerTier === 'source') return 3
  if (variant.providerTier === 'hd') return 2
  if (variant.providerTier === 'compatible') return 1
  return 0
}

function hasDimensions(variant: DownloadVariant): boolean {
  return Boolean(variant.width && variant.height)
}

/** Orden técnico: resolución, FPS, archivo fuente y bitrate; conserva una fuente no verificable. */
export function compareVideoQuality(left: DownloadVariant, right: DownloadVariant): number {
  const leftKnown = hasDimensions(left)
  const rightKnown = hasDimensions(right)
  if (leftKnown !== rightKnown) {
    if (!leftKnown && left.providerTier === 'source') return -1
    if (!rightKnown && right.providerTier === 'source') return 1
    return leftKnown ? -1 : 1
  }

  const leftPixels = pixelCount(left)
  const rightPixels = pixelCount(right)
  if (leftPixels !== rightPixels) return rightPixels - leftPixels

  if (left.fps !== undefined && right.fps !== undefined) {
    const fpsDifference = right.fps - left.fps
    if (Math.abs(fpsDifference) >= 0.5) return fpsDifference
  }

  const sourceDifference = tierRank(right) - tierRank(left)
  if (sourceDifference !== 0) return sourceDifference

  const bitrateDifference = (right.bitrateBps ?? 0) - (left.bitrateBps ?? 0)
  if (bitrateDifference !== 0) return bitrateDifference
  return (right.sizeBytes ?? 0) - (left.sizeBytes ?? 0)
}

export function estimateBitrate(sizeBytes?: number, durationSeconds?: number): number | undefined {
  if (!sizeBytes || !durationSeconds || durationSeconds <= 0) return undefined
  return Math.round((sizeBytes * 8) / durationSeconds)
}
