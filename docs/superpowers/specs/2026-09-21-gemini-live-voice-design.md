# Gemini Live voice and HUD

Date: 2026-09-21
Status: draft for review

## Goal

Replace OpenAI Realtime voice and the OpenAI HUD summary with Gemini, using a server-side Google AI Studio API key. The microphone still flies the globe through the existing map tools. The five-word SUMMARY line still updates from the current view. The OpenAI key, routes, and pricing tables come out.

This uses Gemini API billing on that key. A Google AI Pro or Gemini Pro subscription applies inside the AI Studio website and does not authorize this app.

## Locked decisions

- Browser Live session. The server mints a one-use ephemeral token. The browser talks to Gemini over a WebSocket. Audio is not relayed through this app.
- Model `gemini-3.8-live`. One speech model. The STD/MINI toggle comes out.
- The map action schemas and `gevActions` executor stay. Tool declarations are a Gemini-shaped view of those schemas.
- Viewport and entity context, including the one retained viewport JPEG, still go up on the current schedule.
- Mic audio is sent only while the session mic or push-to-talk is open.
- Spend readout stays. Audio minutes are priced at the published Live rates. $2 warns. $5 closes the session.
- HUD summary moves to a server-side Gemini text call. The route is `/api/gemini/hud-summary`.
- `@google/genai` is a server dependency. The browser bundle does not import it.

## Architecture

`server/providers/gemini` takes the plugin slot that `openAiRealtimeProxy()` holds in `localProviderPlugins`. The plugin installs three routes:

- `GET` and `POST /api/realtime/token` mint the Live token.
- `POST /api/gemini/hud-summary` writes the five-word line.
- `POST /api/realtime/debug-log` stays, with the same always-on limiter, size cap, and rotation. It redacts tokens and audio.

`GEMINI_API_KEY` is read only on the server. The browser receives `token.name` from the token route and connects to:

`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=<token>`

The token is created with `uses: 1`, `expireTime` 30 minutes out, and `newSessionExpireTime` 1 minute out. `liveConnectConstraints` lock the model, system instruction, function declarations, prebuilt voice, `AUDIO` response modality, and `sessionResumption`. That lock is the authority. The browser setup message repeats the same model, modality, and voice. It does not add tools or instructions beyond the lock.

## Components

Server package `server/providers/gemini/`, replacing `server/providers/openai/`:

| File | Responsibility |
| --- | --- |
| `gemini.js` | Vite plugin. Same install hook shape as today's OpenAI plugin. |
| `realtime.js` | Token handler. Calls `@google/genai` `authTokens.create`. |
| `tools.js` | Maps `createActionTools` output into Gemini function declarations. |
| `instructions.js` | Moves the current realtime instruction text here. |
| `hud-summary.js` | `generateContent` against the text model. Five-word clamp stays. |
| `constants.js` | Model ids, voice, prices, token lifetimes. |
| `rate-limit.js` | Opt-in per-IP limiter renamed for the Gemini cost routes. |
| `debug-log.js` | Moves as-is, with token and audio redaction. |

Declaration mapping keeps `name`, `description`, `type`, `properties`, `required`, and `enum`. It drops `additionalProperties`, `minimum`, and `maximum`. Argument limits stay enforced by the existing executor.

Browser voice:

| Module | Change |
| --- | --- |
| `realtimeBackend.js` | Fetches the token and returns `{ token, model, expiresAt }`. The SDP `negotiate` method comes out. |
| `realtimeConnection.js` | Owns the WebSocket, mic stream, resample worklet, and 24 kHz playback queue. Peer connection and data channel come out. |
| `realtimeEvents.js` and the protocol module | Map Live server messages onto the existing turn, speaker, and tool pipeline. |
| `realtimeViewport.js` | Sends the retained JPEG as one Live inline image, with the current pixel cap and single-image rule. |
| `voiceCost.js` and `realtimeCost.js` | Meter input and output audio seconds against the Live per-minute rates. The meter stays bound to the session that negotiated it. |
| `control.js` | Removes the STD/MINI button. The cost readout and mic control stay. |
| `gevActions.js`, `actionSchemas.js` | Unchanged behavior. |

An AudioWorklet resamples the mic to 16-bit PCM, 16 kHz, mono. Playback queues 24 kHz PCM. If the worklet cannot start, the mic reports an error and does not open a socket.

`realtimeController.js` still owns status, UI bindings, and lifetime. Shutdown still invalidates in-flight work, closes transport, stops meters, and releases the mic. A late socket message cannot enter a replacement session.

## Data flow

1. The mic requests `/api/realtime/token`.
2. The server checks the opt-in rate limit, then mints the constrained token. The response body is `{ token, expiresAt }`. Response headers `X-GEV-Voice-Model` carry the model id actually locked. The API key is absent from the body and the headers.
3. The browser opens the constrained WebSocket with that token and sends setup.
4. While the mic or push-to-talk is open, the worklet sends PCM frames as realtime audio input. Closed means no frames, so closed time is not billed as input.
5. Audio replies play at 24 kHz. Turn boundaries drive the existing user/AI speaker state.
6. Viewport text and the one JPEG go out through Live client content on the triggers `realtimeViewport.js` already uses.
7. A `toolCall` is dispatched off the socket reader to `gevActions`. The executor's result, including `ok: false`, is returned with `sendToolResponse` using the call's name and id. The reader keeps consuming audio while the tool runs.
8. Input seconds and output seconds update the readout. At $2 the readout enters the warning state. At $5 the session closes.
9. The HUD posts the same view context to `/api/gemini/hud-summary`. The handler calls `generateContent` with `GEMINI_API_KEY` directly. Ephemeral tokens are Live-only and are not used for this route. The response is five words, or the existing keyless payload when the key is unset.

