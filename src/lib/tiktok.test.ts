import { describe, expect, it, vi } from 'vitest'
import { LinksDownloaderError } from './errors'
import {
  isTikTokUrl,
  normalizeTikWmResponse,
  parseTikTokUrl,
  resolveTikTok,
} from './tiktok'

const TIKWM_VIDEO_FIXTURE = {
  code: 0,
  msg: 'success',
  data: {
    id: '7361234567890123456',
    title: 'Una aventura pixel',
    duration: 23,
    cover: 'https://cdn.example/cover.webp',
    hdplay: 'https://cdn.example/video-hd.mp4',
    hd_size: 8_000,
    play: 'https://cdn.example/video.mp4',
    size: 5_000,
    music: 'https://cdn.example/audio.mp3',
    author: {
      unique_id: 'hero_pixel',
      nickname: 'Hero Pixel',
      avatar: 'https://cdn.example/avatar.jpeg',
    },
  },
}

const TIKWM_CAROUSEL_FIXTURE = {
  code: 0,
  data: {
    id: '7369999999999999999',
    title: 'Carrusel RPG',
    images: [
      'https://cdn.example/image-1.webp',
      'https://cdn.example/image-2.jpeg',
      'https://cdn.example/image-1.webp',
    ],
    music: 'https://cdn.example/carousel-audio.mp3',
    author: { unique_id: '@mage', nickname: 'Mage' },
  },
}

describe('validación de enlaces TikTok', () => {
  it.each([
    'https://www.tiktok.com/@hero/video/7361234567890123456',
    'https://m.tiktok.com/@hero/photo/7361234567890123456?lang=es',
    'https://vm.tiktok.com/ZM123abcD/',
    'https://www.tiktok.com/t/ZM123abcD/',
  ])('acepta URL oficial: %s', (url) => {
    expect(isTikTokUrl(url)).toBe(true)
  })

  it('extrae un enlace desde el texto copiado al compartir', () => {
    const parsed = parseTikTokUrl(
      'Mira este video: https://www.tiktok.com/@hero/video/7361234567890123456 ¡increíble!',
    )
    expect(parsed.kind).toBe('video')
    expect(parsed.mediaId).toBe('7361234567890123456')
  })

  it.each([
    'https://tiktok.com.evil.example/@hero/video/7361234567890123456',
    'https://www.tiktok.com/@hero',
    'https://example.com/video/7361234567890123456',
    'javascript:alert(1)',
  ])('rechaza URL no descargable: %s', (url) => {
    expect(isTikTokUrl(url)).toBe(false)
  })
})

describe('normalización de TikWM', () => {
  it('pone HD arriba y normaliza metadatos y alternativas', () => {
    const media = normalizeTikWmResponse(
      TIKWM_VIDEO_FIXTURE,
      'https://www.tiktok.com/@hero/video/7361234567890123456',
    )

    expect(media).toMatchObject({
      provider: 'tiktok',
      id: '7361234567890123456',
      title: 'Una aventura pixel',
      durationSeconds: 23,
      mediaType: 'video',
      author: { name: 'Hero Pixel', handle: 'hero_pixel' },
    })
    expect(media.variants.map(({ id }) => id)).toEqual([
      'video-hd',
      'video-compatible',
      'audio',
    ])
    expect(media.variants[0]).toMatchObject({ quality: 'best', isBest: true })
  })

  it('deduplica URLs conservando la variante de mayor calidad', () => {
    const fixture = structuredClone(TIKWM_VIDEO_FIXTURE)
    fixture.data.play = fixture.data.hdplay
    const media = normalizeTikWmResponse(fixture, 'https://vm.tiktok.com/ZM123abcD/')

    expect(media.variants.map(({ id }) => id)).toEqual(['video-hd', 'audio'])
  })

  it('expone cada imagen de un carrusel sin duplicados', () => {
    const media = normalizeTikWmResponse(
      TIKWM_CAROUSEL_FIXTURE,
      'https://www.tiktok.com/@mage/photo/7369999999999999999',
    )

    expect(media.mediaType).toBe('carousel')
    expect(media.images).toHaveLength(2)
    expect(media.variants.map(({ id }) => id)).toEqual(['image-1', 'image-2', 'audio'])
    expect(media.variants[0]).toMatchObject({ mediaType: 'image', isBest: true })
  })

  it('convierte errores del proveedor en un error estable', () => {
    expect(() =>
      normalizeTikWmResponse(
        { code: -1, msg: 'Video is private' },
        'https://vm.tiktok.com/ZM123abcD/',
      ),
    ).toThrowError(LinksDownloaderError)
  })
})

describe('cliente TikWM', () => {
  it('solicita hd=1, codifica la URL y usa el fetch inyectado', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(TIKWM_VIDEO_FIXTURE), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const source = 'https://www.tiktok.com/@hero/video/7361234567890123456?lang=es'

    await resolveTikTok(source, { fetchImpl: fetchMock })

    expect(fetchMock).toHaveBeenCalledOnce()
    const endpoint = new URL(String(fetchMock.mock.calls[0]?.[0]))
    expect(endpoint.origin + endpoint.pathname).toBe('https://www.tikwm.com/api/')
    expect(endpoint.searchParams.get('url')).toBe(source)
    expect(endpoint.searchParams.get('hd')).toBe('1')
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('respeta la cancelación externa', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new DOMException('aborted', 'AbortError'))

    await expect(
      resolveTikTok('https://vm.tiktok.com/ZM123abcD/', {
        signal: controller.signal,
        fetchImpl: fetchMock,
      }),
    ).rejects.toMatchObject({ code: 'ABORTED' })
  })
})
