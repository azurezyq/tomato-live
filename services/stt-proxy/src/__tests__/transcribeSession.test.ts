import { describe, it, expect, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { extractTokenFromRequest, verifyWebSocketAuth } from '../auth.js';
import {
  GeminiTranscribeSession,
  type LiveConnectCallbacks,
  type LiveSessionLike,
} from '../transcribeSession.js';
import type { ServerEventMessage } from '../types.js';

describe('auth helpers', () => {
  it('extracts token from Authorization Bearer header', () => {
    const req = {
      headers: { authorization: 'Bearer abc.def.ghi' },
      url: '/ws/stt',
    } as unknown as IncomingMessage;
    expect(extractTokenFromRequest(req)).toBe('abc.def.ghi');
  });

  it('extracts token from query parameter', () => {
    const req = {
      headers: {},
      url: '/ws/stt?token=query-token-123',
    } as unknown as IncomingMessage;
    expect(extractTokenFromRequest(req)).toBe('query-token-123');
  });

  it('rejects missing token when dev bypass is disabled', async () => {
    const prev = process.env.ALLOW_DEV_BYPASS;
    process.env.ALLOW_DEV_BYPASS = 'false';
    const req = { headers: {}, url: '/ws/stt' } as unknown as IncomingMessage;
    await expect(verifyWebSocketAuth(req)).rejects.toThrow('Missing Firebase Auth ID token');
    process.env.ALLOW_DEV_BYPASS = prev;
  });

  it('accepts token via custom verifier', async () => {
    const prev = process.env.ALLOW_DEV_BYPASS;
    process.env.ALLOW_DEV_BYPASS = 'false';
    const req = {
      headers: {},
      url: '/ws/stt?token=valid-id-token',
    } as unknown as IncomingMessage;
    const user = await verifyWebSocketAuth(req, async (token) => ({
      uid: `uid-${token}`,
      email: 'test@example.com',
    }));
    expect(user.uid).toBe('uid-valid-id-token');
    process.env.ALLOW_DEV_BYPASS = prev;
  });
});

describe('GeminiTranscribeSession', () => {
  it('buffers audio until setupComplete, then flushes and emits zh-CN transcripts', async () => {
    const events: ServerEventMessage[] = [];
    const sentInputs: unknown[] = [];
    let capturedCallbacks: LiveConnectCallbacks | undefined;
    let capturedConfig: Record<string, unknown> | undefined;
    let capturedModel = '';

    const mockLiveSession: LiveSessionLike = {
      sendRealtimeInput: vi.fn((input) => sentInputs.push(input)),
      close: vi.fn(),
    };

    const session = new GeminiTranscribeSession({
      languageCodes: ['zh-CN'],
      mode: 'VERBATIM',
      sampleRate: 16000,
      onEvent: (e) => events.push(e),
      connector: async ({ model, config, callbacks }) => {
        capturedModel = model;
        capturedConfig = config;
        capturedCallbacks = callbacks;
        return mockLiveSession;
      },
    });

    await session.start();
    expect(capturedModel).toBe('gemini-3.5-transcribe-live');
    expect(capturedConfig).toMatchObject({
      responseModalities: ['TEXT'],
      inputAudioTranscription: {
        mode: 'VERBATIM',
        languageCodes: ['zh-CN'],
      },
    });

    // Audio sent before setupComplete must be buffered, not forwarded immediately
    const earlyPcm = Buffer.from([1, 2, 3, 4]);
    session.sendAudioChunk(earlyPcm);
    expect(sentInputs).toHaveLength(0);

    // Server signals setupComplete -> ready emitted & buffered PCM flushed
    capturedCallbacks?.onmessage?.({ setupComplete: {} });
    expect(events[0]).toMatchObject({
      type: 'ready',
      model: 'gemini-3.5-transcribe-live',
      languageCodes: ['zh-CN'],
      mode: 'VERBATIM',
    });
    expect(sentInputs).toHaveLength(1);
    expect(sentInputs[0]).toEqual({
      audio: {
        data: earlyPcm.toString('base64'),
        mimeType: 'audio/pcm;rate=16000',
      },
    });

    // Interim and final Chinese transcription events
    capturedCallbacks?.onmessage?.({
      serverContent: { interimInputTranscription: { text: '今天北京' } },
    });
    capturedCallbacks?.onmessage?.({
      serverContent: { inputTranscription: { text: '今天北京天气怎么样？' } },
    });

    expect(events.some((e) => e.type === 'interim' && e.text === '今天北京')).toBe(true);
    expect(events.some((e) => e.type === 'final' && e.text === '今天北京天气怎么样？')).toBe(true);

    // Hybrid VAD audioStreamEnd
    session.sendAudioStreamEnd();
    expect(sentInputs[1]).toEqual({ audioStreamEnd: true });
    expect(events.some((e) => e.type === 'vad' && e.event === 'SPEECH_ACTIVITY_END')).toBe(true);

    session.close();
    expect(mockLiveSession.close).toHaveBeenCalledTimes(1);
  });
});
