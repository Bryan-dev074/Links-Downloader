import { describe, expect, it, vi } from 'vitest'
import { LinksDownloaderError } from './errors'
import {
  isTikTokUrl,
  normalizeTikWmResponse,
  parseTikTokUrl,
  rankVideoVariants,
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
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (String(input).includes('/api/video/task/submit')) {
        return new Response(null, { status: 503 })
      }
      return new Response(JSON.stringify(TIKWM_VIDEO_FIXTURE), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    })
    const source = 'https://www.tiktok.com/@hero/video/7361234567890123456?lang=es'

    const media = await resolveTikTok(source, {
      fetchImpl: fetchMock,
      videoProbeImpl: async () => undefined,
    })

    const endpoint = new URL(String(fetchMock.mock.calls[0]?.[0]))
    expect(endpoint.origin + endpoint.pathname).toBe('https://www.tikwm.com/api/')
    expect(endpoint.searchParams.get('url')).toBe(source)
    expect(endpoint.searchParams.get('hd')).toBe('1')
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/task/submit'))).toBe(true)
    expect(media.variants[0]?.id).toBe('video-hd')
  })

  it('combina el archivo fuente con HD y elige la mayor resolución comprobada', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/task/submit')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { task_id: 'premium-task', status: 0, detail: {} },
        }))
      }
      if (url.includes('/task/result')) {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            task_id: 'premium-task',
            status: 2,
            detail: {
              play_url: 'https://cdn.example/video-source-preview.mp4',
              download_url: 'https://cdn.example/video-source.mp4',
              size: 18_000,
            },
          },
        }))
      }
      return new Response(JSON.stringify(TIKWM_VIDEO_FIXTURE))
    })
    const probe = vi.fn(async (url: string) => {
      if (url.includes('source')) return { width: 1080, height: 1920, fps: 60, codec: 'HEVC' }
      if (url.includes('-hd')) return { width: 720, height: 1280, fps: 30, codec: 'HEVC' }
      return { width: 576, height: 1024, fps: 30, codec: 'H.264' }
    })

    const media = await resolveTikTok(
      'https://www.tiktok.com/@hero/video/7361234567890123456',
      { fetchImpl: fetchMock, videoProbeImpl: probe },
    )

    expect(media.variants[0]).toMatchObject({
      id: 'video-source',
      width: 1080,
      height: 1920,
      fps: 60,
      codec: 'HEVC',
      metadataVerified: true,
      requiresDirectDownload: true,
      isBest: true,
    })
    expect(media.variants[0]?.label).toContain('1080p')
    expect(media.variants.filter(({ mediaType }) => mediaType === 'video')).toHaveLength(3)
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

