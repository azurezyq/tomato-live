export type TranscribeMode = 'VERBATIM' | 'SMART';

export interface ClientConfigMessage {
  type: 'config';
  languageCodes?: string[];
  mode?: TranscribeMode;
  sampleRate?: number;
  model?: string;
}

export interface ClientAudioEndMessage {
  type: 'audio_stream_end';
}

export interface ClientPingMessage {
  type: 'ping';
  ts: number;
}

export type ClientControlMessage =
  | ClientConfigMessage
  | ClientAudioEndMessage
  | ClientPingMessage;

export type ServerEventMessage =
  | { type: 'ready'; model: string; languageCodes: string[]; mode: TranscribeMode }
  | { type: 'interim'; text: string; ts: number }
  | { type: 'final'; text: string; ts: number }
  | { type: 'vad'; event: 'SPEECH_ACTIVITY_BEGIN' | 'SPEECH_ACTIVITY_END'; ts: number }
  | { type: 'pong'; ts: number }
  | { type: 'error'; code: string; message: string; ts: number };
