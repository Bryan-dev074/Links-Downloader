import type {
  CarouselImage,
  DownloadVariant,
  LinkProvider,
  MediaAuthor,
  ResolveOptions,
  ResolvedMedia,
} from '../types'
import { LinksDownloaderError, isAbortError } from './errors'
import { createRequestSignal } from './request'
import { extractUrl, optionalUrl } from './url'
import { estimateBitrate, probeMp4Video } from './video-quality'

const DEFAULT_TIMEOUT_MS = 30_000

type UnknownRecord = Record<string, unknown>

export type InstagramLinkKind = 'post' | 'reel' | 'tv'

export interface InstagramLinkInfo {
  url: string
  kind: InstagramLinkKind
  shortcode?: string
}

interface InstagramApiItem {
  id: string
  type: 'image' | 'video'
  url: string
  width?: number
  height?: number
  fps?: number
  codec?: string
  bitrateBps?: number
  sizeBytes?: number
  mimeType: string
  extension: string
  thumbnailUrl?: string
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function positiveNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function extensionForItem(type: 'image' | 'video', mimeType?: string): {
  extension: string
  mimeType: string
} {
  if (type === 'video') return { extension: 'mp4', mimeType: 'video/mp4' }
  if (mimeType === 'image/png') return { extension: 'png', mimeType }
  if (mimeType === 'image/webp') return { extension: 'webp', mimeType }
  return { extension: 'jpg', mimeType: 'image/jpeg' }
}

function parseApiItem(value: unknown, index: number): InstagramApiItem | undefined {
  if (!isRecord(value)) return undefined
  const rawType = stringValue(value.type, value.mediaType)?.toLowerCase()
  const type = rawType === 'video' ? 'video' : rawType === 'photo' || rawType === 'image' ? 'image' : undefined
  const url = optionalUrl(value.url)
  if (!type || !url || new URL(url).protocol !== 'https:') return undefined

  const declaredMime = stringValue(value.mimeType)
  const format = extensionForItem(type, declaredMime)
  return {
    id: stringValue(value.id) ?? `${type}-${index}`,
    type,
    url,
    width: positiveNumber(value.width),
    height: positiveNumber(value.height),
    fps: positiveNumber(value.fps),
    codec: stringValue(value.codec),
    bitrateBps: positiveNumber(value.bitrateBps),
    sizeBytes: positiveNumber(value.sizeBytes),
    thumbnailUrl: optionalUrl(value.thumbnailUrl, url),
    extension: stringValue(value.extension) ?? format.extension,
    mimeType: declaredMime ?? format.mimeType,
  }
}

export function parseInstagramUrl(input: string): InstagramLinkInfo {
  const parsed = extractUrl(input)
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '')
  const officialDomain = new Set([
    'instagram.com',
    'www.instagram.com',
    'm.instagram.com',
    'instagr.am',
    'www.instagr.am',
  ]).has(hostname)

  if (!officialDomain || parsed.username || parsed.password || parsed.port) {
    throw new LinksDownloaderError(
      'INVALID_URL',
      'El enlace no pertenece a un dominio oficial de Instagram.',
    )
  }

  const canonical = parsed.pathname.match(/^\/(p|reel|tv)\/([a-z0-9_-]{5,})(?:\/|$)/i)
  if (!canonical) {
    throw new LinksDownloaderError(
      'INVALID_URL',
      'Usa el enlace de una publicación o Reel público de Instagram.',
    )
  }

  const rawKind = canonical[1]?.toLowerCase()
  const kind: InstagramLinkKind = rawKind === 'reel'
    ? 'reel'
    : rawKind === 'tv'
      ? 'tv'
      : 'post'

  parsed.protocol = 'https:'
  parsed.hostname = 'www.instagram.com'
  parsed.pathname = `/${rawKind}/${canonical[2]}/`
  parsed.search = ''
  parsed.hash = ''
  return {
    url: parsed.toString(),
    kind,
    shortcode: canonical[2],
  }
}

