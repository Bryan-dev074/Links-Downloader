import { afterEach, describe, expect, it, vi } from 'vitest'
import instagramHandler, {
  extractInstagramMedia,
  isAllowedFallbackMediaUrl,
  isAllowedInstagramMediaUrl,
  normalizeInstagramMedia,
  parseDashMetadata,
  parseInstagramUrl,
  readBoundedHtml,
} from '../../api/instagram.js'

const imageUrl = (name, transform = 'dst-jpg_e35_tt6') => (
  `https://scontent.cdninstagram.com/v/t51.82787-15/${name}.jpg?stp=${transform}&token=test`
)
const videoUrl = (name) => (
  `https://instagram.fagt5-1.fna.fbcdn.net/o1/v/t2/f2/${name}.mp4?token=test`
)
const fallbackUrl = (name) => (
  `https://dl.snapcdn.app/saveinsta?token=${name}${'a'.repeat(48)}`
)

function dataSjs(media, prefix = '') {
  return `<!doctype html><html><body>${prefix}<script type="application/json" data-sjs>${JSON.stringify({
    require: [[
      'CometRelay',
      null,
      null,
      [{ deeply: { nested: { result: { data: { xig_polaris_media: {
        if_not_gated_logged_out: media,
      } } } } } }],
    ]],
  })}</script></body></html>`
}

