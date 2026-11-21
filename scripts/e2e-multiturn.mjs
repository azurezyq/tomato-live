import { GoogleGenAI } from '@google/genai';

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID;
if (!PROJECT) {
  throw new Error('Set GOOGLE_CLOUD_PROJECT (or FIREBASE_PROJECT_ID) before running e2e-multiturn.mjs');
}
const LOCATION = process.env.VERTEX_LOCATION || 'global';
const FAST_MODEL = process.env.FAST_MODEL || 'gemini-3.5-flash-lite';
const MAIN_MODEL = process.env.MAIN_MODEL || 'gemini-4-hydrogen';
const TTS_MODEL = process.env.TTS_MODEL || 'gemini-3.8-flash-lite-tts';
const STT_MODEL = process.env.STT_MODEL || 'gemini-3.5-transcribe-live';

const ai = new GoogleGenAI({ vertexai: true, project: PROJECT, location: LOCATION });

const FAST_SYS =
  '你是面向中国大陆用户的实时语音助手“番茄”。你的唯一任务是用自然、口语化的简体中文，只生成【第一句】简短开场回应（严格控制在 15~40 个汉字以内，朗读不超过 8 秒）。' +
  '要求：1) 直接自然承接用户问题，不要使用生硬模板；2) 不要编造不确定的实时数字；3) 以完整句号、问号或感叹号结尾；4) 不要使用 Markdown 或表情符号。';

const MAIN_SYS =
  '你是面向中国大陆用户的实时语音助手“番茄”，正在进行流畅的多轮口语语音对话。' +
  '你已经向用户播报了开场第一句话，现在需要紧接着这句话的下一个字自然续写完整回答（需要实时信息时使用 Google 搜索）。' +
  '严格要求：1) 绝对不要重复或改写已播报的开场句；2) 回答简洁清晰、适合语音朗读，不要使用 Markdown 标题、星号、代码块或网址链接，控制在 2~4 句话；' +
  '3) 如果上下文出现“——[用户打断]”，说明上一轮说到那里就被打断，未说出的内容用户并未听到。';

function formatHistory(history, rollingSummary) {
  const lines = [];
  if (rollingSummary) lines.push(`【历史对话摘要】\n${rollingSummary}\n`);
  if (history.length > 0) {
    lines.push('【近期对话记录】');
    for (const h of history) {
      lines.push(`${h.role === 'user' ? '用户' : '助手'}：${h.text}`);
    }
  }
  return lines.join('\n');
}

function stripDuplicatePrefix(s1, cont) {
  const a = s1.trim();
  const b = cont.trimStart();
  if (b.startsWith(a)) return b.slice(a.length).replace(/^[\s，,。\.：:]+/, '');
  return cont;
}

function downsample24kTo16k(pcm24kBuf) {
  let buf = pcm24kBuf;
  if (buf.length > 44 && buf.subarray(0, 4).toString('ascii') === 'RIFF') {
    buf = buf.subarray(44);
  }
  const inSamples = Math.floor(buf.length / 2);
  const ratio = 1.5;
  const outSamples = Math.floor(inSamples / ratio);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const srcIdx = Math.min(inSamples - 1, Math.floor(i * ratio));
    out.writeInt16LE(buf.readInt16LE(srcIdx * 2), i * 2);
  }
  return out;
}

async function synthesizeTts(text) {
  const start = Date.now();
  let ttfa = null;
  const chunks = [];
  const stream = await ai.models.generateContentStream({
    model: TTS_MODEL,
    contents: text,
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        languageCode: 'zh-CN',
        voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
      },
    },
  });
  for await (const chunk of stream) {
    for (const p of chunk.candidates?.[0]?.content?.parts || []) {
      if (p.inlineData?.data) {
        if (ttfa === null) ttfa = Date.now() - start;
        chunks.push(Buffer.from(p.inlineData.data, 'base64'));
      }
    }
  }
  const buf = Buffer.concat(chunks);
  return { buf, ttfa, durationSec: +(buf.length / 2 / 24000).toFixed(2) };
}

async function transcribeLivePcm16k(pcm16k) {
  let lastInterim = '';
  let interimCount = 0;
  return new Promise((resolve, reject) => {
    let session;
    const timer = setTimeout(() => {
      try { session?.close(); } catch {}
      if (lastInterim) resolve({ text: lastInterim, interimCount });
      else reject(new Error('STT timed out with no transcript'));
    }, 12000);

    ai.live
      .connect({
        model: STT_MODEL,
        config: {
          responseModalities: ['TEXT'],
          inputAudioTranscription: { mode: 'VERBATIM', languageCodes: ['zh-CN'] },
        },
        callbacks: {
          onmessage: (msg) => {
            if (msg.setupComplete !== undefined) {
              for (let off = 0; off < pcm16k.length; off += 3200) {
                const slice = pcm16k.subarray(off, Math.min(off + 3200, pcm16k.length));
                session.sendRealtimeInput({
                  audio: { data: slice.toString('base64'), mimeType: 'audio/pcm;rate=16000' },
                });
              }
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
              resolve({ text: sc.inputTranscription.text.trim(), interimCount });
            } else if (sc?.turnComplete && lastInterim) {
              clearTimeout(timer);
              session?.close();
              resolve({ text: lastInterim, interimCount });
            }
          },
          onerror: (err) => {
            clearTimeout(timer);
            reject(err instanceof Error ? err : new Error(String(err)));
          },
        },
      })
      .then((s) => { session = s; })
      .catch((e) => { clearTimeout(timer); reject(e); });
  });
}