export function isInstagramUrl(input: string): boolean {
  try {
    parseInstagramUrl(input)
    return true
  } catch {
    return false
  }
}

export function normalizeInstagramResponse(
  payload: unknown,
  sourceUrl: string,
  fallbackId?: string,
): ResolvedMedia {
  if (!isRecord(payload)) {
    throw new LinksDownloaderError('INVALID_RESPONSE', 'Instagram devolvió una respuesta no válida.')
  }

  const error = isRecord(payload.error) ? payload.error : undefined
  if (error) {
    throw new LinksDownloaderError(
      'UPSTREAM_ERROR',
      stringValue(error.message) ?? 'Instagram no pudo procesar esa publicación.',
    )
  }

  const rawData = isRecord(payload.data) ? payload.data : payload
  if (!Array.isArray(rawData.items)) {
    throw new LinksDownloaderError(
      'INVALID_RESPONSE',
      'No se encontraron archivos descargables en esa publicación de Instagram.',
    )
  }

  const items = rawData.items
    .map((item, index) => parseApiItem(item, index + 1))
    .filter((item): item is InstagramApiItem => Boolean(item))
  if (items.length === 0) {
    throw new LinksDownloaderError(
      'INVALID_RESPONSE',
      'Instagram no entregó archivos descargables para ese enlace.',
    )
  }

  const rawAuthor = isRecord(rawData.author) ? rawData.author : {}
  const handle = (stringValue(rawAuthor.handle, rawAuthor.username) ?? 'instagram').replace(/^@/, '')
  const author: MediaAuthor = {
    name: stringValue(rawAuthor.name, rawAuthor.fullName) ?? handle,
    handle,
    avatarUrl: optionalUrl(rawAuthor.avatarUrl),
  }
  const isCarousel = items.length > 1
  const durationSeconds = positiveNumber(rawData.durationSeconds)
  const variants: DownloadVariant[] = items.map((item, zeroBasedIndex) => {
    const index = zeroBasedIndex + 1
    const isBest = zeroBasedIndex === 0
    const resolution = item.width && item.height ? ` · ${item.width} × ${item.height}` : ''
    const itemLabel = item.type === 'video' ? 'Video' : 'Imagen'
    return {
      id: item.id,
      label: isCarousel
        ? `${itemLabel} ${index} · calidad original${resolution}`
        : `Máxima calidad disponible${resolution}`,
      url: item.url,
      mediaType: item.type,
      quality: isBest ? 'best' : 'original',
      extension: item.extension,
      mimeType: item.mimeType,
      isBest,
      sizeBytes: item.sizeBytes,
      itemIndex: isCarousel ? index : undefined,
      imageIndex: isCarousel && item.type === 'image' ? index : undefined,
      width: item.width,
      height: item.height,
      fps: item.fps,
      codec: item.codec,
      bitrateBps: item.type === 'video'
        ? item.bitrateBps ?? estimateBitrate(item.sizeBytes, durationSeconds)
        : undefined,
      providerTier: 'source',
      // En este punto las dimensiones son declaradas por el proveedor. Los videos
      // se marcan como verificados únicamente después de inspeccionar su MP4 real.
      metadataVerified: false,
    }
  })
  const images: CarouselImage[] = items.flatMap((item, index) =>
    item.type === 'image'
      ? [{ index: index + 1, url: item.url, variantId: item.id }]
      : [],
  )
  const coverUrl = optionalUrl(
    stringValue(rawData.coverUrl, rawData.thumbnail, items[0]?.thumbnailUrl),
  )
  const caption = stringValue(rawData.title, rawData.caption)

  return {
    provider: 'instagram',
    sourceUrl,
    id: stringValue(rawData.id) ?? fallbackId,
    title: caption ?? `Instagram de @${handle}`,
    author,
    coverUrl,
    durationSeconds,
    mediaType: isCarousel ? 'carousel' : items[0]?.type === 'image' ? 'image' : 'video',
    variants,
    images,
  }
}

