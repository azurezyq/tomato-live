import type { IncomingMessage, ServerResponse } from 'node:http';
import { GoogleGenAI } from '@google/genai';
import { verifyWebSocketAuth } from './auth.js';
import { dailyTurnLimiter } from './rateLimit.js';

interface HistoryTurn {
  role: 'user' | 'model';
  text: string;
}

function getVertexClient(): GoogleGenAI {
  const useVertex = (process.env.USE_VERTEX_AI ?? 'true').toLowerCase() !== 'false';
  const project = process.env.GOOGLE_CLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID;
  const location = process.env.VERTEX_LOCATION || 'global';
  if (useVertex && project) {
    return new GoogleGenAI({ vertexai: true, project, location });
  }
  if (process.env.GEMINI_API_KEY) {
    return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  throw new Error('Vertex AI credentials or GEMINI_API_KEY not configured');
}

function formatHistoryPrompt(history: HistoryTurn[], rollingSummary?: string): string {
  const lines: string[] = [];
  if (rollingSummary?.trim()) {
    lines.push(`【历史对话摘要】\n${rollingSummary.trim()}\n`);
  }
  if (history?.length > 0) {
    lines.push('【近期对话记录】');
    for (const turn of history) {
      lines.push(`${turn.role === 'user' ? '用户' : '助手'}：${turn.text}`);
    }
  }
  return lines.join('\n');
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return (raw ? JSON.parse(raw) : {}) as T;
}

function setCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
}

function sendJsonError(res: ServerResponse, status: number, message: string): void {
  if (!res.headersSent) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
  }
  res.end(JSON.stringify({ error: message }));
}

