import { Bot, InlineKeyboard } from 'grammy';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';
import { putObject } from './storage.js';
import {
  extractAudioMetadata,
  publicVoice,
  validateAudioMetadata,
  validateVoiceEntry,
} from './lib.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const catalogPath = path.resolve(root, process.env.VOICE_CATALOG_PATH || 'config/voices.json');
const maxBytes = Number(process.env.MAX_AUDIO_SIZE_MB || 20) * 1024 * 1024;
const maxDuration = Number(process.env.MAX_AUDIO_DURATION_SECONDS || 180);
const maxActiveJobs = Number(process.env.MAX_ACTIVE_JOBS_PER_USER || 2);

export async function loadVoiceCatalog() {
  const parsed = JSON.parse(await readFile(catalogPath, 'utf8'));
  if (!Array.isArray(parsed.voices)) throw new Error('config/voices.json phải chứa mảng voices.');
  return parsed.voices.filter(validateVoiceEntry);
}

export async function loadAvailableVoices() {
  const catalog = await loadVoiceCatalog();
  if (catalog.length === 0) return [];
  const status = await pool.query(
    `SELECT voice_id FROM ai_cover_voice_status
     WHERE available = TRUE AND checked_at > NOW() - INTERVAL '30 minutes'`
  );
  const availableIds = new Set(status.rows.map((row) => row.voice_id));
  return catalog.filter((voice) => availableIds.has(voice.id));
}

