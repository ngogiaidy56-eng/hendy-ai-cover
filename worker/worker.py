from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from pathlib import Path
from typing import Any

import asyncpg
import boto3
import requests
from botocore.config import Config as BotoConfig

from core import INDEX_KEY_RE, MODEL_KEY_RE, validate_voice_entry

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s [ai-worker] %(message)s",
)
LOG = logging.getLogger("hendy-ai-cover-worker")

DATABASE_URL = os.getenv("DATABASE_URL", "")
API_BASE_URL = os.getenv("API_BASE_URL", "").rstrip("/")
CALLBACK_SECRET = os.getenv("AI_WORKER_CALLBACK_SECRET", "")
CATALOG_PATH = Path(os.getenv("VOICE_CATALOG_PATH", "/app/config/voices.json"))
RVC_ROOT = Path(os.getenv("RVC_PROJECT_ROOT", "/opt/rvc"))
RVC_PYTHON = os.getenv("RVC_PYTHON", sys.executable)
MAX_DURATION = int(os.getenv("MAX_AUDIO_DURATION_SECONDS", "180"))
POLL_SECONDS = max(2, int(os.getenv("WORKER_POLL_SECONDS", "5")))
STALE_MINUTES = max(30, int(os.getenv("JOB_STALE_MINUTES", "90")))
MAX_OUTPUT_BYTES = int(os.getenv("MAX_OUTPUT_SIZE_MB", "45")) * 1024 * 1024
TEMP_ROOT = Path(os.getenv("TEMP_ROOT", "/tmp/hendy-ai-cover"))


def r2_client():
    account_id = os.getenv("R2_ACCOUNT_ID", "")
    endpoint = os.getenv("R2_ENDPOINT", "") or (f"https://{account_id}.r2.cloudflarestorage.com" if account_id else "")
    if not endpoint or not os.getenv("R2_ACCESS_KEY_ID") or not os.getenv("R2_SECRET_ACCESS_KEY") or not os.getenv("R2_BUCKET_NAME"):
        raise RuntimeError("Cloudflare R2 environment is incomplete")
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        region_name=os.getenv("R2_REGION", "auto"),
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        config=BotoConfig(signature_version="s3v4", s3={"addressing_style": "path"}, retries={"max_attempts": 4}),
    )


S3 = None


def load_voices() -> dict[str, dict[str, Any]]:
    data = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    if not isinstance(data.get("voices"), list):
        raise RuntimeError("Voice catalog must contain a voices array")
    voices = {}
    for voice in data["voices"]:
        if validate_voice_entry(voice):
            model_key = str(voice["model_key"])
            if not MODEL_KEY_RE.fullmatch(model_key) or ".." in model_key.split("/"):
                continue
            index_key = str(voice.get("index_key") or "")
            if index_key and (not INDEX_KEY_RE.fullmatch(index_key) or ".." in index_key.split("/")):
                continue
            voices[voice["id"]] = voice
    return voices


async def sync_voice_status(pool: asyncpg.Pool, voices: dict[str, dict[str, Any]]) -> None:
    assert S3 is not None
    bucket = os.environ["R2_BUCKET_NAME"]
    for voice_id, voice in voices.items():
        available = True
        reason = None
        try:
            await asyncio.to_thread(S3.head_object, Bucket=bucket, Key=voice["model_key"])
            if voice.get("index_key"):
                await asyncio.to_thread(S3.head_object, Bucket=bucket, Key=voice["index_key"])
        except Exception as exc:
            available = False
            reason = "R2 model/index object missing or not accessible: " + exc.__class__.__name__
        async with pool.acquire() as conn:
            await conn.execute(
                """INSERT INTO ai_cover_voice_status(voice_id,voice_name,available,checked_at,last_error)
                   VALUES($1,$2,$3,NOW(),$4)
                   ON CONFLICT(voice_id) DO UPDATE SET voice_name=EXCLUDED.voice_name,
                     available=EXCLUDED.available, checked_at=NOW(), last_error=EXCLUDED.last_error""",
                voice_id, str(voice.get("name", voice_id)), available, reason,
            )
    async with pool.acquire() as conn:
        if voices:
            await conn.execute(
                "UPDATE ai_cover_voice_status SET available=FALSE, checked_at=NOW(), last_error='Preset no longer exists in voice catalog' WHERE NOT (voice_id = ANY($1::text[]))",
                list(voices.keys()),
            )
        else:
            await conn.execute("UPDATE ai_cover_voice_status SET available=FALSE, checked_at=NOW(), last_error='No enabled preset in catalog'")


