import { GoogleGenAI } from '@google/genai';

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID;
if (!PROJECT) {
  throw new Error('Set GOOGLE_CLOUD_PROJECT (or FIREBASE_PROJECT_ID) before running e2e-live.mjs');
}
const LOCATION = process.env.VERTEX_LOCATION || 'global';
const PWA_URL = process.env.PWA_URL || `https://${PROJECT}.web.app`;
const STT_HTTP_URL = process.env.STT_HTTP_URL || '';

const FAST_MODEL = process.env.FAST_MODEL || 'gemini-3.5-flash-lite';
const MAIN_MODEL = process.env.MAIN_MODEL || 'gemini-4-hydrogen';
const TTS_MODEL = process.env.TTS_MODEL || 'gemini-3.8-flash-lite-tts';
const STT_MODEL = process.env.STT_MODEL || 'gemini-3.5-transcribe-live';

const results = [];

async function runStep(name, fn) {
  const start = Date.now();
  try {
    const detail = await fn();
    const ms = Date.now() - start;
    results.push({ name, ok: true, ms, detail });
    console.log(`✅ [PASS] ${name} (${ms}ms)`);
    if (detail) console.log(`   ↳ ${detail}`);
    return { ok: true, detail };
  } catch (err) {
    const ms = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, ms, error: msg });
    console.error(`❌ [FAIL] ${name} (${ms}ms)\n   ↳ ${msg}`);
    return { ok: false, error: msg };
  }
}

function downsample24kTo16k(pcm24kBuf) {
  let buf = pcm24kBuf;
  if (buf.length > 44 && buf.subarray(0, 4).toString('ascii') === 'RIFF') {
    buf = buf.subarray(44);
  }
  const inSamples = Math.floor(buf.length / 2);
  const ratio = 24000 / 16000;
  const outSamples = Math.floor(inSamples / ratio);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const srcIdx = Math.min(inSamples - 1, Math.floor(i * ratio));
    out.writeInt16LE(buf.readInt16LE(srcIdx * 2), i * 2);
  }
  return out;
}

const ai = new GoogleGenAI({
  vertexai: true,
  project: PROJECT,
  location: LOCATION,
});

let fastOpening = '';
let ttsPcm24k = Buffer.alloc(0);

console.log(`\n🍅 Tomato Live — Comprehensive Real E2E Suite (${PROJECT} / ${LOCATION})\n`);

// 1. Live PWA Hosting & AudioWorklets
await runStep('E2E-01: Live PWA Hosting & AudioWorklets', async () => {
  const paths = [
    '/',
    '/manifest.webmanifest',
    '/sw.js',
    '/worklets/mic-capture-processor.js',
    '/worklets/pcm-playback-processor.js',
  ];
  for (const p of paths) {
    const r = await fetch(`${PWA_URL}${p}`);
    if (!r.ok) throw new Error(`${PWA_URL}${p} returned HTTP ${r.status}`);
  }
  const manifest = await (await fetch(`${PWA_URL}/manifest.webmanifest`)).json();
  if (manifest.lang !== 'zh-CN' || manifest.theme_color !== '#FAF6F1') {
    throw new Error(`Unexpected manifest: ${JSON.stringify(manifest)}`);
  }
  return `All 5 PWA assets HTTP 200 (${manifest.short_name}, theme=${manifest.theme_color})`;
});

// 2. Live Cloud Run /health
await runStep('E2E-02: Live Cloud Run Service /health', async () => {
  const r = await fetch(`${STT_HTTP_URL}/health`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  if (data.status !== 'ok' || !data.vertexai) {
    throw new Error(`Unexpected health payload: ${JSON.stringify(data)}`);
  }
  return `status=${data.status}, vertexai=${data.vertexai}, project=${data.project}, model=${data.model}`;
});

// 3. Cloud Run API Auth Guard (401 without Firebase ID token) & CORS Preflight (204)
await runStep('E2E-03: Cloud Run API Auth Guard (401) & CORS Preflight (204)', async () => {
  const unauth = await fetch(`${STT_HTTP_URL}/api/fast-opening`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: PWA_URL },
    body: JSON.stringify({ userText: '你好' }),
  });
  if (unauth.status !== 401) {
    throw new Error(`Expected 401 without token, got HTTP ${unauth.status}`);
  }

  const preflight = await fetch(`${STT_HTTP_URL}/api/grounded-stream`, {
    method: 'OPTIONS',
    headers: { Origin: PWA_URL },
  });
  if (preflight.status !== 204) {
    throw new Error(`Expected 204 on OPTIONS preflight, got HTTP ${preflight.status}`);
  }
  const allowOrigin = preflight.headers.get('access-control-allow-origin');
  if (allowOrigin !== PWA_URL) {
    throw new Error(`Expected CORS origin ${PWA_URL}, got ${allowOrigin}`);
  }
  return `Auth guard 401 ✓, CORS preflight 204 (${allowOrigin}) ✓`;
});

// 4. Real Vertex AI: gemini-3.5-flash-lite Fast Opening Sentence
await runStep(`E2E-04: Vertex AI Fast Opening (${FAST_MODEL})`, async () => {
  const res = await ai.models.generateContent({
    model: FAST_MODEL,
    contents: '用户最新发言：今天北京天气怎么样？请直接输出一句25字以内的自然简体中文开场白。',
    config: { temperature: 0.4, maxOutputTokens: 80 },
  });
  fastOpening = (res.text || '').trim();
  if (!fastOpening) throw new Error('Empty opening sentence');
  return `S1="${fastOpening}"`;
});

