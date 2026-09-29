/**
 * Gemini Live Channel Adapter.
 *
 * Implements the DataChannel / EventTarget interface expected by RealtimeTurns
 * and RealtimeConnection while bridging to Google AI Studio Gemini Live.
 */
export class GeminiLiveChannel extends EventTarget {
  constructor({
    tier = 'standard',
    model = 'gemini-3.8-flash',
    token = null,
    turnEndpoint = '/api/realtime/turn',
    onSpeechDelta = null,
    onAssistantAudio = null,
    debugLog = () => {},
  } = {}) {
    super();
    this.tier = tier;
    this.model = model;
    this.token = token;
    this.turnEndpoint = turnEndpoint;
    this.onSpeechDelta = onSpeechDelta;
    this.onAssistantAudio = onAssistantAudio;
    this.debugLog = debugLog;
    this.readyState = 'connecting';
    this.messages = [];
    this.recognition = null;
    this.isRecognizing = false;
    this._closed = false;
    this.activeTurnAbort = null;
  }

  open() {
    if (this._closed) return;
    this.readyState = 'open';
    const event = new Event('open');
    this.dispatchEvent(event);
  }

  startSpeechRecognition({ continuous = true } = {}) {
    const SpeechRec =
      typeof window !== 'undefined' &&
      (window.SpeechRecognition || window.webkitSpeechRecognition);
    if (!SpeechRec || this._closed) return null;

    try {
      if (this.recognition) {
        try {
          this.recognition.abort();
        } catch {
          /* no-op */
        }
      }
      this.currentTranscript = '';
      this._turnSent = false;
      this._stopping = false;

      const rec = new SpeechRec();
      rec.continuous = continuous;
      rec.interimResults = true;
      rec.lang = 'en-US';

      let silenceTimer = null;
      const SILENCE_MS = 1200; // Force stop after 1.2s of silence to reduce latency

      rec.onstart = () => {
        this.isRecognizing = true;
        this.dispatchEvent(
          new MessageEvent('message', {
            data: JSON.stringify({ type: 'input_audio_buffer.speech_started' }),
          }),
        );
      };

      rec.onresult = (event) => {
        if (silenceTimer) clearTimeout(silenceTimer);

        let interim = '';
        let finalTranscript = '';
        for (let i = 0; i < event.results.length; ++i) {
          const res = event.results[i];
          if (res.isFinal) {
            finalTranscript += res[0].transcript;
          } else {
            interim += res[0].transcript;
          }
        }
        const text = (finalTranscript + ' ' + interim).trim();
        if (text) {
          this.currentTranscript = text;
        }
        if (interim && this.onSpeechDelta) {
          this.onSpeechDelta(interim);
        }

        if (this._stopping) {
          if (text && !this._turnSent) {
            this._sendTranscript(text);
          }
          return;
        }

        if (finalTranscript.trim() && continuous) {
          this._sendTranscript(finalTranscript.trim());
        } else if (interim.trim() && continuous) {
          // In open-mic mode, proactively stop after silence to speed up the turn
          silenceTimer = setTimeout(() => {
            if (this.recognition && this.isRecognizing) {
              try {
                this.recognition.stop();
              } catch {
                /* no-op */
              }
            }
          }, SILENCE_MS);
        }
      };

      rec.onerror = (err) => {
        if (silenceTimer) clearTimeout(silenceTimer);
        this.debugLog('speech.recognition.error', { error: err?.error });
      };

      rec.onend = () => {
        if (silenceTimer) clearTimeout(silenceTimer);
        this.isRecognizing = false;
        if (this._stopping) {
          if (!this._turnSent && this.currentTranscript?.trim()) {
            this._sendTranscript(this.currentTranscript.trim());
          }
          this._stopping = false;
          this.recognition = null;
          return;
        }
        this.recognition = null;
        // If still open and continuous (and not stopped/sent), restart recognition
        if (
          !this._closed &&
          this.readyState === 'open' &&
          continuous &&
          !this._turnSent
        ) {
          try {
            rec.start();
            this.recognition = rec;
          } catch {
            /* ignore restart error */
          }
        }
      };

      rec.start();
      this.recognition = rec;
      return rec;
    } catch (e) {
      this.debugLog('speech.recognition.failed_to_start', {
        error: e?.message,
      });
      return null;
    }
  }

