const PREFIX_BYTES = 512 * 1024
const SUFFIX_BYTES = 1024 * 1024
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const UPSTREAM_TIMEOUT_MS = 7_000

function readAscii(view, offset, length) {
  if (offset < 0 || offset + length > view.byteLength) return ''
  let value = ''
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(view.getUint8(offset + index))
  }
  return value
}

function readBox(view, start, limit = view.byteLength) {
  if (start < 0 || start + 8 > limit) return undefined
  const size32 = view.getUint32(start)
  const type = readAscii(view, start + 4, 4)
  let headerSize = 8
  let size = size32

  if (size32 === 1) {
    if (start + 16 > limit) return undefined
    const size64 = view.getBigUint64(start + 8)
    if (size64 > BigInt(Number.MAX_SAFE_INTEGER)) return undefined
    size = Number(size64)
    headerSize = 16
  } else if (size32 === 0) {
    size = limit - start
  }

  if (size < headerSize || start + size > limit) return undefined
  return { dataStart: start + headerSize, end: start + size, type }
}

function childBoxes(view, parent) {
  const boxes = []
  let cursor = parent.dataStart
  while (cursor + 8 <= parent.end) {
    const box = readBox(view, cursor, parent.end)
    if (!box) break
    boxes.push(box)
    if (box.end <= cursor) break
    cursor = box.end
  }
  return boxes
}

function childBox(view, parent, type) {
  return childBoxes(view, parent).find((box) => box.type === type)
}

function findContainedBox(view, type) {
  for (let offset = 4; offset + 4 <= view.byteLength; offset += 1) {
    if (readAscii(view, offset, 4) !== type) continue
    const box = readBox(view, offset - 4)
    if (box?.type === type) return box
  }
  return undefined
}

function handlerType(view, track) {
  const media = childBox(view, track, 'mdia')
  const handler = media ? childBox(view, media, 'hdlr') : undefined
  if (!handler || handler.dataStart + 12 > handler.end) return undefined
  return readAscii(view, handler.dataStart + 8, 4)
}

function codecName(sampleEntry) {
  return {
    avc1: 'H.264',
    avc3: 'H.264',
    hvc1: 'HEVC',
    hev1: 'HEVC',
    av01: 'AV1',
    vp09: 'VP9',
  }[sampleEntry]
}

function parseMp4VideoMetadata(buffer) {
  const view = new DataView(buffer)
  const movie = findContainedBox(view, 'moov')
  if (!movie) return undefined
  const track = childBoxes(view, movie)
    .filter((box) => box.type === 'trak')
    .find((candidate) => handlerType(view, candidate) === 'vide')
  if (!track) return undefined

  const trackHeader = childBox(view, track, 'tkhd')
  if (!trackHeader || trackHeader.end - 8 < trackHeader.dataStart) return undefined
  const width = Math.round(view.getUint32(trackHeader.end - 8) / 65_536)
  const height = Math.round(view.getUint32(trackHeader.end - 4) / 65_536)
  if (width < 1 || height < 1 || width > 16_384 || height > 16_384) return undefined

  const media = childBox(view, track, 'mdia')
  const mediaInfo = media ? childBox(view, media, 'minf') : undefined
  const sampleTable = mediaInfo ? childBox(view, mediaInfo, 'stbl') : undefined
  const sampleDescription = sampleTable ? childBox(view, sampleTable, 'stsd') : undefined
  const codec = sampleDescription && sampleDescription.dataStart + 16 <= sampleDescription.end
    ? codecName(readAscii(view, sampleDescription.dataStart + 12, 4))
    : undefined

  let fps
  const mediaHeader = media ? childBox(view, media, 'mdhd') : undefined
  const timeToSample = sampleTable ? childBox(view, sampleTable, 'stts') : undefined
  if (mediaHeader && timeToSample && timeToSample.dataStart + 8 <= timeToSample.end) {
    const version = view.getUint8(mediaHeader.dataStart)
    const timescaleOffset = mediaHeader.dataStart + (version === 1 ? 20 : 12)
    const timescale = timescaleOffset + 4 <= mediaHeader.end
      ? view.getUint32(timescaleOffset)
      : 0
    const entryCount = view.getUint32(timeToSample.dataStart + 4)
    let cursor = timeToSample.dataStart + 8
    let samples = 0
    let ticks = 0
    for (let index = 0; index < entryCount && cursor + 8 <= timeToSample.end; index += 1) {
      const sampleCount = view.getUint32(cursor)
      const sampleDelta = view.getUint32(cursor + 4)
      samples += sampleCount
      ticks += sampleCount * sampleDelta
      cursor += 8
    }
    const measuredFps = samples > 0 && ticks > 0 ? (samples * timescale) / ticks : 0
    if (Number.isFinite(measuredFps) && measuredFps >= 1 && measuredFps <= 240) {
      fps = Math.round(measuredFps * 100) / 100
    }
  }

  return { width, height, codec, fps }
}

