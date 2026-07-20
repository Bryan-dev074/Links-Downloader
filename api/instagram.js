const MAX_INPUT_URL_LENGTH = 4_096
const MAX_MEDIA_URL_LENGTH = 16_384
const MAX_HTML_BYTES = 4 * 1024 * 1024
const MAX_FALLBACK_JSON_BYTES = 256 * 1024
const UPSTREAM_TIMEOUT_MS = 12_000
const MAX_REDIRECTS = 3
const FALLBACK_API_URL = 'https://jerrycoder.oggyapi.workers.dev/insta'
const FALLBACK_MEDIA_HOST = 'dl.snapcdn.app'

const FALLBACK_ELIGIBLE_ERRORS = new Set([
  'IDENTITY_UNVERIFIED',
  'UPSTREAM_AUTH_REQUIRED',
  'UPSTREAM_LIMITED',
  'UPSTREAM_ERROR',
  'INVALID_RESPONSE',
])

const INSTAGRAM_HOSTS = new Set([
  'instagram.com',
  'www.instagram.com',
  'm.instagram.com',
])

const DOCUMENT_HEADERS = {
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'max-age=0',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
}

const MEDIA_PATHS = {
  image: /\.(?:avif|heic|heif|jpe?g|png|webp)$/i,
  video: /\.mp4$/i,
}

class InstagramApiError extends Error {
  constructor(code, message, status) {
    super(message)
    this.name = 'InstagramApiError'
    this.code = code
    this.status = status
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function finiteInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : undefined
}

function finiteNumber(value, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed > 0 && parsed <= maximum ? parsed : undefined
}

function instagramHostname(hostname) {
  const normalized = hostname.toLowerCase()
  return INSTAGRAM_HOSTS.has(normalized) ? normalized : undefined
}

/** Valida y normaliza únicamente enlaces directos de publicaciones públicas. */
export function parseInstagramUrl(value) {
  if (!value || value.length > MAX_INPUT_URL_LENGTH) {
    throw new InstagramApiError(
      'INVALID_URL',
      'Pega un enlace válido de una publicación o Reel de Instagram.',
      400,
    )
  }

  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new InstagramApiError(
      'INVALID_URL',
      'Pega un enlace válido de una publicación o Reel de Instagram.',
      400,
    )
  }

  if (
    parsed.protocol !== 'https:'
    || !instagramHostname(parsed.hostname)
    || parsed.username
    || parsed.password
    || parsed.port
    || parsed.hash
  ) {
    throw new InstagramApiError(
      'INVALID_URL',
      'El enlace no pertenece a un dominio oficial de Instagram.',
      400,
    )
  }

  const match = parsed.pathname.match(/^\/(p|reel|tv)\/([a-z0-9_-]{5,64})\/?$/i)
  if (!match) {
    throw new InstagramApiError(
      'INVALID_URL',
      'Usa el enlace directo de una publicación o Reel público de Instagram.',
      400,
    )
  }

  const route = match[1].toLowerCase()
  const id = match[2]
  return {
    id,
    route,
    url: `https://www.instagram.com/${route}/${id}/`,
  }
}

function isAllowedInstagramDocumentUrl(value) {
  try {
    parseInstagramUrl(value)
    return true
  } catch {
    return false
  }
}

function isInstagramAuthRedirect(value) {
  try {
    const parsed = new URL(value)
    return (
      parsed.protocol === 'https:'
      && Boolean(instagramHostname(parsed.hostname))
      && !parsed.username
      && !parsed.password
      && !parsed.port
      && /^\/(?:accounts\/login|challenge|web\/challenge)(?:\/|$)/i.test(parsed.pathname)
    )
  } catch {
    return false
  }
}

function isMetaCdnHostname(hostname) {
  const normalized = hostname.toLowerCase()
  return (
    normalized === 'cdninstagram.com'
    || normalized.endsWith('.cdninstagram.com')
    || normalized === 'fbcdn.net'
    || normalized.endsWith('.fbcdn.net')
  )
}

