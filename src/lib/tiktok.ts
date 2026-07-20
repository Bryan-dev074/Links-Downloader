import type {
  CarouselImage,
  DownloadQuality,
  DownloadVariant,
  LinkProvider,
  MediaAuthor,
  ResolveOptions,
  ResolvedMedia,
} from '../types'
import { LinksDownloaderError, isAbortError } from './errors'
import { createRequestSignal } from './request'
import { extractUrl, optionalUrl } from './url'
import { compareVideoQuality, estimateBitrate, probeMp4Video } from './video-quality'

const TIKWM_API_URL = 'https://www.tikwm.com/api/'
const TIKWM_ORIGINAL_SUBMIT_URL = 'https://www.tikwm.com/api/video/task/submit'
const TIKWM_ORIGINAL_RESULT_URL = 'https://www.tikwm.com/api/video/task/result'
const DEFAULT_TIMEOUT_MS = 30_000
const TIKWM_ASSET_BASE = 'https://www.tikwm.com'
const ORIGINAL_POLL_ATTEMPTS = 18
const ORIGINAL_POLL_INTERVAL_MS = 900

type UnknownRecord = Record<string, unknown>

export type TikTokLinkKind = 'video' | 'photo' | 'short' | 'embed'

export interface TikTokLinkInfo {
  url: string
  kind: TikTokLinkKind
  mediaId?: string
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return undefined
}

function numberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) continue
    const parsed = typeof value === 'number' ? value : Number(value)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }
  return undefined
}

function assetUrl(value: unknown): string | undefined {
  return optionalUrl(value, TIKWM_ASSET_BASE)
}

function urlsFromImageEntry(entry: unknown): string[] {
  if (typeof entry === 'string') {
    const url = assetUrl(entry)
    return url ? [url] : []
  }
  if (!isRecord(entry)) return []

  const directKeys = ['url', 'image_url', 'download_url', 'display_url']
  for (const key of directKeys) {
    const url = assetUrl(entry[key])
    if (url) return [url]
  }

  const nestedKeys = ['display_image', 'owner_watermark_image', 'thumbnail']
  for (const key of nestedKeys) {
    const nested = entry[key]
    if (!isRecord(nested)) continue
    const urlList = nested.url_list
    if (Array.isArray(urlList)) {
      const urls = urlList.map(assetUrl).filter((url): url is string => Boolean(url))
      if (urls.length > 0) return urls.slice(0, 1)
    }
    const url = assetUrl(nested.url)
    if (url) return [url]
  }

  if (Array.isArray(entry.url_list)) {
    const urls = entry.url_list.map(assetUrl).filter((url): url is string => Boolean(url))
    if (urls.length > 0) return urls.slice(0, 1)
  }

  return []
}

function extractImageUrls(data: UnknownRecord): string[] {
  const imagePostInfo = isRecord(data.image_post_info) ? data.image_post_info : undefined
  const sources = [data.images, imagePostInfo?.images]
  const found: string[] = []

  for (const source of sources) {
    if (!Array.isArray(source)) continue
    for (const entry of source) found.push(...urlsFromImageEntry(entry))
  }

  return [...new Set(found)]
}

function extensionFromImageUrl(url: string): { extension: string; mimeType: string } {
  let pathname = ''
  try {
    pathname = new URL(url).pathname.toLowerCase()
  } catch {
    // La URL ya fue validada; este fallback solo conserva una extensión segura.
  }

  if (pathname.endsWith('.png')) return { extension: 'png', mimeType: 'image/png' }
  if (pathname.endsWith('.webp')) return { extension: 'webp', mimeType: 'image/webp' }
  if (pathname.endsWith('.gif')) return { extension: 'gif', mimeType: 'image/gif' }
  return { extension: 'jpg', mimeType: 'image/jpeg' }
}

function createVariant(
  id: string,
  label: string,
  url: string | undefined,
  quality: DownloadQuality,
  options: Pick<DownloadVariant, 'mediaType' | 'extension' | 'mimeType' | 'isBest'> & {
    sizeBytes?: number
    imageIndex?: number
    providerTier?: DownloadVariant['providerTier']
    probeUrl?: string
    requiresDirectDownload?: boolean
  },
): DownloadVariant | undefined {
  if (!url) return undefined
  return { id, label, url, quality, ...options }
}

