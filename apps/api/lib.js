export function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length === 0 || right.length === 0) return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  // Constant-time comparison for equal-length secrets.
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function safeFilename(input, fallback = 'audio-upload') {
  const base = String(input || fallback).split(/[\\/]/).pop() || fallback;
  return base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || fallback;
}

export function extractAudioMetadata(message) {
  const audio = message?.audio;
  const voice = message?.voice;
  const document = message?.document;
  let selected;
  let filename;
  let mimeType;

  if (audio) {
    selected = audio;
    filename = audio.file_name || `telegram-audio-${audio.file_unique_id || 'upload'}.mp3`;
    mimeType = audio.mime_type || 'audio/mpeg';
  } else if (voice) {
    selected = voice;
    filename = `telegram-voice-${voice.file_unique_id || 'upload'}.ogg`;
    mimeType = voice.mime_type || 'audio/ogg';
  } else if (document) {
    mimeType = String(document.mime_type || '').toLowerCase();
    filename = document.file_name || 'audio-upload';
    const ext = filename.toLowerCase().split('.').pop();
    const knownAudioExt = ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus'];
    if (!mimeType.startsWith('audio/') && !knownAudioExt.includes(ext)) return null;
    selected = document;
    if (!mimeType.startsWith('audio/')) mimeType = `audio/${ext}`;
  } else {
    return null;
  }

  return {
    fileId: String(selected.file_id || ''),
    fileUniqueId: String(selected.file_unique_id || ''),
    fileSize: Number(selected.file_size || 0),
    durationSeconds: Number(selected.duration || 0),
    filename: safeFilename(filename),
    mimeType,
  };
}

export function validateAudioMetadata(meta, { maxBytes, maxDurationSeconds }) {
  if (!meta || !meta.fileId) return { ok: false, reason: 'Không nhận diện được file âm thanh.' };
  if (!meta.mimeType.startsWith('audio/')) return { ok: false, reason: 'Chỉ hỗ trợ tệp âm thanh.' };
  if (!Number.isFinite(meta.fileSize) || meta.fileSize <= 0 || meta.fileSize > maxBytes) {
    return { ok: false, reason: `File phải có dung lượng từ 1 byte đến ${Math.floor(maxBytes / 1024 / 1024)} MB.` };
  }
  if (meta.durationSeconds > maxDurationSeconds) {
    return { ok: false, reason: `Bản Basic giới hạn ${maxDurationSeconds} giây cho mỗi bài.` };
  }
  return { ok: true };
}

export function validateVoiceEntry(voice) {
  if (!voice || typeof voice !== 'object') return false;
  const idOk = /^[a-z0-9][a-z0-9_-]{1,47}$/.test(String(voice.id || ''));
  const keyOk = typeof voice.model_key === 'string' && /^models\\/voices\\/[a-zA-Z0-9._/-]+\\.pth$/.test(voice.model_key);
  const safeModelKey = key => typeof key === 'string' && key.startsWith('models/voices/') && key.endsWith('.pth') && key.split('/').every(part => part && part !== '.' && part !== '..') && /^[A-Za-z0-9._/-]+$/.test(key);
  const safeIndexKey = key => key === undefined || key === null || key === '' || (typeof key === 'string' && key.startsWith('models/voices/') && key.endsWith('.index') && key.split('/').every(part => part && part !== '.' && part !== '..') && /^[A-Za-z0-9._/-]+$/.test(key));
  const rights = voice.rights || {};
  const rightsOk = Boolean(
    rights.voice_owner_consent === true &&
    String(rights.rights_holder || '').trim() &&
    String(rights.license || '').trim() &&
    String(rights.authorization_reference || '').trim()
  );
  return idOk && keyOk && safeModelKey(voice.model_key) && safeIndexKey(voice.index_key) && String(voice.name || '').trim().length > 0 && String(voice.name || '').trim().length <= 50 && rightsOk && voice.enabled === true && Number.isInteger(Number(voice.speaker_id ?? 0)) && Number(voice.speaker_id ?? 0) >= 0 && Number(voice.speaker_id ?? 0) <= 109 && Number.isInteger(Number(voice.pitch ?? 0)) && Number(voice.pitch ?? 0) >= -12 && Number(voice.pitch ?? 0) <= 12 && Number(voice.index_rate ?? 0.65) >= 0 && Number(voice.index_rate ?? 0.65) <= 1 && ['rmvpe', 'pm'].includes(String(voice.f0_method || 'rmvpe'));
}

export function publicVoice(voice) {
  return {
    id: voice.id,
    name: voice.name,
    description: voice.description || '',
  };
}