export function isAllowedTokCdnUrl(value) {
  if (!value || value.length > 4_096) return false
  try {
    const parsed = new URL(value)
    return (
      parsed.protocol === 'https:'
      && !parsed.username
      && !parsed.password
      && !parsed.port
      && !parsed.hash
      && parsed.hostname.toLowerCase() === 'v16.tokcdn.com'
      && parsed.pathname.toLowerCase().endsWith('.mp4')
    )
  } catch {
    return false
  }
}

async function readBoundedBody(response, maximumBytes) {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel()
    return undefined
  }
  if (!response.body) {
    const buffer = await response.arrayBuffer()
    return buffer.byteLength <= maximumBytes ? buffer : undefined
  }

  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maximumBytes || total > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      return undefined
    }
    chunks.push(value)
  }
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output.buffer
}

async function fetchRange(url, range, maximumBytes, signal) {
  const response = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'video/mp4', 'Accept-Encoding': 'identity', Range: range },
    redirect: 'manual',
    signal,
  })
  if (!response.ok || response.status !== 206) return undefined
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  const contentRange = response.headers.get('content-range')
  const rangeMatch = contentRange?.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/i)
  if (contentType !== 'video/mp4' || !rangeMatch) {
    await response.body?.cancel()
    return undefined
  }
  const firstByte = Number(rangeMatch[1])
  const lastByte = Number(rangeMatch[2])
  if (
    !Number.isSafeInteger(firstByte)
    || !Number.isSafeInteger(lastByte)
    || lastByte < firstByte
    || lastByte - firstByte + 1 > maximumBytes
  ) {
    await response.body?.cancel()
    return undefined
  }
  return readBoundedBody(response, maximumBytes)
}

async function inspect(url, signal) {
  const prefix = await fetchRange(url, `bytes=0-${PREFIX_BYTES - 1}`, PREFIX_BYTES, signal)
  const prefixMetadata = prefix ? parseMp4VideoMetadata(prefix) : undefined
  if (prefixMetadata) return prefixMetadata
  const suffix = await fetchRange(url, `bytes=-${SUFFIX_BYTES}`, SUFFIX_BYTES, signal)
  return suffix ? parseMp4VideoMetadata(suffix) : undefined
}

function json(body, status) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
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

    const videoUrl = new URL(request.url).searchParams.get('url') ?? ''
    if (!isAllowedTokCdnUrl(videoUrl)) {
      return json({ error: 'URL de video no permitida.' }, 400)
    }

    const controller = new AbortController()
    const onAbort = () => controller.abort(request.signal.reason)
    request.signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
    try {
      const metadata = await inspect(videoUrl, controller.signal)
      if (!metadata?.width || !metadata.height) {
        return json({ error: 'No se pudieron verificar los metadatos.' }, 422)
      }
      return json(metadata, 200)
    } catch (error) {
      const status = error instanceof DOMException && error.name === 'AbortError' ? 504 : 502
      return json({ error: 'No se pudieron verificar los metadatos.' }, status)
    } finally {
      clearTimeout(timer)
      request.signal.removeEventListener('abort', onAbort)
    }
  },
}
