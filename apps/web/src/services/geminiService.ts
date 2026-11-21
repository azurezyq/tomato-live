import { getGenerativeModel, type AI } from 'firebase/ai';
import type {
  AppSettings,
  GroundingMetadataSnapshot,
  GroundingSource,
} from '../types/chat';

export interface HistoryTurn {
  role: 'user' | 'model';
  text: string;
}

export interface GroundedStreamChunk {
  text?: string;
  grounding?: GroundingMetadataSnapshot;
}

export interface GeminiPipelineService {
  warmUp?(): Promise<void>;

  draftFastOpeningSentence(params: {
    history: HistoryTurn[];
    rollingSummary?: string;
    userText: string;
    openingStyle?: 'short' | 'medium';
    settings: AppSettings;
    signal: AbortSignal;
  }): Promise<string>;

  streamGroundedContinuation(params: {
    history: HistoryTurn[];
    rollingSummary?: string;
    userText: string;
    openingSentence: string;
    settings: AppSettings;
    signal: AbortSignal;
  }): AsyncGenerator<GroundedStreamChunk>;

  streamSpeechPcm(params: {
    text: string;
    settings: AppSettings;
    signal: AbortSignal;
  }): AsyncGenerator<ArrayBuffer>;

  summarizeHistory(params: {
    existingSummary?: string;
    turns: HistoryTurn[];
    settings: AppSettings;
  }): Promise<string>;
}

function decodeBase64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  // If a 44-byte RIFF WAV header is present, strip it so AudioWorklet receives raw PCM
  if (
    bytes.length > 44 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 // F
  ) {
    return bytes.slice(44).buffer;
  }
  return bytes.buffer;
}

function formatHistoryPrompt(history: HistoryTurn[], rollingSummary?: string): string {
  const lines: string[] = [];
  if (rollingSummary?.trim()) {
    lines.push(`【历史对话摘要】\n${rollingSummary.trim()}\n`);
  }
  if (history.length > 0) {
    lines.push('【近期对话记录】');
    for (const turn of history) {
      const label = turn.role === 'user' ? '用户' : '助手';
      lines.push(`${label}：${turn.text}`);
    }
  }
  return lines.join('\n');
}

function extractGroundingMetadata(rawResponse: unknown): GroundingMetadataSnapshot | undefined {
  const resp = rawResponse as {
    candidates?: Array<{
      groundingMetadata?: {
        webSearchQueries?: string[];
        groundingChunks?: Array<{
          web?: { uri?: string; title?: string };
        }>;
      };
    }>;
  };

  const meta = resp?.candidates?.[0]?.groundingMetadata;
  if (!meta) return undefined;

  const searchQueries = meta.webSearchQueries ?? [];
  const seen = new Set<string>();
  const sources: GroundingSource[] = [];

  for (const chunk of meta.groundingChunks ?? []) {
    const url = chunk.web?.uri;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    sources.push({
      title: chunk.web?.title || url,
      url,
    });
  }

  if (searchQueries.length === 0 && sources.length === 0) return undefined;
  return { searchQueries, sources };
}

export class FirebaseGeminiService implements GeminiPipelineService {
  private readonly ai: AI;

  constructor(ai: AI) {
    this.ai = ai;
  }