// 5. Real Vertex AI: gemini-4-hydrogen + Google Search Grounding
await runStep(`E2E-05: Vertex AI Grounded Continuation (${MAIN_MODEL} + Google Search)`, async () => {
  const start = Date.now();
  let ttft = null;
  let fullText = '';
  let searchQueries = [];
  let sourceCount = 0;

  const stream = await ai.models.generateContentStream({
    model: MAIN_MODEL,
    contents: `用户问：今天北京实时天气温度是多少？\n你已播报开场句：${fastOpening || '我来帮你查一下北京今天的最新天气。'}\n请务必使用 Google 搜索查询最新数据并紧接着自然续写2句，不要重复开场句。`,
    config: {
      tools: [{ googleSearch: {} }],
      thinkingConfig: { thinkingLevel: 'LOW' },
    },
  });

  for await (const chunk of stream) {
    if (chunk.text) {
      if (ttft === null) ttft = Date.now() - start;
      fullText += chunk.text;
    }
    const meta = chunk.candidates?.[0]?.groundingMetadata;
    if (meta?.webSearchQueries?.length) searchQueries = meta.webSearchQueries;
    if (meta?.groundingChunks?.length) sourceCount = meta.groundingChunks.length;
  }

  if (!fullText.trim()) throw new Error('Empty continuation from Hydrogen');
  return `TTFT=${ttft}ms, queries=${JSON.stringify(searchQueries)}, sources=${sourceCount}, text="${fullText.trim().slice(0, 70)}..."`;
});

// 6. Real Vertex AI: Streaming TTS (gemini-3.8-flash-lite-tts)
await runStep(`E2E-06: Vertex AI Streaming TTS (${TTS_MODEL})`, async () => {
  const start = Date.now();
  let ttfa = null;
  const chunks = [];

  const stream = await ai.models.generateContentStream({
    model: TTS_MODEL,
    contents: '你好，今天北京天气晴朗，气温大约二十度。',
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        languageCode: 'zh-CN',
        voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
      },
    },
  });

  for await (const chunk of stream) {
    const parts = chunk.candidates?.[0]?.content?.parts || [];
    for (const part of parts) {
      if (part.inlineData?.data) {
        if (ttfa === null) ttfa = Date.now() - start;
        chunks.push(Buffer.from(part.inlineData.data, 'base64'));
      }
    }
  }

  ttsPcm24k = Buffer.concat(chunks);
  if (ttsPcm24k.length < 2000) {
    throw new Error(`TTS produced too little audio (${ttsPcm24k.length} bytes)`);
  }
  const durationSec = (ttsPcm24k.length / 2 / 24000).toFixed(2);
  return `TTFA=${ttfa}ms, chunks=${chunks.length}, bytes=${ttsPcm24k.length} (~${durationSec}s @ 24kHz)`;
});

// 7. Real Vertex AI: Live STT Audio Round-Trip (gemini-3.5-transcribe-live)
await runStep(`E2E-07: Vertex AI Live STT Audio Round-Trip (${STT_MODEL})`, async () => {
  if (ttsPcm24k.length < 2000) throw new Error('Skipped: no TTS PCM from E2E-06');
  const pcm16k = downsample24kTo16k(ttsPcm24k);

  let lastInterim = '';
  let interimCount = 0;

  const transcript = await new Promise((resolve, reject) => {
    let session;
    const timer = setTimeout(() => {
      try {
        session?.close();
      } catch {}
      if (lastInterim) {
        resolve(lastInterim);
      } else {
        reject(new Error('Timed out with no interim or final transcript'));
      }
    }, 12000);

    ai.live
      .connect({
        model: STT_MODEL,
        config: {
          responseModalities: ['TEXT'],
          inputAudioTranscription: {
            mode: 'VERBATIM',
            languageCodes: ['zh-CN'],
          },
        },
        callbacks: {
          onmessage: (msg) => {
            if (msg.setupComplete !== undefined) {
              const frameBytes = 3200; // 100ms @ 16kHz 16-bit mono
              for (let off = 0; off < pcm16k.length; off += frameBytes) {
                const slice = pcm16k.subarray(off, Math.min(off + frameBytes, pcm16k.length));
                session.sendRealtimeInput({
                  audio: {
                    data: slice.toString('base64'),
                    mimeType: 'audio/pcm;rate=16000',
                  },
                });
              }
              // Send 600ms of trailing silence then audioStreamEnd
              const silence = Buffer.alloc(16000 * 2 * 0.6);
              session.sendRealtimeInput({
                audio: { data: silence.toString('base64'), mimeType: 'audio/pcm;rate=16000' },
              });
              session.sendRealtimeInput({ audioStreamEnd: true });
            }
            const sc = msg.serverContent;
            if (sc?.interimInputTranscription?.text) {
              interimCount++;
              lastInterim = sc.interimInputTranscription.text.trim();
            }
            if (sc?.inputTranscription?.text?.trim()) {
              clearTimeout(timer);
              session?.close();
              resolve(sc.inputTranscription.text.trim());
            } else if (sc?.turnComplete && lastInterim) {
              clearTimeout(timer);
              session?.close();
              resolve(lastInterim);
            }
          },
          onerror: (err) => {
            clearTimeout(timer);
            reject(err instanceof Error ? err : new Error(String(err)));
          },
        },
      })
      .then((s) => {
        session = s;
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });

  if (!transcript.includes('北京') && !transcript.includes('天气')) {
    throw new Error(`Unexpected transcript: "${transcript}"`);
  }
  return `Transcribed="${transcript}" (interim updates=${interimCount})`;
});

console.log('\n=== Real E2E Summary ===');
const failed = results.filter((r) => !r.ok);
console.log(`Passed: ${results.length - failed.length} / ${results.length}`);
if (failed.length > 0) {
  process.exit(1);
}
