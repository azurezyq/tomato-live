import { describe, it, expect, vi } from 'vitest';
import type { AudioPlaybackAdapter, MicCaptureAdapter, PlaybackProgressEvent } from '../../audio/audioManager';
import type { GeminiPipelineService } from '../../services/geminiService';
import type { SttClientAdapter } from '../../services/sttClient';
import { DEFAULT_SETTINGS, type EngineState } from '../../types/chat';
import { DebugStore } from '../debugStore';
import { LiveChatEngine } from '../liveChatEngine';
import {
  computeSemanticSilenceMs,
  isBackchannelUtterance,
  isEchoOfAssistantSpeech,
  isReadyForSpeculativeDraft,
  isSpeculativeTranscriptMatch,
  pickOpeningLengthStyle,
  sanitizeFastOpening,
} from '../turnHeuristics';

function createMocks() {
  const progress: PlaybackProgressEvent = {
    reason: 'tick',
    activeSegmentId: null,
    bufferedMs: 0,
    gain: 1,
    isFlushing: false,
    segments: [],
  };
  const playback: AudioPlaybackAdapter = {
    init: vi.fn(async () => {}),
    enqueue: vi.fn(),
    duck: vi.fn(),
    unduck: vi.fn(),
    flush: vi.fn(async () => ({ ...progress, reason: 'flushed' as const })),
    reset: vi.fn(),
    getLastProgress: vi.fn(() => progress),
    onProgress: vi.fn(() => () => {}),
    dispose: vi.fn(async () => {}),
  };
  const mic: MicCaptureAdapter = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
  const stt: SttClientAdapter = {
    connect: vi.fn(async () => {}),
    sendAudio: vi.fn(),
    sendAudioStreamEnd: vi.fn(),
    disconnect: vi.fn(),
  };
  return { playback, mic, stt };
}

describe('turnHeuristics (Practices #1-#4)', () => {
  it('#1 identifies Mandarin & English backchannels vs real interruptions', () => {
    expect(isBackchannelUtterance('嗯')).toBe(true);
    expect(isBackchannelUtterance('嗯嗯，')).toBe(true);
    expect(isBackchannelUtterance('好的。')).toBe(true);
    expect(isBackchannelUtterance('明白')).toBe(true);
    expect(isBackchannelUtterance('有道理')).toBe(true);
    expect(isBackchannelUtterance('uh-huh')).toBe(true);

    expect(isBackchannelUtterance('停')).toBe(false);
    expect(isBackchannelUtterance('等等，换成上海')).toBe(false);
    expect(isBackchannelUtterance('不对')).toBe(false);
  });

  it('#2 adjusts semantic silence window: fast (~260ms) on questions, extended (~1050ms) on hesitation', () => {
    expect(computeSemanticSilenceMs('今天北京天气怎么样？', 550)).toBe(260);
    expect(computeSemanticSilenceMs('明天会下雨吗', 550)).toBe(260);
    expect(computeSemanticSilenceMs('我想去杭州，然后', 550)).toBeGreaterThanOrEqual(1050);
    expect(computeSemanticSilenceMs('就是那个嗯', 550)).toBeGreaterThanOrEqual(1050);
    expect(computeSemanticSilenceMs('今天去了西湖', 550)).toBe(550);
  });

  it('#3 checks speculative pre-execution readiness & normalized transcript matching', () => {
    expect(isReadyForSpeculativeDraft('今天北京天气怎么样')).toBe(true);
    expect(isReadyForSpeculativeDraft('你好')).toBe(false);
    expect(isSpeculativeTranscriptMatch('今天北京天气怎么样', '今天北京天气怎么样？')).toBe(true);
    expect(isSpeculativeTranscriptMatch('今天北京天气', '今天上海天气')).toBe(false);
  });

  it('#4 selects medium S1 for search-heavy queries and short S1 for casual chat', () => {
    expect(pickOpeningLengthStyle('今天北京天气怎么样？')).toBe('medium');
    expect(pickOpeningLengthStyle('查一下美元汇率')).toBe('medium');
    expect(pickOpeningLengthStyle('你好呀，今天开心吗')).toBe('short');
  });
});

