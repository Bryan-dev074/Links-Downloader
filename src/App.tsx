import { useEffect, useRef, useState, type FormEvent } from 'react'
import { LinkForm } from './components/LinkForm'
import { ResultPanel } from './components/ResultPanel'
import { SiteHeader } from './components/SiteHeader'
import { SpriteStage, type StageState } from './components/SpriteStage'
import {
  buildDownloadFilename,
  downloadVariant,
  isSupportedLink,
  LinksDownloaderError,
  resolveLink,
} from './lib'
import type { DownloadVariant, ResolvedMedia } from './types'

interface ToastMessage {
  message: string
  tone: 'error' | 'success'
}

function messageForError(error: unknown): string {
  if (error instanceof LinksDownloaderError) {
    if (error.code === 'TIMEOUT') return 'La búsqueda tardó demasiado. Espera unos segundos e inténtalo otra vez.'
    if (error.code === 'NETWORK_ERROR') return 'El servicio no respondió. Comprueba tu conexión e inténtalo de nuevo.'
    if (error.code === 'ABORTED') return 'La búsqueda fue cancelada.'
    return error.message
  }
  return 'No pudimos completar la misión. Inténtalo de nuevo en unos segundos.'
}

export function App() {
  const [input, setInput] = useState('')
  const [media, setMedia] = useState<ResolvedMedia | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [toast, setToast] = useState<ToastMessage>()
  const [downloadProgress, setDownloadProgress] = useState<Record<string, number | null>>({})
  const activeRequest = useRef<AbortController | null>(null)

  useEffect(() => () => activeRequest.current?.abort(), [])

  useEffect(() => {
    if (!toast) return undefined
    const timer = window.setTimeout(() => setToast(undefined), 3400)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    if (!media) return undefined
    const frame = window.requestAnimationFrame(() => {
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      document.getElementById('result-title')?.scrollIntoView({
        behavior: reducedMotion ? 'auto' : 'smooth',
        block: 'start',
      })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [media])

  const hasSupportedInput = isSupportedLink(input)
  const stageState: StageState = loading
    ? 'loading'
    : error
      ? 'error'
      : media
        ? 'success'
        : hasSupportedInput
          ? 'ready'
          : 'idle'

  function handleInputChange(value: string) {
    setInput(value)
    setError(undefined)
    setMedia(null)
    setDownloadProgress({})
  }

  async function handlePaste() {
    try {
      const text = await navigator.clipboard.readText()
      if (!text.trim()) throw new Error('empty clipboard')
      handleInputChange(text.trim())
    } catch {
      setError('No pudimos leer el portapapeles. Mantén pulsado el campo y elige “Pegar”.')
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmedInput = input.trim()
    if (!trimmedInput) {
      setError('Pega un enlace de TikTok para continuar.')
      return
    }
    if (!isSupportedLink(trimmedInput)) {
      setError('Ese enlace no parece ser de un video de TikTok. Copia el enlace completo e inténtalo otra vez.')
      return
    }

    activeRequest.current?.abort()
    const controller = new AbortController()
    activeRequest.current = controller
    setLoading(true)
    setError(undefined)
    setMedia(null)
    setDownloadProgress({})

    try {
      const result = await resolveLink(trimmedInput, { signal: controller.signal, timeoutMs: 20_000 })
      setMedia(result)
    } catch (requestError) {
      if (!controller.signal.aborted) setError(messageForError(requestError))
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = null
        setLoading(false)
      }
    }
  }

  async function handleDownload(variant: DownloadVariant) {
    if (!media || Object.keys(downloadProgress).length > 0) return
    setToast(undefined)
    setDownloadProgress((current) => ({ ...current, [variant.id]: null }))

    try {
      const result = await downloadVariant(variant, {
        filename: buildDownloadFilename(media, variant),
        onProgress: ({ percent }) => {
          setDownloadProgress((current) => ({ ...current, [variant.id]: percent ?? null }))
        },
      })
      setToast({
        message: result.method === 'blob'
          ? 'Tu descarga comenzó.'
          : 'Abrimos el archivo directo para que puedas guardarlo.',
        tone: 'success',
      })
    } catch (downloadError) {
      setToast({ message: messageForError(downloadError), tone: 'error' })
    } finally {
      setDownloadProgress((current) => {
        const next = { ...current }
        delete next[variant.id]
        return next
      })
    }
  }

  return (
    <div className="app">
      <span className="ambient-rune" aria-hidden="true" />
      <span className="ambient-rune" aria-hidden="true" />
      <span className="ambient-rune" aria-hidden="true" />
      <SiteHeader />
      <main className="main-shell">
        <section className="quest-card" aria-labelledby="page-title">
          <SpriteStage state={stageState} compact={Boolean(media)} />
          <div className="hero-copy">
            <p className="eyebrow">Misión de descarga · TikTok</p>
            <h1 id="page-title" className="hero-title">Tu enlace. Su <span className="gold-word">mejor versión.</span></h1>
            <p className="hero-description">
              Pega un TikTok. Encontramos la mayor calidad disponible y la dejamos arriba, lista para descargar.
            </p>
          </div>
          <LinkForm
            input={input}
            loading={loading}
            error={error}
            onInputChange={handleInputChange}
            onPaste={handlePaste}
            onSubmit={handleSubmit}
          />
        </section>
        {media ? (
          <ResultPanel
            media={media}
            downloadProgress={downloadProgress}
            onDownload={handleDownload}
          />
        ) : null}
      </main>
      <footer className="site-footer">
        <strong>Links Downloader</strong> no está afiliado a TikTok. Solo procesa enlaces públicos y no almacena videos.
      </footer>
      {toast ? (
        <div
          className={`toast is-${toast.tone}`}
          role={toast.tone === 'error' ? 'alert' : 'status'}
          aria-live={toast.tone === 'error' ? 'assertive' : 'polite'}
        >
          {toast.message}
        </div>
      ) : null}
    </div>
  )
}
