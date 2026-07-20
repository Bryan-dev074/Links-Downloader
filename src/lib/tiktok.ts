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

const TIKWM_API_URL = 'https://www.tikwm.com/api/'
const DEFAULT_TIMEOUT_MS = 18_000
const TIKWM_ASSET_BASE = 'https://www.tikwm.com'

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
  },
): DownloadVariant | undefined {
  if (!url) return undefined
  return { id, label, url, quality, ...options }
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
      createVariant('video-hd', 'Mejor calidad · HD', hdUrl, 'best', {
        mediaType: 'video',
        extension: 'mp4',
        mimeType: 'video/mp4',
        isBest: true,
        sizeBytes: numberValue(data.hd_size),
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

    return normalizeTikWmResponse(payload, link.url)
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
