import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INTRO_EXIT_MS, INTRO_HOLD_MS, LoadingIntro } from './LoadingIntro'

function installMatchMedia(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

describe('pantalla de entrada', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    installMatchMedia(false)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.classList.remove('intro-lock')
    vi.useRealTimers()
  })

  it('reproduce Shadow y completa la secuencia automática una sola vez', () => {
    const onComplete = vi.fn()
    act(() => root.render(<LoadingIntro onComplete={onComplete} />))

    const intro = container.querySelector<HTMLElement>('.loading-intro')
    const shadow = container.querySelector<HTMLImageElement>('.intro-shadow-image')
    expect(shadow?.getAttribute('src')).toContain('assets/shadow-loading.gif')
    expect(intro?.textContent).toContain('Abriendo el portal')

    act(() => shadow?.dispatchEvent(new Event('load')))
    act(() => vi.advanceTimersByTime(INTRO_HOLD_MS))
    expect(intro?.classList.contains('is-leaving')).toBe(true)
    expect(intro?.textContent).toContain('Portal listo')

    act(() => vi.advanceTimersByTime(INTRO_EXIT_MS))
    expect(onComplete).toHaveBeenCalledTimes(1)
    act(() => vi.runAllTimers())
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('permite acelerar la entrada con el botón', () => {
    const onComplete = vi.fn()
    act(() => root.render(<LoadingIntro onComplete={onComplete} />))

    const button = container.querySelector<HTMLButtonElement>('.intro-skip')
    act(() => button?.click())
    expect(container.querySelector('.loading-intro')?.classList.contains('is-leaving')).toBe(true)

    act(() => vi.advanceTimersByTime(INTRO_EXIT_MS))
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('omite por completo la animación cuando se solicita reducir movimiento', () => {
    installMatchMedia(true)
    const onComplete = vi.fn()
    act(() => root.render(<LoadingIntro onComplete={onComplete} />))

    expect(container.querySelector('.loading-intro')).toBeNull()
    expect(container.querySelector('.intro-shadow-image')).toBeNull()
    expect(onComplete).toHaveBeenCalledTimes(1)
  })
})