## Connection lifetime

Two different events both look like "reconnect":

- Google documents that a Live socket is resumed every 10 minutes, and that the same ephemeral token can resume inside `expireTime` even when `uses` is 1. The token locks `sessionResumption`. On that provider close, the client resumes once with the stored handle and the same token. The cost meter continues. A failed resume ends the session. The user presses the mic to start another one.
- A new user start, a $5 cap, a missing mic, or a failed setup mints a new token. The client does not retry minting on its own.

The client does not loop resumes and does not mint a replacement token in the background.

## Error handling

- Missing `GEMINI_API_KEY`: token route returns 503 `{ error: "GEMINI_API_KEY is not set" }`. The mic says voice is unavailable. The globe keeps running. HUD uses the existing keyless fallback and does not spend a rate-limit slot.
- Token mint or HUD upstream failure: the server logs the HTTP status only. The client receives a fixed message. Upstream bodies, request ids, and audio are not copied through. The token route still uses the upstream HTTP status on its response. HUD uses that same pattern: failure status with a fixed JSON error.
- Timeout for the token and HUD upstream calls stays 30 seconds. Redirects are errors.
- A tool throw becomes the executor's existing `{ ok: false, error }` payload. The model is not told the action succeeded.
- A tool result whose socket is already closed is dropped.
- Socket errors and setup failures set a short local status. Gemini error text is not shown in the UI.
- Pressing the mic during connect still bumps the start generation, aborts the attempt, and releases the stream and socket.
- The debug log keeps its 120-per-client and 400-global one-minute limiter, the 32 MB rotation, and fixed 400/500 messages. Records containing the token, API key, or audio payload are redacted before append.

A LAN-visible server can still mint tokens for anyone who can reach it. `GEV_RATELIMIT_GEMINI_PER_MIN` replaces `GEV_RATELIMIT_OPENAI_PER_MIN` for the token and HUD routes. It remains a per-IP, process-local guard, not a billing cap.

## Configuration and removal

Environment, all server-side:

| Name | Default |
| --- | --- |
| `GEMINI_API_KEY` | unset |
| `GEMINI_LIVE_MODEL` | `gemini-3.8-live` |
| `GEMINI_LIVE_VOICE` | `Kore` |
| `GEMINI_HUD_SUMMARY_MODEL` | `gemini-3.8-flash` |
| `GEV_RATELIMIT_GEMINI_PER_MIN` | unset |

Live audio rates, checked against the Gemini pricing page before the constants are committed: $0.005 per minute input, $0.018 per minute output. `voiceCost.js` records the verification date the way it records one today. An overridden model id that is not in that table is billed at these rates, and the server logs one warning. The meter must not price an unknown model at zero.

Remove `OPENAI_API_KEY`, `OPENAI_REALTIME_*`, `OPENAI_HUD_SUMMARY_MODEL`, and `GEV_RATELIMIT_OPENAI_PER_MIN` from `.env.example`, the local `.env` comments, `scripts/dev-fresh.sh`, the Keychain service name (`gemini-api` / `api-key` replaces `openai-api` / `api-key`), `pinokio/install.js`, `pinokio/update.js`, `src/keySetupCore.mjs` (the key card id becomes `gemini`, pointing at `https://aistudio.google.com/apikey`), `package.json` exports and the `openai-realtime` keyword, `scripts/package-boundaries.json`, and `scripts/format-scope.json`.

Update the voice, security, testing, contributing, and current-state docs that name the OpenAI token flow. `docs/VOICE-OWNERSHIP.md` names the WebSocket and audio graph as the connection owner's transport.

The OpenAI provider directory is deleted in the same change. Call sites that import `server/providers/openai/tools.js` or `instructions.js` import the Gemini modules.

## Testing

Unit tests, in the existing `node` test runner:

- Token route: missing key returns 503 and does not call Google. A non-OK upstream body is replaced with the fixed error, and the status is preserved. A success returns `token.name`, sets `X-GEV-Voice-Model`, and the create config has `uses: 1`, the locked model, instructions, declarations, voice, and session resumption.
- Declaration mapper: every action name survives, required fields stay required, and `additionalProperties` is absent.
- Cost: published per-minute math, $2 warning, $5 cap, reset on a new session, resume does not reset, unknown model id does not bill at zero.
- HUD: five-word clamp, keyless payload when the key is unset, upstream error body not forwarded.
- PCM helper: 16-bit mono chunks at 16 kHz. Playback schedule uses 24 kHz.
- Fake Live socket: one inbound audio chunk reaches the playback queue, and one tool call returns the executor payload with the original name and id. No network.
- Debug log redacts a token and an audio payload.
- Resume: a session-resumption close sends one resume with the same token. A failed resume does not mint another token.

Update existing voice, HUD, key-setup, and first-run tests that assume an OpenAI client secret, the STD/MINI tier, `/api/openai/hud-summary`, or WebRTC SDP. Action-schema and `gevActions` tests stay on the current assertions.

`npm test` and `npm run check:boundaries` are the required local checks.

A live mic against Google runs only when `GEMINI_API_KEY` is set in the environment used for that check. With a key: start the mic, confirm the status leaves `connecting`, and confirm one spoken map command still changes the camera or a layer. Without a key: the mic reports voice unavailable, the HUD stays on the keyless line, and the rest of the globe still renders. The tier button is gone at desktop width and at a narrow viewport.

## Out of scope

- A second provider switch, including keeping OpenAI beside Gemini.
- Spending a Google AI Pro or SuperGrok subscription from this app.
- Gemini Live extended thinking, Google Search grounding, and proactive-audio mode.
- Changing map tool behavior, radio handoff rules, or push-to-talk timing.
- Server-relayed audio.
