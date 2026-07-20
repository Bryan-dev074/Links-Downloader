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

function audioCodecName(sampleEntry) {
  return {
    mp4a: 'AAC',
    Opus: 'Opus',
    opus: 'Opus',
    '.mp3': 'MP3',
    alac: 'ALAC',
    'ac-3': 'AC-3',
    'ec-3': 'E-AC-3',
  }[sampleEntry]
}

function sampleTable(view, track) {
  const media = childBox(view, track, 'mdia')
  const mediaInfo = media ? childBox(view, media, 'minf') : undefined
  return mediaInfo ? childBox(view, mediaInfo, 'stbl') : undefined
}

function firstSampleEntry(view, track) {
  const table = sampleTable(view, track)
  const description = table ? childBox(view, table, 'stsd') : undefined
  if (!description || description.dataStart + 8 > description.end) return undefined
  if (view.getUint32(description.dataStart + 4) < 1) return undefined
  return readBox(view, description.dataStart + 8, description.end)
}

function mediaTiming(view, track) {
  const media = childBox(view, track, 'mdia')
  const header = media ? childBox(view, media, 'mdhd') : undefined
  if (!header || header.dataStart + 4 > header.end) return undefined
  const version = view.getUint8(header.dataStart)
  if (version !== 0 && version !== 1) return undefined
  const timescaleOffset = header.dataStart + (version === 1 ? 20 : 12)
  const durationOffset = timescaleOffset + 4
  const durationBytes = version === 1 ? 8 : 4
  if (durationOffset + durationBytes > header.end) return undefined
  const timescale = view.getUint32(timescaleOffset)
  if (timescale <= 0) return undefined
  const rawDuration = version === 1
    ? view.getBigUint64(durationOffset)
    : BigInt(view.getUint32(durationOffset))
  const durationSeconds = rawDuration > 0n && rawDuration <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(rawDuration) / timescale
    : undefined
  return {
    timescale,
    durationSeconds: durationSeconds && Number.isFinite(durationSeconds)
      ? Math.round(durationSeconds * 1000) / 1000
      : undefined,
  }
}

function sampleDurationSeconds(view, track) {
  const timing = mediaTiming(view, track)
  const table = sampleTable(view, track)
  const timeToSample = table ? childBox(view, table, 'stts') : undefined
  if (!timing || !timeToSample || timeToSample.dataStart + 8 > timeToSample.end) {
    return timing?.durationSeconds
  }
  const entryCount = view.getUint32(timeToSample.dataStart + 4)
  let cursor = timeToSample.dataStart + 8
  let ticks = 0n
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 8 > timeToSample.end) return timing.durationSeconds
    ticks += BigInt(view.getUint32(cursor)) * BigInt(view.getUint32(cursor + 4))
    cursor += 8
  }
  if (ticks <= 0n || ticks > BigInt(Number.MAX_SAFE_INTEGER)) return timing.durationSeconds
  const duration = Number(ticks) / timing.timescale
  return Number.isFinite(duration) && duration > 0
    ? Math.round(duration * 1000) / 1000
    : timing.durationSeconds
}

function framesPerSecond(view, track) {
  const timing = mediaTiming(view, track)
  const table = sampleTable(view, track)
  const timeToSample = table ? childBox(view, table, 'stts') : undefined
  if (!timing || !timeToSample || timeToSample.dataStart + 8 > timeToSample.end) return undefined
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
  const measured = samples > 0 && ticks > 0 ? (samples * timing.timescale) / ticks : 0
  return Number.isFinite(measured) && measured >= 1 && measured <= 240
    ? Math.round(measured * 100) / 100
    : undefined
}

function descriptorPayload(view, descriptorOffset, limit) {
  let cursor = descriptorOffset + 1
  let length = 0
  for (let index = 0; index < 4; index += 1) {
    if (cursor >= limit) return undefined
    const value = view.getUint8(cursor)
    cursor += 1
    length = (length << 7) | (value & 0x7f)
    if ((value & 0x80) === 0) {
      return cursor + length <= limit ? { start: cursor, end: cursor + length } : undefined
    }
  }
  return undefined
}

function parseAacConfig(view, start, end) {
  let bitOffset = 0
  const bitLength = (end - start) * 8
  const readBits = (count) => {
    if (count < 1 || bitOffset + count > bitLength) return undefined
    let value = 0
    for (let index = 0; index < count; index += 1) {
      const absoluteBit = bitOffset + index
      const byte = view.getUint8(start + Math.floor(absoluteBit / 8))
      value = (value << 1) | ((byte >> (7 - (absoluteBit % 8))) & 1)
    }
    bitOffset += count
    return value
  }
  const readAudioObjectType = () => {
    const base = readBits(5)
    if (base === undefined) return undefined
    if (base !== 31) return base
    const extension = readBits(6)
    return extension === undefined ? undefined : 32 + extension
  }
  const sampleRates = [
    96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000,
    22_050, 16_000, 12_000, 11_025, 8_000, 7_350,
  ]
  const readSampleRate = () => {
    const index = readBits(4)
    if (index === undefined) return undefined
    if (index === 15) return readBits(24)
    return sampleRates[index]
  }
  const audioObjectType = readAudioObjectType()
  const baseSampleRate = readSampleRate()
  const channelConfiguration = readBits(4)
  if (audioObjectType === undefined) return undefined
  const profiles = { 2: 'AAC-LC', 5: 'HE-AAC', 29: 'HE-AACv2', 42: 'xHE-AAC' }
  let effectiveSampleRate = baseSampleRate
  if (audioObjectType === 5 || audioObjectType === 29) {
    effectiveSampleRate = readSampleRate() ?? baseSampleRate
  }
  return {
    profile: profiles[audioObjectType],
    sampleRateHz: effectiveSampleRate,
    channels: channelConfiguration && channelConfiguration <= 2
      ? channelConfiguration
      : undefined,
  }
}

