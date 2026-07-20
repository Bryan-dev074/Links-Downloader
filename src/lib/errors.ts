export type LinksDownloaderErrorCode =
  | 'INVALID_URL'
  | 'UNSUPPORTED_PROVIDER'
  | 'UPSTREAM_ERROR'
  | 'INVALID_RESPONSE'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'DOWNLOAD_FAILED'

export class LinksDownloaderError extends Error {
  readonly code: LinksDownloaderErrorCode
  readonly cause?: unknown

  constructor(code: LinksDownloaderErrorCode, message: string, options?: { cause?: unknown }) {
    super(message)
    this.name = 'LinksDownloaderError'
    this.code = code
    this.cause = options?.cause
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  )
}
