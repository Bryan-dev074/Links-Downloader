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

function iconForVariant(variant: DownloadVariant): PixelIconName {
  if (variant.mediaType === 'audio') return 'audio'
  if (variant.mediaType === 'image') return 'image'
  return 'video'
}

function variantMeta(variant: DownloadVariant): string {
  const detail = variant.mediaType === 'audio'
    ? 'Pista de audio'
    : variant.quality === 'compatible'
      ? 'Alta compatibilidad'
      : variant.label
  const parts = [detail]
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
  const bestProgress = downloadProgress[bestVariant.id]
  const bestDownloading = bestProgress !== undefined
  const bestPercent = typeof bestProgress === 'number' ? Math.round(bestProgress) : undefined

  return (
    <section className="result-section" aria-labelledby="result-title">
      <div className="result-heading-row">
        <div>
          <p className="section-kicker">Botín desbloqueado</p>
          <h2 id="result-title" className="result-heading">Video encontrado</h2>
        </div>
        <span className="found-badge">Disponible</span>
      </div>

      <div className="video-summary">
        <div className="cover-frame">
          {media.coverUrl ? (
            <img className="video-cover" src={media.coverUrl} alt="Portada del video" decoding="async" />
          ) : (
            <span className="cover-placeholder"><PixelIcon name="video" /></span>
          )}
          {duration ? <span className="duration-badge">{duration}</span> : null}
        </div>
        <div>
          <p className="video-author">@{media.author.handle}</p>
          <p className="video-title">{media.title}</p>
          <ul className="video-facts" aria-label="Detalles del contenido">
            <li>TikTok</li>
            <li>{media.mediaType === 'carousel' ? `${media.images.length} imágenes` : 'Video público'}</li>
            <li>{media.variants.length} {media.variants.length === 1 ? 'opción' : 'opciones'}</li>
          </ul>
        </div>
      </div>

      <p className="loot-label">Mejor calidad disponible</p>
      <div className="legendary-slot">
        <button
          className="legendary-button"
          type="button"
          onClick={() => onDownload(bestVariant)}
          disabled={bestDownloading}
          aria-label={`Descargar mejor calidad: ${bestVariant.label}`}
        >
          <span className="legendary-icon"><PixelIcon name="gem" /></span>
          <span className="loot-copy">
            <span className="loot-rarity">Mejor calidad</span>
            <span className="loot-title">
              {bestDownloading
                ? bestPercent === undefined ? 'Preparando descarga…' : `Descargando · ${bestPercent}%`
                : 'Descargar mejor calidad'}
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
                    disabled={downloading}
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
        <p className="slideshow-note">Los carruseles se descargan imagen por imagen para conservar su calidad.</p>
      ) : null}
      <p className="source-note">
        Descarga solo contenido propio o con permiso. Si el guardado automático no está disponible, abriremos el archivo directo.{' '}
        <a href={media.sourceUrl} target="_blank" rel="noreferrer">Ver original <span aria-hidden="true">↗</span></a>
      </p>
    </section>
  )
}
