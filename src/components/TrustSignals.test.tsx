import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TrustSignals } from './TrustSignals'

describe('garantías interactivas', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => root.render(<TrustSignals />))
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('muestra una garantía por defecto y permite cambiarla con controles reales', () => {
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('.trust-chip')]
    const detail = container.querySelector<HTMLElement>('#trust-detail')

    expect(buttons).toHaveLength(3)
    expect(buttons[0].getAttribute('aria-pressed')).toBe('true')
    expect(detail?.textContent).toContain('No necesitas crear una cuenta')

    act(() => buttons[1].click())

    expect(buttons[0].getAttribute('aria-pressed')).toBe('false')
    expect(buttons[1].getAttribute('aria-pressed')).toBe('true')
    expect(detail?.textContent).toContain('No almacenamos tu enlace')
  })
})
