import { describe, expect, it } from 'vitest'
import type { LinkProvider, ResolvedMedia } from '../types'
import { ProviderRegistry } from './provider'

function provider(id: 'tiktok' | 'instagram', marker: string): LinkProvider {
  return {
    id,
    name: id === 'tiktok' ? 'TikTok' : 'Instagram',
    matches: (input) => input.includes(marker),
    resolve: async (input): Promise<ResolvedMedia> => ({
      provider: id,
      sourceUrl: input,
      title: 'Contenido de prueba',
      author: { name: 'Hero', handle: 'hero' },
      mediaType: 'video',
      variants: [],
      images: [],
    }),
  }
}

describe('registro de proveedores', () => {
  it('encuentra y resuelve TikTok e Instagram con el mismo contrato', async () => {
    const registry = new ProviderRegistry([
      provider('tiktok', 'tiktok.com'),
      provider('instagram', 'instagram.com'),
    ])

    expect(registry.supports('https://www.tiktok.com/video/1')).toBe(true)
    expect(registry.supports('https://www.instagram.com/reel/ABC/')).toBe(true)
    await expect(registry.resolve('https://www.instagram.com/reel/ABC/')).resolves.toMatchObject({
      provider: 'instagram',
    })
  })

  it('explica el soporte de ambas plataformas cuando ninguna coincide', async () => {
    const registry = new ProviderRegistry()

    await expect(registry.resolve('https://example.com/video')).rejects.toMatchObject({
      code: 'UNSUPPORTED_PROVIDER',
      message: expect.stringMatching(/TikTok e Instagram/),
    })
  })
})