/** Impide que las URLs devueltas conviertan este endpoint en un proxy abierto. */
export function isAllowedInstagramMediaUrl(value, type) {
  if (!value || value.length > MAX_MEDIA_URL_LENGTH || !MEDIA_PATHS[type]) return false
  try {
    const parsed = new URL(value.replaceAll('&amp;', '&'))
    return (
      parsed.protocol === 'https:'
      && isMetaCdnHostname(parsed.hostname)
      && !parsed.username
      && !parsed.password
      && !parsed.port
      && !parsed.hash
      && MEDIA_PATHS[type].test(parsed.pathname)
    )
  } catch {
    return false
  }
}

/** El respaldo solo puede devolver enlaces firmados del host y ruta esperados. */
export function isAllowedFallbackMediaUrl(value) {
  if (!value || value.length > MAX_MEDIA_URL_LENGTH) return false
  try {
    const parsed = new URL(value)
    const parameters = [...parsed.searchParams.entries()]
    return (
      parsed.protocol === 'https:'
      && parsed.hostname.toLowerCase() === FALLBACK_MEDIA_HOST
      && parsed.pathname === '/saveinsta'
      && !parsed.username
      && !parsed.password
      && !parsed.port
      && !parsed.hash
      && parameters.length === 1
      && parameters[0][0] === 'token'
      && parameters[0][1].length >= 32
      && parameters[0][1].length <= 12_000
    )
  } catch {
    return false
  }
}

function safeMediaUrl(value, type) {
  const url = cleanString(value)?.replaceAll('&amp;', '&')
  return url && isAllowedInstagramMediaUrl(url, type) ? url : undefined
}

function downloadableVideoUrl(value) {
  const url = new URL(value)
  // Meta usa este alias para servir el mismo MP4 progresivo sin el redireccionamiento
  // cross-origin del host regional. `dl=1` añade Content-Disposition de adjunto.
  url.hostname = 'video.xx.fbcdn.net'
  url.searchParams.set('dl', '1')
  return url.toString()
}

function downloadableImageUrl(value) {
  const url = new URL(value)
  url.hostname = 'scontent.xx.fbcdn.net'
  url.searchParams.set('dl', '1')
  return url.toString()
}

/** Lee el cuerpo ya descomprimido sin permitir más de 4 MiB en memoria. */
export async function readBoundedHtml(response, maximumBytes = MAX_HTML_BYTES) {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel()
    throw new InstagramApiError(
      'UPSTREAM_RESPONSE_TOO_LARGE',
      'Instagram devolvió una respuesta demasiado grande.',
      502,
    )
  }

  if (!response.body) {
    const buffer = await response.arrayBuffer()
    if (buffer.byteLength > maximumBytes) {
      throw new InstagramApiError(
        'UPSTREAM_RESPONSE_TOO_LARGE',
        'Instagram devolvió una respuesta demasiado grande.',
        502,
      )
    }
    return new TextDecoder().decode(buffer)
  }

  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maximumBytes) {
      await reader.cancel()
      throw new InstagramApiError(
        'UPSTREAM_RESPONSE_TOO_LARGE',
        'Instagram devolvió una respuesta demasiado grande.',
        502,
      )
    }
    chunks.push(value)
  }

  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(output)
}

async function fetchInstagramDocument(url, fetchImpl, signal) {
  let currentUrl = url
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetchImpl(currentUrl, {
      method: 'GET',
      headers: DOCUMENT_HEADERS,
      redirect: 'manual',
      signal,
    })

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (!location || redirectCount === MAX_REDIRECTS) {
        throw new InstagramApiError(
          'UPSTREAM_REDIRECT',
          'Instagram redirigió el enlace demasiadas veces.',
          502,
        )
      }
      const nextUrl = new URL(location, currentUrl).toString()
      if (!isAllowedInstagramDocumentUrl(nextUrl)) {
        if (isInstagramAuthRedirect(nextUrl)) {
          throw new InstagramApiError(
            'UPSTREAM_AUTH_REQUIRED',
            'Instagram exigió iniciar sesión desde el servidor.',
            502,
          )
        }
        throw new InstagramApiError(
          'UPSTREAM_REDIRECT',
          'Instagram redirigió el enlace a un destino no permitido.',
          502,
        )
      }
      currentUrl = parseInstagramUrl(nextUrl).url
      continue
    }

    if (response.status === 429) {
      await response.body?.cancel()
      throw new InstagramApiError(
        'UPSTREAM_LIMITED',
        'Instagram limitó temporalmente las consultas. Inténtalo de nuevo en unos minutos.',
        503,
      )
    }
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      await response.body?.cancel()
      throw new InstagramApiError(
        'PRIVATE_OR_UNAVAILABLE',
        'La publicación es privada, fue eliminada o no está disponible.',
        404,
      )
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new InstagramApiError(
        'UPSTREAM_ERROR',
        'Instagram no pudo entregar esa publicación en este momento.',
        502,
      )
    }

    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
    if (contentType !== 'text/html') {
      await response.body?.cancel()
      throw new InstagramApiError(
        'INVALID_RESPONSE',
        'Instagram devolvió una respuesta inesperada.',
        502,
      )
    }
    return readBoundedHtml(response)
  }

  throw new InstagramApiError(
    'UPSTREAM_REDIRECT',
    'Instagram redirigió el enlace demasiadas veces.',
    502,
  )
}

