import { readRequestBody } from '../common/request.js';
import { enforceOptInRateLimit, geminiRateLimiter } from './rate-limit.js';
import { realtimeInstructions } from './instructions.js';
import { GEV_REALTIME_TOOLS } from './tools.js';
import {
  GEMINI_REALTIME_MODEL_DEFAULT,
  GEMINI_REALTIME_MODEL_MINI_DEFAULT,
} from './constants.js';

function cleanSchemaForGemini(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(cleanSchemaForGemini);
  const clean = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'additionalProperties') continue;
    clean[k] = cleanSchemaForGemini(v);
  }
  return clean;
}

function formatGeminiTools(tools = GEV_REALTIME_TOOLS) {
  const functionDeclarations = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: cleanSchemaForGemini(t.parameters) || { type: 'OBJECT', properties: {} },
  }));
  return [{ functionDeclarations }];
}

function convertMessagesToGeminiContents(messages = []) {
  const contents = [];
  for (const msg of messages) {
    if (!msg) continue;
    const role = msg.role;
    if (role === 'user') {
      const parts = [];
      if (typeof msg.content === 'string' && msg.content.trim()) {
        parts.push({ text: msg.content.trim() });
      } else if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if (item?.type === 'input_text' || item?.type === 'text') {
            if (item.text?.trim()) parts.push({ text: item.text.trim() });
          } else if (item?.type === 'input_image' || item?.type === 'image') {
            const data = item.data || item.image_url?.url || '';
            const match = String(data).match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              parts.push({
                inlineData: { mimeType: match[1], data: match[2] },
              });
            }
          }
        }
      }
      if (parts.length) contents.push({ role: 'user', parts });
    } else if (role === 'model' || role === 'assistant') {
      const parts = [];
      if (Array.isArray(msg.parts) && msg.parts.length) {
        parts.push(...msg.parts);
      } else {
        if (msg.functionCall) {
          parts.push({
            functionCall: msg.functionCall,
            thoughtSignature: msg.thoughtSignature || undefined,
          });
        }
        if (msg.text || (typeof msg.content === 'string' && msg.content.trim())) {
          parts.push({ text: msg.text || msg.content.trim() });
        }
      }
      if (parts.length) contents.push({ role: 'model', parts });
    } else if (role === 'tool' || role === 'function') {
      const name = msg.name || msg.call_id || 'unknown_function';
      let responseObj = msg.content || msg.response || {};
      if (typeof responseObj === 'string') {
        try {
          responseObj = JSON.parse(responseObj);
        } catch {
          responseObj = { output: responseObj };
        }
      }
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name,
              response: responseObj.output !== undefined ? responseObj : { output: responseObj },
            },
          },
        ],
      });
    }
  }
  return contents;
}

function createRealtimeTurnHandler({
  annotationGuidance,
  resolveApiKey = () => process.env.GOOGLE_AI_STUDIO_KEY,
} = {}) {
  const instructions = realtimeInstructions({ annotationGuidance });
  const geminiTools = formatGeminiTools(GEV_REALTIME_TOOLS);

  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    if (!enforceOptInRateLimit(geminiRateLimiter(), req, res)) return;

    const apiKey = resolveApiKey();
    if (!apiKey) {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'GOOGLE_AI_STUDIO_KEY is not set' }));
      return;
    }

    try {
      const rawBody = await readRequestBody(req, 1024 * 1024);
      const payload = JSON.parse(rawBody || '{}');
      const requestedTier = payload.tier === 'mini' ? 'mini' : 'standard';
      const defaultModel =
        requestedTier === 'mini'
          ? (process.env.GEMINI_REALTIME_MODEL_MINI || GEMINI_REALTIME_MODEL_MINI_DEFAULT)
          : (process.env.GEMINI_REALTIME_MODEL || GEMINI_REALTIME_MODEL_DEFAULT);

      const requestedModel = payload.model || defaultModel;
      const modelsToTry = [
        requestedModel,
        'gemini-3.8-flash',
        'gemini-3.6-flash',
        'gemini-3.1-flash-lite',
        'gemini-3.5-flash-lite',
        'gemini-flash-lite-latest',
        'gemini-3-flash-preview',
      ].filter((m, i, arr) => m && arr.indexOf(m) === i);

      const contents = convertMessagesToGeminiContents(payload.messages || []);
      if (!contents.length) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'No message contents provided' }));
        return;
      }

      let lastResponse = null;
      let lastData = null;
      let usedModel = requestedModel;

      for (const model of modelsToTry) {
        usedModel = model;
        const requestBody = {
          systemInstruction: {
            parts: [{ text: payload.instructions || instructions }],
          },
          contents,
          tools: geminiTools,
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 1000,
          },
        };

        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
          },
        );

        lastResponse = response;
        if (response.ok) {
          lastData = await response.json();
          break;
        }

        lastData = await response.json().catch(() => ({}));

        // 429 (quota), 503 (high demand), 404 (not found) -> try next fallback model
        if (response.status === 429 || response.status === 503 || response.status === 404) {
          continue;
        }

        // Auth errors (400, 401, 403)
        break;
      }

      if (!lastResponse?.ok || !lastData) {
        const status = lastResponse?.status || 502;
        console.warn(`[realtime-turn] upstream HTTP ${status}`);
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Gemini turn request failed', details: lastData }));
        return;
      }

      // Parse candidate parts
      const candidate = lastData.candidates?.[0];
      const parts = candidate?.content?.parts || [];
      const functionCalls = [];
      let text = '';

      for (const part of parts) {
        if (part.functionCall) {
          functionCalls.push({
            id: part.functionCall.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            name: part.functionCall.name,
            args: part.functionCall.args || {},
            thoughtSignature: part.thoughtSignature || undefined,
            rawPart: part,
          });
        }
        if (part.text) {
          text = (text ? text + ' ' : '') + part.text;
        }
      }

      const usage = {
        input_tokens: lastData.usageMetadata?.promptTokenCount || 0,
        output_tokens: lastData.usageMetadata?.candidatesTokenCount || 0,
        total_tokens: lastData.usageMetadata?.totalTokenCount || 0,
        output_token_details: {
          text_tokens: lastData.usageMetadata?.candidatesTokenCount || 0,
          audio_tokens: 0,
        },
      };

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-GEV-Voice-Model', usedModel);
      res.end(
        JSON.stringify({
          model: usedModel,
          text: text.trim(),
          functionCalls,
          modelParts: parts,
          usage,
        }),
      );
    } catch (error) {
      console.warn('[realtime-turn] error:', error?.message);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: error?.message || 'Internal server error' }));
    }
  };
}

export { createRealtimeTurnHandler };
