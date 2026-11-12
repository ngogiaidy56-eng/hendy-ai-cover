import 'dotenv/config';
import express from 'express';
import { InputFile, webhookCallback } from 'grammy';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, pingDatabase } from './db.js';
import { createBot, loadAvailableVoices } from './bot.js';
import { getObjectBuffer } from './storage.js';
import { publicVoice, safeEqual } from './lib.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const app = express();
const port = Number(process.env.PORT || 10000);
const botToken = process.env.BOT_TOKEN || '';
const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET || '';
const botMode = process.env.BOT_MODE || (process.env.WEBHOOK_AUTO_REGISTER === 'true' ? 'webhook' : 'polling');
const callbackSecret = process.env.AI_WORKER_CALLBACK_SECRET || '';

if (!botToken) throw new Error('Thiếu BOT_TOKEN. Hãy cấu hình token của bot Hendy AI Cover.');
if (callbackSecret.length < 32) throw new Error('AI_WORKER_CALLBACK_SECRET phải có ít nhất 32 ký tự.');
if (webhookSecret && !/^[A-Za-z0-9_-]{32,256}$/.test(webhookSecret)) throw new Error('TELEGRAM_WEBHOOK_SECRET phải có 32–256 ký tự chữ/số, gạch dưới hoặc gạch ngang.');
if (!['webhook', 'polling'].includes(botMode)) throw new Error('BOT_MODE chỉ nhận webhook hoặc polling.');
if (botMode === 'polling' && process.env.WEBHOOK_AUTO_REGISTER === 'true') throw new Error('Không bật BOT_MODE=polling cùng WEBHOOK_AUTO_REGISTER=true.');
if (botMode === 'webhook' && process.env.WEBHOOK_AUTO_REGISTER !== 'true') throw new Error('BOT_MODE=webhook yêu cầu WEBHOOK_AUTO_REGISTER=true.');
if (process.env.WEBHOOK_AUTO_REGISTER === 'true' && webhookSecret.length < 32) {
  throw new Error('TELEGRAM_WEBHOOK_SECRET phải có ít nhất 32 ký tự khi bật webhook tự động.');
}

const bot = createBot(botToken);
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb', type: 'application/json' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.get('/health', async (_req, res) => {
  try {
    const db = await pingDatabase();
    const voices = await loadAvailableVoices();
    res.status(db ? 200 : 503).json({ status: db ? 'ok' : 'degraded', service: 'hendy-ai-cover-api', database: db, availableVoices: voices.length });
  } catch (error) {
    res.status(503).json({ status: 'error', service: 'hendy-ai-cover-api', message: 'dependency check failed' });
  }
});
app.get('/api/voices', async (_req, res) => {
  try {
    const voices = await loadAvailableVoices();
    res.json({ voices: voices.map(publicVoice) });
  } catch (error) {
    console.error('[voices] catalog error:', error.message);
    res.status(500).json({ error: 'Không đọc được danh sách preset.' });
  }
});

app.post('/telegram/webhook', (req, res, next) => {
  const received = String(req.get('x-telegram-bot-api-secret-token') || '');
  if (!safeEqual(webhookSecret, received)) return res.status(401).json({ error: 'unauthorized' });
  return next();
}, webhookCallback(bot, 'express'));