function hasMediaShape(value) {
  return isRecord(value) && (
    Array.isArray(value.carousel_media)
    || Array.isArray(value.video_versions)
    || isRecord(value.image_versions2)
  )
}

function unwrapMedia(value) {
  if (!isRecord(value)) return undefined
  if (hasMediaShape(value.if_not_gated_logged_out)) return value.if_not_gated_logged_out
  if (hasMediaShape(value)) return value
  return undefined
}

/** Extrae el medio principal sin depender de la posición de los arrays internos de Meta. */
export function extractInstagramMedia(html, expectedId) {
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
  const candidates = []
  let scriptMatch
  while ((scriptMatch = scriptPattern.exec(html)) !== null) {
    const attributes = scriptMatch[1]
    if (!/\bdata-sjs(?:\s|=|$)/i.test(attributes)) continue
    if (!/\btype\s*=\s*(?:"application\/json"|'application\/json')/i.test(attributes)) continue

    let root
    try {
      root = JSON.parse(scriptMatch[2])
    } catch {
      continue
    }

    const stack = [root]
    let visited = 0
    while (stack.length && visited < 100_000) {
      const current = stack.pop()
      visited += 1
      if (!current || typeof current !== 'object') continue
      if (Array.isArray(current)) {
        for (const value of current) stack.push(value)
        continue
      }

      const direct = unwrapMedia(current)
      if (direct) candidates.push(direct)
      const polarMedia = unwrapMedia(current.xig_polaris_media)
      if (polarMedia) candidates.push(polarMedia)
      const shortcodeMedia = unwrapMedia(current.xdt_shortcode_media ?? current.shortcode_media)
      if (shortcodeMedia) candidates.push(shortcodeMedia)

      for (const value of Object.values(current)) stack.push(value)
    }
  }

  return candidates.find((media) => (
    cleanString(media.code) === expectedId
    || cleanString(media.shortcode) === expectedId
    || cleanString(media.short_code) === expectedId
  ))
}

function dimensionsFromTransform(url) {
  try {
    const transform = new URL(url).searchParams.get('stp') ?? ''
    const sized = transform.match(/(?:^|_)[ps](\d{2,5})x(\d{2,5})(?:_|$)/i)
    return sized
      ? { width: finiteInteger(sized[1], 16_384), height: finiteInteger(sized[2], 16_384) }
      : undefined
  } catch {
    return undefined
  }
}

function hasResizeTransform(url) {
  try {
    const transform = new URL(url).searchParams.get('stp') ?? ''
    return /(?:^|_)(?:c[^_]+|[ps]\d{2,5}x\d{2,5})(?:_|$)/i.test(transform)
  } catch {
    return true
  }
}

