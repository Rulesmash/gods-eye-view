# Gemini Live Voice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace OpenAI Realtime voice and the OpenAI HUD summary with a server-minted Gemini Live session and a Gemini text summary, keeping the existing map tools.

**Architecture:** `server/providers/gemini` takes the OpenAI plugin slot. It mints a one-use ephemeral token with `@google/genai` and serves the five-word HUD from `generateContent`. The browser opens the constrained Live WebSocket, and `geminiLiveMessages.js` translates Gemini JSON to and from the session events the current turn pipeline already understands. Audio minutes drive the existing $2 warning and $5 cap.

**Tech Stack:** Node ESM, Vite middleware, `@google/genai` on the server only, browser WebSocket plus AudioWorklet, existing `node --test` runner.

## Global Constraints

- `GEMINI_API_KEY` stays on the server. The browser receives only `token.name`.
- Token config is `uses: 1`, `expireTime` 30 minutes out, `newSessionExpireTime` 1 minute out.
- `liveConnectConstraints` lock model `gemini-3.8-live`, the current system instruction, the Gemini function declarations, voice `Kore`, response modality `AUDIO`, and `sessionResumption`.
- Browser socket URL is `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=<token>`.
- Mic audio is 16-bit PCM, 16 kHz, mono, and is sent only while the mic or push-to-talk is open. Playback is 24 kHz PCM.
- A provider close that carries a session-resumption handle resumes once with the same token. The cost meter continues. A failed resume ends the session and does not mint another token.
- A new mic start, the $5 cap, a missing mic, or a failed setup mints a new token. The client does not mint in the background.
- Live audio rates are $0.005 per minute input and $0.018 per minute output. An unrecognized model id bills at those rates and logs one warning. It never bills at zero.
- Warn at $2. Close the session at $5.
- HUD route is `POST /api/gemini/hud-summary`. Missing key returns the keyless payload and does not consume a rate-limit slot. Upstream failures log the status and return a fixed JSON error. The token route preserves the upstream HTTP status with a fixed body.
- Declaration mapper drops `additionalProperties`, `minimum`, and `maximum`.
- `@google/genai` is not imported by any browser module.
- Google AI Pro does not authorize this app. There is no second provider and no extended-thinking mode.
- Map tool behavior, radio handoff, and push-to-talk timing stay as they are.

---

### Task 1: Gemini function declarations

**Files:**
- Create: `server/providers/gemini/declarations.js`
- Create: `src/voice/geminiDeclarations.test.mjs`
- Modify: none yet. `actionSchemas.js` stays the source of names.

**Interfaces:**
- Consumes: `createActionTools(descriptions)` from `src/voice/actionSchemas.js`. Each tool is `{ type: 'function', name, description, parameters }`.
- Produces: `toGeminiFunctionDeclarations(tools) -> Array<{ name: string, description: string, parameters: object }>`.

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createActionTools } from './actionSchemas.js';
import { toGeminiFunctionDeclarations } from '../../server/providers/gemini/declarations.js';

test('every action name survives and OpenAI-only schema keys are dropped', () => {
  const tools = createActionTools({});
  const declarations = toGeminiFunctionDeclarations(tools);
  assert.equal(declarations.length, tools.length);
  assert.deepEqual(
    declarations.map((item) => item.name),
    tools.map((item) => item.name),
  );
  const fly = declarations.find((item) => item.name === 'fly_to_location');
  assert.equal(fly.parameters.type, 'object');
  assert.equal(Object.hasOwn(fly.parameters, 'additionalProperties'), false);
  assert.equal(
    Object.hasOwn(fly.parameters.properties.latitude, 'minimum'),
    false,
  );
  assert.equal(
    Object.hasOwn(fly.parameters.properties.latitude, 'maximum'),
    false,
  );
  const zoom = declarations.find((item) => item.name === 'adjust_camera_zoom');
  assert.deepEqual(zoom.parameters.required, ['direction', 'amount']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test src/voice/geminiDeclarations.test.mjs`

Expected: FAIL because `server/providers/gemini/declarations.js` does not exist.

- [ ] **Step 3: Write the mapper**

```js
function stripSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const result = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'additionalProperties' || key === 'minimum' || key === 'maximum') continue;
    result[key] = Array.isArray(value) ? value.map(stripSchema) : stripSchema(value);
  }
  return result;
}