app.post('/internal/jobs/:id/notify', async (req, res) => {
  const received = String(req.get('x-hendy-worker-secret') || '');
  if (!safeEqual(callbackSecret, received)) return res.status(401).json({ error: 'unauthorized' });
  const jobId = String(req.params.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return res.status(400).json({ error: 'invalid_job_id' });

  const client = await pool.connect();
  let job;
  try {
    await client.query('BEGIN');
    const claim = await client.query(
      `UPDATE ai_cover_jobs SET delivery_claimed_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND delivery_sent_at IS NULL
         AND (delivery_claimed_at IS NULL OR delivery_claimed_at < NOW() - INTERVAL '10 minutes')
       RETURNING *`,
      [jobId]
    );
    if (claim.rowCount === 0) {
      const existing = await client.query('SELECT status, delivery_sent_at FROM ai_cover_jobs WHERE id = $1', [jobId]);
      await client.query('COMMIT');
      if (existing.rowCount === 0) return res.status(404).json({ error: 'job_not_found' });
      if (existing.rows[0].delivery_sent_at) return res.status(200).json({ status: 'already_delivered' });
      return res.status(409).json({ status: 'delivery_in_progress' });
    }
    job = claim.rows[0];
    if (!['completed', 'failed'].includes(job.status)) {
      await client.query('UPDATE ai_cover_jobs SET delivery_claimed_at = NULL WHERE id = $1', [jobId]);
      await client.query('COMMIT');
      return res.status(409).json({ error: 'job_not_finished' });
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  try {
    if (job.status === 'completed' && job.result_key) {
      const audio = await getObjectBuffer(job.result_key);
      await bot.api.sendAudio(job.chat_id, new InputFile(audio, `hendy-cover-${String(job.id).slice(0, 8)}.mp3`), {
        caption: `🎤 <b>HENDY AI COVER HOÀN TẤT</b>\nGiọng: ${escapeHtml(job.voice_name)}\nMã: ${String(job.id).slice(0, 8)}`,
        parse_mode: 'HTML',
      });
    } else {
      await bot.api.sendMessage(job.chat_id, `❌ Tác vụ AI Cover ${String(job.id).slice(0, 8)} không thành công. Vui lòng thử file ngắn hơn hoặc liên hệ quản trị viên.`);
    }
    await pool.query('UPDATE ai_cover_jobs SET delivery_sent_at = NOW(), delivery_claimed_at = NULL, updated_at = NOW() WHERE id = $1', [jobId]);
    return res.json({ ok: true });
  } catch (error) {
    await pool.query('UPDATE ai_cover_jobs SET delivery_claimed_at = NULL, last_error = LEFT($2, 1000), updated_at = NOW() WHERE id = $1', [jobId, String(error.message || 'delivery failed')]);
    console.error('[delivery] failed:', error.message);
    return res.status(502).json({ error: 'delivery_failed' });
  }
});

app.use((error, _req, res, _next) => {
  console.error('[http] request failed:', error.message);
  if (res.headersSent) return;
  res.status(500).json({ error: 'internal_error' });
});

async function start() {
  if (process.env.AUTO_MIGRATE !== 'false') {
    const schema = await readFile(path.join(root, 'database/schema.sql'), 'utf8');
    await pool.query(schema);
  }
  const server = app.listen(port, '0.0.0.0', () => console.log(`[api] listening on ${port}`));

  if (botMode === 'polling') {
    await bot.api.deleteWebhook({ drop_pending_updates: false });
    bot.start({ onStart: () => console.log('[telegram] long polling started') }).catch((error) => console.error('[telegram] polling stopped:', error.message));
  }

  if (botMode === 'webhook') {
    const base = String(process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
    if (!base.startsWith('https://')) throw new Error('APP_URL hoặc RENDER_EXTERNAL_URL phải là HTTPS để đăng ký webhook.');
    await bot.api.setWebhook(`${base}/telegram/webhook`, {
      secret_token: webhookSecret,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: false,
    });
    await bot.api.setMyCommands([
      { command: 'start', description: 'Mở menu Hendy AI Cover' },
      { command: 'cover', description: 'Tạo bản cover mới' },
      { command: 'voices', description: 'Chọn giọng AI preset' },
      { command: 'history', description: 'Lịch sử AI Cover' },
      { command: 'cancel', description: 'Hủy lựa chọn giọng' },
    ]);
    console.log('[telegram] webhook registered');
  }

  const shutdown = async (signal) => {
    console.log(`[api] received ${signal}, shutting down`);
    server.close();
    await bot.stop();
    await pool.end();
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

start().catch(async (error) => {
  console.error('[startup] failed:', error.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