function imageCandidates(media) {
  const source = isRecord(media.image_versions2) && Array.isArray(media.image_versions2.candidates)
    ? media.image_versions2.candidates
    : []
  const originalWidth = finiteInteger(media.original_width, 16_384)
  const originalHeight = finiteInteger(media.original_height, 16_384)

  const candidates = source.flatMap((candidate, sourceIndex) => {
    if (!isRecord(candidate)) return []
    const url = safeMediaUrl(candidate.url, 'image')
    if (!url) return []
    const transformed = dimensionsFromTransform(url)
    const unscaled = !hasResizeTransform(url)
    return [{
      url,
      sourceIndex,
      unscaled,
      width: finiteInteger(candidate.width, 16_384) ?? (unscaled ? originalWidth : transformed?.width),
      height: finiteInteger(candidate.height, 16_384) ?? (unscaled ? originalHeight : transformed?.height),
    }]
  })

  const displayUrl = safeMediaUrl(media.display_uri ?? media.display_url, 'image')
  if (displayUrl && !candidates.some((candidate) => candidate.url === displayUrl)) {
    const transformed = dimensionsFromTransform(displayUrl)
    const unscaled = !hasResizeTransform(displayUrl)
    candidates.push({
      url: displayUrl,
      sourceIndex: candidates.length,
      unscaled,
      width: unscaled ? originalWidth : transformed?.width,
      height: unscaled ? originalHeight : transformed?.height,
    })
  }

  return candidates.sort((left, right) => {
    if (left.unscaled !== right.unscaled) return left.unscaled ? -1 : 1
    const leftPixels = (left.width ?? 0) * (left.height ?? 0)
    const rightPixels = (right.width ?? 0) * (right.height ?? 0)
    return rightPixels - leftPixels || left.sourceIndex - right.sourceIndex
  })
}

function parseXmlAttributes(source) {
  const attributes = {}
  for (const match of source.matchAll(/([\w:]+)="([^"]*)"/g)) attributes[match[1]] = match[2]
  return attributes
}

/** Describe la mejor pista DASH; se usa para duración, nunca para etiquetar el MP4 progresivo. */
export function parseDashMetadata(value) {
  if (typeof value !== 'string' || value.length > 512 * 1024) return {}
  const representations = [...value.matchAll(/<Representation\s+([^>]+)>/gi)]
    .map((match) => parseXmlAttributes(match[1]))
  const videos = representations
    .filter((entry) => entry.mimeType === 'video/mp4')
    .map((entry) => ({
      width: finiteInteger(entry.width, 16_384),
      height: finiteInteger(entry.height, 16_384),
      bandwidth: finiteInteger(entry.bandwidth),
      frameRate: entry.frameRate,
      codecs: entry.codecs,
    }))
    .sort((left, right) => (
      (right.width ?? 0) * (right.height ?? 0) - (left.width ?? 0) * (left.height ?? 0)
      || (right.bandwidth ?? 0) - (left.bandwidth ?? 0)
    ))
  const bestVideo = videos[0]
  if (!bestVideo) return {}

  const audioBitrate = representations
    .filter((entry) => entry.mimeType === 'audio/mp4')
    .reduce((largest, entry) => Math.max(largest, finiteInteger(entry.bandwidth) ?? 0), 0)
  const fpsParts = bestVideo.frameRate?.split('/').map(Number)
  const measuredFps = fpsParts?.length === 2 && fpsParts[1] > 0
    ? fpsParts[0] / fpsParts[1]
    : Number(bestVideo.frameRate)
  const fps = Number.isFinite(measuredFps) && measuredFps >= 1 && measuredFps <= 240
    ? Math.round(measuredFps * 100) / 100
    : undefined
  const codec = bestVideo.codecs?.startsWith('avc')
    ? 'H.264'
    : bestVideo.codecs?.match(/^(?:hev|hvc)/)
      ? 'HEVC'
      : bestVideo.codecs?.startsWith('av01')
        ? 'AV1'
        : bestVideo.codecs?.startsWith('vp09')
          ? 'VP9'
          : undefined
  const durationMatch = value.match(/\bmediaPresentationDuration="PT([\d.]+)S"/i)
  const durationSeconds = durationMatch
    ? finiteNumber(durationMatch[1], 86_400)
    : undefined

  return {
    width: bestVideo.width,
    height: bestVideo.height,
    fps,
    codec,
    bitrateBps: bestVideo.bandwidth ? bestVideo.bandwidth + audioBitrate : undefined,
    durationSeconds,
  }
}