def run_command(args: list[str], timeout: int, label: str) -> None:
    LOG.info("Starting %s", label)
    completed = subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "command failed")[-1800:]
        raise RuntimeError(f"{label} exited with status {completed.returncode}: {detail}")


def probe_duration(path: Path) -> float:
    completed = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True, timeout=30, check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError("Unable to inspect uploaded audio")
    try:
        duration = float(completed.stdout.strip())
    except ValueError as exc:
        raise RuntimeError("Uploaded audio duration is invalid") from exc
    if duration <= 0 or duration > MAX_DURATION:
        raise RuntimeError(f"Audio duration must be between 1 and {MAX_DURATION} seconds")
    return duration


def download_r2(key: str, target: Path) -> None:
    assert S3 is not None
    S3.download_file(os.environ["R2_BUCKET_NAME"], key, str(target))


def upload_r2(key: str, source: Path) -> None:
    assert S3 is not None
    S3.upload_file(str(source), os.environ["R2_BUCKET_NAME"], key, ExtraArgs={"ContentType": "audio/mpeg"})


def run_pipeline(job: dict[str, Any], voice: dict[str, Any], workspace: Path) -> tuple[str, float, int]:
    source = workspace / "source.audio"
    download_r2(str(job["source_key"]), source)
    if not source.is_file() or source.stat().st_size <= 0:
        raise RuntimeError("Source audio object is missing")
    duration = probe_duration(source)

    demucs_dir = workspace / "separated"
    demucs_dir.mkdir(parents=True, exist_ok=True)
    run_command(
        [RVC_PYTHON, "-m", "demucs.separate", "--two-stems=vocals", "-n",
         os.getenv("DEMUCS_MODEL", "htdemucs"), "-d", os.getenv("DEMUCS_DEVICE", "cpu"),
         "--segment", str(max(1, min(7, int(os.getenv("DEMUCS_SEGMENT_SECONDS", "7"))))), "-o", str(demucs_dir), str(source)],
        timeout=max(900, int(duration * 45)), label="vocal separation",
    )
    candidates = list(demucs_dir.glob("**/vocals.wav"))
    accompaniment_candidates = list(demucs_dir.glob("**/no_vocals.wav"))
    if not candidates or not accompaniment_candidates:
        raise RuntimeError("Demucs did not produce vocal and instrumental stems")
    vocals = candidates[0]
    instrumental = accompaniment_candidates[0]

    model_path = workspace / "voice-model.pth"
    download_r2(str(voice["model_key"]), model_path)
    index_path = None
    if voice.get("index_key"):
        index_path = workspace / "voice-model.index"
        download_r2(str(voice["index_key"]), index_path)

    converted = workspace / "converted-vocals.wav"
    cli = RVC_ROOT / "infer" / "cli.py"
    if not cli.is_file():
        raise RuntimeError("RVC inference CLI is missing from the worker image")
    inference = [
        RVC_PYTHON, str(cli), "--model", str(model_path),
        "--input", str(vocals), "--output", str(converted),
        "--pitch", str(int(voice.get("pitch", 0))),
        "--f0-method", str(voice.get("f0_method", "rmvpe")),
        "--index-rate", str(float(voice.get("index_rate", 0.65)) if index_path else 0.0),
    ]
    if index_path:
        inference.extend(["--index", str(index_path)])
    if voice.get("speaker_id") is not None:
        inference.extend(["--speaker-id", str(int(voice["speaker_id"]))])
    run_command(inference, timeout=max(900, int(duration * 60)), label="RVC voice conversion")
    if not converted.is_file() or converted.stat().st_size <= 0:
        raise RuntimeError("RVC did not create converted vocal audio")

    output = workspace / "hendy-ai-cover.mp3"
    vocal_gain = max(0.0, min(2.0, float(os.getenv("VOCAL_GAIN", "1.0"))))
    instrumental_gain = max(0.0, min(2.0, float(os.getenv("INSTRUMENTAL_GAIN", "0.95"))))
    filter_graph = (
        f"[0:a]volume={vocal_gain}[v];[1:a]volume={instrumental_gain}[i];"
        "[v][i]amix=inputs=2:duration=longest:dropout_transition=2,"
        "alimiter=limit=0.96,loudnorm=I=-16:TP=-1.5:LRA=11[out]"
    )
    run_command(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(converted), "-i", str(instrumental),
         "-filter_complex", filter_graph, "-map", "[out]", "-c:a", "libmp3lame", "-b:a", os.getenv("OUTPUT_BITRATE", "192k"),
         "-metadata", "title=Hendy AI Cover", str(output)],
        timeout=max(600, int(duration * 35)), label="audio mixing and MP3 export",
    )
    size = output.stat().st_size if output.exists() else 0
    if size <= 0 or size > MAX_OUTPUT_BYTES:
        raise RuntimeError("Rendered cover output size is invalid")
    result_key = f"results/{job['id']}/hendy-ai-cover.mp3"
    upload_r2(result_key, output)
    return result_key, duration, size


