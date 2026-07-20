import { LinksDownloaderError } from './errors'

const URL_IN_TEXT = /https?:\/\/[^\s<>"']+/i
const TRAILING_SHARE_PUNCTUATION = /[),.;!?\]}>]+$/

/** Acepta tanto una URL limpia como el texto completo copiado desde "Compartir". */
export function extractUrl(input: string): URL {
  const value = input.trim()
  const match = value.match(URL_IN_TEXT)
  const candidate = (match?.[0] ?? value).replace(TRAILING_SHARE_PUNCTUATION, '')

  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new LinksDownloaderError(
      'INVALID_URL',
      'Pega un enlace completo que empiece con http:// o https://.',
    )
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new LinksDownloaderError('INVALID_URL', 'El enlace debe usar http o https.')
  }

  return parsed
}

export function optionalUrl(value: unknown, baseUrl?: string): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined

  const candidate = value.trim()
  try {
    if (candidate.startsWith('//')) return new URL(`https:${candidate}`).toString()
    return new URL(candidate, baseUrl).toString()
  } catch {
    return undefined
  }
}
