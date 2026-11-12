# Deploy Hendy AI Cover Basic on Render

## Services

Import `render.yaml` as a Render Blueprint. It defines a Node.js Web Service and a Docker Background Worker. Render background workers are designed to poll queues and process media jobs outside the HTTP request path; they do not receive inbound public traffic.

## Provision dependencies

1. Create a Render PostgreSQL database (PostgreSQL 14+). Copy its **Internal Database URL** when services are in the same Render region; use the external URL only when required.
2. Create a private Cloudflare R2 bucket named `hendy-ai-cover` and an S3 API token restricted to that bucket.
3. Configure the same `DATABASE_URL`, R2 credentials, bucket name, and `AI_WORKER_CALLBACK_SECRET` on the API and worker.
4. Configure `BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` on the API service. Generate secrets with a cryptographically secure random generator; use at least 32 characters.
5. Configure `API_BASE_URL` on the worker to the public HTTPS URL of `hendy-ai-cover-api`, for example `https://hendy-ai-cover-api.onrender.com`.
6. Keep `WEBHOOK_AUTO_REGISTER=true` and `BOT_MODE=webhook` on the API. Render supplies `RENDER_EXTERNAL_URL`; the API uses it when `APP_URL` is unset.
7. Upload an authorized RVC voice model to R2 and add its preset entry to `config/voices.json`. The repository begins with no enabled presets by design.

## Environment variable matrix

| Variable | API | Worker | Purpose |
|---|---:|---:|---|
| `BOT_TOKEN` | Required | — | Telegram bot token |
| `TELEGRAM_WEBHOOK_SECRET` | Required | — | Telegram webhook header secret (32+ chars) |
| `DATABASE_URL` | Required | Required | Same PostgreSQL database |
| `DATABASE_SSL` | `true` | `true` | TLS for external PostgreSQL connections |
| `R2_ACCOUNT_ID` | Required | Required | Cloudflare account identifier |
| `R2_ACCESS_KEY_ID` | Required | Required | R2 S3 access key |
| `R2_SECRET_ACCESS_KEY` | Required | Required | R2 S3 secret |
| `R2_BUCKET_NAME` | Required | Required | Private bucket name |
| `AI_WORKER_CALLBACK_SECRET` | Required | Required | Same 32+ character internal secret |
| `API_BASE_URL` | — | Required | Public HTTPS API service URL |

Optional tuning values include `MAX_AUDIO_SIZE_MB`, `MAX_AUDIO_DURATION_SECONDS`, `MAX_ACTIVE_JOBS_PER_USER`, `MAX_JOB_ATTEMPTS`, `WORKER_POLL_SECONDS`, `DEMUCS_MODEL`, `DEMUCS_DEVICE`, `DEMUCS_SEGMENT_SECONDS`, and `OUTPUT_BITRATE`.

## Deploy sequence

1. Deploy API and worker after configuring shared environment variables.
2. API executes `database/schema.sql` at startup (set `AUTO_MIGRATE=false` only if you manage migrations separately).
3. Check `https://<api-host>/health` and `https://<api-host>/api/voices`.
4. Add licensed model objects and a valid catalog entry; wait for the worker's next R2 check (maximum 10 minutes).
5. Verify the preset is present in `/api/voices`, then send a short audio file through Telegram.
6. Inspect worker and API logs for job state transitions. Never paste bot tokens, DB URLs, or R2 secrets into logs/issues.

## Compute and cost considerations

The worker image installs the current Python 3.12 CPU dependency set from the RVC project, downloads its required HuBERT/RMVPE inference assets, and installs Demucs. Build time and image size can be large. The Blueprint uses a `standard` worker plan as a baseline, but CPU-only inference may still be slow or memory-heavy. Start with the default 180-second input cap and one worker instance. For longer songs or higher concurrency, move the inference layer to a GPU-capable host and keep the API/queue/storage architecture.

The Blueprint does not provision PostgreSQL or Cloudflare R2 automatically. This avoids silently creating a paid database or storage resource; configure these resources explicitly and supply their connection details.
