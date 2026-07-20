import { describe, expect, it, vi } from 'vitest'
import {
  getNextSpriteTheme,
  rotateStoredSpriteTheme,
  SPRITE_THEME_STORAGE_KEY,
} from './spriteTheme'

describe('sprite theme rotation', () => {
  it('cycles through every theme without repeating the previous one', () => {
    expect(getNextSpriteTheme(null)).toBe('knights')
    expect(getNextSpriteTheme('knights')).toBe('sonic')
    expect(getNextSpriteTheme('sonic')).toBe('shadow')
    expect(getNextSpriteTheme('shadow')).toBe('knights')
  })

  it('recovers from an unknown stored value', () => {
    expect(getNextSpriteTheme('unknown')).toBe('knights')
  })

  it('stores the theme selected for the current page load', () => {
    const storage = {
      getItem: vi.fn(() => 'knights'),
      setItem: vi.fn(),
    }

    expect(rotateStoredSpriteTheme(storage)).toBe('sonic')
    expect(storage.getItem).toHaveBeenCalledWith(SPRITE_THEME_STORAGE_KEY)
    expect(storage.setItem).toHaveBeenCalledWith(SPRITE_THEME_STORAGE_KEY, 'sonic')
  })
})