  async draftFastOpeningSentence(params: {
    history: HistoryTurn[];
    rollingSummary?: string;
    userText: string;
    settings: AppSettings;
    signal: AbortSignal;
  }): Promise<string> {
    if (params.signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const model = getGenerativeModel(this.ai, {
      model: params.settings.fastModel,
      systemInstruction:
        '你是面向中国大陆用户的实时语音助手“番茄”。你的唯一任务是用自然、口语化的简体中文（如果用户主要说英文则用英文），只生成【第一句】简短开场回应（严格控制在 15~40 个汉字以内，朗读不超过 8 秒）。' +
        '要求：1) 直接自然地承接用户问题，不要使用“好的，让我来帮你查一下”这种生硬模板；2) 绝对不要编造不确定的实时数据、股价、天气数字或最新新闻事实；3) 以完整句号、问号或感叹号结尾，方便后续联网模型无缝续写；4) 不要使用 Markdown、列表符号或表情符号。',
      generationConfig: {
        temperature: 0.5,
        maxOutputTokens: 90,
      },
    });

    const contextBlock = formatHistoryPrompt(params.history, params.rollingSummary);
    const prompt = [
      contextBlock,
      `用户最新发言：${params.userText}`,
      '请直接输出这一句简短开场白：',
    ]
      .filter(Boolean)
      .join('\n\n');

    const result = await model.generateContent(prompt);
    if (params.signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    return result.response.text().trim();
  }

  async *streamGroundedContinuation(params: {
    history: HistoryTurn[];
    rollingSummary?: string;
    userText: string;
    openingSentence: string;
    settings: AppSettings;
    signal: AbortSignal;
  }): AsyncGenerator<GroundedStreamChunk> {
    if (params.signal.aborted) return;

    const model = getGenerativeModel(this.ai, {
      model: params.settings.mainModel,
      tools: [{ googleSearch: {} }] as never,
      systemInstruction:
        '你是面向中国大陆用户的实时语音助手“番茄”，正在进行流畅的口语语音对话。' +
        '你已经向用户播报了开场第一句话，现在需要基于 Google 搜索的最新信息，紧接着这句话的下一个字自然续写完整回答。' +
        '严格要求：1) 绝对不要重复或改写已播报的开场句；2) 如果联网搜索发现开场句有需要补充或纠正的细节，请用自然口语过渡（如“具体来看，根据最新消息……”）；' +
        '3) 回答简洁清晰、适合语音朗读，不要使用 Markdown 标题、星号、代码块或网址链接，控制在 3~5 句话以内（除非用户要求详细展开）；4) 如果上下文中出现“——[用户打断]”，说明你上一轮说到那里就被打断了，未说出的内容用户并未听到。',
      generationConfig: {
        temperature: 0.6,
        thinkingConfig: {
          thinkingLevel: params.settings.thinkingLevel.toUpperCase(),
        },
      } as never,
    });

    const contextBlock = formatHistoryPrompt(params.history, params.rollingSummary);
    const prompt = [
      contextBlock,
      `用户最新发言：${params.userText}`,
      `你已经播报给用户的开场句（请勿重复）：<opening>${params.openingSentence}</opening>`,
      '请从开场句之后的下一句直接自然续写：',
    ]
      .filter(Boolean)
      .join('\n\n');

    const streamResult = await model.generateContentStream(prompt);
    let latestGrounding: GroundingMetadataSnapshot | undefined;

    for await (const chunk of streamResult.stream) {
      if (params.signal.aborted) return;
      const text = chunk.text();
      const grounding = extractGroundingMetadata(chunk);
      if (grounding) latestGrounding = grounding;

      if (text || grounding) {
        yield { text: text || undefined, grounding };
      }
    }

    if (!params.signal.aborted) {
      try {
        const finalResp = await streamResult.response;
        const finalGrounding = extractGroundingMetadata(finalResp);
        if (finalGrounding && !latestGrounding) {
          yield { grounding: finalGrounding };
        }
      } catch {
        // ignore if stream was cancelled
      }
    }
  }

  async *streamSpeechPcm(params: {
    text: string;
    settings: AppSettings;
    signal: AbortSignal;
  }): AsyncGenerator<ArrayBuffer> {
    if (params.signal.aborted || !params.text.trim()) return;

    const languageCode = params.settings.sttLanguage === 'en-US' ? 'en-US' : 'zh-CN';

    const model = getGenerativeModel(this.ai, {
      model: params.settings.ttsModel,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          languageCode,
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: params.settings.ttsVoice,
            },
          },
        },
      } as never,
    });

    const streamResult = await model.generateContentStream(params.text);

    for await (const chunk of streamResult.stream) {
      if (params.signal.aborted) return;
      const candidates = (chunk as unknown as {
        candidates?: Array<{
          content?: {
            parts?: Array<{
              inlineData?: { data?: string; mimeType?: string };
            }>;
          };
        }>;
      }).candidates;

      const parts = candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        if (part.inlineData?.data) {
          yield decodeBase64ToArrayBuffer(part.inlineData.data);
        }
      }
    }
  }

  async summarizeHistory(params: {
    existingSummary?: string;
    turns: HistoryTurn[];
    settings: AppSettings;
  }): Promise<string> {
    const model = getGenerativeModel(this.ai, {
      model: params.settings.fastModel,
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 300,
      },
    });

    const prompt = [
      '请将以下对话压缩为 150 字以内的简体中文要点摘要，保留用户偏好、已讨论的关键事实和未完成意图：',
      params.existingSummary ? `已有摘要：${params.existingSummary}` : '',
      params.turns.map((t) => `${t.role === 'user' ? '用户' : '助手'}：${t.text}`).join('\n'),
    ]
      .filter(Boolean)
      .join('\n\n');

    const res = await model.generateContent(prompt);
    return res.response.text().trim();
  }
}

