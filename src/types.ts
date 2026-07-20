/** Identificador abierto para poder sumar proveedores sin cambiar el contrato. */
export type ProviderId = 'tiktok' | (string & {})

export type MediaType = 'video' | 'carousel'
export type DownloadMediaType = 'video' | 'audio' | 'image'
export type DownloadQuality = 'best' | 'compatible' | 'audio' | 'original'

export interface MediaAuthor {
  name: string
  handle: string
  avatarUrl?: string
}

export interface DownloadVariant {
  /** Identificador estable dentro de un resultado (por ejemplo, `video-hd`). */
  id: string
  label: string
  url: string
  mediaType: DownloadMediaType
  quality: DownloadQuality
  extension: string
  mimeType: string
  /** La opción que debe mostrarse primero y recibir el tratamiento visual premium. */
  isBest: boolean
  sizeBytes?: number
  imageIndex?: number
}

export interface CarouselImage {
  index: number
  url: string
  variantId: string
}

export interface ResolvedMedia {
  provider: ProviderId
  sourceUrl: string
  id?: string
  title: string
  author: MediaAuthor
  coverUrl?: string
  durationSeconds?: number
  mediaType: MediaType
  /** Siempre está deduplicado y ordenado con la mejor calidad primero. */
  variants: DownloadVariant[]
  /** Se completa cuando TikTok entrega un carrusel de fotos. */
  images: CarouselImage[]
}

export interface ResolveOptions {
  signal?: AbortSignal
  timeoutMs?: number
  /** Punto de inyección útil para tests y runtimes con un fetch propio. */
  fetchImpl?: typeof fetch
}

export interface LinkProvider {
  readonly id: ProviderId
  readonly name: string
  matches(input: string): boolean
  resolve(input: string, options?: ResolveOptions): Promise<ResolvedMedia>
}

export interface DownloadProgress {
  loadedBytes: number
  totalBytes?: number
  /** Es `undefined` cuando el servidor no informa Content-Length. */
  percent?: number
}

export interface DownloadOptions {
  filename?: string
  filenameBase?: string
  signal?: AbortSignal
  timeoutMs?: number
  onProgress?: (progress: DownloadProgress) => void
  fetchImpl?: typeof fetch
  /** Permite desactivar la apertura directa, por ejemplo en tests. */
  fallbackToDirect?: boolean
}

export interface DownloadResult {
  method: 'blob' | 'direct'
  filename: string
  bytes?: number
}
