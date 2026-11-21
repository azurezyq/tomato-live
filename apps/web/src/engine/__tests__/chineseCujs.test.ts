import { describe, it, expect, vi } from 'vitest';
import type {
  AudioPlaybackAdapter,
  MicCaptureAdapter,
  PlaybackProgressEvent,
} from '../../audio/audioManager';
import type { GeminiPipelineService, HistoryTurn } from '../../services/geminiService';
import type { SttClientAdapter, SttClientCallbacks, SttConnectOptions } from '../../services/sttClient';
import { DEFAULT_SETTINGS, type AppSettings, type ChatMessage, type EngineState } from '../../types/chat';
import { DebugStore } from '../debugStore';
import { LiveChatEngine, type LiveDraftState } from '../liveChatEngine';
import {
  computeSpokenTruncation,
  SentenceChunker,
  stripDuplicatePrefix,
  truncateTextByRatio,
} from '../sentenceChunker';

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

function createMockMic() {
  let frameHandler: ((pcm: ArrayBuffer, rms: number) => void) | null = null;
  const adapter: MicCaptureAdapter = {
    start: vi.fn(async (onFrame) => {
      frameHandler = onFrame;
    }),
    stop: vi.fn(async () => {
      frameHandler = null;
    }),
  };
  return {
    adapter,
    emitFrame(rms: number, byteLength = 3200) {
      frameHandler?.(new ArrayBuffer(byteLength), rms);
    },
  };
}

function createMockStt(shouldFail = false) {
  let lastOptions: SttConnectOptions | null = null;
  let lastCallbacks: SttClientCallbacks | null = null;
  const adapter: SttClientAdapter = {
    connect: vi.fn(async (opts, cbs) => {
      if (shouldFail) throw new Error('STT WebSocket 连接失败');
      lastOptions = opts;
      lastCallbacks = cbs;
      cbs.onReady?.();
    }),
    sendAudio: vi.fn(),
    sendAudioStreamEnd: vi.fn(),
    disconnect: vi.fn(),
  };
  return {
    adapter,
    getLastOptions: () => lastOptions,
    getLastCallbacks: () => lastCallbacks,
  };
}

function createSimpleGemini(overrides?: Partial<GeminiPipelineService>): GeminiPipelineService {
  return {
    draftFastOpeningSentence: vi.fn(async () => '好的，我来帮你看一下。'),
    async *streamGroundedContinuation() {
      yield { text: '根据最新查询结果，目前一切正常。' };
    },
    async *streamSpeechPcm() {
      yield new ArrayBuffer(4800);
    },
    summarizeHistory: vi.fn(async () => '历史对话摘要：用户询问了天气与出行建议。'),
    ...overrides,
  };
}