export function deriveApiBaseUrl(wsUrl: string): string {
  try {
    const parsed = new URL(wsUrl);
    const protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
    return `${protocol}//${parsed.host}`;
  } catch {
    return 'http://localhost:8081';
  }
}

async function* readNdjsonLines<T>(
  response: Response,
  signal?: AbortSignal
): AsyncGenerator<T> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) {
          yield JSON.parse(line) as T;
        }
        nl = buffer.indexOf('\n');
      }
    }
    const tail = buffer.trim();
    if (tail && !signal?.aborted) {
      yield JSON.parse(tail) as T;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

/**
 * Calls our Cloud Run Vertex AI API endpoints directly via GCP ADC (authenticated
 * with Firebase Auth ID token). Avoids requiring Firebase AI Logic console provisioning.
 */
export class VertexProxyGeminiService implements GeminiPipelineService {
  private readonly baseUrl: string;
  private readonly getIdToken: () => Promise<string | undefined>;

  constructor(baseUrl: string, getIdToken: () => Promise<string | undefined>) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.getIdToken = getIdToken;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.getIdToken();
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  async warmUp(): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/health`, { method: 'GET' });
    } catch {
      // non-fatal warm-up ping
    }
  }

  async draftFastOpeningSentence(params: {
    history: HistoryTurn[];
    rollingSummary?: string;
    userText: string;
    openingStyle?: 'short' | 'medium';
    settings: AppSettings;
    signal: AbortSignal;
  }): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/fast-opening`, {
      method: 'POST',
      headers: await this.authHeaders(),
      body: JSON.stringify({
        model: params.settings.fastModel,
        history: params.history,
        rollingSummary: params.rollingSummary,
        userText: params.userText,
        openingStyle: params.openingStyle ?? 'medium',
      }),
      signal: params.signal,
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Vertex fast-opening HTTP ${res.status}: ${errText}`);
    }
    const data = (await res.json()) as { text?: string };
    return (data.text || '').trim();
  }

  async *streamGroundedContinuation(params: {
    history: HistoryTurn[];
    rollingSummary?: string;
    userText: string;
    openingSentence: string;
    settings: AppSettings;
    signal: AbortSignal;
  }): AsyncGenerator<GroundedStreamChunk> {
    const res = await fetch(`${this.baseUrl}/api/grounded-stream`, {
      method: 'POST',
      headers: await this.authHeaders(),
      body: JSON.stringify({
        model: params.settings.mainModel,
        thinkingLevel: params.settings.thinkingLevel,
        history: params.history,
        rollingSummary: params.rollingSummary,
        userText: params.userText,
        openingSentence: params.openingSentence,
      }),
      signal: params.signal,
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Vertex grounded-stream HTTP ${res.status}: ${errText}`);
    }

    for await (const chunk of readNdjsonLines<GroundedStreamChunk>(res, params.signal)) {
      if (params.signal.aborted) return;
      yield chunk;
    }
  }

  async *streamSpeechPcm(params: {
    text: string;
    settings: AppSettings;
    signal: AbortSignal;
  }): AsyncGenerator<ArrayBuffer> {
    if (!params.text.trim()) return;
    const languageCode = params.settings.sttLanguage === 'en-US' ? 'en-US' : 'zh-CN';
    const res = await fetch(`${this.baseUrl}/api/tts-stream`, {
      method: 'POST',
      headers: await this.authHeaders(),
      body: JSON.stringify({
        model: params.settings.ttsModel,
        text: params.text,
        voiceName: params.settings.ttsVoice,
        languageCode,
      }),
      signal: params.signal,
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Vertex tts-stream HTTP ${res.status}: ${errText}`);
    }

    for await (const item of readNdjsonLines<{ pcmBase64?: string }>(res, params.signal)) {
      if (params.signal.aborted) return;
      if (item.pcmBase64) {
        yield decodeBase64ToArrayBuffer(item.pcmBase64);
      }
    }
  }

  async summarizeHistory(params: {
    existingSummary?: string;
    turns: HistoryTurn[];
    settings: AppSettings;
  }): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/summarize`, {
      method: 'POST',
      headers: await this.authHeaders(),
      body: JSON.stringify({
        model: params.settings.fastModel,
        existingSummary: params.existingSummary,
        turns: params.turns,
      }),
    });
    if (!res.ok) return params.existingSummary || '';
    const data = (await res.json()) as { summary?: string };
    return (data.summary || '').trim();
  }
}