export function toGeminiFunctionDeclarations(tools) {
  return tools.map((tool) => ({
    name: tool.name,
    description: typeof tool.description === 'string' ? tool.description : '',
    parameters: stripSchema(tool.parameters),
  }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test src/voice/geminiDeclarations.test.mjs`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/providers/gemini/declarations.js src/voice/geminiDeclarations.test.mjs
git commit -m "feat: map voice actions to Gemini function declarations"
```

---

### Task 2: Live message translation

**Files:**
- Create: `src/voice/geminiLiveMessages.js`
- Create: `src/voice/geminiLiveMessages.test.mjs`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `liveSocketUrl(token: string) -> string`
  - `liveSetupMessage(model: string) -> object`
  - `liveResumeSetupMessage(model: string, handle: string) -> object`
  - `translateClientEvent(event: object) -> object | null`
  - `translateServerMessage(message: object) -> object[]`

`translateServerMessage` returns zero or more events in the shape the current session already handles (`response.output_audio.delta`, `response.output_audio_transcript.delta`, `response.output_audio_transcript.done`, `conversation.item.input_audio_transcription.completed`, `input_audio_buffer.speech_started`, `response.function_call_arguments.done`, `response.created`, `response.done`, `session.resumption.required`).

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  liveResumeSetupMessage,
  liveSetupMessage,
  liveSocketUrl,
  translateClientEvent,
  translateServerMessage,
} from './geminiLiveMessages.js';

test('socket url uses the constrained v1beta endpoint and the token', () => {
  assert.equal(
    liveSocketUrl('auth_tokens/abc'),
    'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=auth_tokens%2Fabc',
  );
});

test('setup repeats model and audio modality only', () => {
  assert.deepEqual(liveSetupMessage('gemini-3.8-live'), {
    setup: {
      model: 'models/gemini-3.8-live',
      generationConfig: { responseModalities: ['AUDIO'] },
    },
  });
});

test('resume setup carries the stored handle', () => {
  assert.equal(
    liveResumeSetupMessage('gemini-3.8-live', 'handle-1').setup.sessionResumption
      .handle,
    'handle-1',
  );
});

test('audio output and a tool call become session events', () => {
  const events = translateServerMessage({
    serverContent: {
      modelTurn: {
        parts: [
          { inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'QQ==' } },
        ],
      },
      turnComplete: true,
    },
    toolCall: {
      functionCalls: [{ id: 'call-1', name: 'fly_to_location', args: { query: 'LAX' } }],
    },
  });
  assert.deepEqual(
    events.find((event) => event.type === 'response.output_audio.delta').delta,
    'QQ==',
  );
  assert.deepEqual(
    events.find((event) => event.type === 'response.function_call_arguments.done'),
    {
      type: 'response.function_call_arguments.done',
      item_id: 'call-1',
      call_id: 'call-1',
      name: 'fly_to_location',
      arguments: '{"query":"LAX"}',
    },
  );
  assert.equal(events.filter((event) => event.type === 'response.done').length, 1);
});

test('tool output and viewport image become Live client messages', () => {
  const tool = translateClientEvent({
    type: 'conversation.item.create',
    item: {
      type: 'function_call_output',
      call_id: 'call-1',
      output: '{"ok":true}',
    },
  });
  assert.equal(tool.toolResponse.functionResponses[0].id, 'call-1');
  assert.deepEqual(tool.toolResponse.functionResponses[0].response, { ok: true });

  const image = translateClientEvent({
    type: 'conversation.item.create',
    item: {
      type: 'message',
      content: [
        { type: 'input_text', text: 'look' },
        { type: 'input_image', image_url: 'data:image/jpeg;base64,QQ==' },
      ],
    },
  });
  assert.equal(image.realtimeInput.video.data, 'QQ==');
  assert.equal(image.realtimeInput.text, 'look');
});

test('a resumption update asks for one resume and does not look like an error', () => {
  const events = translateServerMessage({
    sessionResumptionUpdate: { resumable: true, newHandle: 'next' },
  });
  assert.deepEqual(events, [
    { type: 'session.resumption.required', handle: 'next' },
  ]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test src/voice/geminiLiveMessages.test.mjs`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Write the translator**

```js
const SOCKET_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';

export function liveSocketUrl(token) {
  return `${SOCKET_URL}?access_token=${encodeURIComponent(token)}`;
}

export function liveSetupMessage(model) {
  return {
    setup: {
      model: model.startsWith('models/') ? model : `models/${model}`,
      generationConfig: { responseModalities: ['AUDIO'] },
    },
  };
}

export function liveResumeSetupMessage(model, handle) {
  const message = liveSetupMessage(model);
  message.setup.sessionResumption = { handle };
  return message;
}

function contentText(item) {
  const parts = Array.isArray(item?.content) ? item.content : [];
  return parts
    .filter((part) => part?.type === 'input_text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

function contentImage(item) {
  const parts = Array.isArray(item?.content) ? item.content : [];
  const image = parts.find((part) => part?.type === 'input_image');
  const url = typeof image?.image_url === 'string' ? image.image_url : '';
  const match = url.match(/^data:image\/jpeg;base64,(.+)$/);
  return match ? match[1] : '';
}

export function translateClientEvent(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.type === 'conversation.item.delete') return null;
  if (event.type === 'response.create') {
    const instructions = event.response?.instructions;
    if (typeof instructions !== 'string' || !instructions.trim()) return null;
    return {
      clientContent: {
        turns: [{ role: 'user', parts: [{ text: instructions }] }],
        turnComplete: true,
      },
    };
  }
  if (event.type !== 'conversation.item.create') return null;
  const item = event.item || {};
  if (item.type === 'function_call_output') {
    let response = {};
    try {
      response = JSON.parse(item.output || '{}');
    } catch {
      response = { output: String(item.output || '') };
    }
    return {
      toolResponse: {
        functionResponses: [
          {
            id: item.call_id,
            name: item.name || '',
            response,
          },
        ],
      },
    };
  }
  const text = contentText(item);
  const image = contentImage(item);
  if (!text && !image) return null;
  if (image) {
    return {
      realtimeInput: {
        ...(text ? { text } : {}),
        video: { mimeType: 'image/jpeg', data: image },
      },
    };
  }
  return {
    clientContent: {
      turns: [{ role: 'user', parts: [{ text }] }],
      turnComplete: true,
    },
  };
}

export function translateServerMessage(message) {
  const events = [];
  const update = message?.sessionResumptionUpdate;
  if (update?.resumable && typeof update.newHandle === 'string' && update.newHandle) {
    events.push({ type: 'session.resumption.required', handle: update.newHandle });
  }
  const parts = message?.serverContent?.modelTurn?.parts;
  if (Array.isArray(parts)) {
    for (const part of parts) {
      const data = part?.inlineData?.data;
      const mime = String(part?.inlineData?.mimeType || '');
      if (typeof data === 'string' && mime.startsWith('audio/pcm')) {
        events.push({ type: 'response.output_audio.delta', delta: data });
      }
      if (typeof part?.text === 'string' && part.text) {
        events.push({
          type: 'response.output_audio_transcript.delta',
          delta: part.text,
        });
      }
    }
  }
  const outputTranscript = message?.serverContent?.outputTranscription?.text;
  if (typeof outputTranscript === 'string' && outputTranscript) {
    events.push({
      type: 'response.output_audio_transcript.done',
      transcript: outputTranscript,
    });
  }
  const inputTranscript = message?.serverContent?.inputTranscription?.text;
  if (typeof inputTranscript === 'string' && inputTranscript) {
    events.push({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: inputTranscript,
    });
    events.push({ type: 'input_audio_buffer.speech_started' });
  }
  const calls = message?.toolCall?.functionCalls;
  if (Array.isArray(calls)) {
    for (const call of calls) {
      if (!call?.name) continue;
      const id = String(call.id || call.name);
      events.push({
        type: 'response.function_call_arguments.done',
        item_id: id,
        call_id: id,
        name: call.name,
        arguments: JSON.stringify(call.args || {}),
      });
    }
  }
  if (message?.serverContent?.interrupted) {
    events.push({ type: 'input_audio_buffer.speech_started' });
  }
  if (message?.serverContent?.turnComplete) {
    events.push({ type: 'response.created', response: { id: 'live-turn' } });
    events.push({
      type: 'response.done',
      response: { id: 'live-turn', status: 'completed' },
    });
  }
  return events;
}
```

The `response.created` event is emitted immediately before `response.done` so the existing turn owner sees a completed turn. Tool calls are separate events and do not wait for `turnComplete`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test src/voice/geminiLiveMessages.test.mjs`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/voice/geminiLiveMessages.js src/voice/geminiLiveMessages.test.mjs
git commit -m "feat: translate Gemini Live messages to the voice session"
```

---

### Task 3: PCM framing

**Files:**
- Create: `src/voice/pcmFraming.js`
- Create: `src/voice/pcmFraming.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `floatToPcm16Base64(samples: Float32Array, inputRate: number, outputRate: number) -> string`
  - `pcm16Base64ToFloat32(base64: string) -> Float32Array`
  - `PCM_INPUT_RATE = 16000`
  - `PCM_OUTPUT_RATE = 24000`

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PCM_INPUT_RATE,
  PCM_OUTPUT_RATE,
  floatToPcm16Base64,
  pcm16Base64ToFloat32,
} from './pcmFraming.js';

test('downsampling keeps a full-scale sample inside signed 16-bit', () => {
  assert.equal(PCM_INPUT_RATE, 16000);
  assert.equal(PCM_OUTPUT_RATE, 24000);
  const input = new Float32Array([0, 1, -1, 0.5]);
  const decoded = pcm16Base64ToFloat32(floatToPcm16Base64(input, 4, 2));
  assert.equal(decoded.length, 2);
  assert.ok(decoded[0] > 0.4 && decoded[0] <= 1);
  assert.ok(decoded[1] < -0.4 && decoded[1] >= -1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test src/voice/pcmFraming.test.mjs`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Write the framer**

```js
export const PCM_INPUT_RATE = 16000;
export const PCM_OUTPUT_RATE = 24000;

function clampSample(value) {
  if (value > 1) return 1;
  if (value < -1) return -1;
  return value;
}

export function floatToPcm16Base64(samples, inputRate, outputRate) {
  const ratio = inputRate / outputRate;
  const length = Math.max(1, Math.floor(samples.length / ratio));
  const pcm = new Int16Array(length);
  for (let index = 0; index < length; index += 1) {
    const sourceIndex = Math.min(samples.length - 1, Math.floor(index * ratio));
    pcm[index] = Math.round(clampSample(samples[sourceIndex]) * 32767);
  }
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
}

export function pcm16Base64ToFloat32(base64) {
  const bytes = Buffer.from(base64, 'base64');
  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const samples = new Float32Array(pcm.length);
  for (let index = 0; index < pcm.length; index += 1) samples[index] = pcm[index] / 32768;
  return samples;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test src/voice/pcmFraming.test.mjs`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/voice/pcmFraming.js src/voice/pcmFraming.test.mjs
git commit -m "feat: frame mic and playback audio as PCM16"
```

---

### Task 4: Price voice by audio minutes

**Files:**
- Modify: `src/voice/voiceCost.js`
- Modify: `src/voice/voiceCost.test.mjs`
- Modify: `src/voice/realtimeCost.js`
- Modify: `src/voice/control.js`
- Modify: `src/voice/realtimeBackend.js`
- Modify: `src/voice/realtimePreferences.js` if it still reads a stored tier
- Modify: `src/voice/gevRealtime.test.mjs`
- Modify: `src/voice/realtimeOwners.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `GEMINI_LIVE_MODEL_ID = 'gemini-3.8-live'`
  - `GEMINI_LIVE_AUDIO_RATES = { inputUsdPerMinute: 0.005, outputUsdPerMinute: 0.018 }`
  - `VOICE_MODEL_RATES_VERIFIED_ON` set to the date the pricing page is read during this task
  - `estimateAudioSecondsCostUsd({ inputSeconds, outputSeconds }, rates) -> number`
  - `resolveVoiceModelById(modelId)` returns the live entry when `modelId` is `gemini-3.8-live`, otherwise the same rates with `recognized: false`
  - `createVoiceCostTracker(...).recordAudio({ inputSeconds, outputSeconds })`
- Remove from the public surface: `VOICE_MODELS.mini`, `VOICE_TIERS`, `DEFAULT_VOICE_TIER`, `resolveVoiceModel`, `isKnownVoiceTier`, `splitUsageTokens`, `estimateUsageCostUsd`, and `record(usage)`.

- [ ] **Step 1: Replace the OpenAI registry tests**

Delete the tests whose names assert two tiers, `gpt-realtime-2`, or `gpt-realtime-2.1-mini`. Replace the top of `src/voice/voiceCost.test.mjs` imports with the new exports. Add this test and delete `dollarsOfUsage`:

```js
test('one output minute costs 1.8 cents and one input minute costs half a cent', () => {
  assert.equal(GEMINI_LIVE_MODEL_ID, 'gemini-3.8-live');
  assert.equal(
    estimateAudioSecondsCostUsd({ inputSeconds: 60, outputSeconds: 0 }, GEMINI_LIVE_AUDIO_RATES),
    0.005,
  );
  assert.equal(
    estimateAudioSecondsCostUsd({ inputSeconds: 0, outputSeconds: 60 }, GEMINI_LIVE_AUDIO_RATES),
    0.018,
  );
});

test('an unknown model id still bills at the published Live rates', () => {
  const model = resolveVoiceModelById('gemini-other');
  assert.equal(model.recognized, false);
  assert.equal(model.rates.outputUsdPerMinute, 0.018);
});

function outputSecondsForUsd(usd) {
  return (usd / GEMINI_LIVE_AUDIO_RATES.outputUsdPerMinute) * 60;
}

test('the tracker warns at $2 and caps at $5 once', () => {
  const tracker = createVoiceCostTracker({ modelId: GEMINI_LIVE_MODEL_ID });
  const warned = tracker.recordAudio({ outputSeconds: outputSecondsForUsd(2) });
  assert.equal(warned.warnCrossed, true);
  assert.equal(warned.capReached, false);
  const capped = tracker.recordAudio({ outputSeconds: outputSecondsForUsd(3) });
  assert.equal(capped.capCrossed, true);
  assert.equal(capped.capReached, true);
  const again = tracker.recordAudio({ outputSeconds: outputSecondsForUsd(1) });
  assert.equal(again.capCrossed, false);
  assert.equal(again.capReached, true);
});
```

Keep the existing tests for `formatCostUsd`, `normalizeCostLimits`, `serializeCostLimits`, and the one-shot latch behavior. Rewrite any remaining `record(usage)` call in this file to `recordAudio({ outputSeconds: outputSecondsForUsd(n) })`.

- [ ] **Step 2: Run the cost test to verify it fails**

Run: `node --test src/voice/voiceCost.test.mjs`

Expected: FAIL on missing `estimateAudioSecondsCostUsd` or leftover tier assertions.

- [ ] **Step 3: Replace the rate table and record path**

In `src/voice/voiceCost.js`:

- Replace the OpenAI model comment and `VOICE_MODELS` with one frozen live rate table dated from the Gemini pricing page read in this task. If that page disagrees with $0.005 and $0.018, use the page and update the test numbers in Step 1 to the page's numbers before finishing.
- Delete `splitUsageTokens` and `estimateUsageCostUsd`.
- Add `estimateAudioSecondsCostUsd`. Ignore negative and non-finite seconds. Return 0 when seconds or rates are missing.

```js
export function estimateAudioSecondsCostUsd(sample, rates) {
  const inputSeconds = Number(sample?.inputSeconds);
  const outputSeconds = Number(sample?.outputSeconds);
  const input = Number.isFinite(inputSeconds) && inputSeconds > 0 ? inputSeconds : 0;
  const output = Number.isFinite(outputSeconds) && outputSeconds > 0 ? outputSeconds : 0;
  const usd =
    (input / 60) * nonNegative(rates?.inputUsdPerMinute) +
    (output / 60) * nonNegative(rates?.outputUsdPerMinute);
  return Number.isFinite(usd) && usd > 0 ? usd : 0;
}
```

- Change `createVoiceCostTracker.record` to `recordAudio(sample)`. It adds `estimateAudioSecondsCostUsd(sample, model.rates)` and keeps the same warn and cap latches. `responses` counts each `recordAudio` call that adds a positive amount.
- `resolveVoiceModelById('gemini-3.8-live')` returns `recognized: true`. Any other id returns `recognized: false` and the same rates. `mostExpensiveVoiceModel` returns that single entry.

In `src/voice/realtimeCost.js`, rename the public method `recordUsage(usage)` to `recordAudio(sample)` and forward to `costTracker.recordAudio(sample)`.

In `src/voice/realtimeBackend.js`, `requestToken({ signal })` no longer appends `tier`.

In `src/voice/control.js`, delete the `#gev-voice-tier` button and the `tierButton` property.

In `src/voice/realtimePreferences.js`, delete tier read and write helpers if they exist. Search for `voiceCost.tier`.

In `src/voice/gevRealtime.test.mjs` and `src/voice/realtimeOwners.test.mjs`:

- Replace `resolveVoiceModel('mini').id` with `'gemini-3.8-live'`.
- Replace `controller.recordUsage(usdUsage(n))` with `controller.recordAudio({ outputSeconds: (n / 0.018) * 60 })`.
- Delete the tests named `voice tier round-trips through storage`, `an unset or hand-edited tier reads back as standard`, `writing a bogus tier persists the safe fallback, not the bogus value`, and `F1: toggling tier mid-session does not erase accrued spend`.
- Remove `tierButton` fixtures. Assertions that read `ui.tierButton.textContent` come out with those tests.

- [ ] **Step 4: Run the voice tests**

Run: `node --test src/voice/voiceCost.test.mjs src/voice/gevRealtime.test.mjs src/voice/realtimeOwners.test.mjs`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/voice/voiceCost.js src/voice/voiceCost.test.mjs src/voice/realtimeCost.js src/voice/control.js src/voice/realtimeBackend.js src/voice/realtimePreferences.js src/voice/gevRealtime.test.mjs src/voice/realtimeOwners.test.mjs
git commit -m "feat: meter Gemini Live voice by audio minute"
```

---

### Task 5: Mint the Live token

**Files:**
- Create: `server/providers/gemini/constants.js`
- Create: `server/providers/gemini/realtime.js`
- Create: `server/providers/gemini/instructions.js`
- Create: `server/providers/gemini/toolDescriptions.js`
- Create: `server/providers/gemini/tools.js`
- Create: `src/voice/geminiToken.test.mjs`
- Modify: `package.json` dependencies

**Interfaces:**
- Consumes: `toGeminiFunctionDeclarations` from Task 1. `realtimeInstructions(annotationGuidance)` copied from `server/providers/openai/instructions.js`. `ACTION_DESCRIPTIONS` copied from `server/providers/openai/toolDescriptions.js`.
- Produces: `createRealtimeTokenHandler({ annotationGuidance, createToken, resolveApiKey, model, voice })` with the same `(req, res)` shape as today's handler.

- [ ] **Step 1: Install the server SDK and copy the instruction text**

Run: `npm install @google/genai`

Copy `server/providers/openai/instructions.js` to `server/providers/gemini/instructions.js` unchanged.

Copy `server/providers/openai/toolDescriptions.js` to `server/providers/gemini/toolDescriptions.js` unchanged.

`server/providers/gemini/tools.js`:

```js
import { createActionTools } from '../../../src/voice/actionSchemas.js';
import { toGeminiFunctionDeclarations } from './declarations.js';
import { ACTION_DESCRIPTIONS } from './toolDescriptions.js';

export const GEV_LIVE_TOOLS = toGeminiFunctionDeclarations(
  createActionTools(ACTION_DESCRIPTIONS),
);
```

`server/providers/gemini/constants.js`:

```js
export const GEMINI_LIVE_MODEL_DEFAULT = 'gemini-3.8-live';
export const GEMINI_LIVE_VOICE_DEFAULT = 'Kore';
export const GEMINI_HUD_SUMMARY_MODEL_DEFAULT = 'gemini-3.8-flash';
export const GEMINI_TOKEN_EXPIRE_MS = 30 * 60 * 1000;
export const GEMINI_NEW_SESSION_EXPIRE_MS = 60 * 1000;
```

- [ ] **Step 2: Write the failing token test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRealtimeTokenHandler } from '../../server/providers/gemini/realtime.js';
import { GEV_LIVE_TOOLS } from '../../server/providers/gemini/tools.js';

function responseDouble() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name] = value; },
    end(body) { this.body = body; },
  };
}

test('missing key returns 503 and does not call Google', async () => {
  let called = false;
  const handler = createRealtimeTokenHandler({
    resolveApiKey: () => '',
    createToken: async () => { called = true; },
  });
  const res = responseDouble();
  await handler({ method: 'GET', url: '/api/realtime/token' }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(called, false);
  assert.match(res.body, /GEMINI_API_KEY is not set/);
});

test('success returns token.name and locks the Live session', async () => {
  let config;
  const handler = createRealtimeTokenHandler({
    resolveApiKey: () => 'test-key',
    model: 'gemini-3.8-live',
    voice: 'Kore',
    createToken: async (next) => {
      config = next;
      return { name: 'auth_tokens/abc' };
    },
  });
  const res = responseDouble();
  await handler({ method: 'POST', url: '/api/realtime/token' }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).token, 'auth_tokens/abc');
  assert.equal(res.headers['X-GEV-Voice-Model'], 'gemini-3.8-live');
  assert.equal(config.uses, 1);
  assert.equal(config.liveConnectConstraints.model, 'gemini-3.8-live');
  assert.equal(config.liveConnectConstraints.config.responseModalities[0], 'AUDIO');
  assert.equal(
    config.liveConnectConstraints.config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,
    'Kore',
  );
  assert.deepEqual(config.liveConnectConstraints.config.sessionResumption, {});
  assert.equal(
    config.liveConnectConstraints.config.tools[0].functionDeclarations.length,
    GEV_LIVE_TOOLS.length,
  );
});

test('upstream failure keeps the status and hides the body', async () => {
  const handler = createRealtimeTokenHandler({
    resolveApiKey: () => 'test-key',
    createToken: async () => { throw Object.assign(new Error('quota sk-secret'), { status: 429 }); },
  });
  const res = responseDouble();
  await handler({ method: 'GET', url: '/api/realtime/token' }, res);
  assert.equal(res.statusCode, 429);
  assert.equal(JSON.parse(res.body).error, 'Failed to create Live token');
  assert.equal(res.body.includes('sk-secret'), false);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test src/voice/geminiToken.test.mjs`

Expected: FAIL because `realtime.js` does not exist.

- [ ] **Step 4: Write the handler**

```js
import { enforceOptInRateLimit, geminiRateLimiter } from './rate-limit.js';
import { realtimeInstructions } from './instructions.js';
import { GEV_LIVE_TOOLS } from './tools.js';
import {
  GEMINI_LIVE_MODEL_DEFAULT,
  GEMINI_LIVE_VOICE_DEFAULT,
  GEMINI_NEW_SESSION_EXPIRE_MS,
  GEMINI_TOKEN_EXPIRE_MS,
} from './constants.js';

function createRealtimeTokenHandler({
  annotationGuidance,
  createToken,
  resolveApiKey = () => process.env.GEMINI_API_KEY,
  model = process.env.GEMINI_LIVE_MODEL || GEMINI_LIVE_MODEL_DEFAULT,
  voice = process.env.GEMINI_LIVE_VOICE || GEMINI_LIVE_VOICE_DEFAULT,
} = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'POST') {
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
      res.end(JSON.stringify({ error: 'GEMINI_API_KEY is not set' }));
      return;
    }
    const now = Date.now();
    const config = {
      uses: 1,
      expireTime: new Date(now + GEMINI_TOKEN_EXPIRE_MS).toISOString(),
      newSessionExpireTime: new Date(now + GEMINI_NEW_SESSION_EXPIRE_MS).toISOString(),
      liveConnectConstraints: {
        model,
        config: {
          sessionResumption: {},
          responseModalities: ['AUDIO'],
          systemInstruction: realtimeInstructions(annotationGuidance),
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
          tools: [{ functionDeclarations: GEV_LIVE_TOOLS }],
        },
      },
    };
    try {
      const token = await createToken(config, apiKey);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('X-GEV-Voice-Model', model);
      res.end(JSON.stringify({ token: token.name, expiresAt: config.expireTime }));
    } catch (error) {
      const status = Number(error?.status) || 502;
      console.warn(`[realtime-token] upstream HTTP ${status}`);
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'Failed to create Live token' }));
    }
  };
}

export { createRealtimeTokenHandler };
```

Add `server/providers/gemini/rate-limit.js` by copying `server/providers/openai/rate-limit.js` and renaming `openAiRateLimiter` to `geminiRateLimiter` and `GEV_RATELIMIT_OPENAI_PER_MIN` to `GEV_RATELIMIT_GEMINI_PER_MIN`. The test above calls that limiter. When the env var is unset, `enforceOptInRateLimit` returns true.

The production `createToken` used in Task 8 is:

```js
import { GoogleGenAI } from '@google/genai';

async function createGeminiToken(config, apiKey) {
  const client = new GoogleGenAI({ apiKey });
  return client.authTokens.create({ config });
}
```

Do not call that from the unit test. The test injects `createToken`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test src/voice/geminiToken.test.mjs src/voice/geminiDeclarations.test.mjs`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json server/providers/gemini src/voice/geminiToken.test.mjs
git commit -m "feat: mint a constrained Gemini Live token"
```

---

### Task 6: HUD summary on Gemini

**Files:**
- Create: `server/providers/gemini/hud-summary.js`
- Modify: `src/hudSummaryResponse.js`
- Modify: `src/hudSummaryResponse.test.mjs`
- Modify: the client module that POSTs `/api/openai/hud-summary` (search the repo for that string and change that one call site)

**Interfaces:**
- Consumes: `keylessHudSummaryResponse` and `toFiveWordHudSummary` behavior from the current HUD handler.
- Produces: `handleHudSummary(req, res)` mounted later at `/api/gemini/hud-summary`. Unconfigured code is `GEMINI_NOT_CONFIGURED`.

- [ ] **Step 1: Write the failing assertion**

In `src/hudSummaryResponse.test.mjs`, change `OPENAI_NOT_CONFIGURED` to `GEMINI_NOT_CONFIGURED` and `/api/openai/hud-summary` to `/api/gemini/hud-summary`.

Add a handler test in `src/voice/geminiHud.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { handleHudSummary } from '../../server/providers/gemini/hud-summary.js';

function responseDouble() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name] = value; },
    end(body) { this.body = body; },
  };
}

function requestWithJson(payload) {
  const req = new EventEmitter();
  req.method = 'POST';
  queueMicrotask(() => {
    req.emit('data', Buffer.from(JSON.stringify(payload)));
    req.emit('end');
  });
  return req;
}

test('a verbose model answer is clamped to five words', async () => {
  const previous = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-key';
  const res = responseDouble();
  await handleHudSummary(requestWithJson({ place: 'Austin' }), res, {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'Austin skyline, traffic, and towers tonight.' }] } }],
      }),
    }),
  });
  process.env.GEMINI_API_KEY = previous;
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).summary, 'Austin skyline traffic and towers');
});

test('upstream error text is not returned', async () => {
  process.env.GEMINI_API_KEY = 'test-key';
  const res = responseDouble();
  await handleHudSummary(requestWithJson({}), res, {
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: { message: 'key leaked sk-live' } }),
    }),
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.includes('sk-live'), false);
  assert.equal(JSON.parse(res.body).error, 'Failed to write HUD summary');
});
```

`handleHudSummary(req, res, { fetchImpl })` reads the body with `readRequestBody` from `server/providers/common/request.js`. `fetchImpl` defaults to `fetch`. The third argument is test-only.

- [ ] **Step 2: Run the HUD tests to verify they fail**

Run: `node --test src/hudSummaryResponse.test.mjs src/voice/geminiHud.test.mjs`

Expected: FAIL on the new code string and the missing handler.

- [ ] **Step 3: Implement the handler**

Change `HUD_SUMMARY_UNCONFIGURED_CODE` in `src/hudSummaryResponse.js` to `GEMINI_NOT_CONFIGURED`.

`handleHudSummary` copies the control flow of `server/providers/openai/hud-summary.js`:

- Reject non-POST with 405.
- If `keylessHudSummaryResponse(process.env.GEMINI_API_KEY)` returns a payload, send it and return before the rate limiter.
- Otherwise enforce `geminiRateLimiter`.
- Read the body with `readRequestBody(req, 64 * 1024)`.
- POST `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent` with header `x-goog-api-key`.
- Body: `{ contents: [{ role: 'user', parts: [{ text: JSON.stringify(context) }] }], systemInstruction: { parts: [{ text: <the same five-word instruction string copied from the OpenAI handler> }] }, generationConfig: { maxOutputTokens: 100 } }`.
- Model is `process.env.GEMINI_HUD_SUMMARY_MODEL || GEMINI_HUD_SUMMARY_MODEL_DEFAULT`.
- Read `candidates[0].content.parts[].text`, run it through the existing five-word clamp, and return `{ summary }` on 200.
- On failure, `console.warn` the status only and return `{ error: 'Failed to write HUD summary' }`.

Point the browser HUD fetch at `/api/gemini/hud-summary`.

- [ ] **Step 4: Run the HUD tests**

Run: `node --test src/hudSummaryResponse.test.mjs src/voice/geminiHud.test.mjs`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/providers/gemini/hud-summary.js src/hudSummaryResponse.js src/hudSummaryResponse.test.mjs src/voice/geminiHud.test.mjs
git commit -m "feat: write the HUD summary with Gemini"
```

Include the HUD client file in that commit once the search shows its path.

---

### Task 7: WebSocket session transport

**Files:**
- Modify: `src/voice/realtimeConnection.js`
- Modify: `src/voice/realtimeBackend.js`
- Create: `src/voice/geminiLiveChannel.js`
- Create: `src/voice/geminiTransport.test.mjs`
- Modify: `src/voice/realtimeViewport.js` only if send still depends on a WebRTC byte limit. Keep the pixel cap. A successful `sendRealtimeEvent` still returns true or false.

**Interfaces:**
- Consumes: `liveSocketUrl`, `liveSetupMessage`, `liveResumeSetupMessage`, `translateClientEvent`, `translateServerMessage`, `floatToPcm16Base64`, `pcm16Base64ToFloat32`, `PCM_INPUT_RATE`, `PCM_OUTPUT_RATE`, `recordAudio`.
- Produces: `createGeminiLiveChannel({ socket, model, onEvent, onResumption })` with `readyState`, `send(jsonString) -> boolean`, and `close()`. `RealtimeConnection.start` uses this object as `this.dc`.

- [ ] **Step 1: Write the failing transport test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiLiveChannel } from './geminiLiveChannel.js';

test('a fake socket plays one audio chunk and returns one tool result', () => {
  const sent = [];
  const events = [];
  let handle = '';
  const socket = {
    readyState: 1,
    send(data) { sent.push(JSON.parse(data)); },
    close() { this.readyState = 3; },
  };
  const channel = createGeminiLiveChannel({
    socket,
    model: 'gemini-3.8-live',
    onEvent(event) { events.push(event); },
    onResumption(next) { handle = next; },
  });
  channel.receive({
    serverContent: {
      modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'QQ==' } }] },
    },
    toolCall: { functionCalls: [{ id: 'call-9', name: 'zoom_to_globe', args: {} }] },
  });
  assert.equal(events.some((event) => event.type === 'response.output_audio.delta'), true);
  assert.equal(
    events.find((event) => event.type === 'response.function_call_arguments.done').call_id,
    'call-9',
  );
  const wrote = channel.send(JSON.stringify({
    type: 'conversation.item.create',
    item: { type: 'function_call_output', call_id: 'call-9', name: 'zoom_to_globe', output: '{"ok":true}' },
  }));
  assert.equal(wrote, true);
  assert.equal(sent.at(-1).toolResponse.functionResponses[0].id, 'call-9');
  channel.receive({ sessionResumptionUpdate: { resumable: true, newHandle: 'h2' } });
  assert.equal(handle, 'h2');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test src/voice/geminiTransport.test.mjs`

Expected: FAIL because the channel module does not exist.

- [ ] **Step 3: Implement the channel and the connection swap**

`createGeminiLiveChannel` holds the socket. `readyState` is `'open'` when `socket.readyState === 1`, otherwise `'closed'`. `send` parses the JSON, runs `translateClientEvent`, and sends the result when it is non-null. `conversation.item.delete` returns true without sending, so the viewport owner's "previous image deleted" bookkeeping still succeeds. `receive` runs `translateServerMessage` and forwards each event to `onEvent`. A `session.resumption.required` event calls `onResumption(handle)` and is not forwarded to the OpenAI session handler.

In `realtimeConnection.js`:

- Delete `RTCPeerConnection`, SDP `negotiate`, and the `<audio>` element path.
- After `requestToken`, open `new WebSocket(liveSocketUrl(token))`.
- On open, send `liveSetupMessage(model)`.
- Construct the channel and assign it to `this.dc` before any session event is delivered.
- Capture the mic with `getUserMedia({ audio: true })`. Load an AudioWorklet that posts Float32 frames. The main thread converts them with `floatToPcm16Base64(frame, sampleRate, PCM_INPUT_RATE)` and sends `{ realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data } } }` only when the existing input policy says the mic is open.
- On each `response.output_audio.delta`, decode with `pcm16Base64ToFloat32` and queue an `AudioBuffer` at `PCM_OUTPUT_RATE`. Call `recordAudio({ outputSeconds: samples.length / PCM_OUTPUT_RATE })`.
- Call `recordAudio({ inputSeconds: frame.length / sampleRate })` for each frame that is actually sent.
- Store the latest resumption handle. On socket close, if a handle exists and this close was not caused by `stop()` or the $5 cap, send `liveResumeSetupMessage(model, handle)` on one new socket created with the same token. If that socket errors, call the existing stop path and do not request another token.
- `stop()` still bumps `startEpoch`, aborts the connection, stops tracks, closes the socket, and clears the playback queue.
- If `AudioWorklet` is missing, set status `error` with `Web Audio microphone support unavailable` and return before opening the socket.

Keep `sendRealtimeEvent` writing through `this.dc.send`. The session modules keep calling it.

`sendToolOutput` in `src/voice/realtimeTurns.js` must include the function name. Change both call sites from `sendToolOutput(call.call_id || call.id, result)` to `sendToolOutput(call, result)`. The method sends:

```js
{
  type: 'conversation.item.create',
  item: {
    type: 'function_call_output',
    call_id: call.call_id || call.id,
    name: call.name,
    output: JSON.stringify(result),
  },
}
```

`translateClientEvent` already copies `item.name` onto `toolResponse.functionResponses[0].name`. Gemini requires that name.

- [ ] **Step 4: Run the transport and session tests**

Run: `node --test src/voice/geminiTransport.test.mjs src/voice/gevRealtime.test.mjs src/voice/realtimeOwners.test.mjs`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/voice/geminiLiveChannel.js src/voice/geminiTransport.test.mjs src/voice/realtimeConnection.js src/voice/realtimeBackend.js src/voice/realtimeViewport.js
git commit -m "feat: connect voice over the Gemini Live WebSocket"
```

---

### Task 8: Remove the OpenAI provider

**Files:**
- Create: `server/providers/gemini.js`
- Create: `server/providers/gemini/debug-log.js`
- Modify: `server/providers/local.js`
- Modify: `package.json` exports and keywords
- Modify: `scripts/package-boundaries.json`
- Modify: `scripts/format-scope.json`
- Delete: `server/providers/openai.js` and `server/providers/openai/`
- Modify: every remaining import of `server/providers/openai`

**Interfaces:**
- Consumes: `createRealtimeTokenHandler`, `handleHudSummary`, `createGeminiToken` from Task 5, and the moved debug-log handler.
- Produces: `geminiLiveProxy()` installed by `localProviderPlugins` in the same array position `openAiRealtimeProxy()` occupies today. Routes: `/api/realtime/token`, `/api/gemini/hud-summary`, `/api/realtime/debug-log`.

- [ ] **Step 1: Point the boundary test at Gemini first**

In `scripts/package-boundaries.json`, rename the `openai-provider` key to `gemini-provider`. Set `exports` to `["./server/providers/gemini"]`. Replace every `server/providers/openai...` path with the Gemini twin. Keep `src/hudSummaryResponse.js`, `src/voice/voiceCost.js`, `src/voice/actionSchemas.js`, and `src/sources/rateLimit.js` in that module list. Add `server/providers/gemini/declarations.js`.

In `scripts/format-scope.json`, replace the OpenAI paths with the Gemini paths.

In `package.json`, replace the `./server/providers/openai` export with `./server/providers/gemini` and replace the keyword `openai-realtime` with `gemini-live`.

- [ ] **Step 2: Run the boundary check to verify it fails**

Run: `npm run check:boundaries`

Expected: FAIL because the Gemini files or export are incomplete, or because OpenAI files are still present and unlisted.

- [ ] **Step 3: Swap the plugin and delete OpenAI**

Copy `server/providers/openai/debug-log.js` to `server/providers/gemini/debug-log.js`. In the redaction function, also replace `access_token` query values and any string value longer than 80 characters under keys `data`, `token`, and `audio`.

`server/providers/gemini.js`:

```js
import { defaultSourceRoot } from './common/source-root.js';
import { handleHudSummary } from './gemini/hud-summary.js';
import { createDebugLogHandler } from './gemini/debug-log.js';
import { createRealtimeTokenHandler } from './gemini/realtime.js';
import { GoogleGenAI } from '@google/genai';

function geminiLiveProxy({ sourceRoot = defaultSourceRoot, annotationGuidance } = {}) {
  function install(middlewares) {
    middlewares.use('/api/gemini/hud-summary', handleHudSummary);
    middlewares.use('/api/realtime/debug-log', createDebugLogHandler({ sourceRoot }));
    middlewares.use('/api/realtime/token', createRealtimeTokenHandler({
      annotationGuidance,
      createToken: async (config, apiKey) => {
        const client = new GoogleGenAI({ apiKey });
        return client.authTokens.create({ config });
      },
    }));
  }
  return {
    name: 'gemini-live-proxy',
    configureServer(server) { install(server.middlewares); },
    configurePreviewServer(server) { install(server.middlewares); },
  };
}

export { geminiLiveProxy };
```

In `server/providers/local.js`, import `geminiLiveProxy` and replace `openAiRealtimeProxy()` with `geminiLiveProxy()`. Remove the `openAiRealtimeProxy` re-export. Export `geminiLiveProxy` instead.

Update `src/firstRunExperience.test.mjs` to import `GEV_LIVE_TOOLS` from `server/providers/gemini/tools.js` and to read `server/providers/gemini/instructions.js`.

Search the repo for `providers/openai`, `openAiRealtimeProxy`, and `GEV_REALTIME_TOOLS`. Update each remaining source import. Then delete `server/providers/openai.js` and the `server/providers/openai` directory.

- [ ] **Step 4: Run boundaries and the provider tests**

Run: `npm run check:boundaries`

Expected: PASS

Run: `node --test src/voice/geminiToken.test.mjs src/voice/geminiDeclarations.test.mjs src/firstRunExperience.test.mjs`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add package.json scripts/package-boundaries.json scripts/format-scope.json server/providers/gemini.js server/providers/gemini server/providers/local.js src/firstRunExperience.test.mjs
git add -u server/providers/openai.js server/providers/openai
git commit -m "feat: serve voice and HUD from the Gemini provider"
```

---

### Task 9: Configuration, key setup, and docs

**Files:**
- Modify: `.env.example`
- Modify: `.env` comment block only. Do not put a real key in the file.
- Modify: `scripts/dev-fresh.sh`
- Modify: `pinokio/install.js`
- Modify: `pinokio/update.js`
- Modify: `src/keySetupCore.mjs`
- Modify: `src/keySetupCore.test.mjs`
- Modify: `README.md`
- Modify: `SECURITY.md`
- Modify: `TESTING.md`
- Modify: `CONTRIBUTING.md`
- Modify: `docs/CODE-BOUNDARIES.md`
- Modify: `docs/CURRENT-STATE.md`
- Modify: `docs/VOICE-OWNERSHIP.md`
- Modify: `CHANGELOG.md` if the current unreleased section is where voice notes go

**Interfaces:**
- Consumes: the env names from the spec.
- Produces: a key card `{ id: 'gemini', title: 'GEMINI', unlocks: 'Voice control — talk to the planet', getUrl: 'https://aistudio.google.com/apikey', envVars: ['GEMINI_API_KEY'], tier: 'metered' }`.

- [ ] **Step 1: Update the key-card test**

In `src/keySetupCore.test.mjs`, change `key.id === 'openai'` to `key.id === 'gemini'`.

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test src/keySetupCore.test.mjs`

Expected: FAIL because the card id is still `openai`.

- [ ] **Step 3: Rename the operator-facing configuration**

Replace the OpenAI block in `.env.example` with:

```
# Optional: Gemini Live voice and HUD summary. Do not prefix with VITE_.
GEMINI_API_KEY=
GEMINI_LIVE_MODEL=gemini-3.8-live
GEMINI_LIVE_VOICE=Kore
GEMINI_HUD_SUMMARY_MODEL=gemini-3.8-flash
# Opt-in per-IP rate limit for /api/realtime/token and /api/gemini/hud-summary.
# GEV_RATELIMIT_GEMINI_PER_MIN=30
```

Apply the same comment replacement in `.env`. Leave any unrelated keys untouched.

In `scripts/dev-fresh.sh`, replace `OPENAI_API_KEY` with `GEMINI_API_KEY`, the Keychain service `openai-api` with `gemini-api`, the account `api-key` stays `api-key`, and the status line becomes `Gemini key (voice + HUD summary)`. Replace `GEV_RATELIMIT_OPENAI_PER_MIN` with `GEV_RATELIMIT_GEMINI_PER_MIN`.

In both Pinokio launcher scripts, pass `GEMINI_API_KEY` and `GEV_RATELIMIT_GEMINI_PER_MIN` instead of the OpenAI names.

Replace the key card in `src/keySetupCore.mjs` with the Gemini card from this task's interfaces.

Update the docs listed above so they describe the token flow, the WebSocket, the audio-minute cap, and the Gemini key. In `docs/VOICE-OWNERSHIP.md`, the connection owner holds the WebSocket, resumption handle, mic stream, and playback queue. Delete the peer-connection and data-channel wording.

Search the repo for `OPENAI_` and `openai-api`. The only remaining hits should be historical changelog lines that describe the removed behavior. Do not leave a current setup instruction that asks for an OpenAI key.

- [ ] **Step 4: Run the key-card test and a repo search**

Run: `node --test src/keySetupCore.test.mjs`

Expected: PASS

Search for `OPENAI_API_KEY` outside `CHANGELOG.md`. Expected: no matches.

- [ ] **Step 5: Commit**

```bash
git add .env.example .env scripts/dev-fresh.sh pinokio/install.js pinokio/update.js src/keySetupCore.mjs src/keySetupCore.test.mjs README.md SECURITY.md TESTING.md CONTRIBUTING.md docs/CODE-BOUNDARIES.md docs/CURRENT-STATE.md docs/VOICE-OWNERSHIP.md CHANGELOG.md
git commit -m "docs: configure Gemini Live voice in place of OpenAI"
```

---

### Task 10: Full verification

**Files:**
- Modify: none unless a previous task left a failing test.

**Interfaces:**
- Consumes: the whole branch.
- Produces: a green unit suite and a green boundary check.

- [ ] **Step 1: Run the required checks**

Run: `npm test`

Expected: PASS

Run: `npm run check:boundaries`

Expected: PASS

- [ ] **Step 2: Manual voice check**

If `GEMINI_API_KEY` is unset, start the app and confirm the mic reports that voice is unavailable, the HUD stays on its keyless line, and the globe still renders. Confirm the STD/MINI button is absent at a wide window and at a narrow window.

If `GEMINI_API_KEY` is set, start a mic session, confirm the status leaves `connecting`, and confirm one spoken map command still changes the camera or a layer. Stop the session and confirm the mic track is released.

- [ ] **Step 3: Commit any verification fixes**

If Step 1 or Step 2 required a code change, commit that change with a message that names the failure it fixed. If nothing failed, do not create an empty commit.

---

## Spec coverage

| Spec requirement | Task |
| --- | --- |
| Declaration mapping | 1 |
| Live message translation, including viewport image and tool results | 2, 7 |
| PCM rates | 3, 7 |
| Audio-minute cost, $2 warning, $5 cap, unknown model | 4 |
| Token mint, locks, sanitized errors, 503 | 5, 8 |
| HUD route, five-word clamp, keyless payload | 6 |
| WebSocket transport, mic gating, one resume | 7 |
| OpenAI package and routes removed | 8 |
| Env, Keychain, launcher, key card, docs | 9 |
| Unit suite, boundaries, manual mic check | 10 |
