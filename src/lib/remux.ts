import type { StreamTargetChunk } from 'mediabunny'
import { LinksDownloaderError, isAbortError } from './errors'

const MEBIBYTE = 1024 * 1024
const MAX_BUFFERED_SOURCE_BYTES = 64 * MEBIBYTE
const MAX_STREAMED_SOURCE_BYTES = 256 * MEBIBYTE
const SOURCE_CACHE_BYTES = 4 * MEBIBYTE
const STREAM_CHUNK_BYTES = 1 * MEBIBYTE
const MIN_DURATION_SECONDS = 0.1
const MAX_AUDIO_EDGE_DELTA_SECONDS = 0.25
const BASE_TIMELINE_TOLERANCE_SECONDS = 0.12
const PROGRESS_START_PERCENT = 8
const PROGRESS_END_PERCENT = 96

export type RemuxProgressPhase = 'analysing' | 'remuxing' | 'finalizing' | 'completed'

export interface RemuxProgress {
  phase: RemuxProgressPhase
  /** Progreso aproximado de 0 a 100 basado en la línea de tiempo procesada. */
  percent: number
  processedSeconds?: number
  durationSeconds?: number
}

export interface RemuxVideoWithBetterAudioOptions {
  videoUrl: string
  audioUrl: string
  videoSizeBytes: number
  audioSizeBytes: number
  signal?: AbortSignal
  onProgress?: (progress: RemuxProgress) => void
  /**
   * Destino con escrituras posicionadas, como FileSystemWritableFileStream.
   * Si se omite, el MP4 se devuelve como Blob con un límite conservador de memoria.
   */
  outputWritable?: WritableStream<StreamTargetChunk>
}

export interface RemuxResult {
  blob?: Blob
  bytes: number
}

interface TrackedWritable {
  writable: WritableStream<StreamTargetChunk>
  bytesWritten: () => number
  abort: (reason?: unknown) => Promise<void>
}

function domainError(message: string, cause?: unknown): LinksDownloaderError {
  return new LinksDownloaderError('INVALID_RESPONSE', message, { cause })
}

function validateMediaUrl(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.toString()
  } catch {
    // Se transforma en un error estable de dominio debajo.
  }
  throw new LinksDownloaderError('DOWNLOAD_FAILED', 'La dirección del video no es válida.')
}

function validateDeclaredSize(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new LinksDownloaderError(
      'DOWNLOAD_FAILED',
      `No se pudo verificar el tamaño del archivo de ${label}.`,
    )
  }
  return value
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new LinksDownloaderError('ABORTED', 'La descarga fue cancelada.', {
      cause: signal.reason,
    })
  }
}

function reportProgress(
  callback: RemuxVideoWithBetterAudioOptions['onProgress'],
  progress: RemuxProgress,
): void {
  try {
    callback?.(progress)
  } catch {
    // Un callback visual nunca debe corromper ni cancelar el archivo.
  }
}

function finiteTimelineValue(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw domainError(`No se pudo leer el reloj de ${label}.`)
  }
  return value
}

function timelineSpan(start: number, end: number, label: string): number {
  const span = end - start
  if (!Number.isFinite(span) || span < MIN_DURATION_SECONDS) {
    throw domainError(`La pista de ${label} no tiene una duración válida.`)
  }
  return span
}

function createTrackedWritable(destination: WritableStream<StreamTargetChunk>): TrackedWritable {
  const destinationWriter = destination.getWriter()
  let maximumEnd = 0
  let settled = false

  const writable = new WritableStream<StreamTargetChunk>({
    async write(chunk) {
      const end = chunk.position + chunk.data.byteLength
      if (!Number.isSafeInteger(end) || chunk.position < 0) {
        throw new LinksDownloaderError(
          'DOWNLOAD_FAILED',
          'El navegador produjo una escritura de archivo no válida.',
        )
      }
      maximumEnd = Math.max(maximumEnd, end)
      await destinationWriter.write(chunk)
    },
    async close() {
      settled = true
      await destinationWriter.close()
    },
    async abort(reason) {
      settled = true
      await destinationWriter.abort(reason)
    },
  })

  return {
    writable,
    bytesWritten: () => maximumEnd,
    abort: async (reason) => {
      if (settled) return
      settled = true
      try {
        await destinationWriter.abort(reason)
      } catch {
        // La operación original conserva el error útil para la interfaz.
      }
    },
  }
}