async function verifyInstagramVideos(
  media: ResolvedMedia,
  options: ResolveOptions,
  signal: AbortSignal,
): Promise<ResolvedMedia> {
  const probe = options.videoProbeImpl ?? probeMp4Video
  const verifiedVideos = new Map<string, DownloadVariant>()
  await Promise.all(media.variants.map(async (variant) => {
    if (variant.mediaType !== 'video') return
    try {
      const metadata = await probe(variant.url, {
        fetchImpl: options.fetchImpl,
        signal,
        preferMediaElement: false,
      })
      verifiedVideos.set(variant.id, {
        ...variant,
        ...(metadata ?? {}),
        metadataVerified: Boolean(metadata?.width && metadata.height),
        audioMetadataVerified: metadata?.hasAudio === false || Boolean(
          metadata?.hasAudio
          && metadata.audioCodec
          && metadata.audioBitrateBps
          && metadata.audioSampleRateHz
          && metadata.audioChannels
          && typeof metadata.audioSyncIssue === 'boolean',
        ),
      })
    } catch {
      verifiedVideos.set(variant.id, {
        ...variant,
        metadataVerified: false,
        audioMetadataVerified: false,
      })
    }
  }))
  if (signal.aborted) throw signal.reason

  return {
    ...media,
    variants: media.variants.map((variant) => verifiedVideos.get(variant.id) ?? variant),
  }
}

function instagramApiEndpoint(sourceUrl: string): URL {
  const origin = typeof window !== 'undefined' && window.location.origin !== 'null'
    ? window.location.origin
    : 'http://localhost'
  const endpoint = new URL('/api/instagram', origin)
  endpoint.searchParams.set('url', sourceUrl)
  return endpoint
}

export async function resolveInstagram(
  input: string,
  options: ResolveOptions = {},
): Promise<ResolvedMedia> {
  const link = parseInstagramUrl(input)
  const requestSignal = createRequestSignal(options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  try {
    const response = await (options.fetchImpl ?? fetch)(instagramApiEndpoint(link.url), {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: requestSignal.signal,
    })
    let payload: unknown
    try {
      payload = await response.json()
    } catch (error) {
      throw new LinksDownloaderError(
        'INVALID_RESPONSE',
        'El servicio de Instagram devolvió una respuesta ilegible.',
        { cause: error },
      )
    }
    if (!response.ok) {
      const apiError = isRecord(payload) && isRecord(payload.error)
        ? stringValue(payload.error.message)
        : undefined
      throw new LinksDownloaderError(
        'UPSTREAM_ERROR',
        apiError ?? `Instagram respondió con el estado ${response.status}.`,
      )
    }
    const media = normalizeInstagramResponse(payload, link.url, link.shortcode)
    return verifyInstagramVideos(media, options, requestSignal.signal)
  } catch (error) {
    if (error instanceof LinksDownloaderError) throw error
    if (options.signal?.aborted) {
      throw new LinksDownloaderError('ABORTED', 'La búsqueda fue cancelada.', { cause: error })
    }
    if (requestSignal.didTimeout()) {
      throw new LinksDownloaderError(
        'TIMEOUT',
        'Instagram tardó demasiado en responder. Inténtalo de nuevo.',
        { cause: error },
      )
    }
    if (isAbortError(error)) {
      throw new LinksDownloaderError('ABORTED', 'La búsqueda fue cancelada.', { cause: error })
    }
    throw new LinksDownloaderError(
      'NETWORK_ERROR',
      'No se pudo conectar con el servicio de Instagram.',
      { cause: error },
    )
  } finally {
    requestSignal.cleanup()
  }
}

export class InstagramProvider implements LinkProvider {
  readonly id = 'instagram' as const
  readonly name = 'Instagram'

  matches(input: string): boolean {
    return isInstagramUrl(input)
  }

  resolve(input: string, options?: ResolveOptions): Promise<ResolvedMedia> {
    return resolveInstagram(input, options)
  }
}
