import { describe, it, expect, vi } from 'vitest';
import type {
  AudioPlaybackAdapter,
  MicCaptureAdapter,
  PlaybackProgressEvent,
} from '../../audio/audioManager';
import type { GeminiPipelineService, HistoryTurn } from '../../services/geminiService';
import type { SttClientAdapter } from '../../services/sttClient';
import { DEFAULT_SETTINGS, type ChatMessage, type EngineState } from '../../types/chat';
import { DebugStore } from '../debugStore';
import { LiveChatEngine } from '../liveChatEngine';

function createMockPlayback(initialProgress?: Partial<PlaybackProgressEvent>) {
  const enqueued: Array<{ segmentId: string; bytes: number }> = [];
  const listeners = new Set<(evt: PlaybackProgressEvent) => void>();
  let progress: PlaybackProgressEvent = {
    reason: 'tick',
    activeSegmentId: null,
    bufferedMs: 0,
    gain: 1,
    isFlushing: false,
    segments: [],
    ...initialProgress,
  };

  const adapter: AudioPlaybackAdapter = {
    init: vi.fn(async () => {}),
    enqueue: vi.fn((segmentId: string, pcm: ArrayBuffer) => {
      enqueued.push({ segmentId, bytes: pcm.byteLength });
    }),
    duck: vi.fn(),
    unduck: vi.fn(),
    flush: vi.fn(async () => ({ ...progress, reason: 'flushed' as const })),
    reset: vi.fn(),
    getLastProgress: vi.fn(() => progress),
    onProgress: vi.fn((cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }),
    dispose: vi.fn(async () => {}),
  };

  return {
    adapter,
    enqueued,
    setProgress(next: PlaybackProgressEvent) {
      progress = next;
      for (const cb of listeners) cb(next);
    },
  };
}

function createMockMic(): MicCaptureAdapter {
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
}

function createMockStt(): SttClientAdapter {
  return {
    connect: vi.fn(async () => {}),
    sendAudio: vi.fn(),
    sendAudioStreamEnd: vi.fn(),
    disconnect: vi.fn(),
  };
}

