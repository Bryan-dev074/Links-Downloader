import { useEffect, useState } from 'react'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

export function useReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(REDUCED_MOTION_QUERY).matches,
  )

  useEffect(() => {
    const mediaQuery = window.matchMedia(REDUCED_MOTION_QUERY)
    const updatePreference = () => setReducedMotion(mediaQuery.matches)
    mediaQuery.addEventListener('change', updatePreference)
    return () => mediaQuery.removeEventListener('change', updatePreference)
  }, [])

  return reducedMotion
}
