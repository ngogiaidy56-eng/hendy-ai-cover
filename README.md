# HENDY AI COVER — Basic V1

Telegram AI cover service for user-owned/licensed audio and explicitly authorized preset voice-conversion models. The bot/API are Node.js + grammY; long-running audio processing runs in a separate Python worker with Demucs, RVC CLI, and FFmpeg. PostgreSQL is the durable job queue and Cloudflare R2 stores private source, model, and result objects.

> **Important:** this repository does not ship pretrained voice models or copyrighted songs. `config/voices.json` starts empty deliberately. A preset only appears in the bot after an administrator adds a voice model they are authorized to use, places the model in the configured R2 bucket, and the worker confirms that the object exists. The system will not return a fake or unchanged file as an AI result.

## Features

- Telegram commands: `/start`, `/cover`, `/voices`, `/history`, `/cancel`.
- User agreement step before accepting audio, plus preset selection.
- Accepts Telegram audio, voice messages, and audio documents.
- File-size and duration checks; worker re-checks duration using `ffprobe`.
- Presets require an explicit rights-holder/license/consent record and are hidden until their R2 model/index objects are verified.
- PostgreSQL queue with row locking, bounded retries, stale-job recovery, and delivery retries.
- Processing: Demucs vocal separation → RVC voice conversion → FFmpeg mix/master → MP3 export.
- Private R2 storage, authenticated worker callback, Telegram webhook secret, health endpoint.
- Render Blueprint for API Web Service and isolated AI Background Worker.

## Architecture

```text
Telegram user
  │ audio + preset choice
  ▼
Node.js API / grammY / Express
  ├─ validates Telegram webhook secret and user agreement
  ├─ validates audio, preset and per-user job limits
  ├─ stores source audio in private Cloudflare R2
  └─ writes job to PostgreSQL
          │ polling + SKIP LOCKED
          ▼
Python AI Background Worker
  ├─ verifies model/index and authorization record
  ├─ Demucs: vocals / instrumental
  ├─ RVC: preset voice conversion
  ├─ FFmpeg: mix and MP3 export
  ├─ uploads result to private R2
  └─ authenticated callback to API
          ▼
Telegram receives MP3
```

## Layout

- `apps/api/` — Telegram bot, API, webhook, PostgreSQL and R2 adapters.
- `worker/` — Python job worker, Demucs/RVC/FFmpeg pipeline.
- `config/voices.json` — authorized preset catalog (empty by default).
- `database/schema.sql` — PostgreSQL schema and indexes.
- `docs/` — Render deployment and voice model rights instructions.
- `tests/` — Node and Python unit tests.
- `render.yaml` — Render API and Background Worker Blueprint.
- `docker-compose.yml` — local development stack.

## Requirements

Node.js 20+, Python 3.12 for the AI image, PostgreSQL 14+, private Cloudflare R2 bucket, Telegram bot token, FFmpeg, and an RVC model with documented permission/consent. No voice model is bundled. CPU inference may be slow; for longer audio or concurrent jobs use a GPU-capable worker.

## Local setup

1. Copy `.env.example` to `.env` and configure bot token, PostgreSQL, R2, and a random `AI_WORKER_CALLBACK_SECRET` (32+ characters).
2. Create a private R2 bucket named `hendy-ai-cover` and an S3 token restricted to that bucket.
3. Add an authorized model and preset following `docs/VOICE-MODELS.md`.
4. Start with `docker compose up --build`.
5. Set `BOT_MODE=polling` and `WEBHOOK_AUTO_REGISTER=false` for local development. Do not use polling and webhook simultaneously for one bot token.

API health: `http://localhost:10000/health`  
Preset list: `http://localhost:10000/api/voices`

## Deploy on Render

Import `render.yaml` as a Blueprint. Provision PostgreSQL and Cloudflare R2 separately, configure shared environment variables on API and worker, then deploy. Follow [`docs/DEPLOY-RENDER.md`](docs/DEPLOY-RENDER.md). Render Background Worker processes queue jobs outside the HTTP request path. The blueprint does not silently provision paid database/storage resources.

## Voice model policy

Only add a model if the model license and voice owner authorize the intended use. Record rights holder, license scope, authorization reference, and explicit consent in `config/voices.json`. Keep model files and private paperwork out of Git. Use a private R2 bucket. See [`docs/VOICE-MODELS.md`](docs/VOICE-MODELS.md).

## Tests

```bash
npm install
npm test
npm run lint
PYTHONPATH=. python -m unittest discover -s tests -p 'test_*.py' -v
python -m compileall -q worker tests
```

The tests cover utility validation and preset rights metadata. They do not replace a full integration test with a real Telegram bot, PostgreSQL, R2 bucket, and licensed RVC model.
