import type {
  AudioTelemetrySnapshot,
  DebugCategory,
  DebugEvent,
  GroundingMetadataSnapshot,
  TurnLatencyMetrics,
} from '../types/chat';

export interface ContextSnapshot {
  rollingSummary: string;
  history: Array<{ role: 'user' | 'model'; text: string; interrupted?: boolean }>;
  lastFastPromptUserText?: string;
  lastOpeningSentence?: string;
  lastGrounding?: GroundingMetadataSnapshot;
}

export interface DebugSnapshot {
  events: DebugEvent[];
  latencies: TurnLatencyMetrics[];
  audio: AudioTelemetrySnapshot;
  context: ContextSnapshot;
}

const MAX_EVENTS = 400;
const MAX_LATENCIES = 40;

export class DebugStore {
  private events: DebugEvent[] = [];
  private latencies: TurnLatencyMetrics[] = [];
  private nextEventId = 1;
  private listeners = new Set<() => void>();

  private audio: AudioTelemetrySnapshot = {
    micRms: 0,
    vadActive: false,
    bufferedMs: 0,
    gain: 1,
    isFlushing: false,
    activeSegmentId: null,
    segments: [],
  };

  private context: ContextSnapshot = {
    rollingSummary: '',
    history: [],
  };

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  log(category: DebugCategory, message: string, payload?: unknown): void {
    const event: DebugEvent = {
      id: this.nextEventId++,
      ts: Date.now(),
      category,
      message,
      payload,
    };
    this.events = [...this.events.slice(-(MAX_EVENTS - 1)), event];
    this.notify();
  }

  upsertLatency(metrics: TurnLatencyMetrics): void {
    const idx = this.latencies.findIndex((m) => m.turnId === metrics.turnId);
    if (idx >= 0) {
      const next = [...this.latencies];
      next[idx] = { ...next[idx], ...metrics };
      this.latencies = next;
    } else {
      this.latencies = [...this.latencies.slice(-(MAX_LATENCIES - 1)), metrics];
    }
    this.notify();
  }

  updateAudio(partial: Partial<AudioTelemetrySnapshot>): void {
    this.audio = { ...this.audio, ...partial };
    this.notify();
  }

  updateContext(partial: Partial<ContextSnapshot>): void {
    this.context = { ...this.context, ...partial };
    this.notify();
  }

  clearEvents(): void {
    this.events = [];
    this.notify();
  }

  getSnapshot(): DebugSnapshot {
    return {
      events: this.events,
      latencies: this.latencies,
      audio: this.audio,
      context: this.context,
    };
  }

  exportJson(): string {
    return JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        ...this.getSnapshot(),
      },
      null,
      2
    );
  }
}

export const debugStore = new DebugStore();