describe('LiveChatEngine integration of Practices #1-#5', () => {
  it('#1 ignores Mandarin backchannels ("嗯", "好的") during playback and restores ducked volume', async () => {
    const { playback, mic, stt } = createMocks();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const gemini: GeminiPipelineService = {
      draftFastOpeningSentence: vi.fn(async () => '西湖边有很多安静的茶室。'),
      async *streamGroundedContinuation() {
        await gate;
        yield { text: '比如茅家埠和郭庄都非常清静。' };
      },
      async *streamSpeechPcm() {
        yield new ArrayBuffer(2400);
      },
      summarizeHistory: vi.fn(async () => ''),
    };

    const engine = new LiveChatEngine(
      { gemini, playback, mic, stt },
      DEFAULT_SETTINGS,
      {
        onStateChange: () => {},
        onInterimTranscript: () => {},
        onDraftChange: () => {},
        onCommitMessage: () => {},
      }
    );

    const p = engine.injectUtterance('推荐杭州茶室');
    await new Promise((r) => setTimeout(r, 15));

    engine.handleServerVad('SPEECH_ACTIVITY_BEGIN');
    expect(playback.duck).toHaveBeenCalledTimes(1);

    // User says "嗯嗯" while listening -> must NOT flush, must unduck!
    engine.handleSttInterim('嗯嗯');
    expect(playback.flush).not.toHaveBeenCalled();
    expect(playback.unduck).toHaveBeenCalledTimes(1);

    release();
    await p;
  });

  it('#3 reuses speculative S1 draft on partial->final match (SPECULATIVE_HIT)', async () => {
    const { playback, mic, stt } = createMocks();
    const debug = new DebugStore();
    const draftSpy = vi.fn(async () => '上海今天天气不错，我这就帮你查具体气温。');

    const gemini: GeminiPipelineService = {
      draftFastOpeningSentence: draftSpy,
      async *streamGroundedContinuation() {
        yield { text: '目前气温二十度。' };
      },
      async *streamSpeechPcm() {
        yield new ArrayBuffer(1200);
      },
      summarizeHistory: vi.fn(async () => ''),
    };

    const engine = new LiveChatEngine(
      {
        gemini,
        playback,
        mic,
        stt,
        debug,
        speculativeDebounceMs: 15,
        utteranceCoalesceMs: 15,
      },
      { ...DEFAULT_SETTINGS, sttProvider: 'manual' },
      {
        onStateChange: () => {},
        onInterimTranscript: () => {},
        onDraftChange: () => {},
        onCommitMessage: () => {},
      }
    );

    await engine.startVoiceSession({ wsUrl: 'ws://localhost:8081/ws/stt' });
    engine.handleSttInterim('今天上海天气怎么样');
    await new Promise((r) => setTimeout(r, 35)); // triggers speculative pre-draft

    engine.handleSttFinal('今天上海天气怎么样？');
    await new Promise((r) => setTimeout(r, 60));

    // Only called ONCE because the speculative draft was reused!
    expect(draftSpy).toHaveBeenCalledTimes(1);
    expect(debug.getSnapshot().events.some((e) => e.message.includes('SPECULATIVE_HIT'))).toBe(true);
  });

  it('#5 transitions through WARMING -> CONNECTING -> LISTENING when warmUp() is provided', async () => {
    const { playback, mic, stt } = createMocks();
    const states: EngineState[] = [];
    const warmUp = vi.fn(async () => {});
    const gemini: GeminiPipelineService = {
      warmUp,
      draftFastOpeningSentence: vi.fn(async () => '你好。'),
      async *streamGroundedContinuation() {
        yield { text: '很高兴见到你。' };
      },
      async *streamSpeechPcm() {
        yield new ArrayBuffer(1200);
      },
      summarizeHistory: vi.fn(async () => ''),
    };

    const engine = new LiveChatEngine(
      { gemini, playback, mic, stt },
      DEFAULT_SETTINGS,
      {
        onStateChange: (s) => states.push(s),
        onInterimTranscript: () => {},
        onDraftChange: () => {},
        onCommitMessage: () => {},
      }
    );

    await engine.startVoiceSession({ wsUrl: 'ws://localhost:8081/ws/stt' });
    expect(warmUp).toHaveBeenCalledTimes(1);
    expect(states).toEqual(['WARMING', 'CONNECTING', 'LISTENING']);
  });

  it('Bug #1: strips leaked google_search / tool_call syntax from Flash-Lite S1 output', () => {
    expect(
      sanitizeFastOpening('google_search(query="北京天气") 我来帮你查一下北京天气。')
    ).toBe('我来帮你查一下北京天气。');
    expect(
      sanitizeFastOpening('```tool_code\nprint(google_search("weather"))\n``` 好的，马上看。')
    ).toBe('好的，马上看。');
    expect(sanitizeFastOpening('<tool_call>{"name":"google_search"}</tool_call>')).toBe('');
  });

  it('Bug #2: rejects phone speakerphone acoustic echo so assistant never interrupts itself', async () => {
    expect(
      isEchoOfAssistantSpeech('北京今天整体天气不错', '北京今天整体天气不错，适合出门散步。')
    ).toBe(true);
    expect(
      isEchoOfAssistantSpeech('等等，换成上海', '北京今天整体天气不错，适合出门散步。')
    ).toBe(false);

    const { playback, mic, stt } = createMocks();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const gemini: GeminiPipelineService = {
      draftFastOpeningSentence: vi.fn(async () => '杭州西湖边有很多安静的茶室可以品龙井。'),
      async *streamGroundedContinuation() {
        await gate;
        yield { text: '比如茅家埠和郭庄都非常清静。' };
      },
      async *streamSpeechPcm() {
        yield new ArrayBuffer(2400);
      },
      summarizeHistory: vi.fn(async () => ''),
    };

    const engine = new LiveChatEngine(
      { gemini, playback, mic, stt, playbackGraceMs: 0 },
      DEFAULT_SETTINGS,
      {
        onStateChange: () => {},
        onInterimTranscript: () => {},
        onDraftChange: () => {},
        onCommitMessage: () => {},
      }
    );

    const p = engine.injectUtterance('推荐杭州茶室');
    await new Promise((r) => setTimeout(r, 15));

    // Phone speaker leaks the assistant's own phrase back into STT
    engine.handleServerVad('SPEECH_ACTIVITY_BEGIN');
    engine.handleSttInterim('杭州西湖边有很多安静的茶室');
    expect(playback.flush).not.toHaveBeenCalled();
    expect(playback.unduck).toHaveBeenCalledTimes(1);

    // Real user explicit interruption still works immediately
    engine.handleSttInterim('等等，换成苏州');
    release();
    await p;
    expect(playback.flush).toHaveBeenCalledTimes(1);
  });
});
