import { describe, expect, it } from 'vitest'
import metadataHandler, { isAllowedTokCdnUrl } from '../../api/video-metadata.js'

describe('respaldo de metadatos en Vercel', () => {
  it('acepta únicamente HTTPS MP4 en el host exacto del CDN', () => {
    expect(isAllowedTokCdnUrl('https://v16.tokcdn.com/path/video.mp4?token=abc')).toBe(true)
    expect(isAllowedTokCdnUrl('https://tokcdn.com/video.mp4')).toBe(false)
    expect(isAllowedTokCdnUrl('https://v19.tokcdn.com/video.mp4')).toBe(false)
    expect(isAllowedTokCdnUrl('https://tokcdn.com.evil.test/video.mp4')).toBe(false)
    expect(isAllowedTokCdnUrl('https://evil-tokcdn.com/video.mp4')).toBe(false)
    expect(isAllowedTokCdnUrl('http://v16.tokcdn.com/video.mp4')).toBe(false)
    expect(isAllowedTokCdnUrl('https://user@v16.tokcdn.com/video.mp4')).toBe(false)
    expect(isAllowedTokCdnUrl('https://v16.tokcdn.com:444/video.mp4')).toBe(false)
    expect(isAllowedTokCdnUrl('https://v16.tokcdn.com/video.jpg')).toBe(false)
    expect(isAllowedTokCdnUrl('https://v16.tokcdn.com./video.mp4')).toBe(false)
    expect(isAllowedTokCdnUrl('https://v16.tokcdn.com/video.mp4#fragment')).toBe(false)
  })

  it('rechaza métodos y destinos no permitidos antes de consultar la red', async () => {
    const post = await metadataHandler.fetch(new Request('https://app.test/api/video-metadata', {
      method: 'POST',
    }))
    const invalid = await metadataHandler.fetch(new Request(
      'https://app.test/api/video-metadata?url=https%3A%2F%2F127.0.0.1%2Fsecret',
    ))

    expect(post.status).toBe(405)
    expect(post.headers.get('allow')).toBe('GET')
    expect(invalid.status).toBe(400)
  })
})
