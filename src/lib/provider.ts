import type { LinkProvider, ResolveOptions, ResolvedMedia } from '../types'
import { LinksDownloaderError } from './errors'

export class ProviderRegistry {
  readonly #providers: LinkProvider[]

  constructor(providers: readonly LinkProvider[] = []) {
    this.#providers = [...providers]
  }

  get providers(): readonly LinkProvider[] {
    return this.#providers
  }

  register(provider: LinkProvider): this {
    const existingIndex = this.#providers.findIndex(({ id }) => id === provider.id)
    if (existingIndex >= 0) this.#providers.splice(existingIndex, 1, provider)
    else this.#providers.push(provider)
    return this
  }

  find(input: string): LinkProvider | undefined {
    return this.#providers.find((provider) => provider.matches(input))
  }

  supports(input: string): boolean {
    return Boolean(this.find(input))
  }

  async resolve(input: string, options?: ResolveOptions): Promise<ResolvedMedia> {
    const provider = this.find(input)
    if (!provider) {
      throw new LinksDownloaderError(
        'UNSUPPORTED_PROVIDER',
        'Por ahora Links Downloader admite enlaces de TikTok.',
      )
    }

    return provider.resolve(input, options)
  }
}
