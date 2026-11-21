export type EngineState =
  | 'IDLE'
  | 'WARMING'
  | 'CONNECTING'
  | 'LISTENING'
  | 'THINKING_FAST'
  | 'SPEAKING_FAST'
  | 'SPEAKING_GROUNDED'
  | 'INTERRUPTED'
  | 'ERROR';

export type ThinkingLevel = 'low' | 'medium' | 'high' | 'xhigh';
export type TranscribeMode = 'VERBATIM' | 'SMART';
export type SttProviderMode = 'proxy' | 'webspeech' | 'manual';
export type UiLocale = 'zh-CN' | 'en';

export interface GroundingSource {
  title: string;
  url: string;
}

export interface GroundingMetadataSnapshot {
  searchQueries: string[];
  sources: GroundingSource[];
}

export interface TurnLatencyMetrics {
  turnId: number;
  userText: string;
  startedAt: number;
  sttFinalizeMs?: number;
  fastDraftMs?: number;
  ttsFirstAudioMs?: number;
  groundedFirstTokenMs?: number;
  groundedCompleteMs?: number;
  handoffGapMs?: number;
  bargeInStopMs?: number;
  interrupted?: boolean;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  /** Text actually heard/spoken (committed to LLM context) */
  spokenText: string;
  /** Full text generated before any interruption (unspoken tail shown dimmed in UI) */
  fullGeneratedText: string;
  /** Fast opening sentence S1 drafted by gemini-3.5-flash-lite */
  fastOpening?: string;
  interrupted?: boolean;
  groundingSources?: GroundingSource[];
  searchQueries?: string[];
  latencyMetrics?: TurnLatencyMetrics;
  createdAt: number;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  rollingSummary?: string;
}

export interface AppSettings {
  locale: UiLocale;
  sttProvider: SttProviderMode;
  sttModel: string;
  sttLanguage: 'zh-CN' | 'auto' | 'en-US';
  sttMode: TranscribeMode;
  fastModel: string;
  mainModel: string;
  thinkingLevel: ThinkingLevel;
  ttsModel: string;
  ttsVoice: string;
  vadSilenceMs: number;
  vadRmsThreshold: number;
  bargeInEnabled: boolean;
  bargeInDuckGain: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  locale: 'zh-CN',
  sttProvider: 'proxy',
  sttModel: import.meta.env.VITE_STT_MODEL || 'gemini-3.5-transcribe-live',
  sttLanguage: 'zh-CN',
  sttMode: 'VERBATIM',
  fastModel: import.meta.env.VITE_FAST_MODEL || 'gemini-3.5-flash-lite',
  mainModel: import.meta.env.VITE_MAIN_MODEL || 'gemini-4-hydrogen',
  thinkingLevel: 'low',
  ttsModel: import.meta.env.VITE_TTS_MODEL || 'gemini-3.8-flash-lite-tts',
  ttsVoice: 'Kore',
  vadSilenceMs: 550,
  vadRmsThreshold: 0.022,
  bargeInEnabled: true,
  bargeInDuckGain: 0.25,
};

export interface SegmentProgress {
  segmentId: string;
  text: string;
  stage: 'fast' | 'grounded';
  samplesPlayed: number;
  totalSamples: number;
}

export interface AudioTelemetrySnapshot {
  micRms: number;
  vadActive: boolean;
  bufferedMs: number;
  gain: number;
  isFlushing: boolean;
  activeSegmentId: string | null;
  segments: SegmentProgress[];
}

export type DebugCategory =
  | 'STT'
  | 'VAD'
  | 'AUDIO'
  | 'LLM'
  | 'TTS'
  | 'CONTEXT'
  | 'STATE'
  | 'ERROR';

export interface DebugEvent {
  id: number;
  ts: number;
  category: DebugCategory;
  message: string;
  payload?: unknown;
}
