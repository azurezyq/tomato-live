import type { TranscribeMode } from '../types/chat';

export interface SttClientCallbacks {
  onReady?: () => void;
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  onVad?: (event: 'SPEECH_ACTIVITY_BEGIN' | 'SPEECH_ACTIVITY_END') => void;
  onError: (message: string) => void;
  onClose?: () => void;
}

export interface SttConnectOptions {
  wsUrl: string;
  idToken?: string;
  model: string;
  languageCodes: string[];
  mode: TranscribeMode;
  sampleRate?: number;
}

export interface SttClientAdapter {
  connect(options: SttConnectOptions, callbacks: SttClientCallbacks): Promise<void>;
  sendAudio(pcm: ArrayBuffer): void;
  sendAudioStreamEnd(): void;
  disconnect(): void;
}

/**
 * WebSocket STT client connecting to services/stt-proxy (gemini-3.5-transcribe-live).
 */
export class ProxySttClient implements SttClientAdapter {
  private ws: WebSocket | null = null;
  private isReady = false;

  async connect(options: SttConnectOptions, callbacks: SttClientCallbacks): Promise<void> {
    this.disconnect();

    const url = new URL(options.wsUrl);
    if (options.idToken) {
      url.searchParams.set('token', options.idToken);
    }

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url.toString());
      this.ws = ws;

      const timeout = setTimeout(() => {
        reject(new Error('STT WebSocket connection timed out'));
      }, 10000);

      ws.onopen = () => {
        clearTimeout(timeout);
        ws.send(
          JSON.stringify({
            type: 'config',
            model: options.model,
            languageCodes: options.languageCodes,
            mode: options.mode,
            sampleRate: options.sampleRate ?? 16000,
          })
        );
        resolve();
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        callbacks.onError('STT WebSocket connection error');
        reject(new Error('STT WebSocket connection error'));
      };

      ws.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        try {
          const msg = JSON.parse(event.data) as {
            type: string;
            text?: string;
            event?: 'SPEECH_ACTIVITY_BEGIN' | 'SPEECH_ACTIVITY_END';
            message?: string;
          };
          if (msg.type === 'ready') {
            this.isReady = true;
            callbacks.onReady?.();
          } else if (msg.type === 'interim' && msg.text) {
            callbacks.onInterim(msg.text);
          } else if (msg.type === 'final' && msg.text) {
            callbacks.onFinal(msg.text);
          } else if (msg.type === 'vad' && msg.event) {
            callbacks.onVad?.(msg.event);
          } else if (msg.type === 'error') {
            callbacks.onError(msg.message || 'STT proxy error');
          }
        } catch {
          // ignore malformed JSON
        }
      };

      ws.onclose = () => {
        this.isReady = false;
        callbacks.onClose?.();
      };
    });
  }

  sendAudio(pcm: ArrayBuffer): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(pcm);
    }
  }

  sendAudioStreamEnd(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.isReady) {
      this.ws.send(JSON.stringify({ type: 'audio_stream_end' }));
    }
  }

  disconnect(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.isReady = false;
  }
}

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

/**
 * Browser Web Speech API fallback (zh-CN) for quick local testing without running stt-proxy.
 */
export class WebSpeechSttClient implements SttClientAdapter {
  private recognition: SpeechRecognitionLike | null = null;
  private active = false;

  async connect(options: SttConnectOptions, callbacks: SttClientCallbacks): Promise<void> {
    this.disconnect();
    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) {
      throw new Error('当前浏览器不支持 Web Speech API，请切换到 STT Proxy 模式。');
    }

    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = options.languageCodes[0] || 'zh-CN';
    this.recognition = rec;
    this.active = true;

    rec.onresult = (event) => {
      let interimText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const text = res[0]?.transcript?.trim() || '';
        if (!text) continue;
        if (res.isFinal) {
          callbacks.onFinal(text);
        } else {
          interimText += text;
        }
      }
      if (interimText) {
        callbacks.onInterim(interimText);
      }
    };

    rec.onerror = (e) => {
      if (e.error !== 'no-speech' && e.error !== 'aborted') {
        callbacks.onError(`Web Speech error: ${e.error}`);
      }
    };

    rec.onend = () => {
      if (this.active && this.recognition) {
        try {
          this.recognition.start();
        } catch {
          // ignore restart race
        }
      }
    };

    rec.start();
    callbacks.onReady?.();
  }

  sendAudio(): void {
    // Web Speech API captures mic directly
  }

  sendAudioStreamEnd(): void {
    // handled natively by Web Speech API
  }

  disconnect(): void {
    this.active = false;
    try {
      this.recognition?.stop();
    } catch {
      // ignore
    }
    this.recognition = null;
  }
}
