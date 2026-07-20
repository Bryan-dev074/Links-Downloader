import type {
  DownloadOptions,
  DownloadResult,
  DownloadVariant,
  ResolvedMedia,
} from '../types'
import { LinksDownloaderError } from './errors'
import { createRequestSignal } from './request'

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000
const MAX_FILENAME_BASE_LENGTH = 96
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

function normalizedExtension(extension: string): string {
  const cleaned = extension.toLowerCase().replace(/^\.+/, '').replace(/[^a-z0-9]/g, '')
  return cleaned || 'bin'
}

export function sanitizeFilename(value: string, fallback = 'links-downloader'): string {
  const cleaned = value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-+/g, '-')
    .replace(/^[ .-]+|[ .-]+$/g, '')
    .slice(0, MAX_FILENAME_BASE_LENGTH)
    .replace(/[ .-]+$/g, '')

  if (!cleaned || WINDOWS_RESERVED_NAME.test(cleaned)) return fallback
  return cleaned
}

function ensureExtension(filename: string, extension: string): string {
  const safeExtension = normalizedExtension(extension)
  const withoutUnsafePath = sanitizeFilename(filename)
  const currentExtension = withoutUnsafePath.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase()
  if (currentExtension === safeExtension) return withoutUnsafePath
  return `${withoutUnsafePath}.${safeExtension}`
}

export function buildDownloadFilename(
  media: Pick<ResolvedMedia, 'title' | 'author'>,
  variant: DownloadVariant,
): string {
  const authorSuffix = media.author.handle ? ` - @${media.author.handle}` : ''
  const imageSuffix = variant.imageIndex ? ` - imagen ${String(variant.imageIndex).padStart(2, '0')}` : ''
  const audioSuffix = variant.mediaType === 'audio' ? ' - audio' : ''
  return ensureExtension(`${media.title}${authorSuffix}${imageSuffix}${audioSuffix}`, variant.extension)
}

function filenameForVariant(variant: DownloadVariant, options: DownloadOptions): string {
  if (options.filename) return ensureExtension(options.filename, variant.extension)
  const suffix = variant.imageIndex ? `-imagen-${String(variant.imageIndex).padStart(2, '0')}` : ''
  const base = options.filenameBase ?? `tiktok-${variant.mediaType}`
  return ensureExtension(`${base}${suffix}`, variant.extension)
}

function validateDownloadUrl(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.toString()
  } catch {
    // Se convierte en un error de dominio debajo.
  }
  throw new LinksDownloaderError('DOWNLOAD_FAILED', 'La dirección del archivo no es válida.')
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new LinksDownloaderError(
      'DOWNLOAD_FAILED',
      'Este navegador no permite guardar el archivo automáticamente.',
    )
  }

  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = filename
  anchor.hidden = true
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  // Mobile browsers may need the Blob URL to remain alive until their native
  // download hand-off finishes.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000)
}

function openDirectUrl(url: string): void {
  if (typeof window === 'undefined') {
    throw new LinksDownloaderError(
      'DOWNLOAD_FAILED',
      'No se pudo abrir el enlace de descarga directa.',
    )
  }

  let openedWindow: Window | null = null
  try {
    openedWindow = window.open(url, '_blank', 'noopener,noreferrer')
  } catch {
    // Algunos navegadores bloquean window.open tras una operación asíncrona.
  }
  if (openedWindow) openedWindow.opener = null
  else if (typeof document !== 'undefined') {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.target = '_blank'
    anchor.rel = 'noopener noreferrer'
    anchor.hidden = true
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
  }
}

async function responseToBlob(
  response: Response,
  variant: DownloadVariant,
  options: DownloadOptions,
): Promise<{ blob: Blob; bytes: number }> {
  const contentLengthHeader = response.headers.get('content-length')
  const parsedTotal = contentLengthHeader ? Number(contentLengthHeader) : undefined
  const totalBytes = parsedTotal && Number.isFinite(parsedTotal) && parsedTotal > 0 ? parsedTotal : undefined
  const contentType = response.headers.get('content-type') || variant.mimeType

  options.onProgress?.({ loadedBytes: 0, totalBytes, percent: totalBytes ? 0 : undefined })

  if (!response.body) {
    const blob = await response.blob()
    options.onProgress?.({
      loadedBytes: blob.size,
      totalBytes: totalBytes ?? blob.size,
      percent: 100,
    })
    return { blob, bytes: blob.size }
  }

  const reader = response.body.getReader()
  const chunks: ArrayBuffer[] = []
  let loadedBytes = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    const ownedChunk = new Uint8Array(value.byteLength)
    ownedChunk.set(value)
    chunks.push(ownedChunk.buffer)
    loadedBytes += value.byteLength
    options.onProgress?.({
      loadedBytes,
      totalBytes,
      percent: totalBytes ? Math.min(100, (loadedBytes / totalBytes) * 100) : undefined,
    })
  }

  const blob = new Blob(chunks, { type: contentType })
  options.onProgress?.({
    loadedBytes,
    totalBytes: totalBytes ?? loadedBytes,
    percent: 100,
  })
  return { blob, bytes: loadedBytes }
}

/**
 * Descarga mediante fetch -> Blob para conservar el nombre del archivo. Si el CDN
 * bloquea CORS, abre la URL original como alternativa nativa del navegador.
 */
export async function downloadVariant(
  variant: DownloadVariant,
  options: DownloadOptions = {},
): Promise<DownloadResult> {
  const url = validateDownloadUrl(variant.url)
  const filename = filenameForVariant(variant, options)
  const fallbackToDirect = options.fallbackToDirect ?? true
  const requestSignal = createRequestSignal(
    options.signal,
    options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS,
  )

  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      signal: requestSignal.signal,
    })
    if (!response.ok) {
      throw new LinksDownloaderError(
        'DOWNLOAD_FAILED',
        `El archivo respondió con el estado ${response.status}.`,
      )
    }

    const { blob, bytes } = await responseToBlob(response, variant, options)
    triggerBlobDownload(blob, filename)
    return { method: 'blob', filename, bytes }
  } catch (error) {
    if (options.signal?.aborted) {
      throw new LinksDownloaderError('ABORTED', 'La descarga fue cancelada.', { cause: error })
    }

    if (!fallbackToDirect) {
      if (error instanceof LinksDownloaderError) throw error
      throw new LinksDownloaderError('DOWNLOAD_FAILED', 'No se pudo descargar el archivo.', {
        cause: error,
      })
    }

    openDirectUrl(url)
    return { method: 'direct', filename }
  } finally {
    requestSignal.cleanup()
  }
}

export function getBestVariant(media: Pick<ResolvedMedia, 'variants'>): DownloadVariant | undefined {
  return media.variants.find((variant) => variant.isBest) ?? media.variants[0]
}
