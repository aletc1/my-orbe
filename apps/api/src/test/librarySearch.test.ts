import '../loadEnv.js'
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { createDbClient, type DbClient } from '@kyomiru/db/client'
import { shows, users, userShowState } from '@kyomiru/db/schema'

// Integration coverage for the hybrid FTS + word_similarity search predicate
// added in 0012_fuzzy_search.sql. Requires Postgres up (`pnpm db:up`);
// skipped otherwise so default `pnpm test` keeps running without infra.
const DATABASE_URL = process.env['DATABASE_URL']

describe.skipIf(!DATABASE_URL)('library search (DB)', () => {
  let db: DbClient
  let userId: string
  const showIds: string[] = []

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL!)

    const suffix = Math.random().toString(36).slice(2, 10)
    const [user] = await db.insert(users).values({
      googleSub: `search-${suffix}`,
      email: `search-${suffix}@example.com`,
      displayName: `Search ${suffix}`,
    }).returning({ id: users.id })
    userId = user!.id

    // Mix of accented, romaji, kana, and short prefix-friendly titles.
    const fixtures = [
      { canonical: 'Frieren: Beyond Journey\'s End', titles: { 'en': 'Frieren: Beyond Journey\'s End', 'ja': '葬送のフリーレン' } },
      { canonical: 'Akira', titles: { 'en': 'Akira', 'ja': 'アキラ' } },
      { canonical: 'Pokémon', titles: { 'en': 'Pokémon', 'es': 'Pokémon' } },
      { canonical: 'Breaking Bad', titles: { 'en': 'Breaking Bad' } },
    ]
    for (const f of fixtures) {
      const [row] = await db.insert(shows).values({
        canonicalTitle: f.canonical,
        titleNormalized: f.canonical.toLowerCase().replace(/[^\w\s]/g, ''),
        titles: f.titles,
      }).returning({ id: shows.id })
      showIds.push(row!.id)
      await db.insert(userShowState).values({
        userId,
        showId: row!.id,
        status: 'in_progress',
      })
    }
  })

  afterAll(async () => {
    if (userId) await db.delete(users).where(eq(users.id, userId))
    if (showIds.length) await db.delete(shows).where(inArray(shows.id, showIds))
  })

  afterEach(() => {
    // No per-test mutation; fixtures are shared.
  })

  // Mirrors the predicate built in apps/api/src/routes/library.routes.ts so a
  // change in one place breaks the other (which is what we want).
  async function search(q: string): Promise<string[]> {
    const rows = await db
      .select({ canonicalTitle: shows.canonicalTitle })
      .from(userShowState)
      .innerJoin(shows, eq(userShowState.showId, shows.id))
      .where(and(
        eq(userShowState.userId, userId),
        sql`(
          ${shows.searchTsv} @@ websearch_to_tsquery('simple', immutable_unaccent(${q}))
          OR word_similarity(lower(immutable_unaccent(${q})), ${shows.searchNormalized}) > 0.3
        )`,
      ))
      .orderBy(sql`word_similarity(lower(immutable_unaccent(${q})), ${shows.searchNormalized}) DESC`)
    return rows.map((r) => r.canonicalTitle)
  }

  it('matches case-insensitively (FTS lowercases via simple dictionary)', async () => {
    expect(await search('frieren')).toContain('Frieren: Beyond Journey\'s End')
    expect(await search('FRIEREN')).toContain('Frieren: Beyond Journey\'s End')
    expect(await search('FrIeReN')).toContain('Frieren: Beyond Journey\'s End')
  })

  it('strips accents on both indexed text and query', async () => {
    // Stored "Pokémon", searched without the accent.
    expect(await search('pokemon')).toContain('Pokémon')
    // And the inverse: stored "Akira" (no accent), searched with one.
    expect(await search('Ákira')).toContain('Akira')
  })

  it('tolerates typos via word_similarity above threshold', async () => {
    // Single transposition: 'frieern' vs 'frieren' (~0.42 word_similarity).
    const results = await search('frieern')
    expect(results[0]).toBe('Frieren: Beyond Journey\'s End')
  })

  it('matches prefixes', async () => {
    // Short prefix 'akir' should still surface 'Akira' as the top hit.
    const results = await search('akir')
    expect(results[0]).toBe('Akira')
  })

  it('searches across locale variants (FTS path covers shows.titles JSONB)', async () => {
    // Japanese kana title is stored in titles['ja'] and concatenated into the tsvector.
    const results = await search('葬送のフリーレン')
    expect(results).toContain('Frieren: Beyond Journey\'s End')
  })

  it('returns nothing for unrelated queries', async () => {
    expect(await search('zzznotarealshow')).toEqual([])
  })
})