function resolutionLabel(variant: DownloadVariant): string | undefined {
  if (!variant.width || !variant.height) return undefined
  return `${Math.min(variant.width, variant.height)}p`
}

function labelForVideoVariant(variant: DownloadVariant, isBest: boolean): string {
  const resolution = resolutionLabel(variant)
  if (isBest) return resolution ? `Máxima calidad · ${resolution}` : 'Máxima calidad disponible'
  if (variant.providerTier === 'source') {
    return resolution ? `Archivo fuente · ${resolution}` : 'Archivo fuente · Original'
  }
  if (variant.providerTier === 'hd') {
    return resolution ? `Alta resolución · ${resolution}` : 'Alta resolución del proveedor'
  }
  return resolution ? `Compatible · ${resolution}` : 'Calidad compatible'
}

function semanticVideoFingerprint(variant: DownloadVariant): string | undefined {
  if (
    !variant.sizeBytes
    || !variant.width
    || !variant.height
    || !variant.codec
    || !variant.fps
  ) return undefined
  return [
    variant.sizeBytes,
    variant.width,
    variant.height,
    variant.codec,
    Math.round(variant.fps * 100) / 100,
  ].join(':')
}

/** Marca como premium la variante de mayor resolución real y deduplica copias idénticas. */
export function rankVideoVariants(
  variants: DownloadVariant[],
  durationSeconds?: number,
): DownloadVariant[] {
  const ranked = variants
    .map((variant) => ({
      ...variant,
      bitrateBps: variant.bitrateBps ?? estimateBitrate(variant.sizeBytes, durationSeconds),
      isBest: false,
    }))
    .sort(compareVideoQuality)

  const seenUrls = new Set<string>()
  const seenFingerprints = new Set<string>()
  const unique = ranked.filter((variant) => {
    if (seenUrls.has(variant.url)) return false
    seenUrls.add(variant.url)
    const fingerprint = semanticVideoFingerprint(variant)
    if (!fingerprint) return true
    if (seenFingerprints.has(fingerprint)) return false
    seenFingerprints.add(fingerprint)
    return true
  })

  return unique.map((variant, index) => {
    const isBest = index === 0
    return {
      ...variant,
      quality: isBest ? 'best' : variant.providerTier === 'compatible' ? 'compatible' : 'original',
      isBest,
      label: labelForVideoVariant(variant, isBest),
    }
  })
}

function dedupeAndSortVariants(variants: Array<DownloadVariant | undefined>): DownloadVariant[] {
  const qualityRank: Record<DownloadQuality, number> = {
    best: 0,
    compatible: 1,
    original: 2,
    audio: 3,
  }
  const unique = new Map<string, DownloadVariant>()

  for (const variant of variants) {
    if (!variant) continue
    if (!unique.has(variant.url)) unique.set(variant.url, variant)
  }

  return [...unique.values()].sort((left, right) => {
    if (left.isBest !== right.isBest) return left.isBest ? -1 : 1
    const qualityDifference = qualityRank[left.quality] - qualityRank[right.quality]
    if (qualityDifference !== 0) return qualityDifference
    return (left.imageIndex ?? 0) - (right.imageIndex ?? 0)
  })
}