  _sendTranscript(text) {
    if (!text || this._closed || this._turnSent) return;
    this._turnSent = true;
    this.currentTranscript = '';
    this.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'conversation.item.input_audio_transcription.completed',
          transcript: text,
          item_id: `user_transcript_${Date.now()}`,
        }),
      }),
    );
    this.handleUserVoiceText(text);
  }

  stopAndSendSpeechRecognition() {
    if (this._closed) return;
    const text = this.currentTranscript?.trim();
    if (text && !this._turnSent) {
      this._sendTranscript(text);
      this.stopSpeechRecognition();
      return;
    }
    if (this.recognition && this.isRecognizing) {
      this._stopping = true;
      try {
        this.recognition.stop();
      } catch {
        this.stopSpeechRecognition();
      }
    } else {
      this.stopSpeechRecognition();
    }
  }

  stopSpeechRecognition() {
    this._stopping = false;
    if (this.recognition) {
      const rec = this.recognition;
      this.recognition = null;
      this.isRecognizing = false;
      try {
        rec.onend = null;
        rec.onerror = null;
        rec.onresult = null;
        rec.stop();
      } catch {
        /* no-op */
      }
    }
  }

  handleUserVoiceText(text) {
    if (!text || this._closed) return;
    this.messages.push({
      role: 'user',
      content: text,
    });
    this.executeTurn();
  }

  send(data) {
    if (this._closed || this.readyState !== 'open') return;
    try {
      const payload = typeof data === 'string' ? JSON.parse(data) : data;
      const type = payload?.type;

      if (type === 'conversation.item.create') {
        const item = payload.item;
        if (!item) return;
        if (item.type === 'message' || item.role === 'user') {
          const text =
            typeof item.content === 'string'
              ? item.content
              : Array.isArray(item.content)
                ? item.content.map((c) => c.text || '').join(' ')
                : '';
          if (text) {
            this.messages.push({ role: 'user', content: text });
          }
        } else if (item.role === 'system') {
          const text = Array.isArray(item.content)
            ? item.content.map((c) => c.text || '').join(' ')
            : item.content || '';
          if (text) {
            this.messages.push({
              role: 'user',
              content: `[SYSTEM CONTEXT: ${text}]`,
            });
          }
        } else if (
          item.type === 'function_call_output' ||
          item.role === 'tool'
        ) {
          this.messages.push({
            role: 'tool',
            name: item.name || item.call_id,
            call_id: item.call_id,
            content: item.output || item.content || '{}',
          });
        }
      } else if (type === 'response.create') {
        this.executeTurn();
      }
    } catch (err) {
      this.debugLog('gemini.channel.send_error', { error: err?.message });
    }
  }

  async executeTurn() {
    if (this._closed) return;
    this.activeTurnAbort?.abort();
    this.activeTurnAbort = new AbortController();
    const signal = this.activeTurnAbort.signal;

    const responseId = `resp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    try {
      const res = await fetch(this.turnEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tier: this.tier,
          model: this.model,
          messages: this.messages,
        }),
        signal,
      });

      if (!res.ok) {
        throw new Error(`Gemini turn failed: HTTP ${res.status}`);
      }

      const data = await res.json();
      if (signal.aborted || this._closed) return;

      const modelName = data.model || this.model;
      const usage = data.usage || {
        input_tokens: 50,
        output_tokens: 20,
        total_tokens: 70,
        output_token_details: { text_tokens: 20, audio_tokens: 0 },
      };

      // 1. Dispatch response.created
      this.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'response.created',
            response: {
              id: responseId,
              status: 'in_progress',
              model: modelName,
            },
          }),
        }),
      );

      // Record model response in conversation history
      if (data.modelParts?.length) {
        this.messages.push({ role: 'model', parts: data.modelParts });
      } else if (data.text) {
        this.messages.push({ role: 'model', parts: [{ text: data.text }] });
      }

      // 2. Dispatch Text & Spoken Voice Output (if any) - DO THIS FIRST FOR PARALLEL EXECUTION
      if (data.text) {
        const itemId = `msg_${Date.now()}`;

        this.dispatchEvent(
          new MessageEvent('message', {
            data: JSON.stringify({
              type: 'response.output_text.delta',
              response_id: responseId,
              item_id: itemId,
              delta: data.text,
            }),
          }),
        );

        this.dispatchEvent(
          new MessageEvent('message', {
            data: JSON.stringify({
              type: 'response.output_audio_transcript.done',
              response_id: responseId,
              item_id: itemId,
              transcript: data.text,
            }),
          }),
        );

        // Speak response audio immediately so it plays while actions execute
        this.speakText(data.text);
      }

      // 3. Dispatch Function Calls (if any)
      if (Array.isArray(data.functionCalls) && data.functionCalls.length > 0) {
        for (const call of data.functionCalls) {
          const callId = call.id;
          const name = call.name;
          const args = JSON.stringify(call.args || {});

          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                type: 'response.output_item.added',
                response_id: responseId,
                item: {
                  id: callId,
                  call_id: callId,
                  type: 'function_call',
                  name,
                  arguments: args,
                },
              }),
            }),
          );

          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                type: 'response.function_call_arguments.done',
                response_id: responseId,
                item_id: callId,
                call_id: callId,
                name,
                arguments: args,
              }),
            }),
          );
        }
      }

      // 4. Dispatch response.done with token usage
      this.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'response.done',
            response: {
              id: responseId,
              status: 'completed',
              model: modelName,
              usage,
            },
          }),
        }),
      );
    } catch (err) {
      if (signal.aborted || this._closed) return;
      this.debugLog('gemini.turn.error', { error: err?.message });
      this.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'response.done',
            response: {
              id: responseId,
              status: 'failed',
              error: err?.message || 'Gemini turn failed',
            },
          }),
        }),
      );
    }
  }

  speakText(text) {
    if (!text || typeof window === 'undefined') return;
    if (this.onAssistantAudio) {
      this.onAssistantAudio(text);
      return;
    }
    if (!('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.05;
      utterance.pitch = 1.0;
      // Choose voice if available
      const voices = window.speechSynthesis.getVoices?.() || [];
      const selectedVoice =
        voices.find(
          (v) =>
            v.lang.startsWith('en') &&
            (v.name.includes('Natural') ||
              v.name.includes('Google') ||
              v.name.includes('Neural')),
        ) ||
        voices.find((v) => v.lang.startsWith('en')) ||
        voices[0];
      if (selectedVoice) utterance.voice = selectedVoice;

      window.speechSynthesis.speak(utterance);
    } catch (e) {
      this.debugLog('speech.synthesis.error', { error: e?.message });
    }
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    this.readyState = 'closed';
    this.stopSpeechRecognition();
    this.activeTurnAbort?.abort();
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        /* no-op */
      }
    }
    this.dispatchEvent(new Event('close'));
  }
}