function videoCandidates(media) {
  if (!Array.isArray(media.video_versions)) return []
  const seen = new Set()
  return media.video_versions.flatMap((candidate, sourceIndex) => {
    if (!isRecord(candidate)) return []
    const url = safeMediaUrl(candidate.url, 'video')
    if (!url || seen.has(url)) return []
    seen.add(url)
    return [{
      url,
      sourceIndex,
      // Estos valores solo ordenan candidatos declarados por Instagram. La respuesta
      // pública no los expone hasta verificarlos en el MP4 progresivo con audio.
      width: finiteInteger(candidate.width, 16_384),
      height: finiteInteger(candidate.height, 16_384),
      fps: finiteNumber(candidate.fps ?? candidate.frame_rate, 240),
      codec: cleanString(candidate.codec),
      bitrateBps: finiteInteger(candidate.bitrate ?? candidate.bitrate_bps),
    }]
  }).sort((left, right) => (
    (right.width ?? 0) * (right.height ?? 0) - (left.width ?? 0) * (left.height ?? 0)
    || (right.bitrateBps ?? 0) - (left.bitrateBps ?? 0)
    || left.sourceIndex - right.sourceIndex
  ))
}

function normalizeItem(media, index, parentId) {
  if (!isRecord(media)) return undefined
  const video = videoCandidates(media)[0]
  const cover = imageCandidates(media)[0]
  const id = cleanString(media.code) ?? cleanString(media.pk) ?? `${parentId}-${index}`
  if (video) {
    return {
      id,
      index,
      type: 'video',
      url: downloadableVideoUrl(video.url),
      mimeType: 'video/mp4',
      extension: 'mp4',
      width: video.width ?? null,
      height: video.height ?? null,
      fps: video.fps ?? null,
      codec: video.codec ?? null,
      bitrateBps: video.bitrateBps ?? null,
      sizeBytes: null,
      thumbnailUrl: cover?.url ?? null,
      quality: 'source',
    }
  }

  if (!cover) return undefined
  const extension = new URL(cover.url).pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? 'jpg'
  const mimeExtension = extension === 'jpg' ? 'jpeg' : extension
  return {
    id,
    index,
    type: 'image',
    url: downloadableImageUrl(cover.url),
    mimeType: `image/${mimeExtension}`,
    extension,
    width: cover.width ?? null,
    height: cover.height ?? null,
    fps: null,
    codec: null,
    bitrateBps: null,
    sizeBytes: null,
    thumbnailUrl: cover.url,
    quality: 'source',
  }
}

/** Convierte el JSON interno de Meta en un contrato pequeño y estable para el frontend. */
export function normalizeInstagramMedia(media, source) {
  if (!hasMediaShape(media)) {
    throw new InstagramApiError(
      'PRIVATE_OR_UNAVAILABLE',
      'La publicación es privada, fue eliminada o no está disponible.',
      422,
    )
  }

  const id = cleanString(media.code) ?? source.id
  const rawItems = Array.isArray(media.carousel_media) ? media.carousel_media : [media]
  const items = rawItems
    .map((item, zeroBasedIndex) => normalizeItem(item, zeroBasedIndex + 1, id))
    .filter(Boolean)
  if (!items.length) {
    throw new InstagramApiError(
      'PRIVATE_OR_UNAVAILABLE',
      'Instagram no entregó archivos descargables para ese enlace.',
      422,
    )
  }

  const rawAuthor = isRecord(media.user) ? media.user : {}
  const username = cleanString(rawAuthor.username) ?? 'instagram'
  const avatarUrl = safeMediaUrl(rawAuthor.profile_pic_url, 'image')
  const caption = isRecord(media.caption) ? cleanString(media.caption.text) : undefined
  const kind = rawItems.length > 1
    ? 'carousel'
    : items[0].type === 'video'
      ? 'video'
      : 'photo'
  const durationMedia = rawItems.find((item) => isRecord(item) && Array.isArray(item.video_versions))
    ?? media
  const dash = parseDashMetadata(durationMedia.video_dash_manifest)
  const durationSeconds = kind === 'video'
    ? finiteNumber(durationMedia.video_duration ?? durationMedia.duration, 86_400)
      ?? dash.durationSeconds
      ?? null
    : null
  const thumbnail = items[0].thumbnailUrl

  return {
    id,
    title: caption ?? `Instagram de @${username}`,
    caption: caption ?? null,
    durationSeconds,
    coverUrl: thumbnail,
    thumbnail,
    author: {
      name: cleanString(rawAuthor.full_name) ?? username,
      handle: username,
      avatarUrl: avatarUrl ?? null,
    },
    items,
    platform: 'instagram',
    sourceUrl: source.url,
    kind,
    takenAt: finiteInteger(media.taken_at) ?? null,
  }
}

