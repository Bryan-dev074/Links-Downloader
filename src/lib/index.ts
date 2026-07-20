import type { ResolveOptions, ResolvedMedia } from '../types'
import { ProviderRegistry } from './provider'
import { TikTokProvider } from './tiktok'

export const providerRegistry = new ProviderRegistry([new TikTokProvider()])

export function isSupportedLink(input: string): boolean {
  return providerRegistry.supports(input)
}

export function resolveLink(input: string, options?: ResolveOptions): Promise<ResolvedMedia> {
  return providerRegistry.resolve(input, options)
}

export * from '../types'
export * from './download'
export * from './errors'
export * from './provider'
export * from './tiktok'