export function parseTikTokUrl(input: string): TikTokLinkInfo {
  const parsed = extractUrl(input)
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '')
  const officialDomain = hostname === 'tiktok.com' || hostname.endsWith('.tiktok.com')

  if (!officialDomain || parsed.username || parsed.password || parsed.port) {
    throw new LinksDownloaderError(
      'INVALID_URL',
      'El enlace no pertenece a un dominio oficial de TikTok.',
    )
  }

  const directMatch = parsed.pathname.match(/^\/@[^/]+\/(video|photo)\/(\d{5,})(?:\/|$)/i)
  const legacyMatch = parsed.pathname.match(/^\/v\/(\d{5,})(?:\.html)?(?:\/|$)/i)
  const embedMatch = parsed.pathname.match(/^\/(?:embed\/v2|player\/v1)\/(\d{5,})(?:\/|$)/i)
  const mainShortMatch = parsed.pathname.match(/^\/t\/([a-z0-9_-]{5,})(?:\/|$)/i)
  const shortHostMatch =
    hostname === 'vm.tiktok.com' || hostname === 'vt.tiktok.com'
      ? parsed.pathname.match(/^\/([a-z0-9_-]{5,})(?:\/|$)/i)
      : null

  let kind: TikTokLinkKind | undefined
  let mediaId: string | undefined
  if (directMatch) {
    kind = directMatch[1]?.toLowerCase() === 'photo' ? 'photo' : 'video'
    mediaId = directMatch[2]
  } else if (legacyMatch) {
    kind = 'video'
    mediaId = legacyMatch[1]
  } else if (embedMatch) {
    kind = 'embed'
    mediaId = embedMatch[1]
  } else if (mainShortMatch || shortHostMatch) {
    kind = 'short'
  }

  if (!kind) {
    throw new LinksDownloaderError(
      'INVALID_URL',
      'Usa el enlace de un video, foto o enlace corto compartido desde TikTok.',
    )
  }

  parsed.hash = ''
  return { url: parsed.toString(), kind, mediaId }
}

export function isTikTokUrl(input: string): boolean {
  try {
    parseTikTokUrl(input)
    return true
  } catch {
    return false
  }
}

/** Normaliza la respuesta externa a un contrato estable para toda la interfaz. */
export function normalizeTikWmResponse(payload: unknown, sourceUrl: string): ResolvedMedia {
  if (!isRecord(payload)) {
    throw new LinksDownloaderError('INVALID_RESPONSE', 'TikTok devolvió una respuesta no válida.')
  }

  const code = numberValue(payload.code)
  if (code !== undefined && code !== 0) {
    const upstreamMessage = stringValue(payload.msg, payload.message)
    throw new LinksDownloaderError(
      'UPSTREAM_ERROR',
      upstreamMessage || 'TikTok no pudo procesar ese enlace. Comprueba que sea público.',
    )
  }

  if (!isRecord(payload.data)) {
    throw new LinksDownloaderError(
      'INVALID_RESPONSE',
      'No se encontraron datos descargables en ese enlace.',
    )
  }

  const data = payload.data
  const rawAuthor = isRecord(data.author) ? data.author : {}
  const handle = (stringValue(rawAuthor.unique_id, rawAuthor.id, data.author_id) ?? 'tiktok').replace(
    /^@/,
    '',
  )
  const author: MediaAuthor = {
    name: stringValue(rawAuthor.nickname, rawAuthor.name, handle) ?? 'Creador de TikTok',
    handle,
    avatarUrl: assetUrl(
      stringValue(rawAuthor.avatar, rawAuthor.avatar_thumb, rawAuthor.avatar_medium),
    ),
  }

  const imageUrls = extractImageUrls(data)
  const isCarousel = imageUrls.length > 0
  const hdUrl = assetUrl(data.hdplay)
  const playUrl = assetUrl(data.play)
  const musicUrl = assetUrl(data.music)
  const variants: Array<DownloadVariant | undefined> = []
  const images: CarouselImage[] = []

  if (isCarousel) {
    imageUrls.forEach((url, zeroBasedIndex) => {
      const index = zeroBasedIndex + 1
      const id = `image-${index}`
      const imageFormat = extensionFromImageUrl(url)
      variants.push(
        createVariant(
          id,
          index === 1 ? 'Mejor calidad · Imagen 1' : `Imagen ${index}`,
          url,
          index === 1 ? 'best' : 'original',
          {
            mediaType: 'image',
            ...imageFormat,
            isBest: index === 1,
            imageIndex: index,
          },
        ),
      )
      images.push({ index, url, variantId: id })
    })
  } else {
    variants.push(
      createVariant('video-hd', 'Alta resolución del proveedor', hdUrl, 'best', {
        mediaType: 'video',
        extension: 'mp4',
        mimeType: 'video/mp4',
        isBest: true,
        sizeBytes: numberValue(data.hd_size),
        providerTier: 'hd',
      }),
    )
    variants.push(
      createVariant(
        'video-compatible',
        hdUrl ? 'Calidad compatible' : 'Mejor calidad disponible',
        playUrl,
        hdUrl ? 'compatible' : 'best',
        {
          mediaType: 'video',
          extension: 'mp4',
          mimeType: 'video/mp4',
          isBest: !hdUrl,
          sizeBytes: numberValue(data.size),
          providerTier: 'compatible',
        },
      ),
    )
  }

  variants.push(
    createVariant('audio', 'Solo audio · MP3', musicUrl, 'audio', {
      mediaType: 'audio',
      extension: 'mp3',
      mimeType: 'audio/mpeg',
      isBest: false,
      sizeBytes: isRecord(data.music_info) ? numberValue(data.music_info.size) : undefined,
    }),
  )

  const normalizedVariants = dedupeAndSortVariants(variants)
  if (normalizedVariants.length === 0) {
    throw new LinksDownloaderError(
      'INVALID_RESPONSE',
      'TikTok no entregó archivos descargables para este enlace.',
    )
  }

  const coverUrl = assetUrl(
    stringValue(data.cover, data.origin_cover, data.ai_dynamic_cover, imageUrls[0]),
  )
  return {
    provider: 'tiktok',
    sourceUrl,
    id: stringValue(data.id),
    title: stringValue(data.title) ?? `TikTok de @${handle}`,
    author,
    coverUrl,
    durationSeconds: isCarousel ? undefined : numberValue(data.duration),
    mediaType: isCarousel ? 'carousel' : 'video',
    variants: normalizedVariants,
    images,
  }
}

