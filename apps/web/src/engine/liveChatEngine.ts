import {
  mergeSegmentProgress,
  type AudioPlaybackAdapter,
  type MicCaptureAdapter,
  type PlaybackProgressEvent,
} from '../audio/audioManager';
import type { GeminiPipelineService, HistoryTurn } from '../services/geminiService';
import type { SttClientAdapter } from '../services/sttClient';
import type {
  AppSettings,
  ChatMessage,
  EngineState,
  GroundingMetadataSnapshot,
  TurnLatencyMetrics,
} from '../types/chat';
import { DebugStore, debugStore as defaultDebugStore } from './debugStore';
import {
  computeSpokenTruncation,
  SentenceChunker,
  stripDuplicatePrefix,
} from './sentenceChunker';
import {
  computeSemanticSilenceMs,
  isBackchannelUtterance,
  isEchoOfAssistantSpeech,
  isExplicitStopCue,
  isReadyForSpeculativeDraft,
  isSpeculativeTranscriptMatch,
  pickOpeningLengthStyle,
  sanitizeFastOpening,
} from './turnHeuristics';

export interface LiveDraftState {
  turnId: number;
  fastOpening: string;
  groundedContinuation: string;
  grounding?: GroundingMetadataSnapshot;
}

export interface LiveChatEngineCallbacks {
  onStateChange: (state: EngineState) => void;
  onInterimTranscript: (text: string) => void;
  onDraftChange: (draft: LiveDraftState | null) => void;
  onCommitMessage: (message: ChatMessage) => void;
  onUpdateRollingSummary?: (summary: string) => void;
  onError?: (message: string) => void;
}

export interface LiveChatEngineDeps {
  gemini: GeminiPipelineService;
  playback: AudioPlaybackAdapter;
  mic: MicCaptureAdapter;
  stt: SttClientAdapter;
  debug?: DebugStore;
  utteranceCoalesceMs?: number;
  duckConfirmTimeoutMs?: number;
  speculativeDebounceMs?: number;
  playbackGraceMs?: number;
}

interface RegisteredSegment {
  segmentId: string;
  text: string;
  stage: 'fast' | 'grounded';
}

interface SpeculativeDraft {
  sourceText: string;
  abortController: AbortController;
  promise: Promise<string>;
  startedAt: number;
}

const CJK_CHAR_RE = /[\u3400-\u9FFF\uF900-\uFAFF]/;
const ACTIVE_HISTORY_WINDOW = 16;

function isSubstantiveInterim(text: string): boolean {
  const cleaned = text.trim();
  if (!cleaned) return false;
  if (isExplicitStopCue(cleaned)) return true;
  if (CJK_CHAR_RE.test(cleaned)) return cleaned.length >= 2;
  return cleaned.length >= 3;
}

export class LiveChatEngine {
  private readonly gemini: GeminiPipelineService;
  private readonly playback: AudioPlaybackAdapter;
  private readonly mic: MicCaptureAdapter;
  private stt: SttClientAdapter;
  private readonly debug: DebugStore;
  private readonly callbacks: LiveChatEngineCallbacks;
  private readonly utteranceCoalesceMs: number;
  private readonly duckConfirmTimeoutMs: number;
  private readonly speculativeDebounceMs: number;
  private readonly playbackGraceMs: number;

  private state: EngineState = 'IDLE';
  private settings: AppSettings;
  private history: ChatMessage[] = [];
  private rollingSummary = '';

  private activeTurnId = 0;
  private turnAbortController: AbortController | null = null;
  private activeSegments: RegisteredSegment[] = [];
  private currentDraft: LiveDraftState | null = null;
  private currentMetrics: TurnLatencyMetrics | null = null;
  private turnCommitted = false;
  private playbackStartedAt = 0;

  // Utterance coalescing, speculative pre-execution & Hybrid VAD timers
  private pendingFinalParts: string[] = [];
  private latestInterimText = '';
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  private duckTimer: ReturnType<typeof setTimeout> | null = null;
  private speculativeTimer: ReturnType<typeof setTimeout> | null = null;
  private speculativeDraft: SpeculativeDraft | null = null;
  private isDucked = false;

  // Local VAD state
  private vadSpeechActive = false;
  private vadConsecutiveSpeechFrames = 0;
  private vadSilenceStartedAt: number | null = null;
  private lastSpeechEndTs: number | null = null;
  private unsubPlaybackProgress: (() => void) | null = null;

