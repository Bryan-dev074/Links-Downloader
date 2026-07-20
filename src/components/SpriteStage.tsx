import { useReducedMotion } from '../hooks/useReducedMotion'
import { selectPageSpriteTheme, type SpriteTheme } from './spriteTheme'

export type StageState = 'error' | 'idle' | 'loading' | 'ready' | 'success'

interface SpriteStageProps {
  state: StageState
  compact?: boolean
}

const STATE_LABELS: Record<StageState, string> = {
  idle: 'Esperando un enlace',
  ready: 'Enlace listo',
  loading: 'Buscando la mejor calidad',
  success: 'Recompensa encontrada',
  error: 'La misión necesita otro enlace',
}

const THEME_ASSETS: Record<SpriteTheme, Record<StageState, string>> = {
  knights: {
    idle: 'idle',
    ready: 'ready',
    loading: 'loading',
    success: 'success',
    error: 'idle',
  },
  sonic: {
    idle: 'sonic-idle',
    ready: 'sonic-success',
    loading: 'sonic-loading',
    success: 'sonic-success',
    error: 'sonic-idle',
  },
  shadow: {
    idle: 'shadow-idle',
    ready: 'shadow-success',
    loading: 'shadow-loading',
    success: 'shadow-success',
    error: 'shadow-idle',
  },
}

// Module evaluation happens once per full page load, including under React StrictMode.
// That keeps one coherent character family through every UI state on this page.
const PAGE_SPRITE_THEME = selectPageSpriteTheme()

export function SpriteStage({ state, compact = false }: SpriteStageProps) {
  const reducedMotion = useReducedMotion()
  const asset = THEME_ASSETS[PAGE_SPRITE_THEME][state]
  const label = STATE_LABELS[state]
  const extension = reducedMotion ? 'png' : 'gif'
  const src = `${import.meta.env.BASE_URL}assets/${asset}.${extension}`

  return (
    <div className={`sprite-stage${compact ? ' is-compact' : ''}`} data-sprite-theme={PAGE_SPRITE_THEME}>
      <div className="sprite-portal" aria-hidden="true" />
      <img key={`${PAGE_SPRITE_THEME}-${state}-${extension}`} className="sprite-image" src={src} alt="" />
      <span className={`sprite-status is-${state}`} role="status" aria-live="polite">
        <span className="sprite-status-dot" aria-hidden="true" />
        {label}
      </span>
    </div>
  )
}