export function createBot(token) {
  const bot = new Bot(token);

  const showHome = async (ctx) => {
    const keyboard = new InlineKeyboard()
      .text('🎤 Tạo AI Cover', 'cover:start')
      .text('🎙️ Danh sách giọng', 'cover:voices').row()
      .text('📂 Lịch sử Cover', 'cover:history');
    await ctx.reply(
      '<b>HENDY AI COVER</b>\n\nGửi bản thu âm bạn có quyền sử dụng, chọn một giọng preset được cấp phép và nhận bản phối MP3.\n\n/cover — Tạo cover mới\n/voices — Danh sách giọng\n/history — Lịch sử tác vụ\n/cancel — Hủy lựa chọn giọng',
      { parse_mode: 'HTML', reply_markup: keyboard }
    );
  };

  const getSession = async (userId) => {
    const result = await pool.query(
      'SELECT telegram_user_id, chat_id, selected_voice_id, terms_accepted_at FROM cover_sessions WHERE telegram_user_id = $1',
      [String(userId)]
    );
    return result.rows[0] || null;
  };

  const ensureSession = async (userId, chatId) => {
    await pool.query(
      `INSERT INTO cover_sessions (telegram_user_id, chat_id, last_seen_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (telegram_user_id) DO UPDATE SET chat_id = EXCLUDED.chat_id, last_seen_at = NOW(), updated_at = NOW()`,
      [String(userId), String(chatId)]
    );
  };

  const showTerms = async (ctx) => {
    const keyboard = new InlineKeyboard().text('✅ Tôi có quyền sử dụng audio — tiếp tục', 'cover:accept');
    await ctx.reply(
      '<b>Trước khi tạo AI Cover</b>\n\nBạn chỉ được tải lên bản thu/bài hát mà bạn sở hữu hoặc có quyền xử lý. Không dùng giọng mẫu để giả mạo, lừa đảo hay gây hiểu nhầm về danh tính người thật. Chỉ các preset có hồ sơ cấp phép hợp lệ mới được hiển thị.\n\nNhấn xác nhận để tiếp tục.',
      { parse_mode: 'HTML', reply_markup: keyboard }
    );
  };

  const showVoices = async (ctx, userId) => {
    const session = await getSession(userId);
    if (!session?.terms_accepted_at) return showTerms(ctx);
    const voices = await loadAvailableVoices();
    if (voices.length === 0) {
      await ctx.reply(
        '🎙️ Hiện chưa có preset voice nào được kích hoạt. Quản trị viên cần đưa model có giấy phép/đồng ý hợp lệ vào R2 và khai báo trong config/voices.json. Bot không dùng giọng giả lập thay cho AI thật.'
      );
      return;
    }
    const keyboard = new InlineKeyboard();
    voices.slice(0, 20).forEach((voice, index) => {
      keyboard.text(`${index + 1}. ${voice.name}`.slice(0, 60), `cover:voice:${voice.id}`).row();
    });
    await ctx.reply(
      '<b>Chọn giọng AI preset</b>\n\n' + voices.slice(0, 20).map((v, i) => `${i + 1}. <b>${escapeHtml(v.name)}</b> — ${escapeHtml(v.description || 'Giọng AI được cấp phép')}`).join('\n') + '\n\nSau khi chọn, gửi file MP3/WAV/FLAC/M4A/OGG để tạo cover.',
      { parse_mode: 'HTML', reply_markup: keyboard }
    );
  };

  bot.command('start', showHome);
  bot.command('help', showHome);
  bot.command('cover', showTerms);
  bot.command('voices', async (ctx) => showVoices(ctx, ctx.from.id));
  bot.command('cancel', async (ctx) => {
    await pool.query('UPDATE cover_sessions SET selected_voice_id = NULL, updated_at = NOW() WHERE telegram_user_id = $1', [String(ctx.from.id)]);
    await ctx.reply('Đã xóa lựa chọn giọng hiện tại. Dùng /cover để bắt đầu lại.');
  });
  bot.command('history', async (ctx) => {
    const result = await pool.query(
      `SELECT id, voice_name, status, created_at FROM ai_cover_jobs
       WHERE telegram_user_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [String(ctx.from.id)]
    );
    if (result.rows.length === 0) return ctx.reply('Bạn chưa có tác vụ AI Cover nào. Dùng /cover để bắt đầu.');
    const lines = result.rows.map((job) => {
      const status = ({ queued: 'Đang chờ', processing: 'Đang xử lý', completed: 'Hoàn tất', failed: 'Thất bại', cancelled: 'Đã hủy' })[job.status] || job.status;
      return `• <code>${String(job.id).slice(0, 8)}</code> · ${escapeHtml(job.voice_name)} · ${status}`;
    });
    await ctx.reply('<b>10 tác vụ gần nhất</b>\n' + lines.join('\n'), { parse_mode: 'HTML' });
  });

  bot.callbackQuery('cover:start', async (ctx) => { await ctx.answerCallbackQuery(); await showTerms(ctx); });
  bot.callbackQuery('cover:voices', async (ctx) => { await ctx.answerCallbackQuery(); await showVoices(ctx, ctx.from.id); });
  bot.callbackQuery('cover:history', async (ctx) => { await ctx.answerCallbackQuery(); await ctx.reply('Dùng /history để xem tối đa 10 tác vụ gần nhất.'); });
  bot.callbackQuery('cover:accept', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ensureSession(ctx.from.id, ctx.chat?.id || ctx.from.id);
    await pool.query(
      'UPDATE cover_sessions SET terms_accepted_at = COALESCE(terms_accepted_at, NOW()), updated_at = NOW() WHERE telegram_user_id = $1',
      [String(ctx.from.id)]
    );
    await showVoices(ctx, ctx.from.id);
  });
  bot.on('callback_query:data', async (ctx, next) => {
    const data = String(ctx.callbackQuery.data || '');
    const match = /^cover:voice:([a-z0-9][a-z0-9_-]{1,47})$/.exec(data);
    if (!match) return next();
    await ctx.answerCallbackQuery();
    const session = await getSession(ctx.from.id);
    if (!session?.terms_accepted_at) return showTerms(ctx);
    const voices = await loadAvailableVoices();
    const voice = voices.find((item) => item.id === match[1]);
    if (!voice) return ctx.reply('Preset này hiện không khả dụng. Hãy tải lại danh sách bằng /voices.');
    await pool.query(
      'UPDATE cover_sessions SET selected_voice_id = $2, chat_id = $3, updated_at = NOW() WHERE telegram_user_id = $1',
      [String(ctx.from.id), voice.id, String(ctx.chat?.id || ctx.from.id)]
    );
    await ctx.reply(`✅ Đã chọn <b>${escapeHtml(voice.name)}</b>.\n\nBây giờ gửi một file audio. Giới hạn bản Basic: ${Math.floor(maxBytes / 1024 / 1024)} MB và ${maxDuration} giây.`, { parse_mode: 'HTML' });
  });

  const receiveAudio = async (ctx) => {
    const userId = String(ctx.from?.id || '');
    const chatId = String(ctx.chat?.id || '');
    if (!/^\d{5,20}$/.test(userId) || !chatId) return;
    const message = ctx.message;
    const meta = extractAudioMetadata(message);
    if (!meta) {
      await ctx.reply('Tệp gửi lên không phải audio được hỗ trợ. Hãy gửi MP3, WAV, FLAC, M4A, AAC, OGG hoặc OPUS.');
      return;
    }
    const validation = validateAudioMetadata(meta, { maxBytes, maxDurationSeconds: maxDuration });
    if (!validation.ok) { await ctx.reply(`❌ ${validation.reason}`); return; }

    const session = await getSession(userId);
    if (!session?.terms_accepted_at) { await showTerms(ctx); return; }
    if (!session.selected_voice_id) { await ctx.reply('Bạn chưa chọn giọng. Dùng /voices để chọn preset trước khi gửi audio.'); return; }
    const voices = await loadAvailableVoices();
    const voice = voices.find((item) => item.id === session.selected_voice_id);
    if (!voice) { await ctx.reply('Giọng đã chọn không còn khả dụng. Dùng /voices để chọn lại.'); return; }

    const active = await pool.query(
      `SELECT COUNT(*)::int AS total FROM ai_cover_jobs
       WHERE telegram_user_id = $1 AND status IN ('queued','processing')`,
      [userId]
    );
    if (active.rows[0].total >= maxActiveJobs) {
      await ctx.reply(`Bạn đang có ${maxActiveJobs} tác vụ chưa hoàn tất. Hãy chờ xử lý xong trước khi gửi bài mới.`);
      return;
    }

    await ctx.api.sendChatAction(chatId, 'upload_document');
    const file = await ctx.api.getFile(meta.fileId);
    if (!file.file_path) throw new Error('Telegram không trả về đường dẫn tệp.');
    const downloadUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const response = await fetch(downloadUrl, { signal: AbortSignal.timeout(45_000) });
    if (!response.ok) throw new Error(`Không tải được file từ Telegram (HTTP ${response.status}).`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > maxBytes) throw new Error('Dung lượng file sau khi tải không hợp lệ.');

    const jobResult = await pool.query('SELECT gen_random_uuid() AS id');
    const jobId = jobResult.rows[0].id;
    const extension = (meta.filename.split('.').pop() || 'audio').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'audio';
    const sourceKey = `sources/${jobId}/original.${extension}`;
    await putObject(sourceKey, bytes, meta.mimeType || 'application/octet-stream');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize the final active-job check per Telegram user to avoid two
      // simultaneous uploads exceeding MAX_ACTIVE_JOBS_PER_USER.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [userId]);
      const lockedActive = await client.query(
        `SELECT COUNT(*)::int AS total FROM ai_cover_jobs
         WHERE telegram_user_id = $1 AND status IN ('queued','processing')`,
        [userId]
      );
      if (lockedActive.rows[0].total >= maxActiveJobs) {
        await client.query('ROLLBACK');
        await ctx.reply(`Bạn đã có ${maxActiveJobs} tác vụ đang chờ hoặc xử lý. Hãy đợi một tác vụ hoàn tất trước khi gửi file mới.`);
        return;
      }
      await client.query(
        `INSERT INTO ai_cover_jobs
          (id, telegram_user_id, chat_id, telegram_update_id, telegram_file_unique_id,
           source_key, source_filename, source_mime_type, voice_id, voice_name,
           max_attempts, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'queued')`,
        [jobId, userId, chatId, Number(ctx.update.update_id), meta.fileUniqueId || null,
          sourceKey, meta.filename, meta.mimeType, voice.id, voice.name,
          Math.max(1, Math.min(10, Number(process.env.MAX_JOB_ATTEMPTS || 3)))]
      );
      await client.query(
        `INSERT INTO ai_cover_events(job_id, event_type, details)
         VALUES ($1, 'queued', jsonb_build_object('voice_id',$2,'file_bytes',$3))`,
        [jobId, voice.id, bytes.length]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      // An already-uploaded source object is retained only until the R2
      // lifecycle rule expires it; the transaction failure is still surfaced.
      throw error;
    } finally {
      client.release();
    }
    await ctx.reply(
      `✅ <b>ĐÃ NHẬN BÀI HÁT</b>\nMã tác vụ: <code>${String(jobId).slice(0, 8)}</code>\nGiọng: <b>${escapeHtml(voice.name)}</b>\nTrạng thái: Đang chờ AI Worker.\n\nBot sẽ gửi MP3 khi hoàn tất.`,
      { parse_mode: 'HTML' }
    );
  };

  const safeReceiveAudio = async (ctx) => {
    try {
      await receiveAudio(ctx);
    } catch (error) {
      console.error('[telegram] audio intake failed:', error.message);
      try { await ctx.reply('❌ Chưa thể tiếp nhận file âm thanh. Hãy kiểm tra định dạng/dung lượng và thử lại sau.'); } catch { /* Telegram send failure is logged above. */ }
    }
  };
  bot.on('message:audio', safeReceiveAudio);
  bot.on('message:voice', safeReceiveAudio);
  bot.on('message:document', safeReceiveAudio);
  bot.catch((error) => {
    console.error('[telegram] update error:', error.error?.message || error.message);
  });

  return bot;
}

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