interface OriginalTaskState {
  status?: number
  taskId?: string
  variant?: DownloadVariant
}

function originalTaskState(payload: unknown): OriginalTaskState {
  if (!isRecord(payload) || numberValue(payload.code) !== 0 || !isRecord(payload.data)) return {}
  const data = payload.data
  const detail = isRecord(data.detail) ? data.detail : undefined
  const url = detail ? assetUrl(detail.download_url) : undefined
  const probeUrl = detail ? assetUrl(detail.play_url) : undefined
  return {
    status: numberValue(data.status),
    taskId: stringValue(data.task_id),
    variant: url
      ? createVariant('video-source', 'Archivo fuente · Original', url, 'original', {
          mediaType: 'video',
          extension: 'mp4',
          mimeType: 'video/mp4',
          isBest: false,
          sizeBytes: detail ? numberValue(detail.size) : undefined,
          providerTier: 'source',
          probeUrl,
          requiresDirectDownload: true,
        })
      : undefined,
  }
}

function waitForPoll(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ORIGINAL_POLL_INTERVAL_MS)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function requestOriginalVariant(
  sourceUrl: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<DownloadVariant | undefined> {
  const form = new FormData()
  form.append('url', sourceUrl)
  const submitResponse = await fetchImpl(TIKWM_ORIGINAL_SUBMIT_URL, {
    method: 'POST',
    body: form,
    headers: { Accept: 'application/json' },
    credentials: 'omit',
    signal,
  })
  if (!submitResponse.ok) return undefined

  const submitted = originalTaskState(await submitResponse.json())
  if (submitted.status === 2 && submitted.variant) return submitted.variant
  if (!submitted.taskId) return undefined

  const endpoint = new URL(TIKWM_ORIGINAL_RESULT_URL)
  endpoint.searchParams.set('task_id', submitted.taskId)
  for (let attempt = 0; attempt < ORIGINAL_POLL_ATTEMPTS; attempt += 1) {
    const resultResponse = await fetchImpl(endpoint, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      signal,
    })
    if (!resultResponse.ok) return undefined
    const state = originalTaskState(await resultResponse.json())
    if (state.status === 2) return state.variant
    if (state.status !== undefined && state.status > 2) return undefined
    if (attempt < ORIGINAL_POLL_ATTEMPTS - 1) await waitForPoll(signal)
  }
  return undefined
}