async function runDualModelTurn({ turnNo, userText, history, rollingSummary, withTts = false, interruptAtRatio = null }) {
  const ctx = formatHistory(history, rollingSummary);
  const fastStart = Date.now();
  const fastRes = await ai.models.generateContent({
    model: FAST_MODEL,
    contents: [ctx, `用户最新发言：${userText}`, '请直接输出这一句简短开场白：'].filter(Boolean).join('\n\n'),
    config: { systemInstruction: FAST_SYS, temperature: 0.5, maxOutputTokens: 90 },
  });
  const s1 = (fastRes.text || '').trim();
  const fastMs = Date.now() - fastStart;
  if (!s1) throw new Error(`Turn ${turnNo}: empty S1`);

  // Parallel: TTS(S1) + Hydrogen Grounded Continuation
  const groundedStart = Date.now();
  const ttsPromise = withTts ? synthesizeTts(s1) : Promise.resolve(null);

  let ttft = null;
  let cont = '';
  let queries = [];
  let sources = 0;

  const stream = await ai.models.generateContentStream({
    model: MAIN_MODEL,
    contents: [
      ctx,
      `用户最新发言：${userText}`,
      `你已经播报给用户的开场句（请勿重复）：<opening>${s1}</opening>`,
      '请从开场句之后的下一句直接自然续写：',
    ]
      .filter(Boolean)
      .join('\n\n'),
    config: {
      systemInstruction: MAIN_SYS,
      tools: [{ googleSearch: {} }],
      temperature: 0.6,
      thinkingConfig: { thinkingLevel: 'LOW' },
    },
  });

  for await (const chunk of stream) {
    if (chunk.text) {
      if (ttft === null) ttft = Date.now() - groundedStart;
      cont += chunk.text;
    }
    const meta = chunk.candidates?.[0]?.groundingMetadata;
    if (meta?.webSearchQueries?.length) queries = meta.webSearchQueries;
    if (meta?.groundingChunks?.length) sources = meta.groundingChunks.length;
  }

  const ttsRes = await ttsPromise;
  const groundedMs = Date.now() - groundedStart;
  const dedupedCont = stripDuplicatePrefix(s1, cont).trim();
  if (!dedupedCont) throw new Error(`Turn ${turnNo}: empty continuation`);

  let spokenText = `${s1}${dedupedCont}`;
  if (interruptAtRatio !== null) {
    const chars = Array.from(dedupedCont);
    const cut = chars.slice(0, Math.max(4, Math.round(chars.length * interruptAtRatio))).join('');
    spokenText = `${s1}${cut}——[用户打断]`;
  }

  console.log(`\n━━━ Turn ${turnNo} ━━━`);
  console.log(`👤 用户: ${userText}`);
  console.log(`⚡ S1 (${fastMs}ms${ttsRes ? `, TTS TTFA=${ttsRes.ttfa}ms, ~${ttsRes.durationSec}s` : ''}): ${s1}`);
  console.log(`🌐 Hydrogen (TTFT=${ttft}ms, total=${groundedMs}ms, search=${queries.length}, sources=${sources}): ${dedupedCont}`);
  if (interruptAtRatio !== null) {
    console.log(`✂️ 模拟中途打断 -> 写入上下文: ${spokenText}`);
  }

  return { s1, cont: dedupedCont, spokenText, fastMs, ttft, groundedMs, queries, sources, ttsRes };
}

console.log(`\n🍅 Tomato Live — 8-Turn Real Multi-Turn Chinese Conversation E2E (${PROJECT} / ${LOCATION})`);

const history = [];
let rollingSummary = '';

// Turn 1: Initial travel preference + weather (simulated mid-speech barge-in at 35% of S2)
const u1 = '我下周三打算从上海坐高铁去杭州玩两天，我比较喜欢喝茶和逛安静的博物馆，先帮我查一下杭州最近天气怎么样？';
const t1 = await runDualModelTurn({ turnNo: 1, userText: u1, history, rollingSummary, withTts: true, interruptAtRatio: 0.35 });
history.push({ role: 'user', text: u1 }, { role: 'model', text: t1.spokenText });