describe('LiveChatEngine', () => {
  it('runs dual-model speculative flow (Flash-Lite S1 + Hydrogen Search continuation + gapless TTS)', async () => {
    const playbackMock = createMockPlayback();
    const debug = new DebugStore();
    const states: EngineState[] = [];
    const committed: ChatMessage[] = [];
    const ttsTexts: string[] = [];

    const gemini: GeminiPipelineService = {
      draftFastOpeningSentence: vi.fn(async () => '北京今天整体天气不错。'),
      async *streamGroundedContinuation({ openingSentence }) {
        // Deliberately echo S1 to verify stripDuplicatePrefix works end-to-end
        yield {
          text: `${openingSentence}具体来看，最高气温 20 度，适合出门。`,
          grounding: {
            searchQueries: ['北京今天天气'],
            sources: [{ title: '中国天气网', url: 'https://weather.example.cn' }],
          },
        };
        yield { text: '晚上稍微降温，记得带件外套。' };
      },
      async *streamSpeechPcm({ text }) {
        ttsTexts.push(text);
        yield new ArrayBuffer(9600);
      },
      summarizeHistory: vi.fn(async () => ''),
    };

    const engine = new LiveChatEngine(
      {
        gemini,
        playback: playbackMock.adapter,
        mic: createMockMic(),
        stt: createMockStt(),
        debug,
      },
      DEFAULT_SETTINGS,
      {
        onStateChange: (s) => states.push(s),
        onInterimTranscript: () => {},
        onDraftChange: () => {},
        onCommitMessage: (m) => committed.push(m),
      }
    );

    await engine.injectUtterance('今天北京天气怎么样？');

    expect(committed).toHaveLength(2);
    expect(committed[0].role).toBe('user');
    expect(committed[0].spokenText).toBe('今天北京天气怎么样？');

    const assistant = committed[1];
    expect(assistant.role).toBe('assistant');
    expect(assistant.fastOpening).toBe('北京今天整体天气不错。');
    // S1 must NOT be duplicated in the grounded continuation
    expect(assistant.spokenText).toBe(
      '北京今天整体天气不错。具体来看，最高气温 20 度，适合出门。晚上稍微降温，记得带件外套。'
    );
    expect(assistant.groundingSources).toEqual([
      { title: '中国天气网', url: 'https://weather.example.cn' },
    ]);

    // TTS received S1 first, followed by S2 and S3 without repeating S1
    expect(ttsTexts).toEqual([
      '北京今天整体天气不错。',
      '具体来看，最高气温 20 度，适合出门。',
      '晚上稍微降温，记得带件外套。',
    ]);
    expect(playbackMock.enqueued).toHaveLength(3);
    expect(states).toContain('THINKING_FAST');
    expect(states).toContain('SPEAKING_FAST');
    expect(states).toContain('SPEAKING_GROUNDED');
    expect(debug.getSnapshot().latencies).toHaveLength(1);
  });

  it('handles mid-speech barge-in, truncates spoken context accurately, and passes only heard text to next turn', async () => {
    const playbackMock = createMockPlayback();
    const debug = new DebugStore();
    const committed: ChatMessage[] = [];
    const receivedHistories: HistoryTurn[][] = [];

    let releaseSecondChunk!: () => void;
    const secondChunkGate = new Promise<void>((r) => {
      releaseSecondChunk = r;
    });

    const gemini: GeminiPipelineService = {
      draftFastOpeningSentence: vi.fn(async ({ history, userText }) => {
        receivedHistories.push(history);
        return userText.includes('上海') ? '好的，马上帮你看上海天气。' : '北京今天整体天气不错。';
      }),
      async *streamGroundedContinuation({ signal, userText }) {
        if (userText.includes('上海')) {
          yield { text: '上海今天多云，气温 22 度。' };
          return;
        }
        yield { text: '白天最高气温二十度，下午空气质量优良。' };
        await secondChunkGate;
        if (signal.aborted) return;
        yield { text: '另外明天可能会下大雨，千万别忘带伞。' };
      },
      async *streamSpeechPcm({ signal }) {
        yield new ArrayBuffer(4800);
        // Keep TTS worker alive until aborted during turn 1
        if (committed.length <= 1) {
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true });
            setTimeout(resolve, 500);
          });
        }
      },
      summarizeHistory: vi.fn(async () => ''),
    };

    const engine = new LiveChatEngine(
      {
        gemini,
        playback: playbackMock.adapter,
        mic: createMockMic(),
        stt: createMockStt(),
        debug,
        utteranceCoalesceMs: 10,
      },
      DEFAULT_SETTINGS,
      {
        onStateChange: () => {},
        onInterimTranscript: () => {},
        onDraftChange: () => {},
        onCommitMessage: (m) => committed.push(m),
      }
    );

    // Start turn 1 without awaiting completion
    const turn1Promise = engine.injectUtterance('今天北京天气怎么样？');
    await new Promise((r) => setTimeout(r, 30));

    // Simulate playback progress: S1 finished (100%), S2 played 45%
    playbackMock.setProgress({
      reason: 'tick',
      activeSegmentId: 't1-s2',
      bufferedMs: 400,
      gain: 1,
      isFlushing: false,
      segments: [
        { segmentId: 't1-s1', samplesPlayed: 24000, totalSamples: 24000 },
        { segmentId: 't1-s2', samplesPlayed: 10800, totalSamples: 24000 },
      ],
    });

    // User speaks over assistant -> server VAD ducks, interim confirms barge-in!
    engine.handleServerVad('SPEECH_ACTIVITY_BEGIN');
    expect(playbackMock.adapter.duck).toHaveBeenCalledTimes(1);

    engine.handleSttInterim('等等，换成上海');
    releaseSecondChunk();
    await turn1Promise;
    await new Promise((r) => setTimeout(r, 20));

    expect(playbackMock.adapter.flush).toHaveBeenCalledTimes(1);
    const interruptedAssistant = committed.find((m) => m.role === 'assistant');
    expect(interruptedAssistant?.interrupted).toBe(true);
    expect(interruptedAssistant?.spokenText).toContain('北京今天整体天气不错。');
    expect(interruptedAssistant?.spokenText).toContain('——[用户打断]');
    expect(interruptedAssistant?.spokenText).not.toContain('下大雨');

    // Turn 2: verify LLM receives ONLY the heard truncated text in history
    await engine.injectUtterance('等等，换成上海吧');
    const secondTurnHistory = receivedHistories[1];
    const modelTurn = secondTurnHistory.find((h) => h.role === 'model');
    expect(modelTurn?.text).toContain('——[用户打断]');
    expect(modelTurn?.text).not.toContain('下大雨');
  });

  it('recovers from false-trigger VAD by unducking when no speech confirms', async () => {
    const playbackMock = createMockPlayback();
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((r) => {
      releaseTurn = r;
    });

    const gemini: GeminiPipelineService = {
      draftFastOpeningSentence: vi.fn(async () => '测试首句。'),
      async *streamGroundedContinuation() {
        await turnGate;
        yield { text: '测试续写。' };
      },
      async *streamSpeechPcm() {
        yield new ArrayBuffer(1000);
      },
      summarizeHistory: vi.fn(async () => ''),
    };

    const engine = new LiveChatEngine(
      {
        gemini,
        playback: playbackMock.adapter,
        mic: createMockMic(),
        stt: createMockStt(),
        duckConfirmTimeoutMs: 40,
      },
      DEFAULT_SETTINGS,
      {
        onStateChange: () => {},
        onInterimTranscript: () => {},
        onDraftChange: () => {},
        onCommitMessage: () => {},
      }
    );

    const turnPromise = engine.injectUtterance('你好');
    await new Promise((r) => setTimeout(r, 15));

    engine.handleServerVad('SPEECH_ACTIVITY_BEGIN');
    expect(playbackMock.adapter.duck).toHaveBeenCalledTimes(1);

    // Wait longer than duckConfirmTimeoutMs without sending any interim transcript
    await new Promise((r) => setTimeout(r, 65));
    expect(playbackMock.adapter.unduck).toHaveBeenCalledTimes(1);
    expect(playbackMock.adapter.flush).not.toHaveBeenCalled();

    releaseTurn();
    await turnPromise;
  });
});