  constructor(
    deps: LiveChatEngineDeps,
    settings: AppSettings,
    callbacks: LiveChatEngineCallbacks
  ) {
    this.gemini = deps.gemini;
    this.playback = deps.playback;
    this.mic = deps.mic;
    this.stt = deps.stt;
    this.debug = deps.debug ?? defaultDebugStore;
    this.settings = settings;
    this.callbacks = callbacks;
    this.utteranceCoalesceMs = deps.utteranceCoalesceMs ?? 400;
    this.duckConfirmTimeoutMs = deps.duckConfirmTimeoutMs ?? 350;
    this.speculativeDebounceMs = deps.speculativeDebounceMs ?? 250;
    this.playbackGraceMs = deps.playbackGraceMs ?? 350;
  }

  getState(): EngineState {
    return this.state;
  }

  updateSettings(next: AppSettings): void {
    this.settings = next;
  }

  setSttAdapter(next: SttClientAdapter): void {
    this.stt = next;
  }

  loadSessionHistory(messages: ChatMessage[], rollingSummary = ''): void {
    this.history = [...messages];
    this.rollingSummary = rollingSummary;
    this.syncDebugContext();
  }

  async startVoiceSession(connectOptions: { wsUrl: string; idToken?: string }): Promise<void> {
    this.debug.log('STATE', 'Starting live voice session', {
      sttProvider: this.settings.sttProvider,
      sttModel: this.settings.sttModel,
      mainModel: this.settings.mainModel,
    });

    try {
      // Zero-cost Cloud Run warm-up ping with user-visible WARMING indicator
      if (this.gemini.warmUp) {
        this.setState('WARMING');
        const warmStart = Date.now();
        await this.gemini.warmUp();
        this.debug.log('STATE', 'Cloud Run warm-up complete', { ms: Date.now() - warmStart });
      }

      this.setState('CONNECTING');
      await this.playback.init();
      this.unsubPlaybackProgress?.();
      this.unsubPlaybackProgress = this.playback.onProgress((evt) =>
        this.handlePlaybackProgress(evt)
      );

      if (this.settings.sttProvider !== 'manual') {
        const languageCodes =
          this.settings.sttLanguage === 'auto' ? [] : [this.settings.sttLanguage];
        await this.stt.connect(
          {
            wsUrl: connectOptions.wsUrl,
            idToken: connectOptions.idToken,
            model: this.settings.sttModel,
            languageCodes,
            mode: this.settings.sttMode,
            sampleRate: 16000,
          },
          {
            onReady: () => {
              this.debug.log('STT', 'STT stream ready', {
                model: this.settings.sttModel,
                languageCodes,
                mode: this.settings.sttMode,
              });
            },
            onInterim: (text) => this.handleSttInterim(text),
            onFinal: (text) => this.handleSttFinal(text),
            onVad: (event) => this.handleServerVad(event),
            onError: (msg) => {
              this.debug.log('ERROR', `STT error: ${msg}`);
              this.callbacks.onError?.(msg);
            },
            onClose: () => {
              this.debug.log('STT', 'STT connection closed');
            },
          }
        );

        if (this.settings.sttProvider === 'proxy') {
          await this.mic.start((pcm, rms) => this.handleMicFrame(pcm, rms));
        }
      }

      this.setState('LISTENING');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.debug.log('ERROR', 'Failed to start voice session', { message: msg });
      this.setState('ERROR');
      this.callbacks.onError?.(msg);
      throw err;
    }
  }

  async stopVoiceSession(): Promise<void> {
    this.clearTimers();
    this.cancelSpeculativeDraft();
    this.abortCurrentTurnInternal();
    await this.mic.stop();
    this.stt.disconnect();
    this.playback.reset();
    this.unsubPlaybackProgress?.();
    this.unsubPlaybackProgress = null;
    this.latestInterimText = '';
    this.callbacks.onInterimTranscript('');
    this.callbacks.onDraftChange(null);
    this.setState('IDLE');
  }

