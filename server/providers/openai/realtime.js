import { enforceOptInRateLimit, geminiRateLimiter } from './rate-limit.js';
import {
  resolveVoiceModel,
  isKnownVoiceTier,
} from '../../../src/voice/voiceCost.js';
import {
  GEMINI_REALTIME_MODEL_MINI_DEFAULT,
  GEMINI_REALTIME_MODEL_DEFAULT,
  GEMINI_REALTIME_VOICE_DEFAULT,
  GEMINI_REALTIME_REASONING_DEFAULT,
  GEMINI_REALTIME_CONTEXT_TOKENS_DEFAULT,
  GEMINI_REALTIME_CONTEXT_RETENTION_DEFAULT,
} from './constants.js';
import { realtimeInstructions } from './instructions.js';
import { GEV_REALTIME_TOOLS } from './tools.js';

function createRealtimeTokenHandler({
  annotationGuidance,
  endpoint = 'https://generativelanguage.googleapis.com/v1beta/models',
  fetchImpl = (...args) => fetch(...args),
  resolveApiKey = () => process.env.GOOGLE_AI_STUDIO_KEY,
  models = {},
} = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    // Opt-in per-IP throttle (GEV_RATELIMIT_GEMINI_PER_MIN). No-op when unset.
    if (!enforceOptInRateLimit(geminiRateLimiter(), req, res)) return;

    const apiKey = resolveApiKey();
    if (!apiKey) {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'GOOGLE_AI_STUDIO_KEY is not set' }));
      return;
    }

    // Voice model tier, requested by the client as ?tier=standard|mini.
    // resolveVoiceModel is total: an unknown, empty, or hostile value
    // resolves to `standard` instead of reaching Gemini as a model id, so a
    // bad querystring degrades to a normal session rather than a dead mic.
    // The env overrides stay authoritative per tier (see .env.example) —
    // a wrong upstream model id is then a config fix, not a code change.
    const requestedTier = (() => {
      try {
        return new URL(req.url || '', 'http://localhost').searchParams.get(
          'tier',
        );
      } catch {
        return null;
      }
    })();
    const tier = resolveVoiceModel(requestedTier).tier;
    const model =
      tier === 'mini'
        ? models.mini ||
          process.env.GEMINI_REALTIME_MODEL_MINI ||
          GEMINI_REALTIME_MODEL_MINI_DEFAULT
        : models.standard ||
          process.env.GEMINI_REALTIME_MODEL ||
          GEMINI_REALTIME_MODEL_DEFAULT;
    const voice =
      process.env.GEMINI_REALTIME_VOICE || GEMINI_REALTIME_VOICE_DEFAULT;
    const effort =
      process.env.GEMINI_REALTIME_REASONING_EFFORT ||
      GEMINI_REALTIME_REASONING_DEFAULT;
    const contextTokenLimit = Math.round(
      Math.max(
        1000,
        Math.min(
          12000,
          Number(process.env.GEMINI_REALTIME_CONTEXT_TOKENS) ||
            GEMINI_REALTIME_CONTEXT_TOKENS_DEFAULT,
        ),
      ),
    );
    const contextRetentionRatio = Math.max(
      0.1,
      Math.min(
        1,
        Number(process.env.GEMINI_REALTIME_CONTEXT_RETENTION) ||
          GEMINI_REALTIME_CONTEXT_RETENTION_DEFAULT,
      ),
    );

    // Google AI Studio / Gemini Live API session configuration.
    // The Gemini Live API uses a BidiGenerateContent stream, but for
    // establishing sessions we mint a token through the REST endpoint.
    const sessionConfig = {
      model,
      voice,
      instructions: realtimeInstructions(annotationGuidance),
      tools: GEV_REALTIME_TOOLS,
      generationConfig: {
        maxOutputTokens: contextTokenLimit,
        temperature: 0.7,
      },
    };

    try {
      // For Google AI Studio, we create a session token by verifying the key
      // and returning a client-side usable credential. Unlike OpenAI's
      // ephemeral secrets, Gemini uses API key auth directly — the token
      // endpoint now verifies the key is valid and returns a session config
      // the client can use.
      const modelsToTry = [
        model,
        'gemini-3.8-flash',
        'gemini-3.6-flash',
        'gemini-3.1-flash-lite',
      ].filter((m, i, arr) => m && arr.indexOf(m) === i);

      let keyValid = false;
      let lastStatus = 502;
      let verifiedModel = model;

      for (const m of modelsToTry) {
        const verifyUrl = `${endpoint}/${m}:generateContent?key=${apiKey}`;
        const response = await fetchImpl(verifyUrl, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            contents: [
              {
                role: 'user',
                parts: [{ text: 'ping' }],
              },
            ],
            generationConfig: { maxOutputTokens: 1 },
          }),
        });

        lastStatus = response.status;
        if (response.ok) {
          keyValid = true;
          verifiedModel = m;
          break;
        }

        // A 503 (high demand) or 429 indicates a valid key authenticated upstream
        if (response.status === 503 || response.status === 429) {
          keyValid = true;
          break;
        }

        // If 404 (model unavailable), try next model in fallback list
        if (response.status === 404) {
          continue;
        }

        // For auth errors (400, 401, 403), key is invalid
        break;
      }

      if (!keyValid) {
        console.warn(`[realtime-token] upstream HTTP ${lastStatus}`);
        res.statusCode = lastStatus;
        res.setHeader('X-GEV-Voice-Tier', tier);
        res.setHeader('X-GEV-Voice-Model', model);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(
          JSON.stringify({ error: 'Failed to create Gemini session token' }),
        );
        return;
      }

      // Key is valid — return a session credential the client can use.
      // The client uses this API key directly for Gemini Live API calls.
      const expiresAt = Math.floor(Date.now() / 1000) + 3600; // 1 hour
      const tokenResponse = {
        client_secret: {
          value: apiKey,
          expires_at: expiresAt,
        },
        session: {
          ...sessionConfig,
          reasoning: { effort },
        },
      };

      res.statusCode = 200;
      res.setHeader('X-GEV-Voice-Tier', tier);
      res.setHeader('X-GEV-Voice-Model', model);
      if (requestedTier && !isKnownVoiceTier(requestedTier)) {
        res.setHeader('X-GEV-Voice-Tier-Fallback', '1');
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(tokenResponse));
    } catch {
      // For a network fault this was a resolver message naming the upstream
      // host; the client only needs to know the mint failed.
      console.warn('[realtime-token] mint failed');
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          error: 'Failed to create Gemini session token',
        }),
      );
    }
  };
}

export { createRealtimeTokenHandler };
