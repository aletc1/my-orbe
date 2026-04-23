import { describe, it, expect } from 'vitest'
import { buildProviderUrl } from '../services/providerLinks.js'

describe('buildProviderUrl', () => {
  it('substitutes {externalId} in the template', () => {
    expect(buildProviderUrl('https://www.crunchyroll.com/series/{externalId}', 'GYVNXNDZ3'))
      .toBe('https://www.crunchyroll.com/series/GYVNXNDZ3')
  })

  it('returns null when the template is missing', () => {
    expect(buildProviderUrl(null, 'anything')).toBeNull()
  })

  it('URL-encodes the externalId to defend against malformed ids', () => {
    expect(buildProviderUrl('https://x.test/{externalId}', 'a/b?c=1'))
      .toBe('https://x.test/a%2Fb%3Fc%3D1')
  })

  it('only replaces the first {externalId} occurrence', () => {
    // External ids aren't expected in multiple places today; this pins the
    // current behavior so a future template with two placeholders fails loudly.
    expect(buildProviderUrl('https://x.test/{externalId}/{externalId}', 'abc'))
      .toBe('https://x.test/abc/{externalId}')
  })
})
