import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import type { DbClient } from '@kyomiru/db/client'
import { providers, showProviders, episodeProviders } from '@kyomiru/db/schema'
import type { ProviderLink } from '@kyomiru/shared/contracts/shows'

/**
 * Substitute `{externalId}` in a provider URL template with the URL-encoded
 * external id. Returns null when the template is missing.
 */
export function buildProviderUrl(template: string | null, externalId: string): string | null {
  if (!template) return null
  return template.replace('{externalId}', encodeURIComponent(externalId))
}

/**
 * Load deep-link URLs for every (show × provider) pair across the given show
 * ids in a single query. Providers without a `showUrlTemplate` or with
 * `enabled=false` are skipped, matching the rule that the UI button only
 * surfaces actionable links.
 */
export async function loadShowProviderLinks(
  db: DbClient,
  showIds: string[],
): Promise<Map<string, ProviderLink[]>> {
  const out = new Map<string, ProviderLink[]>()
  if (showIds.length === 0) return out

  const rows = await db
    .select({
      showId: showProviders.showId,
      key: providers.key,
      displayName: providers.displayName,
      template: providers.showUrlTemplate,
      externalId: showProviders.externalId,
    })
    .from(showProviders)
    .innerJoin(providers, eq(showProviders.providerKey, providers.key))
    .where(and(
      inArray(showProviders.showId, showIds),
      eq(providers.enabled, true),
      isNotNull(providers.showUrlTemplate),
    ))

  for (const r of rows) {
    const url = buildProviderUrl(r.template, r.externalId)
    if (!url) continue
    const bucket = out.get(r.showId) ?? []
    bucket.push({ key: r.key, displayName: r.displayName, url })
    out.set(r.showId, bucket)
  }
  return out
}

/**
 * Load deep-link URLs for every (episode × provider) pair across the given
 * episode ids in a single query. Providers without an `episodeUrlTemplate`
 * or with `enabled=false` are skipped.
 */
export async function loadEpisodeProviderLinks(
  db: DbClient,
  episodeIds: string[],
): Promise<Map<string, ProviderLink[]>> {
  const out = new Map<string, ProviderLink[]>()
  if (episodeIds.length === 0) return out

  const rows = await db
    .select({
      episodeId: episodeProviders.episodeId,
      key: providers.key,
      displayName: providers.displayName,
      template: providers.episodeUrlTemplate,
      externalId: episodeProviders.externalId,
    })
    .from(episodeProviders)
    .innerJoin(providers, eq(episodeProviders.providerKey, providers.key))
    .where(and(
      inArray(episodeProviders.episodeId, episodeIds),
      eq(providers.enabled, true),
      isNotNull(providers.episodeUrlTemplate),
    ))

  for (const r of rows) {
    const url = buildProviderUrl(r.template, r.externalId)
    if (!url) continue
    const bucket = out.get(r.episodeId) ?? []
    bucket.push({ key: r.key, displayName: r.displayName, url })
    out.set(r.episodeId, bucket)
  }
  return out
}