  /**
   * Debug / text-fallback entry point: injects a user utterance directly into the
   * dual-model pipeline (triggering barge-in first if assistant is currently speaking).
   */
  async injectUtterance(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;

    await this.playback.init();
    if (!this.unsubPlaybackProgress) {
      this.unsubPlaybackProgress = this.playback.onProgress((evt) =>
        this.handlePlaybackProgress(evt)
      );
    }

    if (this.isAssistantBusy()) {
      await this.executeBargeIn('manual_inject');
    }

    this.debug.log('STT', 'Injected utterance', { text: trimmed });
    await this.runAssistantTurn(trimmed);
  }

  /**
   * Debug simulator: triggers an immediate barge-in at the exact current audio sample.
   */
  async simulateBargeIn(): Promise<void> {
    if (!this.isAssistantBusy()) {
      this.debug.log('AUDIO', 'Simulate barge-in ignored (assistant not active)');
      return;
    }
    await this.executeBargeIn('debug_simulate');
  }

  /**
   * Exposed for tests and external VAD triggers.
   */
  handleSttInterim(text: string): void {
    this.latestInterimText = text;
    this.debug.log('STT', 'Interim transcript', { text });
    this.callbacks.onInterimTranscript(text);

    if (this.isAssistantBusy()) {
      if (!this.settings.bargeInEnabled) return;

      const assistantSpoken = this.getCurrentAssistantText();
      const explicitStop = isExplicitStopCue(text);

      // 1) Backchannel filter ("嗯", "好的", "对", "明白")
      // 2) Speakerphone acoustic echo filter (mic picking up assistant's own TTS)
      // 3) AEC convergence grace window (first 350ms of playback unless explicit stop cue)
      if (
        isBackchannelUtterance(text) ||
        isEchoOfAssistantSpeech(text, assistantSpoken) ||
        (!explicitStop &&
          this.playbackStartedAt > 0 &&
          Date.now() - this.playbackStartedAt < this.playbackGraceMs)
      ) {
        this.debug.log('AUDIO', 'Ignored backchannel / speakerphone echo during playback', {
          text,
        });
        this.restoreDuckIfNeeded();
        return;
      }

      if (isSubstantiveInterim(text)) {
        void this.executeBargeIn('interim_confirmed');
      }
      return;
    }

    // #3 Speculative S1 pre-execution on stable partial ASR during LISTENING
    if (this.state === 'LISTENING' && isReadyForSpeculativeDraft(text)) {
      this.scheduleSpeculativeDraft(text);
    }
  }

