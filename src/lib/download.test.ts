import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DownloadVariant } from '../types'
import {
  buildDownloadFilename,
  downloadVariant,
  getBestVariant,
  sanitizeFilename,
} from './download'

const VIDEO_VARIANT: DownloadVariant = {
  id: 'video-hd',
  label: 'Mejor calidad · HD',
  url: 'https://cdn.example/video.mp4',
  mediaType: 'video',
  quality: 'best',
  extension: 'mp4',
  mimeType: 'video/mp4',
  isBest: true,
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('nombres de descarga', () => {
  it('elimina caracteres inseguros y nombres reservados', () => {
    expect(sanitizeFilename('  Mi: video / final?  ')).toBe('Mi- video - final')
    expect(sanitizeFilename('CON')).toBe('links-downloader')
  })

  it('crea un nombre descriptivo con una sola extensión', () => {
    expect(
      buildDownloadFilename(
        { title: 'Boss fight', author: { name: 'Hero', handle: 'hero' } },
        VIDEO_VARIANT,
      ),
    ).toBe('Boss fight - @hero.mp4')
  })
})

describe('descarga cross-origin', () => {
  it('guarda un Blob e informa progreso cuando fetch funciona', async () => {
    const NativeURL = URL
    const createObjectURL = vi.fn(() => 'blob:test-download')
    const revokeObjectURL = vi.fn()
    class MockURL extends NativeURL {
      static createObjectURL = createObjectURL
      static revokeObjectURL = revokeObjectURL
    }
    vi.stubGlobal('URL', MockURL)

    let clickedFilename = ''
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(
      this: HTMLAnchorElement,
    ) {
      clickedFilename = this.download
    })
    const progress = vi.fn()
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'content-length': '4', 'content-type': 'video/mp4' },
      }),
    )

    const result = await downloadVariant(VIDEO_VARIANT, {
      filenameBase: 'Mi aventura',
      fetchImpl: fetchMock,
      onProgress: progress,
    })

    expect(result).toEqual({ method: 'blob', filename: 'Mi aventura.mp4', bytes: 4 })
    expect(clickedFilename).toBe('Mi aventura.mp4')
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
    expect(progress).toHaveBeenLastCalledWith({ loadedBytes: 4, totalBytes: 4, percent: 100 })
  })

  it('abre la URL directa cuando el CDN bloquea fetch/CORS', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch'))
    const openMock = vi.spyOn(window, 'open').mockReturnValue(null)
    const clickMock = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const result = await downloadVariant(VIDEO_VARIANT, { fetchImpl: fetchMock })

    expect(result.method).toBe('direct')
    expect(openMock).toHaveBeenCalledWith(
      'https://cdn.example/video.mp4',
      '_blank',
      'noopener,noreferrer',
    )
    expect(clickMock).toHaveBeenCalledOnce()
  })

  it('evita cargar videos grandes completos en la memoria del teléfono', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    const openMock = vi.spyOn(window, 'open').mockReturnValue({ opener: null } as Window)
    const largeVariant = { ...VIDEO_VARIANT, sizeBytes: 100 * 1024 * 1024 }

    const result = await downloadVariant(largeVariant, { fetchImpl: fetchMock })

    expect(result.method).toBe('direct')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(openMock).toHaveBeenCalledOnce()
  })

  it('abre el archivo fuente directamente para conservar el gesto del usuario', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    const clickMock = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const sourceVariant = { ...VIDEO_VARIANT, requiresDirectDownload: true }

    const result = await downloadVariant(sourceVariant, { fetchImpl: fetchMock })

    expect(result.method).toBe('direct')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(clickMock).toHaveBeenCalledOnce()
  })

  it('no abre otra pestaña cuando el usuario cancela', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new DOMException('aborted', 'AbortError'))
    const openMock = vi.spyOn(window, 'open').mockReturnValue(null)

    await expect(
      downloadVariant(VIDEO_VARIANT, { signal: controller.signal, fetchImpl: fetchMock }),
    ).rejects.toMatchObject({ code: 'ABORTED' })
    expect(openMock).not.toHaveBeenCalled()
  })
})

describe('selección de calidad', () => {
  it('elige la variante marcada como mejor aunque no sea la primera', () => {
    const compatible = { ...VIDEO_VARIANT, id: 'compatible', isBest: false }
    expect(getBestVariant({ variants: [compatible, VIDEO_VARIANT] })).toBe(VIDEO_VARIANT)
  })
})
