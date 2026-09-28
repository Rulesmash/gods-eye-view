import { defaultSourceRoot } from './common/source-root.js';
import { handleHudSummary } from './openai/hud-summary.js';
import { createDebugLogHandler } from './openai/debug-log.js';
import { createRealtimeTokenHandler } from './openai/realtime.js';
import { createRealtimeTurnHandler } from './openai/realtime-turn.js';

/**
 * Vite plugin: Google AI Studio (Gemini) Realtime voice control.
 *
 * Keeps GOOGLE_AI_STUDIO_KEY server-side while the browser connects to the
 * Gemini Live API with a short-lived secret.
 */
function openAiRealtimeProxy({
  sourceRoot = defaultSourceRoot,
  annotationGuidance,
  realtime = {},
} = {}) {
  function install(middlewares) {
    middlewares.use('/api/gemini/hud-summary', handleHudSummary);

    middlewares.use(
      '/api/realtime/debug-log',
      createDebugLogHandler({ sourceRoot }),
    );

    middlewares.use(
      '/api/realtime/token',
      createRealtimeTokenHandler({ ...realtime, annotationGuidance }),
    );

    middlewares.use(
      '/api/realtime/turn',
      createRealtimeTurnHandler({ ...realtime, annotationGuidance }),
    );
  }

  return {
    name: 'gemini-realtime-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

export { openAiRealtimeProxy };
