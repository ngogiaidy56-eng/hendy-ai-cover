import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractAudioMetadata,
  safeEqual,
  safeFilename,
  validateAudioMetadata,
  validateVoiceEntry,
} from '../apps/api/lib.js';

test('safeEqual accepts identical non-empty values and rejects different lengths', () => {
  assert.equal(safeEqual('secret-123', 'secret-123'), true);
  assert.equal(safeEqual('secret-123', 'secret-124'), false);
  assert.equal(safeEqual('', ''), false);
  assert.equal(safeEqual('x', 'longer'), false);
});

test('safeFilename removes path components and unsafe characters', () => {
  assert.equal(safeFilename('../../My Song!.mp3'), 'My_Song_.mp3');
  assert.equal(safeFilename(''), 'audio-upload');
});

test('extractAudioMetadata supports Telegram audio, voice, and audio documents', () => {
  assert.equal(extractAudioMetadata({ audio: { file_id: 'a', file_size: 10, duration: 9 } }).mimeType, 'audio/mpeg');
  assert.equal(extractAudioMetadata({ voice: { file_id: 'v', file_size: 10, duration: 9 } }).mimeType, 'audio/ogg');
  assert.equal(extractAudioMetadata({ document: { file_id: 'd', file_size: 10, file_name: 'song.wav' } }).mimeType, 'audio/wav');
  assert.equal(extractAudioMetadata({ document: { file_id: 'd', mime_type: 'application/pdf', file_name: 'notes.pdf' } }), null);
});

test('audio metadata limits enforce file size and duration', () => {
  const meta = { fileId: 'f', fileSize: 100, durationSeconds: 30, mimeType: 'audio/mpeg' };
  assert.equal(validateAudioMetadata(meta, { maxBytes: 200, maxDurationSeconds: 30 }).ok, true);
  assert.equal(validateAudioMetadata(meta, { maxBytes: 99, maxDurationSeconds: 30 }).ok, false);
  assert.equal(validateAudioMetadata({ ...meta, durationSeconds: 31 }, { maxBytes: 200, maxDurationSeconds: 30 }).ok, false);
  assert.equal(validateAudioMetadata({ ...meta, mimeType: 'text/plain' }, { maxBytes: 200, maxDurationSeconds: 30 }).ok, false);
});

test('voice presets require explicit rights-holder/license/consent metadata', () => {
  const voice = {
    id: 'licensed-voice-01', name: 'Licensed voice', enabled: true,
    model_key: 'models/voices/voice.pth',
    rights: { voice_owner_consent: true, rights_holder: 'Owner', license: 'Written license', authorization_reference: 'LIC-001' },
  };
  assert.equal(validateVoiceEntry(voice), true);
  assert.equal(validateVoiceEntry({ ...voice, rights: { ...voice.rights, voice_owner_consent: false } }), false);
  assert.equal(validateVoiceEntry({ ...voice, model_key: '../secret.pth' }), false);
});