export async function handleVertexApiRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;

  if (pathname === '/health' || pathname === '/api/health') {
    setCorsHeaders(req, res);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        service: 'tomato-live-stt-proxy',
        vertexai: (process.env.USE_VERTEX_AI ?? 'true').toLowerCase() !== 'false',
        project: process.env.GOOGLE_CLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || '',
        location: process.env.VERTEX_LOCATION || 'global',
        model: process.env.STT_MODEL || 'gemini-3.5-transcribe-live',
        dailyTurns: dailyTurnLimiter.getUsage(),
      })
    );
    return true;
  }

  if (!pathname.startsWith('/api/')) {
    return false;
  }

  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }

  if (req.method !== 'POST') {
    sendJsonError(res, 405, 'Method Not Allowed');
    return true;
  }

  try {
    await verifyWebSocketAuth(req);
  } catch (err) {
    sendJsonError(res, 401, err instanceof Error ? err.message : 'Unauthorized');
    return true;
  }

  if (pathname === '/api/grounded-stream') {
    const turnStatus = dailyTurnLimiter.consumeTurn();
    if (!turnStatus.allowed) {
      sendJsonError(
        res,
        429,
        `Daily turn limit reached (${turnStatus.used}/${turnStatus.limit} turns on ${turnStatus.date} UTC). Please try again tomorrow.`
      );
      return true;
    }
  } else if (dailyTurnLimiter.isLimitReached()) {
    const usage = dailyTurnLimiter.getUsage();
    sendJsonError(
      res,
      429,
      `Daily turn limit reached (${usage.used}/${usage.limit} turns on ${usage.date} UTC). Please try again tomorrow.`
    );
    return true;
  }

  try {
    const ai = getVertexClient();

    if (pathname === '/api/fast-opening') {
      const body = await readJsonBody<{
        model?: string;
        history?: HistoryTurn[];
        rollingSummary?: string;
        userText: string;
        openingStyle?: 'short' | 'medium';
      }>(req);

      const lengthRule =
        body.openingStyle === 'short'
          ? '严格控制在 10~22 个汉字以内（朗读约 3~4 秒）'
          : '严格控制在 22~40 个汉字以内（朗读约 6~8 秒，为后台联网搜索留出充足衔接时间）';

      const contextBlock = formatHistoryPrompt(body.history ?? [], body.rollingSummary);
      const prompt = [
        contextBlock,
        `用户最新发言：${body.userText}`,
        '请直接输出这一句简短开场白：',
      ]
        .filter(Boolean)
        .join('\n\n');

      const result = await ai.models.generateContent({
        model: body.model || 'gemini-3.5-flash-lite',
        contents: prompt,
        config: {
          tools: [],
          toolConfig: {
            functionCallingConfig: {
              mode: 'NONE' as never,
            },
          },
          systemInstruction:
            `你是面向中国大陆用户的实时语音助手“番茄”。你的唯一任务是用自然、口语化的简体中文（如果用户主要说英文则用英文），只生成【第一句】简短开场回应（${lengthRule}）。` +
            '严格要求：1) 直接自然地承接用户问题，不要使用“好的，让我来帮你查一下”这种生硬模板；2) 绝对不要编造不确定的实时数据、股价、天气数字或最新新闻事实；' +
            '3) 严禁调用任何工具或输出函数调用、搜索命令、代码、JSON、标签（例如 google_search、call:...、tool_code 等），你没有搜索工具，只需自然口语过渡；' +
            '4) 以完整句号、问号或感叹号结尾，不要使用 Markdown、列表符号或表情符号。',
          temperature: 0.5,
          maxOutputTokens: body.openingStyle === 'short' ? 60 : 95,
        },
      });

      const cleaned = (result.text || '')
        .replace(/```[\s\S]*?```/g, '')
        .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
        .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
        .replace(/\b(?:google_?search|search|call|tool_code|print)\s*\([^)]*\)/gi, '')
        .replace(/\[(?:search|tool|call)[^\]]*\]/gi, '')
        .replace(/\s+/g, ' ')
        .trim();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: cleaned || '好的，我马上帮你看一下。' }));
      return true;
    }

    if (pathname === '/api/grounded-stream') {
      const body = await readJsonBody<{
        model?: string;
        thinkingLevel?: string;
        history?: HistoryTurn[];
        rollingSummary?: string;
        userText: string;
        openingSentence: string;
      }>(req);

      const contextBlock = formatHistoryPrompt(body.history ?? [], body.rollingSummary);
      const prompt = [
        contextBlock,
        `用户最新发言：${body.userText}`,
        `你已经播报给用户的开场句（请勿重复）：<opening>${body.openingSentence}</opening>`,
        '请从开场句之后的下一句直接自然续写：',
      ]
        .filter(Boolean)
        .join('\n\n');

      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache',
      });

      const stream = await ai.models.generateContentStream({
        model: body.model || 'gemini-4-hydrogen',
        contents: prompt,
        config: {
          tools: [{ googleSearch: {} }],
          systemInstruction:
            '你是面向中国大陆用户的实时语音助手“番茄”，正在进行流畅的口语语音对话。' +
            '你已经向用户播报了开场第一句话，现在需要基于 Google 搜索的最新信息，紧接着这句话的下一个字自然续写完整回答。' +
            '严格要求：1) 绝对不要重复或改写已播报的开场句；2) 如果联网搜索发现开场句有需要补充或纠正的细节，请用自然口语过渡（如“具体来看，根据最新消息……”）；' +
            '3) 回答简洁清晰、适合语音朗读，不要使用 Markdown 标题、星号、代码块或网址链接，控制在 3~5 句话以内（除非用户要求详细展开）；4) 如果上下文中出现“——[用户打断]”，说明你上一轮说到那里就被打断了，未说出的内容用户并未听到。',
          temperature: 0.6,
          thinkingConfig: {
            thinkingLevel: (body.thinkingLevel || 'LOW').toUpperCase(),
          } as never,
        },
      });

      for await (const chunk of stream) {
        if (res.writableEnded) break;
        const text = chunk.text || undefined;
        const meta = chunk.candidates?.[0]?.groundingMetadata;
        let grounding: { searchQueries: string[]; sources: Array<{ title: string; url: string }> } | undefined;
        if (meta) {
          const searchQueries = meta.webSearchQueries ?? [];
          const seen = new Set<string>();
          const sources: Array<{ title: string; url: string }> = [];
          for (const c of meta.groundingChunks ?? []) {
            const url = c.web?.uri;
            if (!url || seen.has(url)) continue;
            seen.add(url);
            sources.push({ title: c.web?.title || url, url });
          }
          if (searchQueries.length > 0 || sources.length > 0) {
            grounding = { searchQueries, sources };
          }
        }
        if (text || grounding) {
          res.write(`${JSON.stringify({ text, grounding })}\n`);
        }
      }

      res.end();
      return true;
    }

    if (pathname === '/api/tts-stream') {
      const body = await readJsonBody<{
        model?: string;
        text: string;
        voiceName?: string;
        languageCode?: string;
      }>(req);

      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache',
      });

      const stream = await ai.models.generateContentStream({
        model: body.model || 'gemini-3.8-flash-lite-tts',
        contents: body.text,
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            languageCode: body.languageCode || 'zh-CN',
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: body.voiceName || 'Kore',
              },
            },
          } as never,
        },
      });

      for await (const chunk of stream) {
        if (res.writableEnded) break;
        const parts = chunk.candidates?.[0]?.content?.parts ?? [];
        for (const part of parts) {
          if (part.inlineData?.data) {
            res.write(`${JSON.stringify({ pcmBase64: part.inlineData.data })}\n`);
          }
        }
      }

      res.end();
      return true;
    }

    if (pathname === '/api/summarize') {
      const body = await readJsonBody<{
        model?: string;
        existingSummary?: string;
        turns: HistoryTurn[];
      }>(req);

      const prompt = [
        '请将以下对话压缩为 150 字以内的简体中文要点摘要，保留用户偏好、已讨论的关键事实和未完成意图：',
        body.existingSummary ? `已有摘要：${body.existingSummary}` : '',
        (body.turns ?? []).map((t) => `${t.role === 'user' ? '用户' : '助手'}：${t.text}`).join('\n'),
      ]
        .filter(Boolean)
        .join('\n\n');

      const result = await ai.models.generateContent({
        model: body.model || 'gemini-3.5-flash-lite',
        contents: prompt,
        config: { temperature: 0.2, maxOutputTokens: 300 },
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ summary: (result.text || '').trim() }));
      return true;
    }

    sendJsonError(res, 404, 'Unknown API endpoint');
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[vertex-api] ${pathname} failed:`, message);
    sendJsonError(res, 500, message);
    return true;
  }
}
