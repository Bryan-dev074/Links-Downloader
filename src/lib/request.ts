export interface RequestSignal {
  signal: AbortSignal
  didTimeout: () => boolean
  cleanup: () => void
}

/** Combina cancelación del usuario y timeout sin depender de AbortSignal.any(). */
export function createRequestSignal(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): RequestSignal {
  const controller = new AbortController()
  let timedOut = false

  const abortFromExternal = () => controller.abort(externalSignal?.reason)
  if (externalSignal?.aborted) abortFromExternal()
  else externalSignal?.addEventListener('abort', abortFromExternal, { once: true })

  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new DOMException('La solicitud agotó el tiempo de espera.', 'TimeoutError'))
  }, Math.max(0, timeoutMs))

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timer)
      externalSignal?.removeEventListener('abort', abortFromExternal)
    },
  }
}
