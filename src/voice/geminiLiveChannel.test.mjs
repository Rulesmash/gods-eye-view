import assert from 'node:assert/strict';
import test from 'node:test';
import { GeminiLiveChannel } from './geminiLiveChannel.js';
import { RealtimeInput } from './realtimeInput.js';

function mockSpeechRecognition() {
  class MockSpeechRecognition {
    constructor() {
      this.continuous = false;
      this.interimResults = false;
      this.lang = 'en-US';
      this.started = false;
      this.stopped = false;
      this.aborted = false;
      this.onstart = null;
      this.onresult = null;
      this.onerror = null;
      this.onend = null;
      MockSpeechRecognition.instances.push(this);
    }
    start() {
      this.started = true;
      this.onstart?.();
    }
    stop() {
      this.stopped = true;
      this.onend?.();
    }
    abort() {
      this.aborted = true;
      this.onend?.();
    }
  }
  MockSpeechRecognition.instances = [];
  return MockSpeechRecognition;
}

test('GeminiLiveChannel: records while active and sends transcript immediately upon stopAndSendSpeechRecognition', (t) => {
  const MockRec = mockSpeechRecognition();
  const originalSpeechRec = globalThis.SpeechRecognition;
  const originalWindow = globalThis.window;
  globalThis.SpeechRecognition = MockRec;
  globalThis.window = { SpeechRecognition: MockRec };

  t.after(() => {
    globalThis.SpeechRecognition = originalSpeechRec;
    globalThis.window = originalWindow;
  });

  const channel = new GeminiLiveChannel({
    turnEndpoint: '/api/realtime/turn',
  });
  channel.open();

  const dispatchedEvents = [];
  channel.addEventListener('message', (event) => {
    dispatchedEvents.push(JSON.parse(event.data));
  });

  const rec = channel.startSpeechRecognition({ continuous: true });
  assert.ok(rec);
  assert.equal(channel.isRecognizing, true);
  assert.equal(dispatchedEvents[0]?.type, 'input_audio_buffer.speech_started');

  // Simulate interim speech results arriving while space is held
  rec.onresult({
    resultIndex: 0,
    results: [
      Object.assign([{ transcript: 'fly to Tokyo' }], { isFinal: false }),
    ],
  });

  assert.equal(channel.currentTranscript, 'fly to Tokyo');
  // At this point, turn should NOT have been sent yet (still holding space)
  assert.equal(channel.messages.length, 0);

  // Now simulate spacebar release: stopAndSendSpeechRecognition is called
  let turnExecuted = false;
  channel.executeTurn = async () => {
    turnExecuted = true;
  };

  channel.stopAndSendSpeechRecognition();

  // Transcript must be dispatched immediately
  const transcriptEvent = dispatchedEvents.find(
    (e) => e.type === 'conversation.item.input_audio_transcription.completed',
  );
  assert.ok(transcriptEvent, 'Transcript event must be emitted');
  assert.equal(transcriptEvent.transcript, 'fly to Tokyo');

  // Message must be added to user history and turn executed
  assert.equal(channel.messages.length, 1);
  assert.equal(channel.messages[0].content, 'fly to Tokyo');
  assert.equal(turnExecuted, true);

  // Speech recognition must be stopped and NOT recognizing
  assert.equal(channel.isRecognizing, false);
  assert.equal(channel.recognition, null);
  assert.equal(rec.stopped, true);
});

test('GeminiLiveChannel: release with silence stops recognition without sending empty message', (t) => {
  const MockRec = mockSpeechRecognition();
  const originalSpeechRec = globalThis.SpeechRecognition;
  const originalWindow = globalThis.window;
  globalThis.SpeechRecognition = MockRec;
  globalThis.window = { SpeechRecognition: MockRec };

  t.after(() => {
    globalThis.SpeechRecognition = originalSpeechRec;
    globalThis.window = originalWindow;
  });

  const channel = new GeminiLiveChannel();
  channel.open();
  channel.startSpeechRecognition({ continuous: true });
  assert.equal(channel.isRecognizing, true);

  // Release space with no speech spoken
  let turnExecuted = false;
  channel.executeTurn = async () => {
    turnExecuted = true;
  };

  channel.stopAndSendSpeechRecognition();

  assert.equal(channel.messages.length, 0);
  assert.equal(turnExecuted, false);
  assert.equal(channel.isRecognizing, false);
  assert.equal(channel.recognition, null);
});

test('RealtimeInput: releasePushToTalkKey triggers stopAndSendSpeechRecognition on active channel', () => {
  let stopAndSendCalled = false;
  const mockDc = {
    stopAndSendSpeechRecognition() {
      stopAndSendCalled = true;
    },
    stopSpeechRecognition() {},
  };

  const input = new RealtimeInput({
    readUi: () => ({ root: { dataset: {} } }),
    readStream: () => ({ getAudioTracks: () => [] }),
    readStatus: () => 'listening',
    readChannel: () => mockDc,
    operations: {
      updateVoiceButtonLabel() {},
      setStatus() {},
    },
  });

  input.pushToTalkMode = true;
  input.pushToTalkKeyHeld = true;

  input.releasePushToTalkKey();

  assert.equal(input.pushToTalkKeyHeld, false);
  assert.equal(stopAndSendCalled, true, 'stopAndSendSpeechRecognition must be invoked on space release');
});
