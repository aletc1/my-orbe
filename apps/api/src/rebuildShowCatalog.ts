import './loadEnv.js'
import { randomUUID } from 'node:crypto'
import { eq, inArray, sql } from 'drizzle-orm'
import { Redis } from 'ioredis'
import type { DbClient } from '@kyomiru/db/client'
import { createDbClient } from '@kyomiru/db/client'
import { episodes, episodeProviders, seasons, shows, showProviders, watchEvents } from '@kyomiru/db/schema'
import type { Queue } from 'bullmq'
import type { HistoryItem } from '@kyomiru/providers/types'
import { validateEnv } from './plugins/env.js'
import { ingestItems } from './services/sync.service.js'
import { createShowRefreshQueue, enqueueShowRefresh, type ShowRefreshJobData } from './workers/showRefreshWorker.js'
import { logger } from './util/logger.js'

/**
 * Rebuild a show's catalog from existing watch_events.
 *
 * Wipes seasons/episodes/episode_providers/user_episode_progress for the show
 * (cascade), then replays each user's watch_events through ingestItems. The
 * adopt-on-miss path in resolveItemsByMetadata recreates seasons and episodes
 * from each item's raw metadata and seeds episode_providers with the working
 * external IDs, so the next fast-path sync resolves directly.
 *
 * Modes:
 *   rebuild:show <showId>          — rebuild a single show
 *   rebuild:show --scan            — list shows with unmatched watch_events (dry run)
 *   rebuild:show --scan --apply    — same scan, but actually rebuild every flagged show
 *
 * watch_events themselves are untouched — they're the source of truth for
 * the rebuild.
 */

interface ScanCandidate {
  showId: string
  title: string
  unmatched: number
}

/**
 * Find shows whose `watch_events` aren't producing the user_episode_progress
 * they should — typically because the catalog upsert wrote different IDs than
 * the provider's history feed (e.g. Crunchyroll's catalog episode IDs vs
 * watch-history panel IDs).
 *
 * Detection:
 *   - event is fully_watched
 *   - event.external_item_id has no row in episode_providers (unmapped)
 *   - raw has a recoverable (season_number, episode_number) — episode_number > 0
 *     — so the rebuild's adopt-on-miss path can actually create the episode
 *   - AND no user_episode_progress already exists for the user at that
 *     (showId, season_number, episode_number) — i.e. progress is *truly lost*,
 *     not just recorded under a sibling panel ID (dub/sub variant)
 *
 * Matches events to shows via three independent signals: raw.showId,
 * raw.series_title / raw.seriesTitle vs canonical_title, or vs the titles
 * JSONB. Episode_number=0 events (Netflix descriptor parser fallback) are
 * excluded — they can't be auto-resolved by rebuild anyway.
 */
async function findRebuildCandidates(db: DbClient): Promise<ScanCandidate[]> {
  const rows = await db.execute(sql`
    WITH event_show AS (
      SELECT
        we.user_id,
        we.provider_key,
        we.external_item_id,
        sp.show_id,
        COALESCE((we.raw->>'season_number')::int, (we.raw->>'seasonNumber')::int) AS s_num,
        COALESCE((we.raw->>'episode_number')::int, (we.raw->>'episodeNumber')::int) AS e_num
      FROM watch_events we
      JOIN show_providers sp ON sp.provider_key = we.provider_key
      JOIN shows s ON s.id = sp.show_id
      WHERE we.fully_watched
        AND NOT EXISTS (
          SELECT 1 FROM episode_providers ep
          WHERE ep.provider_key = we.provider_key AND ep.external_id = we.external_item_id
        )
        AND (
          we.raw->>'showId' = sp.external_id
          OR we.raw->>'show_id' = sp.external_id
          OR LOWER(COALESCE(we.raw->>'series_title', we.raw->>'seriesTitle', '')) = LOWER(s.canonical_title)
          OR EXISTS (
            SELECT 1 FROM jsonb_each_text(s.titles) jt
            WHERE LOWER(jt.value) = LOWER(COALESCE(we.raw->>'series_title', we.raw->>'seriesTitle', ''))
          )
        )
    )
    SELECT s.id AS show_id, s.canonical_title AS title, COUNT(*)::int AS unmatched
    FROM event_show ev
    JOIN shows s ON s.id = ev.show_id
    WHERE ev.s_num IS NOT NULL AND ev.e_num IS NOT NULL AND ev.e_num > 0
      AND NOT EXISTS (
        SELECT 1 FROM user_episode_progress uep
        JOIN episodes e ON e.id = uep.episode_id
        JOIN seasons sn ON sn.id = e.season_id
        WHERE uep.user_id = ev.user_id
          AND uep.watched
          AND e.show_id = ev.show_id
          AND sn.season_number = ev.s_num
          AND e.episode_number = ev.e_num
      )
    GROUP BY s.id, s.canonical_title
    ORDER BY COUNT(*) DESC
  `)
  return (rows as unknown as { show_id: string; title: string; unmatched: number }[]).map((r) => ({
    showId: r.show_id, title: r.title, unmatched: Number(r.unmatched),
  }))
}