function syntheticDash() {
  return '<MPD mediaPresentationDuration="PT12.5S"><Period><AdaptationSet>'
    + '<Representation mimeType="video/mp4" width="360" height="640" bandwidth="180000" '
    + 'frameRate="30" codecs="avc1.4d001e"></Representation>'
    + '<Representation mimeType="video/mp4" width="720" height="1280" bandwidth="900000" '
    + 'frameRate="15360/512" codecs="avc1.64001f"></Representation>'
    + '<Representation mimeType="audio/mp4" bandwidth="96000" codecs="mp4a.40.5"></Representation>'
    + '</AdaptationSet></Period></MPD>'
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('API propia de Instagram', () => {
  it('acepta solo dominios y rutas directas oficiales', () => {
    expect(parseInstagramUrl('https://instagram.com/reel/DFQe23tOWKz/?igsh=test')).toEqual({
      id: 'DFQe23tOWKz',
      route: 'reel',
      url: 'https://www.instagram.com/reel/DFQe23tOWKz/',
    })
    expect(parseInstagramUrl('https://m.instagram.com/p/CmCVWoIr9OH/').route).toBe('p')

    const invalid = [
      'http://www.instagram.com/reel/DFQe23tOWKz/',
      'https://instagram.com.evil.test/reel/DFQe23tOWKz/',
      'https://evil-instagram.com/reel/DFQe23tOWKz/',
      'https://user@instagram.com/reel/DFQe23tOWKz/',
      'https://instagram.com:444/reel/DFQe23tOWKz/',
      'https://instagram.com/explore/',
      'https://instagram.com/reel/DFQe23tOWKz/#fragment',
    ]
    for (const value of invalid) expect(() => parseInstagramUrl(value)).toThrow()
  })

  it('solo expone archivos HTTPS de CDN de Meta con el tipo esperado', () => {
    expect(isAllowedInstagramMediaUrl(videoUrl('source'), 'video')).toBe(true)
    expect(isAllowedInstagramMediaUrl(imageUrl('photo'), 'image')).toBe(true)
    expect(isAllowedInstagramMediaUrl('https://cdninstagram.com/video.mp4', 'video')).toBe(true)
    expect(isAllowedInstagramMediaUrl('https://fbcdn.net/photo.jpg', 'image')).toBe(true)
    expect(isAllowedInstagramMediaUrl('https://fbcdn.net.evil.test/video.mp4', 'video')).toBe(false)
    expect(isAllowedInstagramMediaUrl('https://evil-fbcdn.net/video.mp4', 'video')).toBe(false)
    expect(isAllowedInstagramMediaUrl('http://scontent.cdninstagram.com/photo.jpg', 'image')).toBe(false)
    expect(isAllowedInstagramMediaUrl('https://scontent.cdninstagram.com/photo.jpg#x', 'image')).toBe(false)
    expect(isAllowedInstagramMediaUrl(imageUrl('photo'), 'video')).toBe(false)
  })

  it('limita los archivos del respaldo a su host, ruta y token exactos', () => {
    expect(isAllowedFallbackMediaUrl(fallbackUrl('video'))).toBe(true)
    expect(isAllowedFallbackMediaUrl('https://dl.snapcdn.app/otra?token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(false)
    expect(isAllowedFallbackMediaUrl('https://dl.snapcdn.app.evil.test/saveinsta?token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(false)
    expect(isAllowedFallbackMediaUrl('https://dl.snapcdn.app/saveinsta?token=short')).toBe(false)
    expect(isAllowedFallbackMediaUrl(`${fallbackUrl('video')}&next=https://evil.test`)).toBe(false)
  })

  it('encuentra el JSON SSR aunque cambie su profundidad e ignora scripts rotos', () => {
    const media = {
      code: 'DFQe23tOWKz',
      original_width: 720,
      original_height: 1280,
      video_versions: [{ url: videoUrl('main') }],
    }
    const broken = '<script type="application/json" data-sjs>{invalid-json</script>'
    expect(extractInstagramMedia(dataSjs(media, broken), media.code)).toMatchObject(media)
  })

  it('nunca sustituye la publicación pedida por contenido recomendado sin shortcode', () => {
    const recommendation = {
      image_versions2: { candidates: [{ url: imageUrl('unrelated') }] },
    }
    expect(extractInstagramMedia(dataSjs(recommendation), 'EXPECTED123')).toBeUndefined()
  })

  it('selecciona el archivo sin transformación y no una copia reescalada', () => {
    const media = {
      code: 'DFx6KVduFWy',
      media_type: 1,
      original_width: 1266,
      original_height: 1370,
      user: { username: 'pixelhero', full_name: 'Pixel Hero' },
      image_versions2: {
        candidates: [
          { url: imageUrl('photo', 'dst-jpg_e35_p1080x1080_tt6') },
          { url: imageUrl('photo', 'dst-jpg_e35_tt6') },
          { url: imageUrl('photo', 'dst-jpg_e35_p640x640_tt6') },
        ],
      },
    }
    const result = normalizeInstagramMedia(media, parseInstagramUrl(
      'https://www.instagram.com/p/DFx6KVduFWy/',
    ))

    expect(result.kind).toBe('photo')
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({
      type: 'image',
      width: 1266,
      height: 1370,
    })
    expect(result.items[0].url).toContain('dst-jpg_e35_tt6')
    expect(new URL(result.items[0].url).hostname).toBe('scontent.xx.fbcdn.net')
    expect(new URL(result.items[0].url).searchParams.get('dl')).toBe('1')
  })

  it('no trata un display_url p640 como original frente a un candidato p1080', () => {
    const media = {
      code: 'DFx6KVduFWy',
      original_width: 1440,
      original_height: 1800,
      display_url: imageUrl('display', 'dst-jpg_e35_p640x640_tt6'),
      image_versions2: { candidates: [
        { url: imageUrl('candidate', 'dst-jpg_e35_p1080x1080_tt6') },
      ] },
    }
    const result = normalizeInstagramMedia(media, parseInstagramUrl(
      'https://www.instagram.com/p/DFx6KVduFWy/',
    ))

    expect(result.items[0].url).toContain('p1080x1080')
    expect(result.items[0]).toMatchObject({ width: 1080, height: 1080 })
  })

  it('normaliza un carrusel mixto en el orden original y elige el video mayor', () => {
    const media = {
      code: 'CvYrSgnsKjv',
      media_type: 8,
      original_width: 1440,
      original_height: 1800,
      taken_at: 1_700_000_000,
      caption: { text: 'Una aventura pixelada' },
      user: {
        username: 'rpg_player',
        full_name: 'RPG Player',
        profile_pic_url: imageUrl('avatar'),
      },
      carousel_media: [
        {
          code: 'photo-child',
          original_width: 1440,
          original_height: 1800,
          image_versions2: { candidates: [
            { url: imageUrl('carousel-photo', 'dst-jpg_e35_p1080x1080_tt6') },
            { url: imageUrl('carousel-photo', 'dst-jpg_e35_tt6') },
          ] },
        },
        {
          code: 'video-child',
          original_width: 720,
          original_height: 1280,
          video_dash_manifest: syntheticDash(),
          video_versions: [
            { width: 360, height: 640, url: videoUrl('small') },
            { width: 720, height: 1280, url: videoUrl('large') },
          ],
          image_versions2: { candidates: [{ url: imageUrl('video-cover') }] },
        },
      ],
    }
    const result = normalizeInstagramMedia(media, parseInstagramUrl(
      'https://www.instagram.com/p/CvYrSgnsKjv/',
    ))

    expect(result).toMatchObject({
      platform: 'instagram',
      id: 'CvYrSgnsKjv',
      kind: 'carousel',
      title: 'Una aventura pixelada',
      caption: 'Una aventura pixelada',
      durationSeconds: null,
      author: { name: 'RPG Player', handle: 'rpg_player' },
      takenAt: 1_700_000_000,
    })
    expect(result.items.map(({ type }) => type)).toEqual(['image', 'video'])
    expect(result.items[1]).toMatchObject({
      width: 720,
      height: 1280,
      fps: null,
      codec: null,
      bitrateBps: null,
    })
    expect(new URL(result.items[1].url).pathname).toContain('/large.mp4')
    expect(new URL(result.items[1].url).hostname).toBe('video.xx.fbcdn.net')
    expect(new URL(result.items[1].url).searchParams.get('dl')).toBe('1')
  })

  it('lee dimensiones, FPS, codec y bitrate del manifiesto sin remultiplexar', () => {
    expect(parseDashMetadata(syntheticDash())).toEqual({
      width: 720,
      height: 1280,
      fps: 30,
      codec: 'H.264',
      bitrateBps: 996_000,
      durationSeconds: 12.5,
    })
  })

  it('detiene cuerpos declarados por encima de 4 MiB', async () => {
    const response = new Response('pequeño', {
      headers: { 'Content-Length': String(4 * 1024 * 1024 + 1) },
    })
    await expect(readBoundedHtml(response)).rejects.toMatchObject({
      code: 'UPSTREAM_RESPONSE_TOO_LARGE',
    })
  })

  it('sirve GET con no-store y rechaza métodos o URLs antes de consultar la red', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const post = await instagramHandler.fetch(new Request('https://app.test/api/instagram', {
      method: 'POST',
    }))
    const invalid = await instagramHandler.fetch(new Request(
      'https://app.test/api/instagram?url=https%3A%2F%2F127.0.0.1%2Fsecret',
    ))

    expect(post.status).toBe(405)
    expect(post.headers.get('allow')).toBe('GET')
    expect(invalid.status).toBe(400)
    expect(invalid.headers.get('cache-control')).toBe('no-store')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('resuelve una respuesta SSR y nunca sigue una redirección externa', async () => {
    const media = {
      code: 'DFQe23tOWKz',
      // Estas dimensiones corresponden al upload/DASH, no necesariamente al
      // MP4 progresivo que se entrega con audio.
      original_width: 888,
      original_height: 1426,
      video_dash_manifest: syntheticDash(),
      user: { username: 'hero' },
      video_versions: [{ url: videoUrl('reel-source') }],
      image_versions2: { candidates: [{ url: imageUrl('reel-cover') }] },
    }
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(dataSjs(media), {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const requestUrl = new URL('https://app.test/api/instagram')
    requestUrl.searchParams.set('url', 'https://www.instagram.com/reel/DFQe23tOWKz/')
    const response = await instagramHandler.fetch(new Request(requestUrl))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(body.data.items[0]).toMatchObject({ type: 'video', width: null, height: null })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.instagram.com/reel/DFQe23tOWKz/',
      expect.objectContaining({ method: 'GET', redirect: 'manual' }),
    )

    fetchMock.mockReset()
    fetchMock.mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: { Location: 'https://evil.test/steal' },
    }))
    const redirected = await instagramHandler.fetch(new Request(requestUrl))
    expect(redirected.status).toBe(502)
    expect((await redirected.json()).error.code).toBe('UPSTREAM_REDIRECT')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('usa un respaldo validado cuando Vercel recibe el login de Instagram', async () => {
    const mediaUrl = fallbackUrl('reel')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { Location: 'https://www.instagram.com/accounts/login/?next=%2Freel%2FDFQe23tOWKz%2F' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'success',
        data: { type: 'video', url: mediaUrl, thumbnail: null },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      }))
      .mockResolvedValueOnce(new Response(new Uint8Array([0]), {
        status: 206,
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': '1',
          'Content-Range': 'bytes 0-0/893586',
        },
      }))
    vi.stubGlobal('fetch', fetchMock)

    const requestUrl = new URL('https://app.test/api/instagram')
    requestUrl.searchParams.set('url', 'https://www.instagram.com/reel/DFQe23tOWKz/')
    const response = await instagramHandler.fetch(new Request(requestUrl))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data).toMatchObject({ platform: 'instagram', kind: 'video' })
    expect(body.data.items[0]).toMatchObject({
      type: 'video',
      url: mediaUrl,
      mimeType: 'video/mp4',
      sizeBytes: 893_586,
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('rechaza una URL ajena aunque el respaldo la marque como exitosa', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { Location: 'https://www.instagram.com/accounts/login/' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'success',
        data: { type: 'video', url: 'https://evil.test/video.mp4' },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)

    const requestUrl = new URL('https://app.test/api/instagram')
    requestUrl.searchParams.set('url', 'https://www.instagram.com/reel/DFQe23tOWKz/')
    const response = await instagramHandler.fetch(new Request(requestUrl))

    expect(response.status).toBe(502)
    expect((await response.json()).error.code).toBe('INVALID_RESPONSE')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