async function enrichVideoQuality(
  media: ResolvedMedia,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  originalVariant?: DownloadVariant,
  videoProbeImpl: NonNullable<ResolveOptions['videoProbeImpl']> = probeMp4Video,
): Promise<ResolvedMedia> {
  const videoVariants = media.variants.filter((variant) => variant.mediaType === 'video')
  if (originalVariant) videoVariants.push(originalVariant)
  const probeCache = new Map<string, ReturnType<typeof probeMp4Video>>()
  const enriched = await Promise.all(
    videoVariants.map(async (variant) => {
      let probe = probeCache.get(variant.url)
      if (!probe) {
        probe = videoProbeImpl(variant.probeUrl ?? variant.url, {
          fetchImpl,
          signal,
          preferMediaElement: variant.requiresDirectDownload,
        })
        probeCache.set(variant.url, probe)
      }
      const metadata = await probe
      return {
        ...variant,
        ...metadata,
        metadataVerified: Boolean(metadata?.width && metadata.height),
      }
    }),
  )
  const rankedVideos = rankVideoVariants(enriched, media.durationSeconds)
  const nonVideoVariants = media.variants.filter((variant) => variant.mediaType !== 'video')
  return { ...media, variants: [...rankedVideos, ...nonVideoVariants] }
}

export async function resolveTikTok(
  input: string,
  options: ResolveOptions = {},
): Promise<ResolvedMedia> {
  const link = parseTikTokUrl(input)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const requestSignal = createRequestSignal(options.signal, timeoutMs)
  const endpoint = new URL(TIKWM_API_URL)
  endpoint.searchParams.set('url', link.url)
  endpoint.searchParams.set('hd', '1')

  try {
    const response = await (options.fetchImpl ?? fetch)(endpoint, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: requestSignal.signal,
    })

    if (!response.ok) {
      throw new LinksDownloaderError(
        'UPSTREAM_ERROR',
        `El servicio de descarga respondió con el estado ${response.status}.`,
      )
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch (error) {
      throw new LinksDownloaderError(
        'INVALID_RESPONSE',
        'El servicio de descarga devolvió una respuesta ilegible.',
        { cause: error },
      )
    }

    const media = normalizeTikWmResponse(payload, link.url)
    if (media.mediaType !== 'video') return media

    let originalVariant: DownloadVariant | undefined
    try {
      originalVariant = await requestOriginalVariant(link.url, options.fetchImpl ?? fetch, requestSignal.signal)
    } catch {
      // El servicio de fuente es experimental: la variante HD normal sigue disponible.
    }

    if (options.signal?.aborted) {
      throw new LinksDownloaderError('ABORTED', 'La búsqueda fue cancelada.')
    }
    return enrichVideoQuality(
      media,
      options.fetchImpl ?? fetch,
      requestSignal.signal,
      originalVariant,
      options.videoProbeImpl,
    )
  } catch (error) {
    if (error instanceof LinksDownloaderError) throw error
    if (options.signal?.aborted) {
      throw new LinksDownloaderError('ABORTED', 'La búsqueda fue cancelada.', { cause: error })
    }
    if (requestSignal.didTimeout()) {
      throw new LinksDownloaderError(
        'TIMEOUT',
        'TikTok tardó demasiado en responder. Inténtalo de nuevo.',
        { cause: error },
      )
    }
    if (isAbortError(error)) {
      throw new LinksDownloaderError('ABORTED', 'La búsqueda fue cancelada.', { cause: error })
    }
    throw new LinksDownloaderError(
      'NETWORK_ERROR',
      'No se pudo conectar con el servicio de descarga.',
      { cause: error },
    )
  } finally {
    requestSignal.cleanup()
  }
}

export class TikTokProvider implements LinkProvider {
  readonly id = 'tiktok' as const
  readonly name = 'TikTok'

  matches(input: string): boolean {
    return isTikTokUrl(input)
  }

  resolve(input: string, options?: ResolveOptions): Promise<ResolvedMedia> {
    return resolveTikTok(input, options)
  }
}