async function enrichItemSizes(result, fetchImpl, signal) {
  const items = await Promise.all(result.items.map(async (item) => {
    try {
      const response = await fetchImpl(item.url, {
        method: 'HEAD',
        headers: { Accept: item.mimeType },
        redirect: 'manual',
        signal,
      })
      await response.body?.cancel()
      if (!response.ok || response.status >= 300) return item
      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
      if (contentType && contentType !== item.mimeType) return item
      const sizeBytes = finiteInteger(response.headers.get('content-length'))
      return sizeBytes ? { ...item, sizeBytes } : item
    } catch (error) {
      if (signal?.aborted) throw error
      return item
    }
  }))
  return { ...result, items }
}

function fallbackRecords(payload) {
  if (!isRecord(payload) || payload.status !== 'success') return []
  const data = payload.data
  return Array.isArray(data) ? data.filter(isRecord) : isRecord(data) ? [data] : []
}

function fallbackUrls(record) {
  const numbered = Object.entries(record)
    .flatMap(([key, value]) => {
      const match = key.match(/^media_url_(\d+)$/i)
      const url = cleanString(value)
      return match && url ? [{ index: Number(match[1]), url }] : []
    })
    .sort((left, right) => left.index - right.index)
    .map(({ url }) => url)
  return numbered.length ? numbered : [cleanString(record.url)].filter(Boolean)
}

function fallbackMediaType(contentType) {
  if (contentType === 'video/mp4') {
    return { type: 'video', mimeType: 'video/mp4', extension: 'mp4' }
  }
  if (contentType === 'image/jpeg') {
    return { type: 'image', mimeType: 'image/jpeg', extension: 'jpg' }
  }
  if (contentType === 'image/png') {
    return { type: 'image', mimeType: 'image/png', extension: 'png' }
  }
  if (contentType === 'image/webp') {
    return { type: 'image', mimeType: 'image/webp', extension: 'webp' }
  }
  if (contentType === 'image/avif') {
    return { type: 'image', mimeType: 'image/avif', extension: 'avif' }
  }
  return undefined
}

function totalBytesFromResponse(response) {
  const range = response.headers.get('content-range')
  const total = range?.match(/\/(\d+)$/)?.[1]
  return finiteInteger(total) ?? finiteInteger(response.headers.get('content-length'))
}

async function inspectFallbackMedia(url, fetchImpl, signal) {
  if (!isAllowedFallbackMediaUrl(url)) return undefined
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { Accept: 'video/mp4,image/avif,image/webp,image/png,image/jpeg', Range: 'bytes=0-0' },
    redirect: 'manual',
    signal,
  })
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  const format = fallbackMediaType(contentType)
  const sizeBytes = totalBytesFromResponse(response)
  await response.body?.cancel()
  if ((!response.ok && response.status !== 206) || response.status >= 300 || !format) {
    return undefined
  }
  return { url, ...format, sizeBytes: sizeBytes ?? null }
}

