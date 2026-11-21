import { GoogleGenAI } from '@google/genai';
import type { ServerEventMessage, TranscribeMode } from './types.js';

export interface LiveSessionLike {
  sendRealtimeInput(input: {
    audio?: { data: string; mimeType: string };
    audioStreamEnd?: boolean;
  }): void;
  close(): void;
}

export interface LiveConnectCallbacks {
  onopen?: () => void;
  onmessage?: (message: Record<string, unknown>) => void;
  onerror?: (error: unknown) => void;
  onclose?: (event: unknown) => void;
}

export type LiveConnector = (params: {
  model: string;
  config: Record<string, unknown>;
  callbacks: LiveConnectCallbacks;
}) => Promise<LiveSessionLike>;

export interface TranscribeSessionOptions {
  apiKey?: string;
  model?: string;
  languageCodes?: string[];
  mode?: TranscribeMode;
  sampleRate?: number;
  connector?: LiveConnector;
  onEvent: (event: ServerEventMessage) => void;
}

const MAX_PENDING_CHUNKS = 30;

export class GeminiTranscribeSession {
  private readonly model: string;
  private readonly languageCodes: string[];
  private readonly mode: TranscribeMode;
  private readonly sampleRate: number;
  private readonly apiKey?: string;
  private readonly connector?: LiveConnector;
  private readonly onEvent: (event: ServerEventMessage) => void;

  private liveSession: LiveSessionLike | null = null;
  private isSetupComplete = false;
  private isClosed = false;
  private pendingAudioChunks: Buffer[] = [];
  private lastInterimText = '';

  constructor(options: TranscribeSessionOptions) {
    this.apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;
    this.model = options.model ?? process.env.STT_MODEL ?? 'gemini-3.5-transcribe-live';
    this.languageCodes = options.languageCodes ?? ['zh-CN'];
    this.mode = options.mode ?? 'VERBATIM';
    this.sampleRate = options.sampleRate ?? 16000;
    this.connector = options.connector;
    this.onEvent = options.onEvent;
  }

  async start(): Promise<void> {
    const config: Record<string, unknown> = {
      responseModalities: ['TEXT'],
      inputAudioTranscription: {
        mode: this.mode,
        ...(this.languageCodes.length > 0 ? { languageCodes: this.languageCodes } : {}),
      },
    };

    const callbacks: LiveConnectCallbacks = {
      onmessage: (msg) => this.handleServerMessage(msg),
      onerror: (err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.onEvent({ type: 'error', code: 'LIVE_API_ERROR', message, ts: Date.now() });
      },
      onclose: () => {
        this.isSetupComplete = false;
        this.liveSession = null;
      },
    };

    if (this.connector) {
      this.liveSession = await this.connector({
        model: this.model,
        config,
        callbacks,
      });
      return;
    }

    const useVertex = (process.env.USE_VERTEX_AI ?? 'true').toLowerCase() !== 'false';
    const project = process.env.GOOGLE_CLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID;
    const location = process.env.VERTEX_LOCATION || 'global';

    let ai: GoogleGenAI;
    if (useVertex && project) {
      ai = new GoogleGenAI({
        vertexai: true,
        project,
        location,
      });
    } else if (this.apiKey) {
      ai = new GoogleGenAI({ apiKey: this.apiKey });
    } else {
      throw new Error(
        'Vertex AI requires GOOGLE_CLOUD_PROJECT (with ADC), or set USE_VERTEX_AI=false with GEMINI_API_KEY'
      );
    }

    // @google/genai live.connect types evolve alongside preview fields like inputAudioTranscription.mode
    this.liveSession = (await ai.live.connect({
      model: this.model,
      config: config as never,
      callbacks: callbacks as never,
    })) as unknown as LiveSessionLike;
  }

  sendAudioChunk(pcmChunk: Buffer): void {
    if (this.isClosed) return;
    if (!this.isSetupComplete || !this.liveSession) {
      if (this.pendingAudioChunks.length >= MAX_PENDING_CHUNKS) {
        this.pendingAudioChunks.shift();
      }
      this.pendingAudioChunks.push(pcmChunk);
      return;
    }

    this.forwardChunk(pcmChunk);
  }

  sendAudioStreamEnd(): void {
    if (this.isClosed || !this.isSetupComplete || !this.liveSession) return;
    this.liveSession.sendRealtimeInput({ audioStreamEnd: true });
    this.onEvent({ type: 'vad', event: 'SPEECH_ACTIVITY_END', ts: Date.now() });
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.pendingAudioChunks = [];
    this.isSetupComplete = false;
    try {
      this.liveSession?.close();
    } catch {
      // ignore close errors
    }
    this.liveSession = null;
  }

  private forwardChunk(pcmChunk: Buffer): void {
    if (!this.liveSession) return;
    this.liveSession.sendRealtimeInput({
      audio: {
        data: pcmChunk.toString('base64'),
        mimeType: `audio/pcm;rate=${this.sampleRate}`,
      },
    });
  }

  private flushPendingChunks(): void {
    while (this.pendingAudioChunks.length > 0 && this.isSetupComplete && !this.isClosed) {
      const chunk = this.pendingAudioChunks.shift();
      if (chunk) this.forwardChunk(chunk);
    }
  }

  private handleServerMessage(msg: Record<string, unknown>): void {
    if (this.isClosed) return;

    // Wait for setupComplete before streaming buffered audio frames
    if ('setupComplete' in msg && msg.setupComplete !== undefined) {
      this.isSetupComplete = true;
      this.onEvent({
        type: 'ready',
        model: this.model,
        languageCodes: this.languageCodes,
        mode: this.mode,
      });
      this.flushPendingChunks();
      return;
    }

    const serverContent = msg.serverContent as Record<string, unknown> | undefined;
    if (!serverContent) return;

    const interim = serverContent.interimInputTranscription as { text?: string } | undefined;
    if (interim?.text && interim.text.trim().length > 0) {
      this.lastInterimText = interim.text.trim();
      this.onEvent({
        type: 'interim',
        text: interim.text,
        ts: Date.now(),
      });
    }

    const finalTranscript = serverContent.inputTranscription as { text?: string } | undefined;
    if (finalTranscript?.text !== undefined) {
      const trimmed = finalTranscript.text.trim();
      this.lastInterimText = '';
      if (trimmed.length > 0) {
        this.onEvent({
          type: 'final',
          text: trimmed,
          ts: Date.now(),
        });
      }
      return;
    }

    if (serverContent.turnComplete && this.lastInterimText) {
      const finalized = this.lastInterimText;
      this.lastInterimText = '';
      this.onEvent({
        type: 'final',
        text: finalized,
        ts: Date.now(),
      });
    }
  }
}
