import 'dotenv/config';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { verifyWebSocketAuth } from './auth.js';
import { GeminiTranscribeSession } from './transcribeSession.js';
import { handleVertexApiRequest } from './vertexApi.js';
import type { ClientControlMessage, ServerEventMessage } from './types.js';

const PORT = Number(process.env.PORT || 8081);

function isOriginAllowed(origin: string | undefined): boolean {
  const allowedRaw = process.env.ALLOWED_ORIGINS;
  if (!allowedRaw || allowedRaw.trim() === '*' || !origin) return true;
  const allowed = allowedRaw.split(/[;,]/).map((s) => s.trim());
  return allowed.includes(origin);
}

function sendJson(ws: WebSocket, payload: ServerEventMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

export function createSttProxyServer(): http.Server {
  const server = http.createServer((req, res) => {
    void handleVertexApiRequest(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end('Not Found');
      }
    });
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (req, socket, head) => {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    if (pathname !== '/ws/stt') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!isOriginAllowed(req.headers.origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    try {
      const user = await verifyWebSocketAuth(req);
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req, user);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unauthorized';
      console.warn('[stt-proxy] Auth rejected:', message);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
    }
  });

  wss.on('connection', (ws: WebSocket) => {
    let session: GeminiTranscribeSession | null = null;

    const startSession = async (cfg?: {
      languageCodes?: string[];
      mode?: 'VERBATIM' | 'SMART';
      sampleRate?: number;
      model?: string;
    }) => {
      session?.close();
      session = new GeminiTranscribeSession({
        languageCodes: cfg?.languageCodes ?? ['zh-CN'],
        mode: cfg?.mode ?? 'VERBATIM',
        sampleRate: cfg?.sampleRate ?? 16000,
        model: cfg?.model,
        onEvent: (event) => sendJson(ws, event),
      });
      try {
        await session.start();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendJson(ws, {
          type: 'error',
          code: 'SESSION_START_FAILED',
          message,
          ts: Date.now(),
        });
      }
    };

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const buf = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data);
        session?.sendAudioChunk(buf);
        return;
      }

      try {
        const msg = JSON.parse(data.toString()) as ClientControlMessage;
        if (msg.type === 'config') {
          void startSession({
            languageCodes: msg.languageCodes,
            mode: msg.mode,
            sampleRate: msg.sampleRate,
            model: msg.model,
          });
        } else if (msg.type === 'audio_stream_end') {
          session?.sendAudioStreamEnd();
        } else if (msg.type === 'ping') {
          sendJson(ws, { type: 'pong', ts: msg.ts });
        }
      } catch (err) {
        sendJson(ws, {
          type: 'error',
          code: 'INVALID_CONTROL_MESSAGE',
          message: err instanceof Error ? err.message : 'Malformed JSON',
          ts: Date.now(),
        });
      }
    });

    ws.on('close', () => {
      session?.close();
      session = null;
    });

    ws.on('error', () => {
      session?.close();
      session = null;
    });
  });

  return server;
}

if (process.env.NODE_ENV !== 'test') {
  const server = createSttProxyServer();
  server.listen(PORT, () => {
    console.log(`[stt-proxy] Listening on :${PORT} (ws path /ws/stt, health /healthz)`);
  });

  const shutdown = () => {
    console.log('[stt-proxy] Shutting down...');
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
