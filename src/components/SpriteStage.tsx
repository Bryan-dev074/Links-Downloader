import { useReducedMotion } from '../hooks/useReducedMotion'

export type StageState = 'error' | 'idle' | 'loading' | 'ready' | 'success'

interface SpriteStageProps {
  state: StageState
  compact?: boolean
}

const STATE_CONTENT: Record<StageState, { asset: string; label: string }> = {
  idle: { asset: 'idle', label: 'Esperando un enlace' },
  ready: { asset: 'ready', label: 'Enlace listo' },
  loading: { asset: 'loading', label: 'Buscando la mejor calidad' },
  success: { asset: 'success', label: 'Recompensa encontrada' },
  error: { asset: 'idle', label: 'La misión necesita otro enlace' },
}

export function SpriteStage({ state, compact = false }: SpriteStageProps) {
  const reducedMotion = useReducedMotion()
  const { asset, label } = STATE_CONTENT[state]
  const extension = reducedMotion ? 'png' : 'gif'
  const src = `${import.meta.env.BASE_URL}assets/${asset}.${extension}`

  return (
    <div className={`sprite-stage${compact ? ' is-compact' : ''}`}>
      <div className="sprite-portal" aria-hidden="true" />
      <img key={`${state}-${extension}`} className="sprite-image" src={src} alt="" />
      <span className={`sprite-status is-${state}`} role="status" aria-live="polite">
        <span className="sprite-status-dot" aria-hidden="true" />
        {label}
      </span>
    </div>
  )
}