describe('番茄实时语音 · 50项中文全链路核心用户旅程 (Chinese CUJs)', () => {
  // =========================================================================
  // Group 1: 实时语音起句与双模型无缝衔接 (10 tests)
  // =========================================================================

  it('CUJ-01: 北京实时天气查询，首句 Flash-Lite 与 Hydrogen 联网结果无缝衔接并附带搜索来源', async () => {
    const pb = createMockPlayback();
    const committed: ChatMessage[] = [];
    const gemini = createSimpleGemini({
      draftFastOpeningSentence: vi.fn(async () => '北京今天整体以晴为主。'),
      async *streamGroundedContinuation() {
        yield {
          text: '白天最高气温 21 度，微风，非常适合户外活动。',
          grounding: {
            searchQueries: ['北京今天天气'],
            sources: [{ title: '中国天气网', url: 'https://www.weather.com.cn' }],
          },
        };
      },
    });
    const engine = new LiveChatEngine(
      { gemini, playback: pb.adapter, mic: createMockMic().adapter, stt: createMockStt().adapter },
      DEFAULT_SETTINGS,
      {
        onStateChange: () => {},
        onInterimTranscript: () => {},
        onDraftChange: () => {},
        onCommitMessage: (m) => committed.push(m),
      }
    );

    await engine.injectUtterance('今天北京天气怎么样？');
    expect(committed[1].spokenText).toBe('北京今天整体以晴为主。白天最高气温 21 度，微风，非常适合户外活动。');
    expect(committed[1].groundingSources?.[0].title).toBe('中国天气网');
  });

  it('CUJ-02: 科技热点查询（星舰试飞），展示多条 Google 搜索来源与检索词', async () => {
    const pb = createMockPlayback();
    const debug = new DebugStore();
    const committed: ChatMessage[] = [];
    const gemini = createSimpleGemini({
      draftFastOpeningSentence: vi.fn(async () => '星舰近期试飞有不少新进展。'),
      async *streamGroundedContinuation() {
        yield {
          text: '最新一次试飞顺利完成了助推器回收测试。',
          grounding: {
            searchQueries: ['SpaceX 星舰 最新试飞', 'Starship launch 2026'],
            sources: [
              { title: 'SpaceX 官网', url: 'https://spacex.com' },
              { title: '航天新闻', url: 'https://space.example.cn' },
            ],
          },
        };
      },
    });
    const engine = new LiveChatEngine(
      { gemini, playback: pb.adapter, mic: createMockMic().adapter, stt: createMockStt().adapter, debug },
      DEFAULT_SETTINGS,
      {
        onStateChange: () => {},
        onInterimTranscript: () => {},
        onDraftChange: () => {},
        onCommitMessage: (m) => committed.push(m),
      }
    );

    await engine.injectUtterance('SpaceX 星舰最近试飞进展怎么样？');
    expect(committed[1].groundingSources).toHaveLength(2);
    expect(committed[1].searchQueries).toContain('SpaceX 星舰 最新试飞');
    expect(debug.getSnapshot().context.lastGrounding?.sources).toHaveLength(2);
  });

  it('CUJ-03: 美食推荐多句流式播报，按中文句号分批推入 TTS 队列', async () => {
    const pb = createMockPlayback();
    const ttsQueueTexts: string[] = [];
    const gemini = createSimpleGemini({
      draftFastOpeningSentence: vi.fn(async () => '北京好吃的铜锅涮肉选择很多。'),
      async *streamGroundedContinuation() {
        yield { text: '南门涮肉的麻酱小料非常地道。' };
        yield { text: '聚宝源的手切鲜羊肉也很受欢迎。' };
        yield { text: '建议提前在手机上取号排队。' };
      },
      async *streamSpeechPcm({ text }) {
        ttsQueueTexts.push(text);
        yield new ArrayBuffer(2400);
      },
    });
    const engine = new LiveChatEngine(
      { gemini, playback: pb.adapter, mic: createMockMic().adapter, stt: createMockStt().adapter },
      DEFAULT_SETTINGS,
      {
        onStateChange: () => {},
        onInterimTranscript: () => {},
        onDraftChange: () => {},
        onCommitMessage: () => {},
      }
    );

    await engine.injectUtterance('推荐一家北京好吃的铜锅涮肉');
    expect(ttsQueueTexts).toEqual([
      '北京好吃的铜锅涮肉选择很多。',
      '南门涮肉的麻酱小料非常地道。聚宝源的手切鲜羊肉也很受欢迎。',
      '建议提前在手机上取号排队。',
    ]);
  });

  it('CUJ-04: 中英混说技术问答（AudioWorklet），保持术语完整且不乱切句', async () => {
    const pb = createMockPlayback();
    const ttsTexts: string[] = [];
    const gemini = createSimpleGemini({
      draftFastOpeningSentence: vi.fn(async () => 'AudioWorklet 是浏览器专门处理低延迟音频的独立线程。'),
      async *streamGroundedContinuation() {
        yield { text: '相比旧版 ScriptProcessorNode，它运行在 AudioWorkletGlobalScope 中，不会卡顿主线程 UI。' };
      },
      async *streamSpeechPcm({ text }) {
        ttsTexts.push(text);
        yield new ArrayBuffer(1200);
      },
    });
    const engine = new LiveChatEngine(
      { gemini, playback: pb.adapter, mic: createMockMic().adapter, stt: createMockStt().adapter },
      DEFAULT_SETTINGS,
      {
        onStateChange: () => {},
        onInterimTranscript: () => {},
        onDraftChange: () => {},
        onCommitMessage: () => {},
      }
    );

    await engine.injectUtterance('解释一下 WebAudio 里的 AudioWorklet');
    expect(ttsTexts[0]).toContain('AudioWorklet');
    expect(ttsTexts.join('')).toContain('ScriptProcessorNode');
  });

  it('CUJ-05: Hydrogen 意外重复首句 S1（含半角标点差异）时自动去重', async () => {
    const pb = createMockPlayback();
    const ttsTexts: string[] = [];
    const gemini = createSimpleGemini({
      draftFastOpeningSentence: vi.fn(async () => '关于这个问题，我们可以分两步来看。'),
      async *streamGroundedContinuation() {
        yield { text: '关于这个问题, 我们可以分两步来看. 第一步是确认网络延迟，第二步是优化音频缓冲。' };
      },
      async *streamSpeechPcm({ text }) {
        ttsTexts.push(text);
        yield new ArrayBuffer(1200);
      },
    });
    const engine = new LiveChatEngine(
      { gemini, playback: pb.adapter, mic: createMockMic().adapter, stt: createMockStt().adapter },
      DEFAULT_SETTINGS,
      {
        onStateChange: () => {},
        onInterimTranscript: () => {},
        onDraftChange: () => {},
        onCommitMessage: () => {},
      }
    );

    await engine.injectUtterance('怎么降低实时语音延迟？');
    expect(ttsTexts[0]).toBe('关于这个问题，我们可以分两步来看。');
    expect(ttsTexts[1]).not.toContain('关于这个问题');
    expect(ttsTexts[1]).toContain('第一步是确认网络延迟');
  });

  it('CUJ-06: 首句保守起句后，Hydrogen 基于搜索自然纠偏并补充具体数字', async () => {
    const pb = createMockPlayback();
    const committed: ChatMessage[] = [];
    const gemini = createSimpleGemini({
      draftFastOpeningSentence: vi.fn(async () => '我来帮你核实一下今天的最新金价。'),
      async *streamGroundedContinuation() {
        yield { text: '根据刚刚查到的行情，国内足金零售价大约在每克 780 元左右。' };
      },
    });
    const engine = new LiveChatEngine(
      { gemini, playback: pb.adapter, mic: createMockMic().adapter, stt: createMockStt().adapter },
      DEFAULT_SETTINGS,
      {
        onStateChange: () => {},
        onInterimTranscript: () => {},
        onDraftChange: () => {},
        onCommitMessage: (m) => committed.push(m),
      }
    );

    await engine.injectUtterance('今天金价多少钱一克？');
    expect(committed[1].spokenText).toContain('780 元');
  });

  it('CUJ-07: Hydrogen 续写极短尾句时（少于去重缓冲阈值）仍正常输出与播报', async () => {
    const pb = createMockPlayback();
    const ttsTexts: string[] = [];
    const gemini = createSimpleGemini({
      draftFastOpeningSentence: vi.fn(async () => '你好呀，很高兴和你聊天！'),
      async *streamGroundedContinuation() {
        yield { text: '有什么我可以帮你的？' };
      },
      async *streamSpeechPcm({ text }) {
        ttsTexts.push(text);
        yield new ArrayBuffer(1200);
      },
    });
    const engine = new LiveChatEngine(
      { gemini, playback: pb.adapter, mic: createMockMic().adapter, stt: createMockStt().adapter },
      DEFAULT_SETTINGS,
      {
        onStateChange: () => {},
        onInterimTranscript: () => {},
        onDraftChange: () => {},
        onCommitMessage: () => {},
      }
    );

    await engine.injectUtterance('你好');
    expect(ttsTexts).toEqual(['你好呀，很高兴和你聊天！', '有什么我可以帮你的？']);
  });

  it('CUJ-08: 完整记录每轮延迟瀑布图核心指标（Flash-Lite、TTFA、Hydrogen 首字、衔接间隙）', async () => {
    const pb = createMockPlayback();
    const debug = new DebugStore();
    const gemini = createSimpleGemini({
      draftFastOpeningSentence: vi.fn(async () => '正在为你查询上海航班。'),
      async *streamGroundedContinuation() {
        yield { text: '今天下午三点有一班直飞虹桥的航班。' };
      },
    });
    const engine = new LiveChatEngine(
      { gemini, playback: pb.adapter, mic: createMockMic().adapter, stt: createMockStt().adapter, debug },
      DEFAULT_SETTINGS,
      {
        onStateChange: () => {},
        onInterimTranscript: () => {},
        onDraftChange: () => {},
        onCommitMessage: () => {},
      }
    );

    await engine.injectUtterance('帮我查今天飞上海的航班');
    const lat = debug.getSnapshot().latencies[0];
    expect(lat.fastDraftMs).toBeGreaterThanOrEqual(0);
    expect(lat.ttsFirstAudioMs).toBeGreaterThanOrEqual(0);
    expect(lat.groundedFirstTokenMs).toBeGreaterThanOrEqual(0);
    expect(lat.groundedCompleteMs).toBeGreaterThanOrEqual(0);
    expect(lat.handoffGapMs).toBeGreaterThanOrEqual(0);
  });

  it('CUJ-09: 汇率与百分比小数播报（7.24、3.15%）不会把小数点误切为句子', async () => {
    const pb = createMockPlayback();
    const ttsTexts: string[] = [];
    const gemini = createSimpleGemini({
      draftFastOpeningSentence: vi.fn(async () => '我帮你查了最新汇率。'),
      async *streamGroundedContinuation() {
        yield { text: '美元兑人民币目前约 7.24，较上周上涨 0.35%。' };
      },
      async *streamSpeechPcm({ text }) {
        ttsTexts.push(text);
        yield new ArrayBuffer(1200);
      },
    });
    const engine = new LiveChatEngine(
      { gemini, playback: pb.adapter, mic: createMockMic().adapter, stt: createMockStt().adapter },
      DEFAULT_SETTINGS,
      {
        onStateChange: () => {},
        onInterimTranscript: () => {},
        onDraftChange: () => {},
        onCommitMessage: () => {},
      }
    );

    await engine.injectUtterance('现在美元汇率是多少？');
    expect(ttsTexts[1]).toBe('美元兑人民币目前约 7.24，较上周上涨 0.35%。');
  });

  it('CUJ-10: 连续多轮中文追问（“那明天呢？”）正确将上一轮完整对话传入历史', async () => {
    const pb = createMockPlayback();
    const histories: HistoryTurn[][] = [];
    const gemini = createSimpleGemini({
      draftFastOpeningSentence: vi.fn(async ({ history, userText }) => {
        histories.push(history);
        return userText.includes('明天') ? '明天杭州有小雨。' : '今天杭州多云转晴。';
      }),
      async *streamGroundedContinuation({ userText }) {
        yield { text: userText.includes('明天') ? '出门记得带把折叠伞。' : '气温 19 度很舒适。' };
      },
    });
    const engine = new LiveChatEngine(
      { gemini, playback: pb.adapter, mic: createMockMic().adapter, stt: createMockStt().adapter },
      DEFAULT_SETTINGS,
      {
        onStateChange: () => {},
        onInterimTranscript: () => {},
        onDraftChange: () => {},
        onCommitMessage: () => {},
      }
    );

    await engine.injectUtterance('今天杭州天气如何？');
    await engine.injectUtterance('那明天呢？');
    expect(histories[0]).toEqual([]);
    expect(histories[1]).toEqual([
      { role: 'user', text: '今天杭州天气如何？' },
      { role: 'model', text: '今天杭州多云转晴。气温 19 度很舒适。' },
    ]);
  });

  // =========================================================================
  // Group 2: 说话打断与精准上下文截断 (12 tests)
  // =========================================================================

  it('CUJ-11: 播报首句 S1 一半时立即打断，仅保留 S1 已听前半段且不纳入未播报的 S2', async () => {
    const pb = createMockPlayback();
    const committed: ChatMessage[] = [];
    const gemini = createSimpleGemini({
      draftFastOpeningSentence: vi.fn(async () => '成都大熊猫基地早上人会比较多，建议早点出发。'),
      async *streamGroundedContinuation({ signal }) {
        await new Promise((r) => setTimeout(r, 80));
        if (signal.aborted) return;
        yield { text: '可以坐地铁三号线到熊猫大道站。' };
      },
      async *streamSpeechPcm({ signal }) {
        yield new ArrayBuffer(4800);
        await new Promise<void>((res) => {
          signal.addEventListener('abort', () => res(), { once: true });
          setTimeout(res, 300);
        });
      },
    });
    const engine = new LiveChatEngine(
      { gemini, playback: pb.adapter, mic: createMockMic().adapter, stt: createMockStt().adapter },
      DEFAULT_SETTINGS,
      {
        onStateChange: () => {},
        onInterimTranscript: () => {},
        onDraftChange: () => {},
        onCommitMessage: (m) => committed.push(m),
      }
    );

    const p = engine.injectUtterance('去成都看熊猫怎么安排？');
    await new Promise((r) => setTimeout(r, 20));
    pb.setProgress({
      reason: 'tick',
      activeSegmentId: 't1-s1',
      bufferedMs: 300,
      gain: 1,
      isFlushing: false,
      segments: [{ segmentId: 't1-s1', samplesPlayed: 12000, totalSamples: 24000 }],
    });
    await engine.simulateBargeIn();
    await p;

    const assistant = committed.find((m) => m.role === 'assistant');
    expect(assistant?.interrupted).toBe(true);
    expect(assistant?.spokenText).toContain('成都大熊猫基地');
    expect(assistant?.spokenText).toContain('——[用户打断]');
    expect(assistant?.spokenText).not.toContain('地铁三号线');
  });

  it('CUJ-12: 播报 S2 中段（约 40%）打断，中文按逗号边界截断并标记用户打断', async () => {
    const pb = createMockPlayback();
    const committed: ChatMessage[] = [];
    const gemini = createSimpleGemini({
      draftFastOpeningSentence: vi.fn(async () => '好的，先说第一个方案。'),
      async *streamGroundedContinuation() {
        yield { text: '你可以先坐高铁到苏州北站，然后换乘地铁二号线直达平江路。' };
      },
      async *streamSpeechPcm({ signal }) {
        yield new ArrayBuffer(4800);
        await new Promise<void>((res) => {
          signal.addEventListener('abort', () => res(), { once: true });
          setTimeout(res, 200);
        });
      },
    });
    const engine = new LiveChatEngine(
      { gemini, playback: pb.adapter, mic: createMockMic().adapter, stt: createMockStt().adapter },
      DEFAULT_SETTINGS,
      {
        onStateChange: () => {},
        onInterimTranscript: () => {},
        onDraftChange: () => {},
        onCommitMessage: (m) => committed.push(m),
      }
    );

    const p = engine.injectUtterance('从上海去苏州平江路怎么走？');
    await new Promise((r) => setTimeout(r, 30));
    pb.setProgress({
      reason: 'tick',
      activeSegmentId: 't1-s2',
      bufferedMs: 500,
      gain: 1,
      isFlushing: false,
      segments: [
        { segmentId: 't1-s1', samplesPlayed: 20000, totalSamples: 20000 },
        { segmentId: 't1-s2', samplesPlayed: 10000, totalSamples: 25000 },
      ],
    });
    await engine.simulateBargeIn();
    await p;

    const assistant = committed.find((m) => m.role === 'assistant');
    expect(assistant?.spokenText).toContain('你可以先坐高铁到苏州北站');
    expect(assistant?.spokenText).toContain('——[用户打断]');
    expect(assistant?.spokenText).not.toContain('平江路');
  });

  it('CUJ-13: 音频尚未开始播报（0% 样本）即被打断，记录“[尚未播报即被用户打断]”', () => {
    const res = computeSpokenTruncation(
      [{ segmentId: 's1', text: '正在为你查询机票。', stage: 'fast', samplesPlayed: 0, totalSamples: 24000 }],
      true,
      'zh-CN'
    );
    expect(res.interrupted).toBe(true);
    expect(res.spokenText).toBe('[尚未播报即被用户打断]');
    expect(res.unspokenText).toBe('正在为你查询机票。');
  });

  it('CUJ-14: 播报进度达到 97% 时被打断，保留完整句子不切碎末尾', () => {
    const res = computeSpokenTruncation(
      [{ segmentId: 's1', text: '明天上午九点有雨。', stage: 'fast', samplesPlayed: 23500, totalSamples: 24000 }],
      true,
      'zh-CN'
    );
    expect(res.spokenText).toBe('明天上午九点有雨。——[用户打断]');
    expect(res.unspokenText).toBe('');
  });

  it('CUJ-15: 连续两轮被用户打断后，第 3 轮历史仅包含前两轮已播报截断文本', async () => {
    const pb = createMockPlayback();
    const histories: HistoryTurn[][] = [];
    const gemini = createSimpleGemini({
      draftFastOpeningSentence: vi.fn(async ({ history, userText }) => {
        histories.push(history);
        return `收到关于${userText}的问题。`;
      }),
      async *streamGroundedContinuation() {
        yield { text: '这里是未播报的详细长篇说明内容。' };
      },
      async *streamSpeechPcm({ signal }) {
        yield new ArrayBuffer(2400);
        await new Promise<void>((res) => {
          signal.addEventListener('abort', () => res(), { once: true });
          setTimeout(res, 180);
        });
      },
    });
    const engine = new LiveChatEngine(
      { gemini, playback: pb.adapter, mic: createMockMic().adapter, stt: createMockStt().adapter },
      DEFAULT_SETTINGS,
      {
        onStateChange: () => {},
        onInterimTranscript: () => {},
        onDraftChange: () => {},
        onCommitMessage: () => {},
      }
    );

    const p1 = engine.injectUtterance('第一个问题');
    await new Promise((r) => setTimeout(r, 20));
    pb.setProgress({
      reason: 'tick',
      activeSegmentId: 't1-s1',
      bufferedMs: 100,
      gain: 1,
      isFlushing: false,
      segments: [{ segmentId: 't1-s1', samplesPlayed: 24000, totalSamples: 24000 }],
    });
    await engine.simulateBargeIn();
    await p1;

    const p2 = engine.injectUtterance('第二个问题');
    await new Promise((r) => setTimeout(r, 20));
    const turn2SegId = pb.enqueued[pb.enqueued.length - 1].segmentId;
    pb.setProgress({
      reason: 'tick',
      activeSegmentId: turn2SegId,
      bufferedMs: 100,
      gain: 1,
      isFlushing: false,
      segments: [{ segmentId: turn2SegId, samplesPlayed: 24000, totalSamples: 24000 }],
    });
    await engine.simulateBargeIn();
    await p2;

    await engine.injectUtterance('第三个问题');
    const h3 = histories[2];
    expect(h3.filter((m) => m.role === 'model').every((m) => m.text.includes('——[用户打断]'))).toBe(true);
    expect(h3.some((m) => m.text.includes('未播报的详细长篇说明内容'))).toBe(false);
  });

  it('CUJ-16: 打断并切换城市话题（北京→深圳），未说出的北京景点不污染深圳对话上下文', async () => {
    const pb = createMockPlayback();
    const histories: HistoryTurn[][] = [];
    const gemini = createSimpleGemini({
      draftFastOpeningSentence: vi.fn(async ({ history, userText }) => {
        histories.push(history);
        return userText.includes('深圳') ? '好的，聊聊深圳。' : '北京有很多历史景点。';
      }),
      async *streamGroundedContinuation({ userText }) {
        yield {
          text: userText.includes('深圳')
            ? '深圳湾公园和世界之窗都很值得去。'
            : '比如故宫博物院、颐和园和天坛公园。',
        };
      },
      async *streamSpeechPcm({ signal }) {
        yield new ArrayBuffer(2400);
        await new Promise<void>((res) => {
          signal.addEventListener('abort', () => res(), { once: true });
          setTimeout(res, 150);
        });
      },
    });
    const engine = new LiveChatEngine(
      { gemini, playback: pb.adapter, mic: createMockMic().adapter, stt: createMockStt().adapter },
      DEFAULT_SETTINGS,
      {
        onStateChange: () => {},
        onInterimTranscript: () => {},
        onDraftChange: () => {},
        onCommitMessage: () => {},
      }
    );

    const p1 = engine.injectUtterance('推荐北京景点');
    await new Promise((r) => setTimeout(r, 20));
    pb.setProgress({
      reason: 'tick',
      activeSegmentId: 't1-s1',
      bufferedMs: 200,
      gain: 1,
      isFlushing: false,
      segments: [{ segmentId: 't1-s1', samplesPlayed: 24000, totalSamples: 24000 }],
    });
    await engine.simulateBargeIn();
    await p1;

    await engine.injectUtterance('不用了，换成深圳吧');
    expect(histories[1][1].text).not.toContain('故宫博物院');
  });

  it('CUJ-17: 咳嗽或桌面噪音触发 VAD 降音（duck）但无识别文本，超时后自动恢复音量（unduck）', async () => {
    const pb = createMockPlayback();
    let finishTurn!: () => void;
    const gate = new Promise<void>((r) => {
      finishTurn = r;
    });
    const gemini = createSimpleGemini({
      async *streamGroundedContinuation() {
        await gate;
        yield { text: '继续播报完成。' };
      },
    });
    const engine = new LiveChatEngine(
      {
        gemini,
        playback: pb.adapter,
        mic: createMockMic().adapter,
        stt: createMockStt().adapter,
        duckConfirmTimeoutMs: 35,
      },
      DEFAULT_SETTINGS,
      {
        onStateChange: () => {},
        onInterimTranscript: () => {},
        onDraftChange: () => {},
        onCommitMessage: () => {},
      }
    );

    const p = engine.injectUtterance('讲个冷笑话');
    await new Promise((r) => setTimeout(r, 15));
    engine.handleServerVad('SPEECH_ACTIVITY_BEGIN');
    expect(pb.adapter.duck).toHaveBeenCalledTimes(1);

    await new Promise((r) => setTimeout(r, 55));
    expect(pb.adapter.unduck).toHaveBeenCalledTimes(1);
    expect(pb.adapter.flush).not.toHaveBeenCalled();
    finishTurn();
    await p;
  });

  it('CUJ-18: 关闭允许插话打断开关（bargeInEnabled=false）时，用户中途说话不中止当前播报', async () => {
    const pb = createMockPlayback();
    let finishTurn!: () => void;
    const gate = new Promise<void>((r) => {
      finishTurn = r;
    });
    const gemini = createSimpleGemini({
      async *streamGroundedContinuation() {
        await gate;
        yield { text: '完整播报不会被中断。' };
      },
    });
    const settings: AppSettings = { ...DEFAULT_SETTINGS, bargeInEnabled: false };
    const engine = new LiveChatEngine(
      { gemini, playback: pb.adapter, mic: createMockMic().adapter, stt: createMockStt().adapter },
      settings,
      {
        onStateChange: () => {},
        onInterimTranscript: () => {},
        onDraftChange: () => {},
        onCommitMessage: () => {},
      }
    );

    const p = engine.injectUtterance('介绍西湖');
    await new Promise((r) => setTimeout(r, 15));
    engine.handleServerVad('SPEECH_ACTIVITY_BEGIN');
    engine.handleSttInterim('停一下');
    expect(pb.adapter.duck).not.toHaveBeenCalled();
    expect(pb.adapter.flush).not.toHaveBeenCalled();
    finishTurn();
    await p;
  });

  it('CUJ-19: 调试面板点击“模拟打断”记录 bargeInStopMs 并回退到 LISTENING 状态', async () => {
    const pb = createMockPlayback();
    const debug = new DebugStore();
    const gemini = createSimpleGemini({
      async *streamSpeechPcm({ signal }) {
        yield new ArrayBuffer(2400);
        await new Promise<void>((res) => {
          signal.addEventListener('abort', () => res(), { once: true });
          setTimeout(res, 200);
        });
      },
    });
    const engine = new LiveChatEngine(
      { gemini, playback: pb.adapter, mic: createMockMic().adapter, stt: createMockStt().adapter, debug },
      DEFAULT_SETTINGS,
      {
        onStateChange: () => {},
        onInterimTranscript: () => {},
        onDraftChange: () => {},
        onCommitMessage: () => {},
      }
    );

    const p = engine.injectUtterance('测试模拟打断');
    await new Promise((r) => setTimeout(r, 20));
    await engine.simulateBargeIn();
    await p;

    expect(engine.getState()).toBe('LISTENING');
    expect(debug.getSnapshot().latencies[0].bargeInStopMs).toBeGreaterThanOrEqual(0);
  });

  it('CUJ-20: 仅空白字符的 interim 识别结果不会误触发打断', async () => {
    const pb = createMockPlayback();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const gemini = createSimpleGemini({
      async *streamGroundedContinuation() {
        await gate;
        yield { text: '正常结束。' };
      },
    });
    const engine = new LiveChatEngine(
      { gemini, playback: pb.adapter, mic: createMockMic().adapter, stt: createMockStt().adapter },
      DEFAULT_SETTINGS,
      {
        onStateChange: () => {},
        onInterimTranscript: () => {},
        onDraftChange: () => {},
        onCommitMessage: () => {},
      }
    );

    const p = engine.injectUtterance('你好');
    await new Promise((r) => setTimeout(r, 15));
    engine.handleSttInterim('   ');
    expect(pb.adapter.flush).not.toHaveBeenCalled();
    release();
    await p;
  });

  it('CUJ-21: 中文单字打断词（“停”）可即时触发打断，而单字母噪音（“a”）不触发', async () => {
    const pb = createMockPlayback();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const gemini = createSimpleGemini({
      async *streamGroundedContinuation({ signal }) {
        await gate;
        if (signal.aborted) return;
        yield { text: '不会说完。' };
      },
    });
    const engine = new LiveChatEngine(
      { gemini, playback: pb.adapter, mic: createMockMic().adapter, stt: createMockStt().adapter },
      DEFAULT_SETTINGS,
      {
        onStateChange: () => {},
        onInterimTranscript: () => {},
        onDraftChange: () => {},
        onCommitMessage: () => {},
      }
    );

    const p = engine.injectUtterance('念一首长诗');
    await new Promise((r) => setTimeout(r, 15));
    engine.handleSttInterim('a');
    expect(pb.adapter.flush).not.toHaveBeenCalled();

    engine.handleSttInterim('停');
    release();
    await p;
    expect(pb.adapter.flush).toHaveBeenCalledTimes(1);
  });

  it('CUJ-22: 处于 THINKING_FAST 思考首句阶段时被打断，立即取消 Flash-Lite 不进入播报', async () => {
    const pb = createMockPlayback();
    const ttsCalled = vi.fn();
    let abortObserved = false;
    const gemini = createSimpleGemini({
      draftFastOpeningSentence: vi.fn(
        ({ signal }) =>
          new Promise<string>((resolve) => {
            signal.addEventListener('abort', () => {
              abortObserved = true;
              resolve('');
            });
            setTimeout(() => resolve('迟到的首句。'), 200);
          })
      ),
      async *streamSpeechPcm() {
        ttsCalled();
        yield new ArrayBuffer(1200);
      },
    });
    const engine = new LiveChatEngine(
      { gemini, playback: pb.adapter, mic: createMockMic().adapter, stt: createMockStt().adapter },
      DEFAULT_SETTINGS,
      {
        onStateChange: () => {},
        onInterimTranscript: () => {},
        onDraftChange: () => {},
        onCommitMessage: () => {},
      }
    );

    const p = engine.injectUtterance('帮我查个复杂问题');
    await new Promise((r) => setTimeout(r, 15));
    expect(engine.getState()).toBe('THINKING_FAST');
    await engine.simulateBargeIn();
    await p;

    expect(abortObserved).toBe(true);
    expect(ttsCalled).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Group 3: 语音识别流、Hybrid VAD 与分句合并 (8 tests)
  // =========================================================================

  it('CUJ-23: 短时间内的连续碎片 final 识别结果自动合并为一轮完整发言', async () => {
    const pb = createMockPlayback();
    const committed: ChatMessage[] = [];
    const gemini = createSimpleGemini();
    const engine = new LiveChatEngine(
      {
        gemini,
        playback: pb.adapter,
        mic: createMockMic().adapter,
        stt: createMockStt().adapter,
        utteranceCoalesceMs: 40,
      },
      DEFAULT_SETTINGS,
      {
        onStateChange: () => {},
        onInterimTranscript: () => {},
        onDraftChange: () => {},
        onCommitMessage: (m) => committed.push(m),
      }
    );

    engine.handleSttFinal('帮我查一下');
    await new Promise((r) => setTimeout(r, 15));
    engine.handleSttFinal('明天去杭州的高铁');
    await new Promise((r) => setTimeout(r, 90));

    const userMsgs = committed.filter((m) => m.role === 'user');
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0].spokenText).toBe('帮我查一下 明天去杭州的高铁');
  });

  it('CUJ-24: 超过合并窗口的两次 final 各自触发独立轮次', async () => {
    const pb = createMockPlayback();
    const committed: ChatMessage[] = [];
    const gemini = createSimpleGemini();
    const engine = new LiveChatEngine(
      {
        gemini,
        playback: pb.adapter,
        mic: createMockMic().adapter,
        stt: createMockStt().adapter,
        utteranceCoalesceMs: 25,
      },
      DEFAULT_SETTINGS,
      {
        onStateChange: () => {},
        onInterimTranscript: () => {},
        onDraftChange: () => {},
        onCommitMessage: (m) => committed.push(m),
      }
    );

    engine.handleSttFinal('第一句');
    await new Promise((r) => setTimeout(r, 60));
    engine.handleSttFinal('第二句');
    await new Promise((r) => setTimeout(r, 60));

    const userMsgs = committed.filter((m) => m.role === 'user');
    expect(userMsgs.map((u) => u.spokenText)).toEqual(['第一句', '第二句']);
  });

  it('CUJ-25: 本地 Hybrid VAD 检测到人声结束并静默超阈值后，自动发送 audioStreamEnd 加速判停', async () => {
    const pb = createMockPlayback();
    const mic = createMockMic();
    const stt = createMockStt();
    const settings: AppSettings = { ...DEFAULT_SETTINGS, vadSilenceMs: 30, vadRmsThreshold: 0.02 };
    const engine = new LiveChatEngine(
      { gemini: createSimpleGemini(), playback: pb.adapter, mic: mic.adapter, stt: stt.adapter },
      settings,
      {
        onStateChange: () => {},
        onInterimTranscript: () => {},
        onDraftChange: () => {},
        onCommitMessage: () => {},
      }
    );

    await engine.startVoiceSession({ wsUrl: 'ws://localhost:8081/ws/stt', idToken: 'tok' });
    // 2 frames above threshold -> speech active
    mic.emitFrame(0.05);
    mic.emitFrame(0.06);
    // Silence starts
    mic.emitFrame(0.003);
    await new Promise((r) => setTimeout(r, 40));
    mic.emitFrame(0.002);

    expect(stt.adapter.sendAudioStreamEnd).toHaveBeenCalledTimes(1);
    await engine.stopVoiceSession();
  });

  it('CUJ-26: 环境低底噪（RMS 低于阈值）不会误触发 Hybrid VAD 或 audioStreamEnd', async () => {
    const pb = createMockPlayback();
    const mic = createMockMic();
    const stt = createMockStt();
    const engine = new LiveChatEngine(
      { gemini: createSimpleGemini(), playback: pb.adapter, mic: mic.adapter, stt: stt.adapter },
      { ...DEFAULT_SETTINGS, vadSilenceMs: 20, vadRmsThreshold: 0.03 },
      {
        onStateChange: () => {},
        onInterimTranscript: () => {},
        onDraftChange: () => {},
        onCommitMessage: () => {},
      }
    );

    await engine.startVoiceSession({ wsUrl: 'ws://localhost:8081/ws/stt' });
    mic.emitFrame(0.005);
    mic.emitFrame(0.008);
    await new Promise((r) => setTimeout(r, 30));
    mic.emitFrame(0.004);

    expect(stt.adapter.sendAudioStreamEnd).not.toHaveBeenCalled();
    await engine.stopVoiceSession();
  });

  it('CUJ-27: 语音会话完整生命周期（IDLE→CONNECTING→LISTENING→IDLE）正确释放麦克风与 WebSocket', async () => {
    const pb = createMockPlayback();
    const mic = createMockMic();
    const stt = createMockStt();
    const states: EngineState[] = [];
    const engine = new LiveChatEngine(
      { gemini: createSimpleGemini(), playback: pb.adapter, mic: mic.adapter, stt: stt.adapter },
      DEFAULT_SETTINGS,
      {
        onStateChange: (s) => states.push(s),
        onInterimTranscript: () => {},
        onDraftChange: () => {},
        onCommitMessage: () => {},
      }
    );

    await engine.startVoiceSession({ wsUrl: 'ws://localhost:8081/ws/stt', idToken: 'abc' });
    await engine.stopVoiceSession();

    expect(states).toEqual(['CONNECTING', 'LISTENING', 'IDLE']);
    expect(mic.adapter.stop).toHaveBeenCalledTimes(1);
    expect(stt.adapter.disconnect).toHaveBeenCalledTimes(1);
  });

  it('CUJ-28: 切换自动语言检测（auto 中英混说）时向 Transcribe Live 传递空 languageCodes', async () => {
    const stt = createMockStt();
    const engine = new LiveChatEngine(
      {
        gemini: createSimpleGemini(),
        playback: createMockPlayback().adapter,
        mic: createMockMic().adapter,
        stt: stt.adapter,
      },
      { ...DEFAULT_SETTINGS, sttLanguage: 'auto' },
      {
        onStateChange: () => {},
        onInterimTranscript: () => {},
        onDraftChange: () => {},
        onCommitMessage: () => {},
      }
    );

    await engine.startVoiceSession({ wsUrl: 'ws://localhost:8081/ws/stt' });
    expect(stt.getLastOptions()?.languageCodes).toEqual([]);
    await engine.stopVoiceSession();
  });

  it('CUJ-29: 切换 SMART 智能去口癖转录模式正确透传至 STT 连接配置', async () => {
    const stt = createMockStt();
    const engine = new LiveChatEngine(
      {
        gemini: createSimpleGemini(),
        playback: createMockPlayback().adapter,
        mic: createMockMic().adapter,
        stt: stt.adapter,
      },
      { ...DEFAULT_SETTINGS, sttMode: 'SMART' },
      {
        onStateChange: () => {},
        onInterimTranscript: () => {},
        onDraftChange: () => {},
        onCommitMessage: () => {},
      }
    );

    await engine.startVoiceSession({ wsUrl: 'ws://localhost:8081/ws/stt' });
    expect(stt.getLastOptions()?.mode).toBe('SMART');
    await engine.stopVoiceSession();
  });

  it('CUJ-30: 纯文字/手动调试模式（sttProvider=manual）不申请麦克风也不连接 STT WebSocket', async () => {
    const mic = createMockMic();
    const stt = createMockStt();
    const engine = new LiveChatEngine(
      {
        gemini: createSimpleGemini(),
        playback: createMockPlayback().adapter,
        mic: mic.adapter,
        stt: stt.adapter,
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
    expect(engine.getState()).toBe('LISTENING');
    expect(mic.adapter.start).not.toHaveBeenCalled();
    expect(stt.adapter.connect).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Group 4: 中文标点分句、前缀去重与多语种边界 (8 tests)
  // =========================================================================

  it('CUJ-31: 中文省略号……、感叹号！、问号？、分号；均能准确切分', () => {
    const chunker = new SentenceChunker();
    const out = chunker.push('真的吗？太棒了！不过……还是小心点；明天再说。');
    expect(out).toEqual(['真的吗？', '太棒了！', '不过……', '还是小心点；', '明天再说。']);
  });

  it('CUJ-32: 句末带中文右引号或书名号时保持引号归属当前句', () => {
    const chunker = new SentenceChunker();
    const out = chunker.push('他笑着说：“今天天气真好！”然后转身离开了。');
    expect(out).toEqual(['他笑着说：“今天天气真好！”', '然后转身离开了。']);
  });

  it('CUJ-33: 超长口语中文句子在逗号/顿号处按阈值提前切分以降低首音延迟', () => {
    const chunker = new SentenceChunker({ clauseSplitThreshold: 14, minClauseLength: 8 });
    const out = chunker.push('如果你周末打算带家人去故宫和景山公园逛一逛，记得提前三天预约门票。');
    expect(out).toEqual([
      '如果你周末打算带家人去故宫和景山公园逛一逛，',
      '记得提前三天预约门票。',
    ]);
  });

  it('CUJ-34: 混排英文缩写（Dr. / e.g. / U.S.）与温度小数（25.5℃）不误切句', () => {
    const chunker = new SentenceChunker();
    const out = chunker.push('Dr. Li 提到 U.S. 的平均气温为 25.5℃，e.g. 加州很暖和。下一句开始。');
    expect(out).toEqual([
      'Dr. Li 提到 U.S. 的平均气温为 25.5℃，e.g. 加州很暖和。',
      '下一句开始。',
    ]);
  });

  it('CUJ-35: 换行符强制分句并自动清理多余空白', () => {
    const chunker = new SentenceChunker();
    const out = chunker.push('第一条建议：早睡早起\n  第二条建议：多喝热水\n');
    expect(out).toEqual(['第一条建议：早睡早起', '第二条建议：多喝热水']);
  });

  it('CUJ-36: stripDuplicatePrefix 忽略全角空格与中文引号差异去除首句回声', () => {
    const s1 = '关于“人工智能”，前景很广阔。';
    const cont = '关于 "人工智能" ,　前景很广阔. 尤其是多模态实时交互领域。';
    expect(stripDuplicatePrefix(s1, cont)).toBe('尤其是多模态实时交互领域。');
  });

  it('CUJ-37: computeSpokenTruncation 在正常播报完毕（interrupted=false）时完整返回文本', () => {
    const res = computeSpokenTruncation(
      [
        { segmentId: 's1', text: '第一句。', stage: 'fast', samplesPlayed: 100, totalSamples: 100 },
        { segmentId: 's2', text: '第二句。', stage: 'grounded', samplesPlayed: 100, totalSamples: 100 },
      ],
      false,
      'zh-CN'
    );
    expect(res).toEqual({ spokenText: '第一句。第二句。', unspokenText: '', interrupted: false });
  });

  it('CUJ-38: 纯英文场景被打断时按单词边界截断并附加英文打断标记', () => {
    const res = computeSpokenTruncation(
      [
        {
          segmentId: 's1',
          text: 'Hello there, let me check the latest flight status for you.',
          stage: 'fast',
          samplesPlayed: 12000,
          totalSamples: 24000,
        },
      ],
      true,
      'en'
    );
    expect(res.spokenText).toBe('Hello there, let me check the — [interrupted by user]');
    expect(truncateTextByRatio('Hello world today', 0.01)).toBe('');
  });

  // =========================================================================
  // Group 5: 长对话上下文压缩、异常恢复与调试面板遥测 (12 tests)
  // =========================================================================

  it('CUJ-39: 超过 20 条消息的长对话自动触发 summarizeHistory 生成中文滚动摘要', async () => {
    const pb = createMockPlayback();
    const summaries: string[] = [];
    const summarizeMock = vi.fn(async () => '摘要：用户持续咨询了多日京沪差旅安排。');
    const gemini = createSimpleGemini({ summarizeHistory: summarizeMock });

    const engine = new LiveChatEngine(
      { gemini, playback: pb.adapter, mic: createMockMic().adapter, stt: createMockStt().adapter },
      DEFAULT_SETTINGS,
      {
        onStateChange: () => {},
        onInterimTranscript: () => {},
        onDraftChange: () => {},
        onCommitMessage: () => {},
        onUpdateRollingSummary: (s) => summaries.push(s),
      }
    );

    // Preload 20 historical messages (10 turns)
    const oldHistory: ChatMessage[] = Array.from({ length: 20 }, (_, i) => ({
      id: `m-${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      spokenText: `历史消息 ${i + 1}`,
      fullGeneratedText: `历史消息 ${i + 1}`,
      createdAt: Date.now() - (20 - i) * 1000,
    }));
    engine.loadSessionHistory(oldHistory, '');

    await engine.injectUtterance('帮我总结一下明天的日程');
    await new Promise((r) => setTimeout(r, 20));

    expect(summarizeMock).toHaveBeenCalledTimes(1);
    expect(summaries[0]).toContain('摘要：');
  });

  it('CUJ-40: 从 Firestore 恢复历史会话（loadSessionHistory）同步更新调试上下文面板', () => {
    const debug = new DebugStore();
    const engine = new LiveChatEngine(
      {
        gemini: createSimpleGemini(),
        playback: createMockPlayback().adapter,
        mic: createMockMic().adapter,
        stt: createMockStt().adapter,
        debug,
      },
      DEFAULT_SETTINGS,
      {
        onStateChange: () => {},
        onInterimTranscript: () => {},
        onDraftChange: () => {},
        onCommitMessage: () => {},
      }
    );

    engine.loadSessionHistory(
      [
        {
          id: '1',
          role: 'user',
          spokenText: '我喜欢吃辣',
          fullGeneratedText: '我喜欢吃辣',
          createdAt: 1000,
        },
        {
          id: '2',
          role: 'assistant',
          spokenText: '记住啦，下次优先推荐川湘菜。',
          fullGeneratedText: '记住啦，下次优先推荐川湘菜。',
          createdAt: 2000,
        },
      ],
      '用户偏好重口味辣菜'
    );

    const ctx = debug.getSnapshot().context;
    expect(ctx.rollingSummary).toBe('用户偏好重口味辣菜');
    expect(ctx.history).toHaveLength(2);
  });

  it('CUJ-41: Flash-Lite 首句接口报错时优雅恢复到 LISTENING 并触发 onError 与 ERROR 日志', async () => {
    const debug = new DebugStore();
    const errors: string[] = [];
    const gemini = createSimpleGemini({
      draftFastOpeningSentence: vi.fn(async () => {
        throw new Error('Quota exceeded');
      }),
    });
    const engine = new LiveChatEngine(
      {
        gemini,
        playback: createMockPlayback().adapter,
        mic: createMockMic().adapter,
        stt: createMockStt().adapter,
        debug,
      },
      DEFAULT_SETTINGS,
      {
        onStateChange: () => {},
        onInterimTranscript: () => {},
        onDraftChange: () => {},
        onCommitMessage: () => {},
        onError: (e) => errors.push(e),
      }
    );

    await engine.injectUtterance('触发配额错误');
    expect(engine.getState()).toBe('LISTENING');
    expect(errors[0]).toContain('Quota exceeded');
    expect(debug.getSnapshot().events.some((e) => e.category === 'ERROR')).toBe(true);
  });

  it('CUJ-42: Hydrogen 联网续写流中途抛错时安全捕获，不卡死状态机', async () => {
    const errors: string[] = [];
    const gemini = createSimpleGemini({
      async *streamGroundedContinuation() {
        yield { text: '前半句正常输出。' };
        throw new Error('Hydrogen stream reset');
      },
    });
    const engine = new LiveChatEngine(
      {
        gemini,
        playback: createMockPlayback().adapter,
        mic: createMockMic().adapter,
        stt: createMockStt().adapter,
      },
      DEFAULT_SETTINGS,
      {
        onStateChange: () => {},
        onInterimTranscript: () => {},
        onDraftChange: () => {},
        onCommitMessage: () => {},
        onError: (e) => errors.push(e),
      }
    );

    await engine.injectUtterance('测试流中断恢复');
    expect(engine.getState()).toBe('LISTENING');
    expect(errors[0]).toContain('Hydrogen stream reset');
  });

  it('CUJ-43: STT 代理连接失败时进入 ERROR 状态并上报错误', async () => {
    const errors: string[] = [];
    const engine = new LiveChatEngine(
      {
        gemini: createSimpleGemini(),
        playback: createMockPlayback().adapter,
        mic: createMockMic().adapter,
        stt: createMockStt(true).adapter,
      },
      DEFAULT_SETTINGS,
      {
        onStateChange: () => {},
        onInterimTranscript: () => {},
        onDraftChange: () => {},
        onCommitMessage: () => {},
        onError: (e) => errors.push(e),
      }
    );

    await expect(
      engine.startVoiceSession({ wsUrl: 'ws://localhost:8081/ws/stt' })
    ).rejects.toThrow('STT WebSocket 连接失败');
    expect(engine.getState()).toBe('ERROR');
    expect(errors[0]).toContain('STT WebSocket 连接失败');
  });

  it('CUJ-44: DebugStore 实时记录多类事件并支持清空日志', () => {
    const debug = new DebugStore();
    const notifySpy = vi.fn();
    const unsub = debug.subscribe(notifySpy);

    debug.log('STT', '收到中文 interim', { text: '你好' });
    debug.log('LLM', 'Hydrogen 首字到达', { ms: 420 });
    expect(debug.getSnapshot().events).toHaveLength(2);
    expect(notifySpy).toHaveBeenCalledTimes(2);

    debug.clearEvents();
    expect(debug.getSnapshot().events).toHaveLength(0);
    unsub();
  });

  it('CUJ-45: DebugStore.exportJson() 导出完整可解析的 JSON 调试报告', () => {
    const debug = new DebugStore();
    debug.log('STATE', 'IDLE → LISTENING');
    debug.upsertLatency({ turnId: 1, userText: '导出测试', startedAt: 1000, fastDraftMs: 210 });
    const parsed = JSON.parse(debug.exportJson()) as Record<string, unknown>;

    expect(parsed).toHaveProperty('exportedAt');
    expect(parsed).toHaveProperty('events');
    expect(parsed).toHaveProperty('latencies');
    expect(parsed).toHaveProperty('audio');
    expect(parsed).toHaveProperty('context');
  });

  it('CUJ-46: DebugStore 环形事件缓冲自动限制最多 400 条，防止长时间对话内存泄漏', () => {
    const debug = new DebugStore();
    for (let i = 0; i < 450; i++) {
      debug.log('AUDIO', `tick-${i}`);
    }
    const events = debug.getSnapshot().events;
    expect(events).toHaveLength(400);
    expect(events[0].message).toBe('tick-50');
    expect(events[399].message).toBe('tick-449');
  });

  it('CUJ-47: AudioWorklet 播报进度事件实时同步至调试面板（bufferedMs、gain、片段进度）', async () => {
    const pb = createMockPlayback();
    const debug = new DebugStore();
    const drafts: Array<LiveDraftState | null> = [];
    const engine = new LiveChatEngine(
      {
        gemini: createSimpleGemini(),
        playback: pb.adapter,
        mic: createMockMic().adapter,
        stt: createMockStt().adapter,
        debug,
      },
      DEFAULT_SETTINGS,
      {
        onStateChange: () => {},
        onInterimTranscript: () => {},
        onDraftChange: (d) => drafts.push(d),
        onCommitMessage: () => {},
      }
    );

    await engine.injectUtterance('测试进度遥测');
    pb.setProgress({
      reason: 'tick',
      activeSegmentId: 't1-s1',
      bufferedMs: 640,
      gain: 0.25,
      isFlushing: false,
      segments: [{ segmentId: 't1-s1', samplesPlayed: 12000, totalSamples: 24000 }],
    });

    const audio = debug.getSnapshot().audio;
    expect(audio.bufferedMs).toBe(640);
    expect(audio.gain).toBe(0.25);
    expect(audio.activeSegmentId).toBe('t1-s1');
    expect(drafts.some((d) => d !== null)).toBe(true);
  });

  it('CUJ-48: 运行中动态切换模型配置（Hydrogen thinkingLevel 与 TTS 音色）立即生效于下一轮', async () => {
    let seenThinking = '';
    let seenVoice = '';
    const gemini = createSimpleGemini({
      async *streamGroundedContinuation({ settings }) {
        seenThinking = settings.thinkingLevel;
        yield { text: '已使用新配置。' };
      },
      async *streamSpeechPcm({ settings }) {
        seenVoice = settings.ttsVoice;
        yield new ArrayBuffer(1200);
      },
    });
    const engine = new LiveChatEngine(
      {
        gemini,
        playback: createMockPlayback().adapter,
        mic: createMockMic().adapter,
        stt: createMockStt().adapter,
      },
      DEFAULT_SETTINGS,
      {
        onStateChange: () => {},
        onInterimTranscript: () => {},
        onDraftChange: () => {},
        onCommitMessage: () => {},
      }
    );

    engine.updateSettings({ ...DEFAULT_SETTINGS, thinkingLevel: 'high', ttsVoice: 'Aoede' });
    await engine.injectUtterance('测试动态配置');
    expect(seenThinking).toBe('high');
    expect(seenVoice).toBe('Aoede');
  });

  it('CUJ-49: 快速连续两次 injectUtterance，第 2 次自动打断第 1 次并顺利完成第 2 轮回答', async () => {
    const pb = createMockPlayback();
    const committed: ChatMessage[] = [];
    const gemini = createSimpleGemini({
      draftFastOpeningSentence: vi.fn(async ({ userText }) => `回答：${userText}。`),
      async *streamGroundedContinuation({ userText }) {
        yield { text: `${userText}的详细说明。` };
      },
      async *streamSpeechPcm({ text, signal }) {
        yield new ArrayBuffer(2400);
        if (text.includes('第一次')) {
          await new Promise<void>((res) => {
            signal.addEventListener('abort', () => res(), { once: true });
            setTimeout(res, 250);
          });
        }
      },
    });
    const engine = new LiveChatEngine(
      { gemini, playback: pb.adapter, mic: createMockMic().adapter, stt: createMockStt().adapter },
      DEFAULT_SETTINGS,
      {
        onStateChange: () => {},
        onInterimTranscript: () => {},
        onDraftChange: () => {},
        onCommitMessage: (m) => committed.push(m),
      }
    );

    const p1 = engine.injectUtterance('第一次提问');
    await new Promise((r) => setTimeout(r, 20));
    const p2 = engine.injectUtterance('第二次提问');
    await Promise.all([p1, p2]);

    const lastMsg = committed[committed.length - 1];
    expect(lastMsg.role).toBe('assistant');
    expect(lastMsg.spokenText).toContain('第二次提问');
    expect(lastMsg.interrupted).toBe(false);
  });

  it('CUJ-50: 完整端到端中文情景（先查天气 → 中途打断改问晚餐 → 追问人均价格）全部上下文精准一致', async () => {
    const pb = createMockPlayback();
    const histories: HistoryTurn[][] = [];
    const committed: ChatMessage[] = [];
    const gemini = createSimpleGemini({
      draftFastOpeningSentence: vi.fn(async ({ history, userText }) => {
        histories.push(history);
        if (userText.includes('吃什么')) return '推荐去吃本帮菜。';
        if (userText.includes('天气')) return '上海今天小雨。';
        return '人均大概一百五十元左右。';
      }),
      async *streamGroundedContinuation({ userText }) {
        if (userText.includes('吃什么')) {
          yield { text: '老吉士和兰心餐厅口碑都很好。' };
        } else if (userText.includes('天气')) {
          yield { text: '下午雨势会加大，建议取消户外散步计划。' };
        } else {
          yield { text: '红烧肉和油爆虾都是必点招牌菜。' };
        }
      },
      async *streamSpeechPcm({ text, signal }) {
        yield new ArrayBuffer(2400);
        if (text.includes('上海今天小雨')) {
          await new Promise<void>((res) => {
            signal.addEventListener('abort', () => res(), { once: true });
            setTimeout(res, 200);
          });
        }
      },
    });

    const engine = new LiveChatEngine(
      { gemini, playback: pb.adapter, mic: createMockMic().adapter, stt: createMockStt().adapter },
      DEFAULT_SETTINGS,
      {
        onStateChange: () => {},
        onInterimTranscript: () => {},
        onDraftChange: () => {},
        onCommitMessage: (m) => committed.push(m),
      }
    );

    // 第 1 轮：查上海天气，播完首句后被打断
    const t1 = engine.injectUtterance('上海今天天气怎么样？');
    await new Promise((r) => setTimeout(r, 20));
    pb.setProgress({
      reason: 'tick',
      activeSegmentId: 't1-s1',
      bufferedMs: 200,
      gain: 1,
      isFlushing: false,
      segments: [{ segmentId: 't1-s1', samplesPlayed: 24000, totalSamples: 24000 }],
    });
    await engine.simulateBargeIn();
    await t1;

    // 第 2 轮：打断改问晚餐
    await engine.injectUtterance('先不管天气了，晚上吃什么好？');

    // 第 3 轮：追问人均价格
    await engine.injectUtterance('人均大概多少钱？');

    expect(histories[1][1].text).toBe('上海今天小雨。——[用户打断]');
    expect(histories[1][1].text).not.toContain('户外散步');
    expect(histories[2].map((h) => h.text)).toEqual([
      '上海今天天气怎么样？',
      '上海今天小雨。——[用户打断]',
      '先不管天气了，晚上吃什么好？',
      '推荐去吃本帮菜。老吉士和兰心餐厅口碑都很好。',
    ]);
    expect(committed[committed.length - 1].spokenText).toBe(
      '人均大概一百五十元左右。红烧肉和油爆虾都是必点招牌菜。'
    );
  });
});
