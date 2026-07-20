import { useState } from 'react'
import { PixelIcon, type PixelIconName } from './PixelIcon'

interface TrustSignal {
  detail: string
  icon: PixelIconName
  id: string
  label: string
}

const TRUST_SIGNALS: readonly TrustSignal[] = [
  {
    id: 'instant',
    icon: 'bolt',
    label: 'Sin registro',
    detail: 'Entra, pega y descarga. No necesitas crear una cuenta.',
  },
  {
    id: 'private',
    icon: 'shield',
    label: 'Privado',
    detail: 'No almacenamos tu enlace ni los archivos que descargas.',
  },
  {
    id: 'mobile',
    icon: 'mobile',
    label: 'Para móvil',
    detail: 'Controles grandes y descarga directa desde tu teléfono.',
  },
] as const

export function TrustSignals() {
  const [activeId, setActiveId] = useState(TRUST_SIGNALS[0].id)
  const activeSignal = TRUST_SIGNALS.find(({ id }) => id === activeId) ?? TRUST_SIGNALS[0]

  return (
    <section className="trust-console" aria-labelledby="trust-console-title">
      <div className="trust-console-head">
        <span className="trust-console-beacon" aria-hidden="true" />
        <span id="trust-console-title">Protección del portal</span>
        <span className="trust-console-state">Activo</span>
      </div>
      <div className="trust-tabs" role="group" aria-label="Ver garantías de la descarga">
        {TRUST_SIGNALS.map((signal) => (
          <button
            key={signal.id}
            className="trust-chip"
            type="button"
            aria-controls="trust-detail"
            aria-pressed={signal.id === activeSignal.id}
            onClick={() => setActiveId(signal.id)}
          >
            <span className="trust-chip-icon" aria-hidden="true">
              <PixelIcon name={signal.icon} />
            </span>
            <span>{signal.label}</span>
          </button>
        ))}
      </div>
      <div id="trust-detail" className="trust-detail" role="status" aria-live="polite" aria-atomic="true">
        <PixelIcon name={activeSignal.icon} className="trust-detail-icon" />
        <span>
          <strong>{activeSignal.label}</strong>
          <small>{activeSignal.detail}</small>
        </span>
      </div>
      <span className="trust-current" aria-hidden="true" />
    </section>
  )
}
