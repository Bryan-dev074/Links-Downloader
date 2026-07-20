import type { DownloadVariant, ResolvedMedia } from '../types'
import { getBestVariant } from '../lib'
import { PixelIcon, type PixelIconName } from './PixelIcon'

interface ResultPanelProps {
  downloadProgress: Readonly<Record<string, number | null>>
  media: ResolvedMedia
  onDownload: (variant: DownloadVariant) => void | Promise<void>
}

function formatDuration(seconds?: number): string | undefined {
  if (seconds === undefined) return undefined
  const rounded = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(rounded / 60)
  const remainder = String(rounded % 60).padStart(2, '0')
  return `${minutes}:${remainder}`
}

function formatBytes(bytes?: number): string | undefined {
  if (!bytes || bytes <= 0) return undefined
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

function formatBitrate(bitsPerSecond?: number): string | undefined {
  if (!bitsPerSecond || bitsPerSecond <= 0) return undefined
  if (bitsPerSecond < 1_000_000) return `${Math.round(bitsPerSecond / 1000)} kbit/s`
  return `${(bitsPerSecond / 1_000_000).toFixed(2).replace(/0$/, '')} Mbit/s`
}

function formatSampleRate(hertz?: number): string | undefined {
  if (!hertz || hertz <= 0) return undefined
  const kilohertz = hertz / 1000
  return `${Number.isInteger(kilohertz) ? kilohertz : kilohertz.toFixed(1)} kHz`
}

function formatChannels(channels?: number): string | undefined {
  if (channels === 1) return 'mono'
  if (channels === 2) return 'estéreo'
  return channels && channels > 0 ? `${channels} canales` : undefined
}

function iconForVariant(variant: DownloadVariant): PixelIconName {
  if (variant.mediaType === 'audio') return 'audio'
  if (variant.mediaType === 'image') return 'image'
  return 'video'
}

function providerLabel(provider: ResolvedMedia['provider']): string {
  if (provider === 'tiktok') return 'TikTok'
  if (provider === 'instagram') return 'Instagram'
  return provider.charAt(0).toUpperCase() + provider.slice(1)
}

function variantMeta(variant: DownloadVariant): string {
  const parts: string[] = []
  if (variant.width && variant.height) parts.push(`${variant.width} × ${variant.height}`)
  if (variant.codec) parts.push(variant.codec)
  if (variant.fps && variant.fps >= 1) parts.push(`${Math.round(variant.fps)} FPS`)
  const videoBitrate = formatBitrate(variant.videoBitrateBps)
  const totalBitrate = formatBitrate(variant.bitrateBps)
  if (videoBitrate) parts.push(`video ${videoBitrate}`)
  else if (totalBitrate) parts.push(`total ~${totalBitrate}`)

  if (variant.mediaType === 'video') {
    if (variant.hasAudio === false) {
      parts.push('sin audio')
    } else if (variant.hasAudio) {
      parts.push(variant.audioProfile ?? variant.audioCodec ?? 'audio integrado')
      const audioBitrate = formatBitrate(variant.audioBitrateBps)
      if (audioBitrate) parts.push(`audio ${audioBitrate}`)
      const sampleRate = formatSampleRate(variant.audioSampleRateHz)
      if (sampleRate) parts.push(sampleRate)
      const channels = formatChannels(variant.audioChannels)
      if (channels) parts.push(channels)
      if (variant.audioSyncIssue) parts.push('desfase detectado')
    }
    if (variant.remuxSources) parts.push('pistas combinadas sin recodificar')
  }
  if (parts.length === 0) {
    parts.push(
      variant.mediaType === 'audio'
        ? 'Pista de audio'
        : variant.quality === 'compatible'
          ? 'Alta compatibilidad'
          : variant.label,
    )
  }
  parts.push(variant.extension.toUpperCase())
  const size = formatBytes(variant.sizeBytes)
  if (size) parts.push(size)
  return parts.join(' · ')
}

export function ResultPanel({ downloadProgress, media, onDownload }: ResultPanelProps) {
  const bestVariant = getBestVariant(media)
  if (!bestVariant) return null

  const otherVariants = media.variants.filter((variant) => variant.id !== bestVariant.id)
  const duration = formatDuration(media.durationSeconds)
  const anyDownloading = Object.keys(downloadProgress).length > 0
  const bestProgress = downloadProgress[bestVariant.id]
  const bestDownloading = bestProgress !== undefined
  const bestPercent = typeof bestProgress === 'number' ? Math.round(bestProgress) : undefined
  const videoVariants = media.variants.filter((variant) => variant.mediaType === 'video')
  const bestIsRemuxed = Boolean(bestVariant.remuxSources)
  const hasTechnicalComparison =
    videoVariants.length > 1 && videoVariants.every((variant) => variant.metadataVerified)
  const hasAudioComparison =
    media.mediaType === 'video'
    && videoVariants.length > 1
    && videoVariants.every((variant) => variant.audioMetadataVerified)
  const bestAudioVerified = Boolean(
    bestVariant.mediaType === 'video'
    && bestVariant.audioMetadataVerified
    && bestVariant.hasAudio
    && bestVariant.audioSyncIssue === false,
  )
  const maximumVideoPixels = Math.max(
    0,
    ...videoVariants.map((variant) => (variant.width ?? 0) * (variant.height ?? 0)),
  )
  const bestVideoPixels = (bestVariant.width ?? 0) * (bestVariant.height ?? 0)
  const audioWasPrioritized = Boolean(
    media.mediaType === 'video'
    && bestVariant.mediaType === 'video'
    && bestVideoPixels > 0
    && bestVideoPixels < maximumVideoPixels
    && videoVariants.some((variant) => {
      const pixels = (variant.width ?? 0) * (variant.height ?? 0)
      const minimumHealthyAudio = variant.audioChannels === 1 ? 32_000 : 48_000
      return pixels > bestVideoPixels && (
        variant.hasAudio === false
        || variant.audioSyncIssue === true
        || Boolean(
          variant.hasAudio
          && variant.audioBitrateBps
          && variant.audioBitrateBps < minimumHealthyAudio,
        )
      )
    })
  )
  const bestDimensionsVerified = Boolean(
    bestVariant.metadataVerified && bestVariant.width && bestVariant.height,
  )
  const bestDimensionsDeclared = Boolean(bestVariant.width && bestVariant.height)
  const provider = providerLabel(media.provider)
  const carouselItemCount = media.variants.filter((variant) => variant.mediaType !== 'audio').length

  return (
    <section className="result-section" aria-labelledby="result-title">
      <div className="result-heading-row">
        <div>
          <p className="section-kicker">Botín desbloqueado</p>
          <h2 id="result-title" className="result-heading">Contenido encontrado</h2>
        </div>
        <span className="found-badge">Disponible</span>
      </div>

      <div className="video-summary">
        <div className="cover-frame">
          {media.coverUrl ? (
            <img className="video-cover" src={media.coverUrl} alt="Portada del contenido" decoding="async" />
          ) : (
            <span className="cover-placeholder"><PixelIcon name="video" /></span>
          )}
          {duration ? <span className="duration-badge">{duration}</span> : null}
        </div>
        <div>
          <p className="video-author">@{media.author.handle}</p>
          <p className="video-title">{media.title}</p>
          <ul className="video-facts" aria-label="Detalles del contenido">
            <li>{provider}</li>
            <li>
              {media.mediaType === 'carousel'
                ? `${carouselItemCount} archivos`
                : media.mediaType === 'image'
                  ? 'Imagen pública'
                  : 'Video público'}
            </li>
            {bestAudioVerified ? <li>Audio verificado</li> : null}
            <li>{media.variants.length} {media.variants.length === 1 ? 'opción' : 'opciones'}</li>
          </ul>
        </div>
      </div>

      <p className="loot-label">
        {bestIsRemuxed
          ? 'Mejor video + mejor audio'
          : audioWasPrioritized && bestAudioVerified
          ? 'Mejor equilibrio audiovisual verificado'
          : audioWasPrioritized
            ? 'Protección de audio aplicada'
          : hasTechnicalComparison && hasAudioComparison
          ? 'Mejor calidad audiovisual verificada'
          : hasTechnicalComparison
            ? 'Mayor resolución verificada'
          : bestDimensionsVerified
            ? 'Resolución original verificada'
            : bestDimensionsDeclared
              ? 'Resolución original disponible'
              : 'Mejor variante disponible'}
      </p>
      <div className="legendary-slot">
        <button
          className="legendary-button"
          type="button"
          onClick={() => onDownload(bestVariant)}
          disabled={anyDownloading}
          aria-label={`Descargar mejor calidad: ${bestVariant.label}`}
        >
          <span className="legendary-icon"><PixelIcon name="gem" /></span>
          <span className="loot-copy">
            <span className="loot-rarity">
              {bestIsRemuxed
                ? 'Fusión audiovisual sin recodificar'
                : audioWasPrioritized && bestAudioVerified
                ? 'Audio verificado priorizado'
                : audioWasPrioritized
                  ? 'Audio muy comprimido evitado'
                : hasTechnicalComparison && hasAudioComparison
                ? 'Video y audio comparados'
                : hasTechnicalComparison
                  ? 'Comparación técnica de video'
                : bestDimensionsVerified
                  ? 'Calidad fuente verificada'
                  : bestDimensionsDeclared
                    ? 'Calidad fuente disponible'
                    : 'Mejor variante'}
            </span>
            <span className="loot-title">
              {bestDownloading
                ? bestPercent === undefined ? 'Preparando descarga…' : `Descargando · ${bestPercent}%`
                : 'Descargar máxima calidad'}
            </span>
            <span className="loot-spec">{variantMeta(bestVariant)}</span>
          </span>
          <span className="loot-arrow"><PixelIcon name="download" /></span>
          {bestDownloading ? (
            <progress
              className="download-progress"
              max={100}
              value={bestPercent}
              aria-label={bestPercent === undefined ? 'Preparando descarga' : `Descarga al ${bestPercent}%`}
            />
          ) : null}
        </button>
      </div>

      {otherVariants.length > 0 ? (
        <div className="other-variants">
          <h3 className="other-variants-title">Otras opciones</h3>
          <ul className="variant-list">
            {otherVariants.map((variant) => {
              const progress = downloadProgress[variant.id]
              const downloading = progress !== undefined
              return (
                <li className="variant-row" key={variant.id}>
                  <span className="variant-type-icon"><PixelIcon name={iconForVariant(variant)} /></span>
                  <span className="variant-copy">
                    <span className="variant-name">{variant.label}</span>
                    <span className="variant-meta">{variantMeta(variant)}</span>
                  </span>
                  <button
                    className="variant-download"
                    type="button"
                    onClick={() => onDownload(variant)}
                    disabled={anyDownloading}
                  >
                    {downloading && typeof progress === 'number' ? `${Math.round(progress)}%` : downloading ? 'Abriendo…' : 'Descargar'}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}

      {media.mediaType === 'carousel' ? (
        <p className="slideshow-note">Los carruseles se descargan archivo por archivo para conservar su calidad.</p>
      ) : null}
      <p className="source-note">
        Elegimos la mejor combinación disponible de imagen y audio sin recomprimir ni aumentar resolución artificialmente. Descarga solo contenido propio o con permiso.{' '}
        <a href={media.sourceUrl} target="_blank" rel="noreferrer">Ver publicación original <span aria-hidden="true">↗</span></a>
      </p>
    </section>
  )
}
