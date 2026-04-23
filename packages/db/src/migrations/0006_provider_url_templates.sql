-- ─── Provider deep-link URL templates ───────────────────────────────────────
-- Used by the API to build per-show / per-episode "Open externally" URLs from
-- the externalId recorded in show_providers / episode_providers. The {externalId}
-- placeholder is substituted (URL-encoded) at response time.
ALTER TABLE providers
  ADD COLUMN IF NOT EXISTS show_url_template    text,
  ADD COLUMN IF NOT EXISTS episode_url_template text;

-- Crunchyroll IDs resolve without a slug (CR redirects to the slugged URL).
UPDATE providers
   SET show_url_template    = 'https://www.crunchyroll.com/series/{externalId}',
       episode_url_template = 'https://www.crunchyroll.com/watch/{externalId}'
 WHERE key = 'crunchyroll';

-- Forward-compatible templates for providers not yet ingested. These are the
-- public deep-link patterns that iOS Universal Links / Android App Links route
-- to the native app when installed, falling back to the browser otherwise.
UPDATE providers
   SET show_url_template = 'https://www.netflix.com/title/{externalId}'
 WHERE key = 'netflix';

UPDATE providers
   SET show_url_template = 'https://www.amazon.com/gp/video/detail/{externalId}'
 WHERE key = 'prime';
