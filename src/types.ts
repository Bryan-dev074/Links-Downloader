/** Identificador abierto para poder sumar proveedores sin cambiar el contrato. */
export type ProviderId = 'tiktok' | 'instagram' | (string & {})

export type MediaType = 'video' | 'image' | 'carousel'
export type DownloadMediaType = 'video' | 'audio' | 'image'
export type DownloadQuality = 'best' | 'compatible' | 'audio' | 'original'
export type VideoProviderTier = 'source' | 'hd' | 'compatible'

export interface RemuxSources {
  /** Archivo del que se copia la pista de imagen, sin decodificarla. */
  videoUrl: string
  /** Archivo del que se copia la mezcla de audio del video, no la pista musical separada. */
  audioUrl: string
  videoSizeBytes?: number
  audioSizeBytes?: number
}

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
  /** Posición del archivo dentro de un carrusel, aunque sea video o imagen. */
  itemIndex?: number
  imageIndex?: number
  /** Dimensiones reales leídas del contenedor MP4 cuando el CDN permite inspeccionarlo. */
  width?: number
  height?: number
  fps?: number
  codec?: string
  /** Metadatos de la pista de audio embebida en el mismo MP4. */
  hasAudio?: boolean
  audioCodec?: string
  audioProfile?: string
  audioBitrateBps?: number
  audioSampleRateHz?: number
  audioChannels?: number
  /** Duraciones declaradas por cada pista; permiten detectar archivos desincronizados. */
  videoDurationSeconds?: number
  audioDurationSeconds?: number
  avDurationDeltaSeconds?: number
  audioSyncIssue?: boolean
  /** Bitrate medio de la pista de imagen, separado del bitrate total del archivo. */
  videoBitrateBps?: number
  /** Bitrate medio total; se estima con tamaño/duración cuando el MP4 no lo declara. */
  bitrateBps?: number
  /** Origen de la variante para desempatar sin confundir “más pesado” con “mejor”. */
  providerTier?: VideoProviderTier
  /** `true` cuando las dimensiones fueron comprobadas leyendo el MP4. */
  metadataVerified?: boolean
  /** `true` cuando se inspeccionó la pista de audio del mismo MP4. */
  audioMetadataVerified?: boolean
  /** Combina dos tracks compatibles en el navegador sin volver a codificarlos. */
  remuxSources?: RemuxSources
  /** URL equivalente apta para leer metadatos; la descarga puede usar otra con Content-Disposition. */
  probeUrl?: string
  /** Algunos CDN fuente bloquean CORS y deben abrirse directamente desde el gesto del usuario. */
  requiresDirectDownload?: boolean
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
  /** Se completa cuando el proveedor entrega un carrusel de fotos. */
  images: CarouselImage[]
}

export interface ResolveOptions {
  signal?: AbortSignal
  timeoutMs?: number
  /** Punto de inyección útil para tests y runtimes con un fetch propio. */
  fetchImpl?: typeof fetch
  /** Punto de inyección para verificar metadatos MP4 sin acoplar los tests a la red. */
  videoProbeImpl?: (
    url: string,
    options: { fetchImpl?: typeof fetch; signal?: AbortSignal; preferMediaElement?: boolean },
  ) => Promise<Pick<
    DownloadVariant,
    | 'width'
    | 'height'
    | 'fps'
    | 'codec'
    | 'hasAudio'
    | 'audioCodec'
    | 'audioProfile'
    | 'audioBitrateBps'
    | 'audioSampleRateHz'
    | 'audioChannels'
    | 'videoDurationSeconds'
    | 'audioDurationSeconds'
    | 'avDurationDeltaSeconds'
    | 'audioSyncIssue'
    | 'videoBitrateBps'
  > | undefined>
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
  /** Umbral de memoria para Blob; al superarlo se usa la descarga directa. */
  maxBlobBytes?: number
}

export interface DownloadResult {
  method: 'blob' | 'direct'
  filename: string
  bytes?: number
}
