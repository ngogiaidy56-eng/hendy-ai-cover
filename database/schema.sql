CREATE TABLE IF NOT EXISTS cover_sessions (
  telegram_user_id TEXT PRIMARY KEY CHECK (telegram_user_id ~ '^[0-9]{5,20}$'),
  chat_id TEXT NOT NULL,
  selected_voice_id TEXT,
  terms_accepted_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_cover_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_user_id TEXT NOT NULL CHECK (telegram_user_id ~ '^[0-9]{5,20}$'),
  chat_id TEXT NOT NULL,
  telegram_update_id BIGINT NOT NULL UNIQUE,
  telegram_file_unique_id TEXT,
  source_key TEXT NOT NULL,
  source_filename TEXT NOT NULL DEFAULT 'audio-upload',
  source_mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  voice_id TEXT NOT NULL,
  voice_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','completed','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  result_key TEXT,
  duration_seconds NUMERIC(8,2),
  output_size_bytes BIGINT,
  last_error TEXT,
  worker_id TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  delivery_sent_at TIMESTAMPTZ,
  delivery_claimed_at TIMESTAMPTZ,
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  delivery_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_cover_jobs_queue
  ON ai_cover_jobs(status, available_at, created_at)
  WHERE status IN ('queued','processing');
CREATE INDEX IF NOT EXISTS idx_ai_cover_jobs_user_created
  ON ai_cover_jobs(telegram_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_cover_jobs_stale
  ON ai_cover_jobs(updated_at)
  WHERE status = 'processing';

CREATE TABLE IF NOT EXISTS ai_cover_events (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES ai_cover_jobs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_cover_events_job_created
  ON ai_cover_events(job_id, created_at);

CREATE TABLE IF NOT EXISTS ai_cover_voice_status (
  voice_id TEXT PRIMARY KEY,
  voice_name TEXT NOT NULL,
  available BOOLEAN NOT NULL DEFAULT FALSE,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_cover_voice_status_available
  ON ai_cover_voice_status(available, checked_at DESC);
