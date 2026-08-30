-- AI Auto Editor Pro — initial schema.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE users (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email            TEXT NOT NULL UNIQUE,
  password_hash    TEXT,
  google_sub       TEXT UNIQUE,
  name             TEXT,
  avatar_url       TEXT,
  role             TEXT NOT NULL DEFAULT 'user',
  key_pool_settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  plan             TEXT NOT NULL DEFAULT 'free',
  monthly_price_usd NUMERIC(10,2) NOT NULL DEFAULT 0,
  last_seen_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  video_title        TEXT,
  aspect_ratio       TEXT NOT NULL DEFAULT '9:16',
  target_duration_sec INTEGER,
  language           TEXT NOT NULL DEFAULT 'en',
  status             TEXT NOT NULL DEFAULT 'draft',
  progress           NUMERIC(5,2) NOT NULL DEFAULT 0,
  settings           JSONB NOT NULL DEFAULT '{}'::jsonb,
  quality_report     JSONB,
  error_message      TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX projects_user_idx ON projects (user_id, created_at DESC);
CREATE INDEX projects_status_idx ON projects (status);

CREATE TABLE assets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID REFERENCES projects(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  storage_key  TEXT NOT NULL,
  filename     TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  bytes        BIGINT NOT NULL DEFAULT 0,
  duration_sec NUMERIC(12,3),
  width        INTEGER,
  height       INTEGER,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX assets_project_idx ON assets (project_id, kind);
CREATE INDEX assets_user_idx ON assets (user_id);

CREATE TABLE transcripts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  asset_id     UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  language     TEXT NOT NULL DEFAULT 'en',
  text         TEXT NOT NULL DEFAULT '',
  segments     JSONB NOT NULL DEFAULT '[]'::jsonb,
  word_count   INTEGER NOT NULL DEFAULT 0,
  duration_sec NUMERIC(12,3) NOT NULL DEFAULT 0,
  confidence   NUMERIC(4,3) NOT NULL DEFAULT 0,
  approved_at  TIMESTAMPTZ,
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Undo/redo history for the transcript editor. Capped per project by the API.
CREATE TABLE transcript_versions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transcript_id UUID NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  text          TEXT NOT NULL,
  segments      JSONB NOT NULL,
  reason        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (transcript_id, version)
);
CREATE INDEX transcript_versions_idx ON transcript_versions (transcript_id, version DESC);

CREATE TABLE style_profiles (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       UUID NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  name             TEXT NOT NULL DEFAULT 'Style DNA',
  summary          TEXT NOT NULL DEFAULT '',
  color_palette    JSONB NOT NULL DEFAULT '[]'::jsonb,
  color_grading    TEXT NOT NULL DEFAULT '',
  lighting         TEXT NOT NULL DEFAULT '',
  composition      TEXT NOT NULL DEFAULT '',
  camera_lens      TEXT NOT NULL DEFAULT '',
  camera_style     TEXT NOT NULL DEFAULT '',
  mood             TEXT NOT NULL DEFAULT '',
  realism_level    TEXT NOT NULL DEFAULT '',
  artistic_style   TEXT NOT NULL DEFAULT '',
  texture_detail   TEXT NOT NULL DEFAULT '',
  negative_prompt  TEXT NOT NULL DEFAULT '',
  prompt_suffix    TEXT NOT NULL DEFAULT '',
  source_asset_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  locked           BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE competitor_insights (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id             UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  asset_id               UUID REFERENCES assets(id) ON DELETE SET NULL,
  source_url             TEXT,
  editing_pace           TEXT NOT NULL DEFAULT '',
  avg_scene_duration_sec NUMERIC(8,3) NOT NULL DEFAULT 0,
  story_structure        TEXT NOT NULL DEFAULT '',
  caption_style          TEXT NOT NULL DEFAULT '',
  transition_style       TEXT NOT NULL DEFAULT '',
  camera_movement        TEXT NOT NULL DEFAULT '',
  hook_structure         TEXT NOT NULL DEFAULT '',
  visual_rhythm          TEXT NOT NULL DEFAULT '',
  scene_duration_pattern JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommendations        JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX competitor_insights_project_idx ON competitor_insights (project_id);

CREATE TABLE characters (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  role                TEXT NOT NULL DEFAULT '',
  age                 TEXT NOT NULL DEFAULT '',
  gender              TEXT NOT NULL DEFAULT '',
  skin_tone           TEXT NOT NULL DEFAULT '',
  hair                TEXT NOT NULL DEFAULT '',
  face                TEXT NOT NULL DEFAULT '',
  body_shape          TEXT NOT NULL DEFAULT '',
  clothing            TEXT NOT NULL DEFAULT '',
  accessories         TEXT NOT NULL DEFAULT '',
  voice_tone          TEXT NOT NULL DEFAULT '',
  canonical_prompt    TEXT NOT NULL DEFAULT '',
  reference_asset_id  UUID REFERENCES assets(id) ON DELETE SET NULL,
  locked              BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

CREATE TABLE scenes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scene_index     INTEGER NOT NULL,
  start_sec       NUMERIC(12,3) NOT NULL DEFAULT 0,
  end_sec         NUMERIC(12,3) NOT NULL DEFAULT 0,
  narration       TEXT NOT NULL DEFAULT '',
  visual_prompt   TEXT NOT NULL DEFAULT '',
  negative_prompt TEXT,
  emotion         TEXT NOT NULL DEFAULT '',
  location        TEXT NOT NULL DEFAULT '',
  character_ids   JSONB NOT NULL DEFAULT '[]'::jsonb,
  camera_motion   TEXT NOT NULL DEFAULT 'push_in',
  motion_prompt   TEXT,
  transition_in   TEXT,
  is_broll        BOOLEAN NOT NULL DEFAULT false,
  broll_subject   TEXT,
  status          TEXT NOT NULL DEFAULT 'planned',
  image_asset_id  UUID REFERENCES assets(id) ON DELETE SET NULL,
  clip_asset_id   UUID REFERENCES assets(id) ON DELETE SET NULL,
  words           JSONB NOT NULL DEFAULT '[]'::jsonb,
  attempts        INTEGER NOT NULL DEFAULT 0,
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX scenes_project_index_idx ON scenes (project_id, scene_index);
CREATE INDEX scenes_status_idx ON scenes (project_id, status);

CREATE TABLE jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  progress      NUMERIC(5,2) NOT NULL DEFAULT 0,
  total         INTEGER NOT NULL DEFAULT 0,
  completed     INTEGER NOT NULL DEFAULT 0,
  failed        INTEGER NOT NULL DEFAULT 0,
  priority      INTEGER NOT NULL DEFAULT 10,
  attempts      INTEGER NOT NULL DEFAULT 0,
  message       TEXT,
  error_message TEXT,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  queue_job_id  TEXT,
  cancel_requested BOOLEAN NOT NULL DEFAULT false,
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX jobs_project_idx ON jobs (project_id, created_at DESC);
CREATE INDEX jobs_user_idx ON jobs (user_id, created_at DESC);
CREATE INDEX jobs_status_idx ON jobs (status);

CREATE TABLE renders (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  job_id         UUID REFERENCES jobs(id) ON DELETE SET NULL,
  format         TEXT NOT NULL DEFAULT 'mp4',
  resolution     TEXT NOT NULL DEFAULT '1080p',
  fps            INTEGER NOT NULL DEFAULT 30,
  status         TEXT NOT NULL DEFAULT 'pending',
  asset_id       UUID REFERENCES assets(id) ON DELETE SET NULL,
  bytes          BIGINT,
  duration_sec   NUMERIC(12,3),
  quality_report JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ
);
CREATE INDEX renders_project_idx ON renders (project_id, created_at DESC);

CREATE TABLE api_keys (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  encrypted_key    TEXT NOT NULL,
  key_fingerprint  TEXT NOT NULL,
  masked_key       TEXT NOT NULL,
  enabled          BOOLEAN NOT NULL DEFAULT true,
  priority         INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'untested',
  status_message   TEXT,
  last_tested_at   TIMESTAMPTZ,
  last_used_at     TIMESTAMPTZ,
  response_time_ms INTEGER,
  available_models JSONB NOT NULL DEFAULT '[]'::jsonb,
  request_count    BIGINT NOT NULL DEFAULT 0,
  failure_count    INTEGER NOT NULL DEFAULT 0,
  cooldown_until   TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, key_fingerprint)
);
CREATE INDEX api_keys_user_idx ON api_keys (user_id, priority ASC);

CREATE TABLE api_key_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id   UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  event        TEXT NOT NULL,
  status_code  INTEGER,
  latency_ms   INTEGER,
  model        TEXT,
  detail       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX api_key_events_idx ON api_key_events (api_key_id, created_at DESC);

CREATE TABLE usage_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id    UUID REFERENCES projects(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL,
  model         TEXT,
  units         NUMERIC(14,4) NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd      NUMERIC(12,6) NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX usage_events_user_idx ON usage_events (user_id, created_at DESC);
CREATE INDEX usage_events_kind_idx ON usage_events (kind, created_at DESC);

CREATE TABLE templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX templates_user_idx ON templates (user_id, kind);

CREATE TABLE refresh_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);

-- Keeps updated_at honest without every writer having to remember it.
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users','projects','transcripts','style_profiles','characters','scenes','jobs','api_keys','templates'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_touch BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION touch_updated_at()',
      t, t
    );
  END LOOP;
END $$;