async function fetchInstagramFallback(source, fetchImpl, signal) {
  const endpoint = new URL(FALLBACK_API_URL)
  endpoint.searchParams.set('url', source.url)
  const response = await fetchImpl(endpoint, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    redirect: 'manual',
    signal,
  })
  if (!response.ok || response.status >= 300) {
    await response.body?.cancel()
    throw new InstagramApiError(
      'FALLBACK_UNAVAILABLE',
      'Instagram no pudo entregar esa publicación en este momento.',
      502,
    )
  }
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    await response.body?.cancel()
    throw new InstagramApiError(
      'INVALID_RESPONSE',
      'El respaldo de Instagram devolvió una respuesta inesperada.',
      502,
    )
  }

  let payload
  try {
    payload = JSON.parse(await readBoundedHtml(response, MAX_FALLBACK_JSON_BYTES))
  } catch (error) {
    if (error instanceof InstagramApiError) throw error
    throw new InstagramApiError(
      'INVALID_RESPONSE',
      'El respaldo de Instagram devolvió una respuesta ilegible.',
      502,
    )
  }

  const records = fallbackRecords(payload)
  const urls = [...new Set(records.flatMap(fallbackUrls))]
  if (!urls.length || urls.length > 20 || urls.some((url) => !isAllowedFallbackMediaUrl(url))) {
    throw new InstagramApiError(
      'INVALID_RESPONSE',
      'El respaldo de Instagram no entregó archivos válidos.',
      502,
    )
  }

  const inspected = await Promise.all(urls.map((url) => (
    inspectFallbackMedia(url, fetchImpl, signal)
  )))
  const files = inspected.filter(Boolean)
  if (files.length !== urls.length) {
    throw new InstagramApiError(
      'INVALID_RESPONSE',
      'No fue posible verificar todos los archivos de Instagram.',
      502,
    )
  }

  const thumbnail = records
    .map((record) => cleanString(record.thumbnail))
    .find((url) => url && isAllowedFallbackMediaUrl(url))
  const items = files.map((file, zeroBasedIndex) => ({
    id: `${source.id}-${zeroBasedIndex + 1}`,
    index: zeroBasedIndex + 1,
    type: file.type,
    url: file.url,
    mimeType: file.mimeType,
    extension: file.extension,
    width: null,
    height: null,
    fps: null,
    codec: null,
    bitrateBps: null,
    sizeBytes: file.sizeBytes,
    thumbnailUrl: file.type === 'video' ? thumbnail ?? null : file.url,
    quality: 'source',
  }))
  const kind = items.length > 1
    ? 'carousel'
    : items[0].type === 'video'
      ? 'video'
      : 'photo'
  const coverUrl = thumbnail ?? items[0].thumbnailUrl
  return {
    id: source.id,
    title: 'Publicación de Instagram',
    caption: null,
    durationSeconds: null,
    coverUrl,
    thumbnail: coverUrl,
    author: { name: 'Instagram', handle: 'instagram', avatarUrl: null },
    items,
    platform: 'instagram',
    sourceUrl: source.url,
    kind,
    takenAt: null,
  }
}

export async function resolveInstagramUrl(value, options = {}) {
  const source = parseInstagramUrl(value)
  const fetchImpl = options.fetchImpl ?? fetch
  try {
    const html = await fetchInstagramDocument(source.url, fetchImpl, options.signal)
    const media = extractInstagramMedia(html, source.id)
    if (!media) {
      if (/\/(?:accounts\/login|challenge)\b|login_required|loginForm/i.test(html)) {
        throw new InstagramApiError(
          'UPSTREAM_AUTH_REQUIRED',
          'Instagram exigió iniciar sesión desde el servidor.',
          502,
        )
      }
      throw new InstagramApiError(
        'IDENTITY_UNVERIFIED',
        'Instagram no permitió verificar la publicación solicitada.',
        502,
      )
    }
    const result = normalizeInstagramMedia(media, source)
    return enrichItemSizes(result, fetchImpl, options.signal)
  } catch (error) {
    if (
      !(error instanceof InstagramApiError)
      || !FALLBACK_ELIGIBLE_ERRORS.has(error.code)
      || options.signal?.aborted
    ) {
      throw error
    }
    return fetchInstagramFallback(source, fetchImpl, options.signal)
  }
}

function json(body, status) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

export default {
  async fetch(request) {
    if (request.method !== 'GET') {
      return new Response(null, {
        status: 405,
        headers: { Allow: 'GET', 'Cache-Control': 'no-store' },
      })
    }

    const input = new URL(request.url).searchParams.get('url') ?? ''
    const controller = new AbortController()
    const onAbort = () => controller.abort(request.signal.reason)
    request.signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)

    try {
      const result = await resolveInstagramUrl(input, { signal: controller.signal })
      return json({ data: result }, 200)
    } catch (error) {
      if (error instanceof InstagramApiError) {
        return json({ error: { code: error.code, message: error.message } }, error.status)
      }
      if (error instanceof DOMException && error.name === 'AbortError') {
        return json({
          error: {
            code: 'TIMEOUT',
            message: 'Instagram tardó demasiado en responder. Inténtalo de nuevo.',
          },
        }, 504)
      }
      return json({
        error: {
          code: 'UPSTREAM_ERROR',
          message: 'No se pudo conectar con Instagram en este momento.',
        },
      }, 502)
    } finally {
      clearTimeout(timer)
      request.signal.removeEventListener('abort', onAbort)
    }
  },
}