function aacConfig(view, entry) {
  let esds
  for (let offset = entry.dataStart + 20; offset + 4 <= entry.end; offset += 1) {
    if (readAscii(view, offset, 4) !== 'esds') continue
    const candidate = readBox(view, offset - 4, entry.end)
    if (candidate?.type === 'esds') {
      esds = candidate
      break
    }
  }
  if (!esds) return undefined
  for (let offset = esds.dataStart + 4; offset + 3 <= esds.end; offset += 1) {
    if (view.getUint8(offset) !== 0x05) continue
    const payload = descriptorPayload(view, offset, esds.end)
    if (!payload || payload.end - payload.start < 2 || payload.end - payload.start > 8) continue
    const config = parseAacConfig(view, payload.start, payload.end)
    if (config) return config
  }
  return undefined
}

function audioSampleMetadata(view, track) {
  const entry = firstSampleEntry(view, track)
  if (!entry) return {}
  const audioCodec = audioCodecName(entry.type)
  const config = entry.type === 'mp4a' ? aacConfig(view, entry) : undefined
  const audioProfile = config?.profile
  if (entry.dataStart + 28 > entry.end) {
    return {
      audioCodec,
      audioProfile,
      audioSampleRateHz: config?.sampleRateHz,
      audioChannels: config?.channels,
    }
  }
  const channels = view.getUint16(entry.dataStart + 16)
  const sampleRate = view.getUint32(entry.dataStart + 24) / 65_536
  return {
    audioCodec,
    audioProfile,
    audioChannels: channels > 0 && channels <= 32 ? channels : config?.channels,
    audioSampleRateHz: config?.sampleRateHz ?? (
      sampleRate >= 8_000 && sampleRate <= 768_000 ? Math.round(sampleRate) : undefined
    ),
  }
}

function trackPayloadBytes(view, track) {
  const table = sampleTable(view, track)
  const sampleSizes = table ? childBox(view, table, 'stsz') : undefined
  if (!sampleSizes || sampleSizes.dataStart + 12 > sampleSizes.end) return undefined
  const uniformSize = view.getUint32(sampleSizes.dataStart + 4)
  const sampleCount = view.getUint32(sampleSizes.dataStart + 8)
  if (sampleCount === 0) return undefined
  if (uniformSize > 0) {
    const total = uniformSize * sampleCount
    return Number.isSafeInteger(total) ? total : undefined
  }
  let cursor = sampleSizes.dataStart + 12
  let total = 0
  for (let index = 0; index < sampleCount; index += 1) {
    if (cursor + 4 > sampleSizes.end) return undefined
    total += view.getUint32(cursor)
    if (!Number.isSafeInteger(total)) return undefined
    cursor += 4
  }
  return total > 0 ? total : undefined
}

function trackBitrate(view, track, durationSeconds) {
  const bytes = trackPayloadBytes(view, track)
  if (!bytes || !durationSeconds || durationSeconds <= 0) return undefined
  const bitrate = (bytes * 8) / durationSeconds
  return Number.isFinite(bitrate) && bitrate > 0 ? Math.round(bitrate) : undefined
}

function audioSyncMetadata(videoDurationSeconds, audioDurationSeconds) {
  if (!videoDurationSeconds || !audioDurationSeconds) return {}
  const delta = Math.abs(videoDurationSeconds - audioDurationSeconds)
  const reference = Math.max(videoDurationSeconds, audioDurationSeconds)
  const tolerance = Math.max(0.25, Math.min(1, reference * 0.01))
  return {
    avDurationDeltaSeconds: Math.round(delta * 1000) / 1000,
    audioSyncIssue: delta > tolerance,
  }
}

export function parseMp4VideoMetadata(buffer) {
  const view = new DataView(buffer)
  const movie = findContainedBox(view, 'moov')
  if (!movie) return undefined
  const tracks = childBoxes(view, movie).filter((box) => box.type === 'trak')
  const track = tracks
    .find((candidate) => handlerType(view, candidate) === 'vide')
  if (!track) return undefined
  const audioTrack = tracks.find((candidate) => handlerType(view, candidate) === 'soun')

  const trackHeader = childBox(view, track, 'tkhd')
  if (!trackHeader || trackHeader.end - 8 < trackHeader.dataStart) return undefined
  const width = Math.round(view.getUint32(trackHeader.end - 8) / 65_536)
  const height = Math.round(view.getUint32(trackHeader.end - 4) / 65_536)
  if (width < 1 || height < 1 || width > 16_384 || height > 16_384) return undefined

  const videoDurationSeconds = sampleDurationSeconds(view, track)
  const audioDurationSeconds = audioTrack ? sampleDurationSeconds(view, audioTrack) : undefined
  return {
    width,
    height,
    codec: firstSampleEntry(view, track)
      ? codecName(firstSampleEntry(view, track).type)
      : undefined,
    fps: framesPerSecond(view, track),
    videoBitrateBps: trackBitrate(view, track, videoDurationSeconds),
    hasAudio: Boolean(audioTrack),
    ...(audioTrack ? audioSampleMetadata(view, audioTrack) : {}),
    audioBitrateBps: audioTrack
      ? trackBitrate(view, audioTrack, audioDurationSeconds)
      : undefined,
    videoDurationSeconds,
    audioDurationSeconds,
    ...audioSyncMetadata(videoDurationSeconds, audioDurationSeconds),
  }
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
