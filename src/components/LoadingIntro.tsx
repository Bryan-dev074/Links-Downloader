import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from 'react'
import { useReducedMotion } from '../hooks/useReducedMotion'

export const INTRO_HOLD_MS = 1_800
export const INTRO_EXIT_MS = 440
const INTRO_ASSET_FALLBACK_MS = 650

interface LoadingIntroProps {
  onComplete: () => void
}

export function LoadingIntro({ onComplete }: LoadingIntroProps) {
  const reducedMotion = useReducedMotion()
  const [assetReady, setAssetReady] = useState(false)
  const [exiting, setExiting] = useState(false)
  const autoExitTimer = useRef<number | undefined>(undefined)
  const finishTimer = useRef<number | undefined>(undefined)
  const exitingRef = useRef(false)
  const completedRef = useRef(false)

  const finish = useCallback(() => {
    if (completedRef.current) return
    completedRef.current = true
    onComplete()
  }, [onComplete])

  const requestExit = useCallback(() => {
    if (exitingRef.current || completedRef.current) return
    exitingRef.current = true
    setExiting(true)
    window.clearTimeout(autoExitTimer.current)
    finishTimer.current = window.setTimeout(finish, INTRO_EXIT_MS)
  }, [finish])

  const handleShadowLoad = useCallback((event: SyntheticEvent<HTMLImageElement>) => {
    const image = event.currentTarget
    if (typeof image.decode !== 'function') {
      setAssetReady(true)
      return
    }
    void image.decode().catch(() => undefined).finally(() => setAssetReady(true))
  }, [])

  useEffect(() => {
    if (reducedMotion) {
      finish()
      return undefined
    }

    document.body.classList.add('intro-lock')
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') requestExit()
    }
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      document.body.classList.remove('intro-lock')
      window.removeEventListener('keydown', handleKeyDown)
      window.clearTimeout(autoExitTimer.current)
      window.clearTimeout(finishTimer.current)
    }
  }, [finish, reducedMotion, requestExit])

  useEffect(() => {
    if (reducedMotion || !assetReady || exitingRef.current) return undefined
    autoExitTimer.current = window.setTimeout(requestExit, INTRO_HOLD_MS)
    return () => window.clearTimeout(autoExitTimer.current)
  }, [assetReady, reducedMotion, requestExit])

  useEffect(() => {
    if (reducedMotion || assetReady) return undefined
    const fallback = window.setTimeout(() => setAssetReady(true), INTRO_ASSET_FALLBACK_MS)
    return () => window.clearTimeout(fallback)
  }, [assetReady, reducedMotion])

  if (reducedMotion) return null

  const shadowSrc = `${import.meta.env.BASE_URL}assets/shadow-loading.gif`
  const portalSrc = `${import.meta.env.BASE_URL}assets/brand-portal.gif`

  return (
    <section
      className={`loading-intro${assetReady ? ' is-ready' : ''}${exiting ? ' is-leaving' : ''}`}
      data-phase={exiting ? 'leaving' : assetReady ? 'running' : 'preparing'}
      aria-label="Entrada de Links Downloader"
    >
      <p className="sr-only" role="status">Cargando Links Downloader.</p>

      <div className="intro-world" aria-hidden="true">
        <span className="intro-starfield" />
        <span className="intro-horizon intro-horizon-far" />
        <span className="intro-horizon intro-horizon-near" />
        <span className="intro-speed-stream intro-speed-stream-a" />
        <span className="intro-speed-stream intro-speed-stream-b" />
        <span className="intro-grid" />
      </div>

      <div className="intro-copy" aria-hidden="true">
        <span className="intro-kicker">
          <i />
          Links Downloader // Ruta segura
          <i />
        </span>
        <p className="intro-title">
          {exiting ? 'Portal listo' : 'Abriendo el portal'}
          {!exiting ? (
            <span className="intro-title-dots">
              <i />
              <i />
              <i />
            </span>
          ) : null}
        </p>
        <p className="intro-subtitle">Preparando tu acceso a máxima calidad</p>
      </div>

      <div className="intro-runway" aria-hidden="true">
        <span className="intro-track-line" />
        <div className="intro-shadow-runner">
          <span className="intro-fire-trail" />
          <img
            className="intro-shadow-image"
            src={shadowSrc}
            alt=""
            width="200"
            height="200"
            decoding="async"
            fetchPriority="high"
            draggable="false"
            onLoad={handleShadowLoad}
            onError={() => setAssetReady(true)}
          />
        </div>
        <div className="intro-gate">
          <span className="intro-gate-ring" />
          <img className="intro-gate-image" src={portalSrc} alt="" width="64" height="64" draggable="false" />
        </div>
      </div>

      <div className="intro-route" aria-hidden="true">
        <div className="intro-route-labels">
          <span>Inicio</span>
          <span>{exiting ? 'Conectado' : 'Enlazando'}</span>
          <span>Portal</span>
        </div>
        <span className="intro-route-track">
          <i />
        </span>
      </div>

      <button
        className="intro-skip"
        type="button"
        onClick={requestExit}
        aria-label="Saltar animación de entrada"
      >
        <span>Entrar ahora</span>
        <i aria-hidden="true" />
      </button>
    </section>
  )
}
