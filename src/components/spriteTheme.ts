export const SPRITE_THEMES = ['knights', 'sonic', 'shadow'] as const

export type SpriteTheme = (typeof SPRITE_THEMES)[number]

export const SPRITE_THEME_STORAGE_KEY = 'links-downloader:last-sprite-theme'

interface ThemeStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function getNextSpriteTheme(previousTheme: string | null): SpriteTheme {
  const previousIndex = SPRITE_THEMES.findIndex((theme) => theme === previousTheme)
  return SPRITE_THEMES[(previousIndex + 1) % SPRITE_THEMES.length]
}

export function rotateStoredSpriteTheme(storage: ThemeStorage): SpriteTheme {
  const nextTheme = getNextSpriteTheme(storage.getItem(SPRITE_THEME_STORAGE_KEY))
  storage.setItem(SPRITE_THEME_STORAGE_KEY, nextTheme)
  return nextTheme
}

export function selectPageSpriteTheme(): SpriteTheme {
  if (typeof window === 'undefined') return SPRITE_THEMES[0]

  try {
    return rotateStoredSpriteTheme(window.localStorage)
  } catch {
    return SPRITE_THEMES[0]
  }
}