async function rebuildOneShow(
  db: DbClient,
  redis: Redis,
  showRefreshQueue: Queue<ShowRefreshJobData>,
  showId: string,
): Promise<{ totalIngested: number; users: number; matched: number }> {
  const [show] = await db.select().from(shows).where(eq(shows.id, showId))
  if (!show) throw new Error(`Show ${showId} not found`)
  logger.info({ showId, title: show.canonicalTitle }, 'rebuilding catalog')

  const spRows = await db.select({ providerKey: showProviders.providerKey, externalId: showProviders.externalId })
    .from(showProviders).where(eq(showProviders.showId, showId))
  const externalIdByProvider = new Map(spRows.map((r) => [r.providerKey, r.externalId]))

  // Snapshot existing episode_providers mappings BEFORE the wipe so we can use
  // them as a guaranteed-correct match signal (even when raw lacks titles).
  const mappedExtIdRows = await db
    .select({ providerKey: episodeProviders.providerKey, externalId: episodeProviders.externalId })
    .from(episodeProviders)
    .innerJoin(episodes, eq(episodes.id, episodeProviders.episodeId))
    .where(eq(episodes.showId, showId))
  const mappedExtIdsByProvider = new Map<string, Set<string>>()
  for (const r of mappedExtIdRows) {
    const set = mappedExtIdsByProvider.get(r.providerKey) ?? new Set<string>()
    set.add(r.externalId)
    mappedExtIdsByProvider.set(r.providerKey, set)
  }

  const events = externalIdByProvider.size > 0
    ? await db.select().from(watchEvents).where(inArray(watchEvents.providerKey, [...externalIdByProvider.keys()]))
    : []

  const titleFilters = new Set<string>()
  if (show.canonicalTitle) titleFilters.add(show.canonicalTitle.toLowerCase())
  for (const t of Object.values((show.titles as Record<string, string>) ?? {})) titleFilters.add(t.toLowerCase())

  const eventsForShow = events.filter((ev) => {
    if (mappedExtIdsByProvider.get(ev.providerKey)?.has(ev.externalItemId)) return true
    const raw = ev.raw as Record<string, unknown> | null
    const seriesTitleSnake = typeof raw?.series_title === 'string' ? raw.series_title.toLowerCase() : null
    const seriesTitleCamel = typeof raw?.seriesTitle === 'string' ? raw.seriesTitle.toLowerCase() : null
    if (seriesTitleSnake && titleFilters.has(seriesTitleSnake)) return true
    if (seriesTitleCamel && titleFilters.has(seriesTitleCamel)) return true
    const showIdInRaw = typeof raw?.showId === 'string' ? raw.showId
      : typeof raw?.show_id === 'string' ? raw.show_id : null
    return showIdInRaw !== null && externalIdByProvider.get(ev.providerKey) === showIdInRaw
  })
  logger.info({ showId, totalEvents: events.length, matched: eventsForShow.length }, 'matched watch_events to show')

  // Wipe catalog. Cascades: episodes → episode_providers + user_episode_progress; seasons → episodes.
  await db.delete(episodes).where(eq(episodes.showId, showId))
  await db.delete(seasons).where(eq(seasons.showId, showId))
  await db.update(shows).set({ enrichedAt: null }).where(eq(shows.id, showId))
  await db.update(showProviders).set({ catalogSyncedAt: null }).where(eq(showProviders.showId, showId))

  const grouped = new Map<string, typeof eventsForShow>()
  for (const ev of eventsForShow) {
    const key = `${ev.userId}|${ev.providerKey}`
    const arr = grouped.get(key) ?? []
    arr.push(ev)
    grouped.set(key, arr)
  }

  let totalIngested = 0
  for (const [key, group] of grouped) {
    const [userId, providerKey] = key.split('|') as [string, string]
    const externalShowId = externalIdByProvider.get(providerKey)
    if (!externalShowId) {
      logger.warn({ userId, providerKey }, 'no show_providers mapping — skipping group')
      continue
    }
    const items: HistoryItem[] = group.map((ev) => ({
      externalItemId: ev.externalItemId,
      externalShowId,
      watchedAt: ev.watchedAt,
      ...(ev.playheadSeconds !== null && { playheadSeconds: ev.playheadSeconds }),
      ...(ev.durationSeconds !== null && { durationSeconds: ev.durationSeconds }),
      ...(ev.fullyWatched !== null && { fullyWatched: ev.fullyWatched }),
      raw: ev.raw,
    }))
    const counters = await ingestItems(
      db, userId, providerKey, items, [], randomUUID(), null, redis, showRefreshQueue,
    )
    totalIngested += counters.itemsIngested
    logger.info({ userId, providerKey, ...counters }, 'replayed events for user')
  }

  await enqueueShowRefresh(showRefreshQueue, showId)
  logger.info({ showId, totalIngested, users: grouped.size }, 'rebuild complete')
  return { totalIngested, users: grouped.size, matched: eventsForShow.length }
}