describe('ranking técnico de calidad', () => {
  it('prefiere 720p HEVC aunque un 576p H.264 tenga más bytes', () => {
    const common = {
      mediaType: 'video' as const,
      extension: 'mp4',
      mimeType: 'video/mp4',
      quality: 'original' as const,
      isBest: false,
    }
    const ranked = rankVideoVariants([
      {
        ...common,
        id: 'large-576',
        label: '576p',
        url: 'https://cdn.example/large.mp4',
        width: 576,
        height: 1024,
        codec: 'H.264',
        sizeBytes: 4_160_000,
        providerTier: 'compatible',
      },
      {
        ...common,
        id: 'small-720',
        label: '720p',
        url: 'https://cdn.example/small.mp4',
        width: 720,
        height: 1280,
        codec: 'HEVC',
        sizeBytes: 1_650_000,
        providerTier: 'hd',
      },
    ], 10)

    expect(ranked[0]).toMatchObject({ id: 'small-720', isBest: true })
    expect(ranked[0]?.bitrateBps).toBe(1_320_000)
  })

  it('en la misma resolución prioriza el archivo fuente', () => {
    const common = {
      mediaType: 'video' as const,
      extension: 'mp4',
      mimeType: 'video/mp4',
      quality: 'original' as const,
      isBest: false,
      width: 1080,
      height: 1920,
    }
    const ranked = rankVideoVariants([
      {
        ...common,
        id: 'provider-hd',
        label: 'HD',
        url: 'https://cdn.example/hd.mp4',
        sizeBytes: 20_000,
        providerTier: 'hd',
      },
      {
        ...common,
        id: 'source',
        label: 'Fuente',
        url: 'https://cdn.example/source.mp4',
        sizeBytes: 18_000,
        providerTier: 'source',
      },
    ], 10)

    expect(ranked[0]?.id).toBe('source')
  })

  it('prioriza FPS antes que el origen cuando la resolución coincide', () => {
    const common = {
      mediaType: 'video' as const,
      extension: 'mp4',
      mimeType: 'video/mp4',
      quality: 'original' as const,
      isBest: false,
      width: 1080,
      height: 1920,
    }
    const ranked = rankVideoVariants([
      {
        ...common,
        id: 'source-30',
        label: 'Fuente 30 FPS',
        url: 'https://cdn.example/source-30.mp4',
        fps: 30,
        providerTier: 'source',
      },
      {
        ...common,
        id: 'hd-60',
        label: 'HD 60 FPS',
        url: 'https://cdn.example/hd-60.mp4',
        fps: 60,
        providerTier: 'hd',
      },
    ])

    expect(ranked[0]?.id).toBe('hd-60')
  })

  it('no penaliza una fuente cuando solo la alternativa informa FPS', () => {
    const common = {
      mediaType: 'video' as const,
      extension: 'mp4',
      mimeType: 'video/mp4',
      quality: 'original' as const,
      isBest: false,
      width: 1080,
      height: 1920,
    }
    const ranked = rankVideoVariants([
      {
        ...common,
        id: 'source-unknown-fps',
        label: 'Fuente',
        url: 'https://cdn.example/source.mp4',
        providerTier: 'source',
      },
      {
        ...common,
        id: 'hd-known-fps',
        label: 'HD',
        url: 'https://cdn.example/hd.mp4',
        fps: 60,
        providerTier: 'hd',
      },
    ])

    expect(ranked[0]?.id).toBe('source-unknown-fps')
  })

  it('conserva arriba una fuente no verificable y relega otras variantes desconocidas', () => {
    const common = {
      mediaType: 'video' as const,
      extension: 'mp4',
      mimeType: 'video/mp4',
      quality: 'original' as const,
      isBest: false,
    }
    const ranked = rankVideoVariants([
      {
        ...common,
        id: 'unknown-hd',
        label: 'HD desconocida',
        url: 'https://cdn.example/unknown-hd.mp4',
        providerTier: 'hd',
      },
      {
        ...common,
        id: 'known-compatible',
        label: 'Compatible conocida',
        url: 'https://cdn.example/known.mp4',
        width: 576,
        height: 1024,
        providerTier: 'compatible',
      },
      {
        ...common,
        id: 'unknown-source',
        label: 'Fuente desconocida',
        url: 'https://cdn.example/unknown-source.mp4',
        providerTier: 'source',
      },
    ])

    expect(ranked.map(({ id }) => id)).toEqual([
      'unknown-source',
      'known-compatible',
      'unknown-hd',
    ])
  })

  it('deduplica archivos técnicamente idénticos aunque sus URLs cambien', () => {
    const common = {
      mediaType: 'video' as const,
      extension: 'mp4',
      mimeType: 'video/mp4',
      quality: 'original' as const,
      isBest: false,
      width: 576,
      height: 1024,
      sizeBytes: 2_953_029,
      codec: 'H.264',
      fps: 30,
    }
    const ranked = rankVideoVariants([
      {
        ...common,
        id: 'source',
        label: 'Fuente',
        url: 'https://cdn.example/source.mp4',
        providerTier: 'source',
      },
      {
        ...common,
        id: 'compatible',
        label: 'Compatible',
        url: 'https://cdn.example/compatible.mp4',
        providerTier: 'compatible',
      },
    ], 10)

    expect(ranked).toHaveLength(1)
    expect(ranked[0]?.id).toBe('source')
  })

  it('no deduplica codificaciones distintas con igual tamaño y resolución', () => {
    const common = {
      mediaType: 'video' as const,
      extension: 'mp4',
      mimeType: 'video/mp4',
      quality: 'original' as const,
      isBest: false,
      width: 720,
      height: 1280,
      fps: 30,
      sizeBytes: 2_000_000,
    }
    const ranked = rankVideoVariants([
      {
        ...common,
        id: 'hevc',
        label: 'HEVC',
        url: 'https://cdn.example/hevc.mp4',
        codec: 'HEVC',
        providerTier: 'source',
      },
      {
        ...common,
        id: 'h264',
        label: 'H.264',
        url: 'https://cdn.example/h264.mp4',
        codec: 'H.264',
        providerTier: 'hd',
      },
    ])

    expect(ranked).toHaveLength(2)
  })
})
