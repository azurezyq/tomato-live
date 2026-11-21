import type { IncomingMessage } from 'node:http';
import admin from 'firebase-admin';

let initialized = false;

export interface VerifiedUser {
  uid: string;
  email?: string;
}

function ensureAdminInitialized(): void {
  if (initialized || admin.apps.length > 0) {
    initialized = true;
    return;
  }
  const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID;
  admin.initializeApp(projectId ? { projectId } : undefined);
  initialized = true;
}

export function extractTokenFromRequest(req: IncomingMessage): string | null {
  // 1. Authorization: Bearer <token>
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }

  // 2. Query parameter ?token=<idToken> (standard browser WebSocket pattern)
  if (req.url) {
    try {
      const parsed = new URL(req.url, 'http://localhost');
      const tokenParam = parsed.searchParams.get('token');
      if (tokenParam) return tokenParam.trim();
    } catch {
      // ignore malformed URL
    }
  }

  // 3. Sec-WebSocket-Protocol: bearer, <token>
  const protoHeader = req.headers['sec-websocket-protocol'];
  if (typeof protoHeader === 'string') {
    const parts = protoHeader.split(',').map((p) => p.trim());
    const bearerIdx = parts.findIndex((p) => p.toLowerCase() === 'bearer');
    if (bearerIdx >= 0 && parts[bearerIdx + 1]) {
      return parts[bearerIdx + 1];
    }
  }

  return null;
}

export function isEmailAllowed(email: string | undefined, allowedEmailsEnv = process.env.ALLOWED_EMAILS): boolean {
  if (!allowedEmailsEnv || !allowedEmailsEnv.trim()) {
    return true;
  }
  const allowed = allowedEmailsEnv
    .split(/[;,]/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.length === 0) {
    return true;
  }
  if (!email) {
    return false;
  }
  return allowed.includes(email.trim().toLowerCase());
}

export async function verifyWebSocketAuth(
  req: IncomingMessage,
  verifier?: (token: string) => Promise<VerifiedUser>
): Promise<VerifiedUser> {
  if (process.env.ALLOW_DEV_BYPASS === 'true') {
    return { uid: 'dev-bypass-user', email: 'dev@localhost' };
  }

  const token = extractTokenFromRequest(req);
  if (!token) {
    throw new Error('Missing Firebase Auth ID token');
  }

  let user: VerifiedUser;
  if (verifier) {
    user = await verifier(token);
  } else {
    ensureAdminInitialized();
    const decoded = await admin.auth().verifyIdToken(token);
    user = { uid: decoded.uid, email: decoded.email };
  }

  if (!isEmailAllowed(user.email)) {
    throw new Error('Forbidden: email not in ALLOWED_EMAILS');
  }

  return user;
}