async function main() {
  const args = process.argv.slice(2)
  const scan = args.includes('--scan')
  const apply = args.includes('--apply')
  const showId = args.find((a) => !a.startsWith('--'))

  if (!scan && !showId) {
    console.error('Usage:')
    console.error('  rebuild:show <showId>          rebuild a single show')
    console.error('  rebuild:show --scan            list shows with unmatched watch_events (dry run)')
    console.error('  rebuild:show --scan --apply    rebuild every flagged show')
    process.exit(1)
  }

  const config = validateEnv()
  const db = createDbClient(config.DATABASE_URL)
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null })
  const showRefreshQueue = createShowRefreshQueue(redis)

  try {
    if (scan) {
      const candidates = await findRebuildCandidates(db)
      if (candidates.length === 0) {
        logger.info('no shows with unmatched watch_events — nothing to rebuild')
        return
      }
      logger.info({ count: candidates.length }, 'shows with unmatched watch_events')
      for (const c of candidates) {
        logger.info({ showId: c.showId, title: c.title, unmatched: c.unmatched }, 'candidate')
      }
      if (!apply) {
        logger.info('dry run — pass --apply to rebuild')
        return
      }
      let succeeded = 0
      let failed = 0
      for (const c of candidates) {
        try {
          await rebuildOneShow(db, redis, showRefreshQueue, c.showId)
          succeeded++
        } catch (err) {
          failed++
          logger.error({ showId: c.showId, err }, 'rebuild failed for show')
        }
      }
      logger.info({ total: candidates.length, succeeded, failed }, 'bulk rebuild complete')
      return
    }

    if (showId) await rebuildOneShow(db, redis, showRefreshQueue, showId)
  } finally {
    await showRefreshQueue.close()
    await redis.quit()
  }
}

void main().then(() => process.exit(0)).catch((err) => {
  logger.error({ err }, 'rebuild failed')
  process.exit(1)
})
