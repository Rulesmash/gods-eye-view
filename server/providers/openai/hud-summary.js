import {
  HUD_SUMMARY_INSTRUCTIONS,
  keylessHudSummaryResponse,
} from '../../../src/hudSummaryResponse.js';
import { enforceOptInRateLimit, geminiRateLimiter } from './rate-limit.js';
import { readRequestBody } from '../common/request.js';
import { GEMINI_HUD_SUMMARY_MODEL_DEFAULT } from './constants.js';

function extractGeminiResponseText(data) {
  // Gemini generateContent response shape:
  // { candidates: [{ content: { parts: [{ text: "..." }] } }] }
  if (Array.isArray(data?.candidates)) {
    for (const candidate of data.candidates) {
      const parts = candidate?.content?.parts;
      if (Array.isArray(parts)) {
        const texts = parts
          .map((part) => part?.text || '')
          .join(' ')
          .trim();
        if (texts) return texts;
      }
    }
  }
  // Fallback for simpler response shapes
  if (typeof data?.text === 'string' && data.text.trim()) {
    return data.text.trim();
  }
  return '';
}

function toFiveWordHudSummary(value) {
  return String(value || '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join(' ');
}

async function handleHudSummary(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const apiKey = process.env.GOOGLE_AI_STUDIO_KEY;
  const keyless = keylessHudSummaryResponse(apiKey);
  if (keyless) {
    res.statusCode = keyless.statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(keyless.payload));
    return;
  }

  // Opt-in per-IP throttle (GEV_RATELIMIT_GEMINI_PER_MIN). Keyless HUD
  // fallback has no provider cost and resolves above without consuming a
  // paid-endpoint quota slot.
  if (!enforceOptInRateLimit(geminiRateLimiter(), req, res)) return;

  try {
    const body = await readRequestBody(req, 64 * 1024);
    const context = JSON.parse(body || '{}');
    const model =
      process.env.GEMINI_HUD_SUMMARY_MODEL ||
      GEMINI_HUD_SUMMARY_MODEL_DEFAULT;
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: HUD_SUMMARY_INSTRUCTIONS }],
          },
          contents: [
            {
              role: 'user',
              parts: [{ text: JSON.stringify(context) }],
            },
          ],
          generationConfig: {
            maxOutputTokens: 100,
            temperature: 0.2,
          },
        }),
      },
    );
    const data = await response.json().catch(() => ({}));
    const summary = toFiveWordHudSummary(extractGeminiResponseText(data));
    res.statusCode = response.ok && summary ? 200 : response.status || 502;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (!response.ok)
      console.warn(`[hud-summary] upstream HTTP ${response.status}`);
    res.end(
      JSON.stringify({
        summary: summary || null,
        // Never relay `data.error.message`: that is Gemini's own wording, and
        // it carries request ids and quota phrasing.
        error: response.ok ? null : 'Gemini HUD summary request failed',
      }),
    );
  } catch {
    console.warn('[hud-summary] request failed');
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        error: 'Gemini HUD summary request failed',
      }),
    );
  }
}

export { handleHudSummary };
