-- unaccent(text) is STABLE because it reads a configurable dictionary;
-- pinning the dictionary name and wrapping in SQL makes it safe to use
-- in trigger expressions and indexed expressions.
CREATE OR REPLACE FUNCTION immutable_unaccent(text) RETURNS text AS $$
  SELECT unaccent('unaccent', $1)
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT;

-- Lowercased + accent-stripped blob covering canonical_title + every locale
-- value in shows.titles. Maintained by the same trigger as search_tsv.
ALTER TABLE shows ADD COLUMN IF NOT EXISTS search_normalized text NOT NULL DEFAULT '';

-- Rebuild trigger: apply immutable_unaccent before tokenizing so 'Ákira' and
-- 'akira' map to the same lexeme, and populate search_normalized for trigram.
CREATE OR REPLACE FUNCTION shows_search_tsv_update() RETURNS trigger AS $$
DECLARE
  title_blob text;
  desc_blob  text;
BEGIN
  SELECT string_agg(value, ' ') INTO title_blob FROM jsonb_each_text(NEW.titles);
  SELECT string_agg(value, ' ') INTO desc_blob  FROM jsonb_each_text(NEW.descriptions);

  NEW.search_tsv :=
    setweight(to_tsvector('simple', immutable_unaccent(coalesce(NEW.canonical_title, '') || ' ' || coalesce(title_blob, ''))), 'A') ||
    setweight(to_tsvector('simple', immutable_unaccent(coalesce(NEW.description,     '') || ' ' || coalesce(desc_blob,  ''))), 'B');

  -- Titles only (canonical + every locale value). Descriptions stay FTS-only;
  -- trigram on long descriptions is noisy and inflates index size.
  NEW.search_normalized := lower(immutable_unaccent(
    coalesce(NEW.canonical_title, '') || ' ' || coalesce(title_blob, '')
  ));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE INDEX IF NOT EXISTS shows_search_normalized_trgm_idx
  ON shows USING GIN (search_normalized gin_trgm_ops);

-- Lower the word_similarity threshold from the 0.6 default so the `<%` operator
-- catches typical typos ('frieern' <% 'Frieren' ≈ 0.42). Per-database setting
-- applies to new connections; the API connects after migrations finish.
DO $$ BEGIN
  EXECUTE 'ALTER DATABASE ' || quote_ident(current_database())
       || ' SET pg_trgm.word_similarity_threshold = 0.3';
END $$;

-- Backfill: trigger fires on any UPDATE, repopulating search_tsv and search_normalized.
UPDATE shows SET canonical_title = canonical_title;