async def claim_job(pool: asyncpg.Pool) -> dict[str, Any] | None:
    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                """SELECT * FROM ai_cover_jobs
                   WHERE (
                     (status = 'queued' AND attempts < max_attempts AND available_at <= NOW()) OR
                     (status = 'processing' AND updated_at < NOW() - ($1::text || ' minutes')::interval)
                   )
                   ORDER BY created_at ASC LIMIT 1
                   FOR UPDATE SKIP LOCKED""",
                STALE_MINUTES,
            )
            if not row:
                return None
            updated = await conn.fetchrow(
                """UPDATE ai_cover_jobs
                   SET status='processing', attempts=attempts+1, worker_id=$2,
                       started_at=COALESCE(started_at,NOW()), updated_at=NOW()
                   WHERE id=$1 RETURNING *""",
                row["id"], f"worker-{os.getpid()}",
            )
            await conn.execute(
                "INSERT INTO ai_cover_events(job_id,event_type,details) VALUES($1,'processing',jsonb_build_object('attempt',$2))",
                updated["id"], updated["attempts"],
            )
            return dict(updated)


async def record_failure(pool: asyncpg.Pool, job: dict[str, Any], error: Exception) -> bool:
    message = str(error).replace("\x00", "")[:1500]
    retry = int(job["attempts"]) < int(job["max_attempts"])
    status = "queued" if retry else "failed"
    delay = min(300, 15 * max(1, int(job["attempts"])))
    async with pool.acquire() as conn:
        await conn.execute(
            """UPDATE ai_cover_jobs SET status=$2, last_error=$3,
               available_at=CASE WHEN $2='queued' THEN NOW() + ($4::text || ' seconds')::interval ELSE available_at END,
               updated_at=NOW() WHERE id=$1""",
            job["id"], status, message, delay,
        )
        await conn.execute(
            "INSERT INTO ai_cover_events(job_id,event_type,details) VALUES($1,$2,jsonb_build_object('attempt',$3,'message',$4))",
            job["id"], "retry_scheduled" if retry else "failed", job["attempts"], message,
        )
    return not retry


def notify_api(job_id: str) -> bool:
    if not API_BASE_URL or len(CALLBACK_SECRET) < 32:
        LOG.error("API_BASE_URL or callback secret is not configured; job notification cannot be sent")
        return False
    try:
        response = requests.post(
            f"{API_BASE_URL}/internal/jobs/{job_id}/notify",
            headers={"X-Hendy-Worker-Secret": CALLBACK_SECRET},
            json={}, timeout=20,
        )
        if response.status_code in (200, 202):
            return True
        LOG.warning("API notification returned HTTP %s", response.status_code)
    except requests.RequestException as exc:
        LOG.warning("API notification failed: %s", exc.__class__.__name__)
    return False


async def schedule_delivery_retry(pool: asyncpg.Pool, job_id: str) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            """UPDATE ai_cover_jobs SET delivery_attempts=delivery_attempts+1,
               delivery_retry_at=NOW() + LEAST(900, 15 * (delivery_attempts + 1)) * INTERVAL '1 second',
               updated_at=NOW() WHERE id=$1 AND delivery_sent_at IS NULL""",
            job_id,
        )


