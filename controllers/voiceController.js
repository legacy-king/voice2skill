/**
 * POST /api/voice/transcribe — speech-to-text for the goal, check-in and mentor boxes.
 *
 * The browser records with MediaRecorder (max 60 s) and uploads the raw clip as the request body
 * with its audio Content-Type (no multipart parser). Order matters: login, rate limit, type and
 * size checks happen BEFORE the body is read; the bytes are then checked against the claimed type
 * (magic bytes), the daily cap is reserved, and the clip goes to the LLM router (Groq Whisper,
 * Gemini paid as fallback).
 *
 * The audio is never stored: it lives in memory for this request only. Only the transcript is
 * returned; it is saved later only if the student submits it as their goal, check-in or message.
 * Free users get voice too (PLAN D2), with a smaller daily cap. Caps: STT_DAILY_LIMIT_FREE (20),
 * STT_DAILY_LIMIT_PAID (60). Max upload: STT_MAX_BYTES (3 MB, ~60 s even at high bitrates).
 */
const express = require('express');
const llm = require('../services/llm');
const usageModel = require('../models/usageModel');
const { loadState, canUse } = require('../services/entitlements');
const { log } = require('../utils/log');

const KIND = 'stt';
const MIN_BYTES = 1000;
const MAX_BYTES = () => Number(process.env.STT_MAX_BYTES) || 3 * 1024 * 1024;
const DAILY_LIMIT = (paid) => (paid
  ? Number(process.env.STT_DAILY_LIMIT_PAID) || 60
  : Number(process.env.STT_DAILY_LIMIT_FREE) || 20);

// Content-Type the browser may send -> canonical type the router understands.
const TYPES = {
  'audio/webm': 'audio/webm',
  'video/webm': 'audio/webm', // some browsers label audio-only webm this way
  'audio/ogg': 'audio/ogg',
  'audio/mp4': 'audio/mp4', // Safari / iOS MediaRecorder
  'audio/x-m4a': 'audio/mp4',
  'audio/m4a': 'audio/mp4'
};

/** Do the first bytes match the claimed container? Stops renamed files and junk uploads. */
function magicMatches(mime, buf) {
  if (buf.length < 12) return false;
  if (mime === 'audio/webm') return buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3; // EBML
  if (mime === 'audio/ogg') return buf.toString('latin1', 0, 4) === 'OggS';
  if (mime === 'audio/mp4') return buf.toString('latin1', 4, 8) === 'ftyp';
  return false;
}

function requireLogin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'login' });
  next();
}

/** Type + declared size first, then read at most MAX_BYTES into memory. */
function readAudio(req, res, next) {
  const declared = (req.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const mime = TYPES[declared];
  if (!mime) return res.status(415).json({ error: 'unsupported_type' });
  const length = Number(req.get('content-length'));
  if (Number.isFinite(length) && length > MAX_BYTES()) return res.status(413).json({ error: 'too_large' });

  express.raw({ type: () => true, limit: MAX_BYTES() })(req, res, (err) => {
    if (err) {
      const status = err.type === 'entity.too.large' ? 413 : 400;
      return res.status(status).json({ error: status === 413 ? 'too_large' : 'bad_upload' });
    }
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (buf.length < MIN_BYTES) return res.status(400).json({ error: 'too_short' });
    if (!magicMatches(mime, buf)) return res.status(415).json({ error: 'unsupported_type' });
    req.audio = { buf, mime };
    req.body = null;
    next();
  });
}

async function transcribe(req, res) {
  res.set('Cache-Control', 'no-store');
  const userId = req.session.userId;
  const { buf, mime } = req.audio;
  req.audio = null;

  const state = await loadState(userId);
  if (!canUse(state, 'voice_stt')) return res.status(403).json({ error: 'no_access' });
  const limit = DAILY_LIMIT(canUse(state, 'ai_coach'));

  const used = await usageModel.bumpUsage(userId, KIND);
  if (used > limit) {
    await usageModel.refundUsage(userId, KIND);
    return res.status(429).json({ error: 'daily_limit', limit });
  }

  try {
    const { text } = await llm.transcribe({ audio: buf, mime, userId });
    return res.json({ text, remainingToday: Math.max(0, limit - used) });
  } catch (err) {
    log.error('Transcription failed:', err.message);
    await usageModel.refundUsage(userId, KIND).catch(() => {});
    return res.status(502).json({ error: 'stt_unavailable' });
  }
}

module.exports = { requireLogin, readAudio, transcribe, magicMatches, TYPES };
