import { describe, expect, it, vi } from 'vitest'
import {
  isInstagramUrl,
  normalizeInstagramResponse,
  parseInstagramUrl,
  resolveInstagram,
} from './instagram'

const VIDEO_PAYLOAD = {
  data: {
    id: 'DFQe23tOWKz',
    caption: 'Una misión veloz',
    author: { name: 'Hero Pixel', handle: 'hero.pixel' },
    coverUrl: 'https://scontent.cdninstagram.com/cover.jpg',
    items: [
      {
        id: 'video-1',
        type: 'video',
        url: 'https://scontent.cdninstagram.com/source.mp4',
        width: 720,
        height: 1280,
        sizeBytes: 4_160_000,
        mimeType: 'video/mp4',
        extension: 'mp4',
      },
    ],
  },
}

describe('validación de enlaces Instagram', () => {
  it.each([
    'https://www.instagram.com/reel/DFQe23tOWKz/',
    'https://instagram.com/p/CvYrSgnsKjv/?igsh=abc',
    'https://instagr.am/tv/AbCdEf123/',
  ])('acepta publicación oficial: %s', (url) => {
    expect(isInstagramUrl(url)).toBe(true)
  })

  it('extrae una URL desde el texto compartido', () => {
    const parsed = parseInstagramUrl(
      'Mira esto https://www.instagram.com/reel/DFQe23tOWKz/?igsh=abc',
    )
    expect(parsed).toMatchObject({
      url: 'https://www.instagram.com/reel/DFQe23tOWKz/',
      kind: 'reel',
      shortcode: 'DFQe23tOWKz',
    })
  })

  it.each([
    'https://instagram.com.evil.example/reel/DFQe23tOWKz/',
    'https://www.instagram.com/hero.pixel/',
    'https://www.instagram.com/stories/hero/123/',
    'https://www.instagram.com/share/reel/BAg5TestToken/',
    'javascript:alert(1)',
  ])('rechaza URL no descargable: %s', (url) => {
    expect(isInstagramUrl(url)).toBe(false)
  })
})

describe('normalización de Instagram', () => {
  it('conserva el archivo fuente y sus dimensiones reales', () => {
    const media = normalizeInstagramResponse(
      VIDEO_PAYLOAD,
      'https://www.instagram.com/reel/DFQe23tOWKz/',
    )
    expect(media).toMatchObject({
      provider: 'instagram',
      id: 'DFQe23tOWKz',
      title: 'Una misión veloz',
      mediaType: 'video',
      author: { name: 'Hero Pixel', handle: 'hero.pixel' },
    })
    expect(media.variants[0]).toMatchObject({
      isBest: true,
      mediaType: 'video',
      width: 720,
      height: 1280,
      sizeBytes: 4_160_000,
      metadataVerified: false,
    })
  })

  it('expone un carrusel mixto en el orden original', () => {
    const media = normalizeInstagramResponse(
      {
        data: {
          items: [
            { id: 'photo-1', type: 'photo', url: 'https://cdn.example/one.jpg', width: 1080, height: 1350 },
            { id: 'video-2', type: 'video', url: 'https://cdn.example/two.mp4', width: 720, height: 1280 },
          ],
        },
      },
      'https://www.instagram.com/p/CvYrSgnsKjv/',
    )
    expect(media.mediaType).toBe('carousel')
    expect(media.variants.map(({ mediaType }) => mediaType)).toEqual(['image', 'video'])
    expect(media.variants[1]).toMatchObject({ itemIndex: 2, imageIndex: undefined })
    expect(media.images).toEqual([
      { index: 1, url: 'https://cdn.example/one.jpg', variantId: 'photo-1' },
    ])
  })
})

describe('cliente Instagram de Vercel', () => {
  it('consulta la función propia y normaliza su respuesta', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(VIDEO_PAYLOAD), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const source = 'https://www.instagram.com/reel/DFQe23tOWKz/'

    const media = await resolveInstagram(source, {
      fetchImpl: fetchMock,
      videoProbeImpl: async () => ({ width: 720, height: 1280, fps: 30, codec: 'H.264' }),
    })

    const endpoint = new URL(String(fetchMock.mock.calls[0]?.[0]))
    expect(endpoint.pathname).toBe('/api/instagram')
    expect(endpoint.searchParams.get('url')).toBe(source)
    expect(media.provider).toBe('instagram')
  })

  it('muestra el error estable de la función', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'La publicación es privada.' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    )

    await expect(
      resolveInstagram('https://www.instagram.com/p/CvYrSgnsKjv/', {
        fetchImpl: fetchMock,
        videoProbeImpl: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_ERROR', message: 'La publicación es privada.' })
  })
})
