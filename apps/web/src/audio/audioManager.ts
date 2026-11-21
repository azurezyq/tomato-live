import type { SegmentProgress } from '../types/chat';

export interface PlaybackProgressEvent {
  reason: 'tick' | 'flushed' | 'drained';
  activeSegmentId: string | null;
  bufferedMs: number;
  gain: number;
  isFlushing: boolean;
  segments: Array<{
    segmentId: string;
    samplesPlayed: number;
    totalSamples: number;
  }>;
}

export interface AudioPlaybackAdapter {
  init(): Promise<void>;
  enqueue(segmentId: string, pcm: ArrayBuffer): void;
  duck(gain?: number): void;
  unduck(): void;
  flush(): Promise<PlaybackProgressEvent>;
  reset(): void;
  getLastProgress(): PlaybackProgressEvent;
  onProgress(cb: (evt: PlaybackProgressEvent) => void): () => void;
  dispose(): Promise<void>;
}

export interface MicCaptureAdapter {
  start(onFrame: (pcm: ArrayBuffer, rms: number) => void): Promise<void>;
  stop(): Promise<void>;
}

export class WebAudioPlayback implements AudioPlaybackAdapter {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private listeners = new Set<(evt: PlaybackProgressEvent) => void>();
  private flushResolver: ((evt: PlaybackProgressEvent) => void) | null = null;
  private lastProgress: PlaybackProgressEvent = {
    reason: 'tick',
    activeSegmentId: null,
    bufferedMs: 0,
    gain: 1,
    isFlushing: false,
    segments: [],
  };

  async init(): Promise<void> {
    if (this.ctx && this.node) {
      if (this.ctx.state === 'suspended') {
        await this.ctx.resume();
      }
      return;
    }

    // Gemini TTS streaming outputs 24 kHz 16-bit mono PCM
    this.ctx = new AudioContext({ sampleRate: 24000 });
    await this.ctx.audioWorklet.addModule('/worklets/pcm-playback-processor.js');
    this.node = new AudioWorkletNode(this.ctx, 'pcm-playback-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    this.node.connect(this.ctx.destination);

    this.node.port.onmessage = (event: MessageEvent<PlaybackProgressEvent>) => {
      const msg = event.data;
      if (!msg) return;
      this.lastProgress = msg;
      if (msg.reason === 'flushed' && this.flushResolver) {
        const resolve = this.flushResolver;
        this.flushResolver = null;
        resolve(msg);
      }
      for (const cb of this.listeners) {
        cb(msg);
      }
    };

    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
  }

  enqueue(segmentId: string, pcm: ArrayBuffer): void {
    if (!this.node) return;
    const copy = pcm.slice(0);
    this.node.port.postMessage({ type: 'enqueue', segmentId, pcm: copy }, [copy]);
  }

  duck(gain = 0.25): void {
    this.node?.port.postMessage({ type: 'duck', gain });
  }

  unduck(): void {
    this.node?.port.postMessage({ type: 'unduck' });
  }

  flush(): Promise<PlaybackProgressEvent> {
    if (!this.node) {
      return Promise.resolve(this.lastProgress);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.flushResolver) {
          this.flushResolver = null;
          resolve(this.lastProgress);
        }
      }, 120);

      this.flushResolver = (evt) => {
        clearTimeout(timer);
        resolve(evt);
      };
      this.node?.port.postMessage({ type: 'flush' });
    });
  }

  reset(): void {
    this.node?.port.postMessage({ type: 'reset' });
    this.lastProgress = {
      reason: 'tick',
      activeSegmentId: null,
      bufferedMs: 0,
      gain: 1,
      isFlushing: false,
      segments: [],
    };
  }

  getLastProgress(): PlaybackProgressEvent {
    return this.lastProgress;
  }

  onProgress(cb: (evt: PlaybackProgressEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async dispose(): Promise<void> {
    this.node?.disconnect();
    this.node = null;
    if (this.ctx) {
      await this.ctx.close();
      this.ctx = null;
    }
  }
}

export class WebMicCapture implements MicCaptureAdapter {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;

  async start(onFrame: (pcm: ArrayBuffer, rms: number) => void): Promise<void> {
    await this.stop();

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });

    this.ctx = new AudioContext();
    await this.ctx.audioWorklet.addModule('/worklets/mic-capture-processor.js');
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'mic-capture-processor', {
      processorOptions: { targetSampleRate: 16000 },
    });

    this.node.port.onmessage = (event: MessageEvent<{ type: string; pcm: ArrayBuffer; rms: number }>) => {
      if (event.data?.type === 'audio') {
        onFrame(event.data.pcm, event.data.rms);
      }
    };

    // Connect through a muted gain node so the worklet runs without playing mic back to speakers
    const silentGain = this.ctx.createGain();
    silentGain.gain.value = 0;
    this.source.connect(this.node);
    this.node.connect(silentGain);
    silentGain.connect(this.ctx.destination);
  }

  async stop(): Promise<void> {
    this.source?.disconnect();
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.source = null;
    this.node = null;
    this.stream = null;
    if (this.ctx) {
      await this.ctx.close();
      this.ctx = null;
    }
  }
}

export function mergeSegmentProgress(
  registered: Array<{ segmentId: string; text: string; stage: 'fast' | 'grounded' }>,
  evt: PlaybackProgressEvent
): SegmentProgress[] {
  const byId = new Map(evt.segments.map((s) => [s.segmentId, s]));
  return registered.map((reg) => {
    const stats = byId.get(reg.segmentId);
    return {
      segmentId: reg.segmentId,
      text: reg.text,
      stage: reg.stage,
      samplesPlayed: stats?.samplesPlayed ?? 0,
      totalSamples: stats?.totalSamples ?? 0,
    };
  });
}