// Turn 2: Interrupt & ask for quiet museum/teahouse recommendations (must remember 杭州 + 喝茶/安静博物馆)
const u2 = '等等，先不管天气了，帮我推荐两个符合我口味的安静展馆或茶室吧。';
const t2 = await runDualModelTurn({ turnNo: 2, userText: u2, history, rollingSummary, withTts: true });
if (!/馆|茶|杭州|西湖|龙井|博物/.test(t2.spokenText)) {
  throw new Error(`Turn 2 lost Hangzhou tea/museum context: ${t2.spokenText}`);
}
history.push({ role: 'user', text: u2 }, { role: 'model', text: t2.spokenText });

// Turn 3: Pronoun resolution ("刚才你提到的第一个地方")
const u3 = '刚才你提到的第一个地方，怎么坐地铁去比较方便？需要提前预约吗？';
const t3 = await runDualModelTurn({ turnNo: 3, userText: u3, history, rollingSummary });
if (!/地铁|预约|站|公交|打车|开放/.test(t3.spokenText)) {
  throw new Error(`Turn 3 failed transit/booking follow-up: ${t3.spokenText}`);
}
history.push({ role: 'user', text: u3 }, { role: 'model', text: t3.spokenText });

// Turn 4: Mid-conversation real-time Search pivot (USD/CNY FX rate)
const u4 = '对了，顺便帮我查一下今天美元兑人民币汇率大概是多少？';
const t4 = await runDualModelTurn({ turnNo: 4, userText: u4, history, rollingSummary });
if (!/\d\.\d/.test(t4.spokenText)) {
  throw new Error(`Turn 4 missing numeric FX rate: ${t4.spokenText}`);
}
history.push({ role: 'user', text: u4 }, { role: 'model', text: t4.spokenText });

// Turn 5: Mixed Chinese-English technical question
const u5 = '如果我想用 React 和 WebAudio 做一个类似的 live voice app，你觉得 AudioWorklet 最容易踩的坑是什么？';
const t5 = await runDualModelTurn({ turnNo: 5, userText: u5, history, rollingSummary, withTts: true });
if (!/AudioWorklet|采样率|线程|缓冲|AudioContext|HTTPS|跨域|延迟/i.test(t5.spokenText)) {
  throw new Error(`Turn 5 off-topic for AudioWorklet: ${t5.spokenText}`);
}
history.push({ role: 'user', text: u5 }, { role: 'model', text: t5.spokenText });

// Turn 6: Real Audio Round-Trip (TTS -> 16kHz PCM -> gemini-3.5-transcribe-live -> Dual-model response!)
const spokenPrompt6 = '回到杭州行程，第二天早上我想去西湖边喝龙井茶，有什么推荐吗？';
const synth6 = await synthesizeTts(spokenPrompt6);
const stt6 = await transcribeLivePcm16k(downsample24kTo16k(synth6.buf));
console.log(`\n🎙️ Turn 6 Real Voice Round-Trip: TTS(${synth6.durationSec}s) -> Transcribe Live="${stt6.text}" (interims=${stt6.interimCount})`);
const t6 = await runDualModelTurn({ turnNo: 6, userText: stt6.text, history, rollingSummary });
history.push({ role: 'user', text: stt6.text }, { role: 'model', text: t6.spokenText });

// Turn 7: Rolling Summary Compaction via gemini-3.5-flash-lite
const sumStart = Date.now();
const sumRes = await ai.models.generateContent({
  model: FAST_MODEL,
  contents:
    '请将以下对话压缩为 150 字以内的简体中文要点摘要，保留用户出发地、目的地、时间、偏好和已讨论的关键内容：\n\n' +
    history.map((h) => `${h.role === 'user' ? '用户' : '助手'}：${h.text}`).join('\n'),
  config: { temperature: 0.2, maxOutputTokens: 300 },
});
rollingSummary = (sumRes.text || '').trim();
console.log(`\n🗜️ Turn 7 Rolling Summary Compaction (${Date.now() - sumStart}ms):\n   ${rollingSummary}`);
if (!rollingSummary.includes('杭州')) {
  throw new Error(`Rolling summary lost key entity 杭州: ${rollingSummary}`);
}

// Turn 8: Long-horizon recall using ONLY Rolling Summary + last 2 turns (simulating sliding window!)
const windowedHistory = history.slice(-4);
const u8 = '最后帮我用三句话把这趟从上海出发的杭州两日游和注意事项串起来总结一下吧。';
const t8 = await runDualModelTurn({
  turnNo: 8,
  userText: u8,
  history: windowedHistory,
  rollingSummary,
  withTts: true,
});
if (!/杭州/.test(t8.spokenText) || !/茶|馆|西湖|高铁/.test(t8.spokenText)) {
  throw new Error(`Turn 8 failed long-horizon recall: ${t8.spokenText}`);
}

console.log('\n✅ ALL 8 REAL MULTI-TURN CONVERSATION CHECKS PASSED!');