  handleSttFinal(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;

    this.latestInterimText = '';
    this.debug.log('STT', 'Final transcript', { text: trimmed });
    this.callbacks.onInterimTranscript('');

    // If assistant is busy, drop pure backchannel or speakerphone echo finals completely
    if (this.isAssistantBusy()) {
      const assistantSpoken = this.getCurrentAssistantText();
      if (isBackchannelUtterance(trimmed) || isEchoOfAssistantSpeech(trimmed, assistantSpoken)) {
        this.debug.log('AUDIO', 'Dropped backchannel / speakerphone echo final', { text: trimmed });
        this.restoreDuckIfNeeded();
        return;
      }
      if (this.settings.bargeInEnabled) {
        void this.executeBargeIn('final_confirmed');
      }
    }

    this.pendingFinalParts.push(trimmed);
    if (this.coalesceTimer) {
      clearTimeout(this.coalesceTimer);
    }

    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = null;
      const merged = this.pendingFinalParts.join(' ').trim();
      this.pendingFinalParts = [];
      if (merged) {
        void this.runAssistantTurn(merged);
      }
    }, this.utteranceCoalesceMs);
  }

  handleServerVad(event: 'SPEECH_ACTIVITY_BEGIN' | 'SPEECH_ACTIVITY_END'): void {
    this.debug.log('VAD', `Server VAD: ${event}`);
    if (event === 'SPEECH_ACTIVITY_BEGIN') {
      this.triggerDuckGate('server_vad');
    } else if (event === 'SPEECH_ACTIVITY_END') {
      this.lastSpeechEndTs = Date.now();
    }
  }

  private handleMicFrame(pcm: ArrayBuffer, rms: number): void {
    // Require elevated RMS during playback so phone speaker bleed doesn't trip local VAD
    const effectiveThreshold = this.isAssistantBusy()
      ? this.settings.vadRmsThreshold * 2.2
      : this.settings.vadRmsThreshold;
    const isAboveThreshold = rms >= effectiveThreshold;
    this.debug.updateAudio({ micRms: rms, vadActive: this.vadSpeechActive });

    this.stt.sendAudio(pcm);

    if (isAboveThreshold) {
      this.vadConsecutiveSpeechFrames++;
      this.vadSilenceStartedAt = null;

      if (!this.vadSpeechActive && this.vadConsecutiveSpeechFrames >= 2) {
        this.vadSpeechActive = true;
        this.debug.log('VAD', 'Local VAD speech begin', { rms: Number(rms.toFixed(4)) });
        if (this.settings.bargeInEnabled && this.isAssistantBusy()) {
          this.triggerDuckGate('local_vad');
        }
      }
    } else {
      this.vadConsecutiveSpeechFrames = 0;
      if (this.vadSpeechActive) {
        if (this.vadSilenceStartedAt === null) {
          this.vadSilenceStartedAt = Date.now();
        } else {
          // #2 Lightweight Chinese semantic endpointing
          const targetSilenceMs = computeSemanticSilenceMs(
            this.latestInterimText,
            this.settings.vadSilenceMs
          );
          if (Date.now() - this.vadSilenceStartedAt >= targetSilenceMs) {
            this.vadSpeechActive = false;
            this.vadSilenceStartedAt = null;
            this.lastSpeechEndTs = Date.now();
            this.debug.log('VAD', 'Semantic VAD silence -> sending audioStreamEnd', {
              targetSilenceMs,
              interimTail: this.latestInterimText.slice(-12),
            });
            this.stt.sendAudioStreamEnd();
          }
        }
      }
    }
  }

  private getCurrentAssistantText(): string {
    const draftText = this.currentDraft
      ? `${this.currentDraft.fastOpening}${this.currentDraft.groundedContinuation}`
      : '';
    if (draftText) return draftText;
    // Also check last committed assistant message in case echo arrives right at turn end
    const last = this.history[this.history.length - 1];
    return last?.role === 'assistant' ? last.spokenText : '';
  }

  private restoreDuckIfNeeded(): void {
    if (this.isDucked) {
      this.isDucked = false;
      if (this.duckTimer) {
        clearTimeout(this.duckTimer);
        this.duckTimer = null;
      }
      this.playback.unduck();
    }
  }

  private scheduleSpeculativeDraft(partialText: string): void {
    if (this.speculativeTimer) {
      clearTimeout(this.speculativeTimer);
      this.speculativeTimer = null;
    }

    this.speculativeTimer = setTimeout(() => {
      this.speculativeTimer = null;
      if (this.state !== 'LISTENING') return;

      // Skip if we already have an in-flight speculative draft for the same normalized text
      if (
        this.speculativeDraft &&
        isSpeculativeTranscriptMatch(this.speculativeDraft.sourceText, partialText)
      ) {
        return;
      }

      this.cancelSpeculativeDraft();
      const abortController = new AbortController();
      const llmHistory = this.buildLlmHistory();
      const openingStyle = pickOpeningLengthStyle(partialText);

      this.debug.log('LLM', 'Speculative S1 pre-execution started', {
        partialText,
        openingStyle,
      });

      const promise = this.gemini
        .draftFastOpeningSentence({
          history: llmHistory,
          rollingSummary: this.rollingSummary,
          userText: partialText,
          openingStyle,
          settings: this.settings,
          signal: abortController.signal,
        })
        .catch(() => '');

      this.speculativeDraft = {
        sourceText: partialText,
        abortController,
        promise,
        startedAt: Date.now(),
      };
    }, this.speculativeDebounceMs);
  }

  private cancelSpeculativeDraft(): void {
    if (this.speculativeTimer) {
      clearTimeout(this.speculativeTimer);
      this.speculativeTimer = null;
    }
    if (this.speculativeDraft) {
      this.speculativeDraft.abortController.abort();
      this.speculativeDraft = null;
    }
  }

  private triggerDuckGate(source: string): void {
    if (!this.settings.bargeInEnabled || !this.isAssistantBusy() || this.isDucked) return;

    this.isDucked = true;
    this.playback.duck(this.settings.bargeInDuckGain);
    this.debug.log('AUDIO', `Ducking playback (${source})`, {
      gain: this.settings.bargeInDuckGain,
    });

    if (this.duckTimer) clearTimeout(this.duckTimer);
    this.duckTimer = setTimeout(() => {
      this.duckTimer = null;
      if (this.isDucked && this.isAssistantBusy()) {
        this.isDucked = false;
        this.playback.unduck();
        this.debug.log('AUDIO', 'Duck timeout without speech confirmation -> unducking');
      }
    }, this.duckConfirmTimeoutMs);
  }

  private async executeBargeIn(reason: string): Promise<void> {
    const bargeStart = Date.now();
    if (this.duckTimer) {
      clearTimeout(this.duckTimer);
      this.duckTimer = null;
    }
    this.isDucked = false;

    const interruptedTurnId = this.activeTurnId;
    this.activeTurnId++;
    this.abortCurrentTurnInternal();

    const progress = await this.playback.flush();
    const stopMs = Date.now() - bargeStart;

    this.debug.log('AUDIO', `Barge-in flushed (${reason})`, {
      interruptedTurnId,
      stopMs,
      activeSegmentId: progress.activeSegmentId,
    });

    this.commitAssistantTurnIfNeeded(true, progress, stopMs);
    this.setState('INTERRUPTED');
    this.setState('LISTENING');
  }

  private async runAssistantTurn(userText: string): Promise<void> {
    const now = Date.now();
    const turnId = ++this.activeTurnId;
    this.turnAbortController = new AbortController();
    const signal = this.turnAbortController.signal;

    this.activeSegments = [];
    this.turnCommitted = false;
    this.playbackStartedAt = 0;
    this.playback.reset();

    // Commit user turn
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      spokenText: userText,
      fullGeneratedText: userText,
      createdAt: now,
    };
    this.history.push(userMsg);
    this.callbacks.onCommitMessage(userMsg);

    const metrics: TurnLatencyMetrics = {
      turnId,
      userText,
      startedAt: now,
      sttFinalizeMs: this.lastSpeechEndTs ? Math.max(0, now - this.lastSpeechEndTs) : undefined,
    };
    this.lastSpeechEndTs = null;
    this.currentMetrics = metrics;
    this.debug.upsertLatency(metrics);

    const llmHistory = this.buildLlmHistory();
    this.syncDebugContext(userText);

    this.setState('THINKING_FAST');

    try {
      // Stage A: Fast opening sentence via gemini-3.5-flash-lite (reusing speculative S1 if matched!)
      const fastStart = Date.now();
      const openingStyle = pickOpeningLengthStyle(userText);
      let openingSentence = '';

      if (this.speculativeTimer) {
        clearTimeout(this.speculativeTimer);
        this.speculativeTimer = null;
      }

      if (
        this.speculativeDraft &&
        isSpeculativeTranscriptMatch(this.speculativeDraft.sourceText, userText)
      ) {
        const hit = this.speculativeDraft;
        this.speculativeDraft = null;
        this.debug.log('LLM', 'SPECULATIVE_HIT: Reusing pre-executed S1 draft', {
          preStartedMsAgo: Date.now() - hit.startedAt,
        });
        openingSentence = (await hit.promise).trim();
      } else if (this.speculativeDraft) {
        this.debug.log('LLM', 'SPECULATIVE_MISS: Discarding stale partial draft', {
          partial: this.speculativeDraft.sourceText,
          final: userText,
        });
        this.cancelSpeculativeDraft();
      }

      if (!openingSentence) {
        openingSentence = await this.gemini.draftFastOpeningSentence({
          history: llmHistory,
          rollingSummary: this.rollingSummary,
          userText,
          openingStyle,
          settings: this.settings,
          signal,
        });
      }

      if (signal.aborted || turnId !== this.activeTurnId) return;

      openingSentence = sanitizeFastOpening(openingSentence) || '好的，我马上帮你看一下。';

      metrics.fastDraftMs = Date.now() - fastStart;
      this.debug.upsertLatency(metrics);
      this.debug.log('LLM', 'Fast opening sentence S1 ready', {
        model: this.settings.fastModel,
        openingStyle,
        ms: metrics.fastDraftMs,
        openingSentence,
      });

      this.currentDraft = {
        turnId,
        fastOpening: openingSentence,
        groundedContinuation: '',
      };
      this.callbacks.onDraftChange({ ...this.currentDraft });
      this.syncDebugContext(userText, openingSentence);

      // Sequential TTS queue so S1 plays immediately while S2..Sn enqueue seamlessly behind it
      const ttsQueue: RegisteredSegment[] = [];
      let ttsQueueNotify: (() => void) | null = null;
      let llmFinished = false;

      const notifyTtsWorker = () => {
        const fn = ttsQueueNotify;
        ttsQueueNotify = null;
        fn?.();
      };

      const pushTtsSegment = (seg: RegisteredSegment) => {
        this.activeSegments.push(seg);
        ttsQueue.push(seg);
        this.debug.log('TTS', `Queued segment ${seg.segmentId} (${seg.stage})`, {
          text: seg.text,
        });
        notifyTtsWorker();
      };

      let s1AudioFinishedAt: number | null = null;
      let s2FirstAudioRecorded = false;

      const runTtsWorker = async () => {
        while (!signal.aborted && turnId === this.activeTurnId) {
          let nextSeg = ttsQueue.shift();
          if (!nextSeg) {
            if (llmFinished) break;
            await new Promise<void>((resolve) => {
              ttsQueueNotify = resolve;
              signal.addEventListener('abort', () => resolve(), { once: true });
            });
            continue;
          }

          // #4 Smart TTS grouping: if 2+ grounded sentences are already buffered,
          // coalesce up to 2 short sentences (<= 90 chars) for smoother Mandarin prosody
          if (
            nextSeg.stage === 'grounded' &&
            ttsQueue.length > 0 &&
            ttsQueue[0].stage === 'grounded' &&
            nextSeg.text.length + ttsQueue[0].text.length <= 90
          ) {
            const partner = ttsQueue.shift()!;
            const mergedText = `${nextSeg.text}${partner.text}`;
            const mergedId = `${nextSeg.segmentId}+${partner.segmentId}`;
            // Update activeSegments so sample-accurate barge-in tracks the merged segment cleanly
            const idx1 = this.activeSegments.findIndex((s) => s.segmentId === nextSeg!.segmentId);
            if (idx1 >= 0) {
              this.activeSegments.splice(idx1, 2, {
                segmentId: mergedId,
                text: mergedText,
                stage: 'grounded',
              });
            }
            nextSeg = { segmentId: mergedId, text: mergedText, stage: 'grounded' };
            this.debug.log('TTS', `Grouped 2 buffered grounded segments (${mergedId})`, {
              chars: mergedText.length,
            });
          }

          this.setState(nextSeg.stage === 'fast' ? 'SPEAKING_FAST' : 'SPEAKING_GROUNDED');

          let gotFirstChunkForSeg = false;
          for await (const pcm of this.gemini.streamSpeechPcm({
            text: nextSeg.text,
            settings: this.settings,
            signal,
          })) {
            if (signal.aborted || turnId !== this.activeTurnId) return;
            if (!gotFirstChunkForSeg) {
              gotFirstChunkForSeg = true;
              if (nextSeg.stage === 'fast' && metrics.ttsFirstAudioMs === undefined) {
                this.playbackStartedAt = Date.now();
                metrics.ttsFirstAudioMs = Date.now() - now;
                this.debug.upsertLatency(metrics);
                this.debug.log('TTS', 'First audio PCM chunk enqueued (TTFA)', {
                  ttfaMs: metrics.ttsFirstAudioMs,
                });
              }
              if (nextSeg.stage === 'grounded' && !s2FirstAudioRecorded) {
                s2FirstAudioRecorded = true;
                metrics.handoffGapMs =
                  s1AudioFinishedAt !== null ? Math.max(0, Date.now() - s1AudioFinishedAt) : 0;
                this.debug.upsertLatency(metrics);
              }
            }
            this.playback.enqueue(nextSeg.segmentId, pcm);
          }

          if (nextSeg.stage === 'fast') {
            s1AudioFinishedAt = Date.now();
          }
        }
      };

      // Stage B (Parallel): Kick off TTS(S1) AND Gemini 4 Hydrogen + Search simultaneously!
      if (openingSentence) {
        pushTtsSegment({ segmentId: `t${turnId}-s1`, text: openingSentence, stage: 'fast' });
      }

      const ttsWorkerPromise = runTtsWorker();

      const groundedStart = Date.now();
      const chunker = new SentenceChunker();
      let segIndex = 2;
      let rawContinuation = '';
      let prefixChecked = false;
      let firstTokenLogged = false;

      for await (const chunk of this.gemini.streamGroundedContinuation({
        history: llmHistory,
        rollingSummary: this.rollingSummary,
        userText,
        openingSentence,
        settings: this.settings,
        signal,
      })) {
        if (signal.aborted || turnId !== this.activeTurnId) return;

        if (chunk.grounding) {
          if (this.currentDraft) {
            this.currentDraft.grounding = chunk.grounding;
            this.callbacks.onDraftChange({ ...this.currentDraft });
          }
          this.debug.updateContext({ lastGrounding: chunk.grounding });
          this.debug.log('LLM', 'Received Google Search grounding metadata', chunk.grounding);
        }

        if (chunk.text) {
          if (!firstTokenLogged) {
            firstTokenLogged = true;
            metrics.groundedFirstTokenMs = Date.now() - groundedStart;
            this.debug.upsertLatency(metrics);
            this.debug.log('LLM', 'Gemini 4 Hydrogen first token', {
              ms: metrics.groundedFirstTokenMs,
            });
          }

          rawContinuation += chunk.text;

          // Wait until we have enough characters to verify/strip accidental S1 echo
          if (!prefixChecked) {
            if (rawContinuation.length < Math.min(openingSentence.length + 6, 36)) {
              continue;
            }
            prefixChecked = true;
            const deduped = stripDuplicatePrefix(openingSentence, rawContinuation);
            rawContinuation = deduped;
            if (this.currentDraft) {
              this.currentDraft.groundedContinuation = deduped;
              this.callbacks.onDraftChange({ ...this.currentDraft });
            }
            for (const sentence of chunker.push(deduped)) {
              pushTtsSegment({
                segmentId: `t${turnId}-s${segIndex++}`,
                text: sentence,
                stage: 'grounded',
              });
            }
          } else {
            if (this.currentDraft) {
              this.currentDraft.groundedContinuation = rawContinuation;
              this.callbacks.onDraftChange({ ...this.currentDraft });
            }
            for (const sentence of chunker.push(chunk.text)) {
              pushTtsSegment({
                segmentId: `t${turnId}-s${segIndex++}`,
                text: sentence,
                stage: 'grounded',
              });
            }
          }
        }
      }

      if (signal.aborted || turnId !== this.activeTurnId) return;

      // Handle short continuations that finished before prefixChecked flipped
      if (!prefixChecked && rawContinuation.trim()) {
        const deduped = stripDuplicatePrefix(openingSentence, rawContinuation);
        if (this.currentDraft) {
          this.currentDraft.groundedContinuation = deduped;
          this.callbacks.onDraftChange({ ...this.currentDraft });
        }
        for (const sentence of chunker.push(deduped)) {
          pushTtsSegment({
            segmentId: `t${turnId}-s${segIndex++}`,
            text: sentence,
            stage: 'grounded',
          });
        }
      }

      for (const tail of chunker.flush()) {
        pushTtsSegment({
          segmentId: `t${turnId}-s${segIndex++}`,
          text: tail,
          stage: 'grounded',
        });
      }

      metrics.groundedCompleteMs = Date.now() - groundedStart;
      this.debug.upsertLatency(metrics);
      llmFinished = true;
      notifyTtsWorker();

      await ttsWorkerPromise;
      if (signal.aborted || turnId !== this.activeTurnId) return;

      this.commitAssistantTurnIfNeeded(false, this.playback.getLastProgress());
      this.setState('LISTENING');
      void this.maybeCompactHistory();
    } catch (err) {
      if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.debug.log('ERROR', `Turn pipeline failed: ${message}`);
      this.callbacks.onError?.(message);
      this.setState('LISTENING');
    }
  }

  private commitAssistantTurnIfNeeded(
    interrupted: boolean,
    progress: PlaybackProgressEvent,
    bargeInStopMs?: number
  ): void {
    if (this.turnCommitted || !this.currentDraft) return;
    this.turnCommitted = true;

    const mergedProgress = mergeSegmentProgress(this.activeSegments, progress);
    const fullGeneratedText = `${this.currentDraft.fastOpening}${this.currentDraft.groundedContinuation}`;
    const truncation = computeSpokenTruncation(
      mergedProgress,
      interrupted,
      this.settings.locale
    );

    if (this.currentMetrics) {
      this.currentMetrics.interrupted = interrupted;
      if (bargeInStopMs !== undefined) {
        this.currentMetrics.bargeInStopMs = bargeInStopMs;
      }
      this.debug.upsertLatency(this.currentMetrics);
    }

    const assistantMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      spokenText: interrupted ? truncation.spokenText : fullGeneratedText,
      fullGeneratedText,
      fastOpening: this.currentDraft.fastOpening,
      interrupted,
      groundingSources: this.currentDraft.grounding?.sources,
      searchQueries: this.currentDraft.grounding?.searchQueries,
      latencyMetrics: this.currentMetrics ? { ...this.currentMetrics } : undefined,
      createdAt: Date.now(),
    };

    this.history.push(assistantMsg);
    this.callbacks.onCommitMessage(assistantMsg);
    this.callbacks.onDraftChange(null);
    this.currentDraft = null;
    this.syncDebugContext();

    this.debug.log('CONTEXT', interrupted ? 'Committed interrupted turn' : 'Committed full turn', {
      spokenText: assistantMsg.spokenText,
      fullGeneratedText: assistantMsg.fullGeneratedText,
      interrupted,
    });
  }

  private handlePlaybackProgress(evt: PlaybackProgressEvent): void {
    const segments = mergeSegmentProgress(this.activeSegments, evt);
    this.debug.updateAudio({
      bufferedMs: evt.bufferedMs,
      gain: evt.gain,
      isFlushing: evt.isFlushing,
      activeSegmentId: evt.activeSegmentId,
      segments,
    });
  }

  private buildLlmHistory(): HistoryTurn[] {
    const recent = this.history.slice(-ACTIVE_HISTORY_WINDOW);
    // Exclude the latest user message we just pushed because it is passed separately as userText
    const prior = recent.length > 0 && recent[recent.length - 1].role === 'user'
      ? recent.slice(0, -1)
      : recent;

    return prior.map((m) => ({
      role: m.role === 'user' ? 'user' : 'model',
      text: m.spokenText,
    }));
  }

  private syncDebugContext(lastUserText?: string, lastOpeningSentence?: string): void {
    this.debug.updateContext({
      rollingSummary: this.rollingSummary,
      history: this.history.slice(-ACTIVE_HISTORY_WINDOW).map((m) => ({
        role: m.role === 'user' ? 'user' : 'model',
        text: m.spokenText,
        interrupted: m.interrupted,
      })),
      ...(lastUserText !== undefined ? { lastFastPromptUserText: lastUserText } : {}),
      ...(lastOpeningSentence !== undefined ? { lastOpeningSentence } : {}),
    });
  }

  private async maybeCompactHistory(): Promise<void> {
    if (this.history.length <= ACTIVE_HISTORY_WINDOW + 4) return;
    const olderTurns = this.history.slice(0, this.history.length - ACTIVE_HISTORY_WINDOW);
    try {
      const summary = await this.gemini.summarizeHistory({
        existingSummary: this.rollingSummary,
        turns: olderTurns.map((m) => ({
          role: m.role === 'user' ? 'user' : 'model',
          text: m.spokenText,
        })),
        settings: this.settings,
      });
      if (summary) {
        this.rollingSummary = summary;
        this.callbacks.onUpdateRollingSummary?.(summary);
        this.syncDebugContext();
        this.debug.log('CONTEXT', 'Updated rolling context summary', {
          summaryLength: summary.length,
        });
      }
    } catch {
      // non-fatal background optimization
    }
  }

  private isAssistantBusy(): boolean {
    return (
      this.state === 'THINKING_FAST' ||
      this.state === 'SPEAKING_FAST' ||
      this.state === 'SPEAKING_GROUNDED'
    );
  }

  private abortCurrentTurnInternal(): void {
    if (this.turnAbortController) {
      this.turnAbortController.abort();
      this.turnAbortController = null;
    }
  }

  private clearTimers(): void {
    if (this.coalesceTimer) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = null;
    }
    if (this.duckTimer) {
      clearTimeout(this.duckTimer);
      this.duckTimer = null;
    }
  }

  private setState(next: EngineState): void {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    this.debug.log('STATE', `${prev} → ${next}`);
    this.callbacks.onStateChange(next);
  }
}