async def deliver_pending(pool: asyncpg.Pool) -> None:
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT id FROM ai_cover_jobs
               WHERE status IN ('completed','failed') AND delivery_sent_at IS NULL
                 AND delivery_retry_at <= NOW() AND delivery_attempts < 12
               ORDER BY updated_at ASC LIMIT 5"""
        )
    for row in rows:
        if not notify_api(str(row["id"])):
            await schedule_delivery_retry(pool, str(row["id"]))


async def process_one(pool: asyncpg.Pool, voices: dict[str, dict[str, Any]]) -> bool:
    job = await claim_job(pool)
    if not job:
        return False
    if int(job["attempts"]) > int(job["max_attempts"]):
        exhausted = await record_failure(pool, job, RuntimeError("Stale job exceeded its retry limit after worker restart"))
        if exhausted and not notify_api(str(job["id"])):
            await schedule_delivery_retry(pool, str(job["id"]))
        return True
    voice = voices.get(str(job["voice_id"]))
    if not voice:
        exhausted = await record_failure(pool, job, RuntimeError("Selected voice preset is no longer configured"))
        if exhausted:
            notify_api(str(job["id"]))
        return True

    try:
        TEMP_ROOT.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=f"job-{str(job['id'])[:8]}-", dir=TEMP_ROOT) as temp_dir:
            result_key, duration, size = await asyncio.to_thread(run_pipeline, job, voice, Path(temp_dir))
        async with pool.acquire() as conn:
            await conn.execute(
                """UPDATE ai_cover_jobs SET status='completed', result_key=$2,
                   duration_seconds=$3, output_size_bytes=$4, completed_at=NOW(), last_error=NULL, updated_at=NOW()
                   WHERE id=$1""",
                job["id"], result_key, duration, size,
            )
            await conn.execute(
                "INSERT INTO ai_cover_events(job_id,event_type,details) VALUES($1,'completed',jsonb_build_object('duration_seconds',$2,'output_bytes',$3))",
                job["id"], duration, size,
            )
        if not notify_api(str(job["id"])):
            await schedule_delivery_retry(pool, str(job["id"]))
        LOG.info("Job %s completed", str(job["id"])[:8])
    except Exception as exc:  # A failed job is persisted and either retried or surfaced to the user.
        exhausted = await record_failure(pool, job, exc)
        LOG.exception("Job %s failed on attempt %s", str(job["id"])[:8], job["attempts"])
        if exhausted:
            if not notify_api(str(job["id"])):
                await schedule_delivery_retry(pool, str(job["id"]))
    return True


async def main() -> None:
    global S3
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL is required")
    if len(CALLBACK_SECRET) < 32:
        raise RuntimeError("AI_WORKER_CALLBACK_SECRET must contain at least 32 characters")
    if not API_BASE_URL:
        raise RuntimeError("API_BASE_URL is required")
    S3 = r2_client()
    # asyncpg takes TLS configuration as a connect argument rather than relying
    # on libpq-style sslmode parsing in every PostgreSQL URL variant.
    parts = urlsplit(DATABASE_URL)
    query = [(key, value) for key, value in parse_qsl(parts.query) if key not in ('sslmode', 'sslrootcert', 'sslcert', 'sslkey')]
    dsn = urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))
    ssl_mode = os.getenv('DATABASE_SSL', 'true').lower() not in ('false', '0', 'no', 'off')
    pool = await asyncpg.create_pool(dsn, ssl='require' if ssl_mode else False, min_size=1, max_size=3, command_timeout=30)
    LOG.info("Worker online; polling every %ss", POLL_SECONDS)
    try:
        while True:
            try:
                voices = load_voices()
                if not getattr(main, "last_voice_sync", 0) or time.time() - main.last_voice_sync > 600:
                    await sync_voice_status(pool, voices)
                    main.last_voice_sync = time.time()
                processed = await process_one(pool, voices)
                await deliver_pending(pool)
                if not processed:
                    await asyncio.sleep(POLL_SECONDS)
            except Exception as exc:
                LOG.error("Worker loop error: %s", exc.__class__.__name__)
                await asyncio.sleep(max(POLL_SECONDS, 5))
    finally:
        await pool.close()


if __name__ == "__main__":
    asyncio.run(main())