/**
 * Conserva el video de mayor calidad y reemplaza únicamente su pista de audio.
 * Los paquetes codificados se copian al MP4 de salida: no hay decode, encode,
 * cambio de FPS, resampleo ni alteración del bitrate.
 */
export async function remuxVideoWithBetterAudio(
  options: RemuxVideoWithBetterAudioOptions,
): Promise<RemuxResult> {
  throwIfAborted(options.signal)

  const videoUrl = validateMediaUrl(options.videoUrl)
  const audioUrl = validateMediaUrl(options.audioUrl)
  const videoSizeBytes = validateDeclaredSize(options.videoSizeBytes, 'video')
  const audioSizeBytes = validateDeclaredSize(options.audioSizeBytes, 'audio')
  const combinedSourceBytes = videoSizeBytes + audioSizeBytes
  const maximumSourceBytes = options.outputWritable
    ? MAX_STREAMED_SOURCE_BYTES
    : MAX_BUFFERED_SOURCE_BYTES

  if (!Number.isSafeInteger(combinedSourceBytes) || combinedSourceBytes > maximumSourceBytes) {
    const limitMegabytes = maximumSourceBytes / MEBIBYTE
    throw new LinksDownloaderError(
      'DOWNLOAD_FAILED',
      options.outputWritable
        ? `Los archivos superan el límite seguro de ${limitMegabytes} MB.`
        : `La mezcla necesita más de ${limitMegabytes} MB de memoria.`,
    )
  }

  reportProgress(options.onProgress, { phase: 'analysing', percent: 0 })
  throwIfAborted(options.signal)

  let disposeVideoInput: (() => void) | undefined
  let disposeAudioInput: (() => void) | undefined
  let cancelOutput: (() => Promise<void>) | undefined
  let trackedWritable: TrackedWritable | undefined
  let finalized = false

  const abortInputs = () => {
    disposeVideoInput?.()
    disposeAudioInput?.()
  }
  options.signal?.addEventListener('abort', abortInputs, { once: true })

  try {
    const {
      BufferTarget,
      EncodedAudioPacketSource,
      EncodedPacketSink,
      EncodedVideoPacketSource,
      Input,
      MP4,
      Mp4OutputFormat,
      Output,
      StreamTarget,
      UrlSource,
    } = await import('mediabunny')

    throwIfAborted(options.signal)

    const sourceOptions = {
      maxCacheSize: SOURCE_CACHE_BYTES,
      parallelism: 2,
      requestInit: {
        cache: 'no-store' as const,
        credentials: 'omit' as const,
        mode: 'cors' as const,
        referrerPolicy: 'no-referrer' as const,
      },
    }
    const videoInput = new Input({
      formats: [MP4],
      source: new UrlSource(videoUrl, sourceOptions),
    })
    const audioInput = new Input({
      formats: [MP4],
      source: new UrlSource(audioUrl, sourceOptions),
    })
    disposeVideoInput = () => videoInput.dispose()
    disposeAudioInput = () => audioInput.dispose()

    const [videoTrack, donorVideoTrack, audioTrack] = await Promise.all([
      videoInput.getPrimaryVideoTrack(),
      audioInput.getPrimaryVideoTrack(),
      audioInput.getPrimaryAudioTrack(),
    ])
    throwIfAborted(options.signal)

    if (!videoTrack) throw domainError('El archivo de máxima calidad no contiene video.')
    if (!donorVideoTrack || !audioTrack) {
      throw domainError('El archivo alternativo no contiene video y audio compatibles.')
    }

    const [
      videoCodec,
      audioCodec,
      videoDecoderConfig,
      audioDecoderConfig,
      rotation,
      targetVideoStart,
      targetVideoEnd,
      donorVideoStart,
      donorVideoEnd,
      donorAudioStart,
      donorAudioEnd,
    ] = await Promise.all([
      videoTrack.getCodec(),
      audioTrack.getCodec(),
      videoTrack.getDecoderConfig(),
      audioTrack.getDecoderConfig(),
      videoTrack.getRotation(),
      videoTrack.getFirstTimestamp(),
      videoTrack.computeDuration(),
      donorVideoTrack.getFirstTimestamp(),
      donorVideoTrack.computeDuration(),
      audioTrack.getFirstTimestamp(),
      audioTrack.computeDuration(),
    ])
    throwIfAborted(options.signal)

    if (!videoCodec || !videoDecoderConfig) {
      throw domainError('El codec de video no se puede copiar a un MP4.')
    }
    if (!audioCodec || !audioDecoderConfig) {
      throw domainError('El codec de audio no se puede copiar a un MP4.')
    }

    const targetStart = finiteTimelineValue(targetVideoStart, 'video')
    const targetEnd = finiteTimelineValue(targetVideoEnd, 'video')
    const donorStart = finiteTimelineValue(donorVideoStart, 'video alternativo')
    const donorEnd = finiteTimelineValue(donorVideoEnd, 'video alternativo')
    const audioStart = finiteTimelineValue(donorAudioStart, 'audio')
    const audioEnd = finiteTimelineValue(donorAudioEnd, 'audio')
    const targetSpan = timelineSpan(targetStart, targetEnd, 'video')
    const donorVideoSpan = timelineSpan(donorStart, donorEnd, 'video alternativo')
    const donorAudioSpan = timelineSpan(audioStart, audioEnd, 'audio')

    const timelineTolerance = BASE_TIMELINE_TOLERANCE_SECONDS
    if (Math.abs(targetSpan - donorVideoSpan) > timelineTolerance) {
      throw domainError('Las dos versiones del video no comparten la misma duración.')
    }

    const alignedAudioStart = audioStart - donorStart
    const alignedAudioEnd = audioEnd - donorStart
    if (
      alignedAudioEnd < targetSpan - MAX_AUDIO_EDGE_DELTA_SECONDS
      || alignedAudioEnd > targetSpan + MAX_AUDIO_EDGE_DELTA_SECONDS
      || donorAudioSpan < targetSpan - MAX_AUDIO_EDGE_DELTA_SECONDS
    ) {
      throw domainError('El audio alternativo no está sincronizado con el video.')
    }

    const format = new Mp4OutputFormat({ fastStart: false })
    if (!format.getSupportedVideoCodecs().includes(videoCodec)) {
      throw domainError(`El codec de video ${videoCodec} no es compatible con MP4.`)
    }
    if (!format.getSupportedAudioCodecs().includes(audioCodec)) {
      throw domainError(`El codec de audio ${audioCodec} no es compatible con MP4.`)
    }

    const bufferTarget = options.outputWritable ? undefined : new BufferTarget()
    if (options.outputWritable) trackedWritable = createTrackedWritable(options.outputWritable)
    const target = bufferTarget ?? new StreamTarget(
      trackedWritable!.writable,
      { chunked: true, chunkSize: STREAM_CHUNK_BYTES },
    )
    const output = new Output({ format, target })
    cancelOutput = () => output.cancel()

    const videoSource = new EncodedVideoPacketSource(videoCodec)
    const audioSource = new EncodedAudioPacketSource(audioCodec)
    output.addVideoTrack(videoSource, { rotation })
    output.addAudioTrack(audioSource)
    await output.start()
    throwIfAborted(options.signal)

    const videoPackets = new EncodedPacketSink(videoTrack).packets()[Symbol.asyncIterator]()
    const audioPackets = new EncodedPacketSink(audioTrack).packets()[Symbol.asyncIterator]()
    let [nextVideo, nextAudio] = await Promise.all([videoPackets.next(), audioPackets.next()])
    throwIfAborted(options.signal)

    if (nextVideo.done) throw domainError('La pista de video no contiene fotogramas.')
    if (nextAudio.done) throw domainError('La pista de audio no contiene muestras.')

    // Conserva el pre-roll AAC. Mediabunny no acepta timestamps negativos, por
    // eso se mueve la línea de tiempo completa, manteniendo intacta la relación A/V.
    const globalShift = Math.max(0, -alignedAudioStart)
    const progressDuration = targetSpan + globalShift
    let firstVideoPacket = true
    let firstAudioPacket = true
    let furthestTimestamp = 0
    let lastReportedPercent = PROGRESS_START_PERCENT - 1

    reportProgress(options.onProgress, {
      phase: 'remuxing',
      percent: PROGRESS_START_PERCENT,
      processedSeconds: 0,
      durationSeconds: progressDuration,
    })

    while (!nextVideo.done || !nextAudio.done) {
      throwIfAborted(options.signal)

      const videoTimestamp = nextVideo.done
        ? Number.POSITIVE_INFINITY
        : nextVideo.value.timestamp - targetStart + globalShift
      const audioTimestamp = nextAudio.done
        ? Number.POSITIVE_INFINITY
        : nextAudio.value.timestamp - donorStart + globalShift

      if (!nextVideo.done && (nextAudio.done || videoTimestamp <= audioTimestamp)) {
        const packet = nextVideo.value
        await videoSource.add(
          packet.clone({ timestamp: videoTimestamp }),
          firstVideoPacket ? { decoderConfig: videoDecoderConfig } : undefined,
        )
        firstVideoPacket = false
        furthestTimestamp = Math.max(furthestTimestamp, videoTimestamp + packet.duration)
        nextVideo = await videoPackets.next()
      } else if (!nextAudio.done) {
        const packet = nextAudio.value
        await audioSource.add(
          packet.clone({ timestamp: audioTimestamp }),
          firstAudioPacket ? { decoderConfig: audioDecoderConfig } : undefined,
        )
        firstAudioPacket = false
        furthestTimestamp = Math.max(furthestTimestamp, audioTimestamp + packet.duration)
        nextAudio = await audioPackets.next()
      } else {
        break
      }

      const ratio = Math.min(1, furthestTimestamp / progressDuration)
      const percent = Math.min(
        PROGRESS_END_PERCENT,
        PROGRESS_START_PERCENT
          + ratio * (PROGRESS_END_PERCENT - PROGRESS_START_PERCENT),
      )
      if (percent - lastReportedPercent >= 0.5) {
        lastReportedPercent = percent
        reportProgress(options.onProgress, {
          phase: 'remuxing',
          percent,
          processedSeconds: Math.min(furthestTimestamp, progressDuration),
          durationSeconds: progressDuration,
        })
      }
    }

    videoSource.close()
    audioSource.close()
    reportProgress(options.onProgress, {
      phase: 'finalizing',
      percent: PROGRESS_END_PERCENT,
      processedSeconds: progressDuration,
      durationSeconds: progressDuration,
    })
    await output.finalize()
    finalized = true
    throwIfAborted(options.signal)

    if (bufferTarget) {
      const buffer = bufferTarget.buffer
      if (!buffer || buffer.byteLength === 0) {
        throw new LinksDownloaderError('DOWNLOAD_FAILED', 'No se pudo crear el archivo final.')
      }
      const blob = new Blob([buffer], { type: 'video/mp4' })
      reportProgress(options.onProgress, { phase: 'completed', percent: 100 })
      return { blob, bytes: buffer.byteLength }
    }

    const bytes = trackedWritable?.bytesWritten() ?? 0
    if (bytes <= 0) {
      throw new LinksDownloaderError('DOWNLOAD_FAILED', 'No se pudo escribir el archivo final.')
    }
    reportProgress(options.onProgress, { phase: 'completed', percent: 100 })
    return { bytes }
  } catch (error) {
    if (!finalized) {
      try {
        await cancelOutput?.()
      } catch {
        // El error original describe mejor el fallo.
      }
      await trackedWritable?.abort(error)
    }

    if (options.signal?.aborted || isAbortError(error)) {
      throw new LinksDownloaderError('ABORTED', 'La descarga fue cancelada.', { cause: error })
    }
    if (error instanceof LinksDownloaderError) throw error
    throw new LinksDownloaderError(
      'DOWNLOAD_FAILED',
      'No se pudo combinar el video con el audio de mayor calidad.',
      { cause: error },
    )
  } finally {
    options.signal?.removeEventListener('abort', abortInputs)
    disposeVideoInput?.()
    disposeAudioInput?.()
  }
}
