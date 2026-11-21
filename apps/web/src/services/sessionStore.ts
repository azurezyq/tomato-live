import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  updateDoc,
  type Firestore,
} from 'firebase/firestore';
import type { ChatMessage, ChatSession } from '../types/chat';

export interface SessionStoreAdapter {
  subscribeSessions(uid: string, cb: (sessions: ChatSession[]) => void): () => void;
  subscribeMessages(
    uid: string,
    sessionId: string,
    cb: (messages: ChatMessage[]) => void
  ): () => void;
  createSession(uid: string, title?: string): Promise<ChatSession>;
  updateSession(
    uid: string,
    sessionId: string,
    patch: Partial<Pick<ChatSession, 'title' | 'updatedAt' | 'rollingSummary'>>
  ): Promise<void>;
  deleteSession(uid: string, sessionId: string): Promise<void>;
  saveMessage(uid: string, sessionId: string, message: ChatMessage): Promise<void>;
}

export class FirestoreSessionStore implements SessionStoreAdapter {
  private readonly db: Firestore;

  constructor(db: Firestore) {
    this.db = db;
  }

  subscribeSessions(uid: string, cb: (sessions: ChatSession[]) => void): () => void {
    const q = query(collection(this.db, 'users', uid, 'sessions'), orderBy('updatedAt', 'desc'));
    return onSnapshot(q, (snap) => {
      const items: ChatSession[] = snap.docs.map((d) => {
        const data = d.data() as Omit<ChatSession, 'id'>;
        return { id: d.id, ...data };
      });
      cb(items);
    });
  }

  subscribeMessages(
    uid: string,
    sessionId: string,
    cb: (messages: ChatMessage[]) => void
  ): () => void {
    const q = query(
      collection(this.db, 'users', uid, 'sessions', sessionId, 'messages'),
      orderBy('createdAt', 'asc')
    );
    return onSnapshot(q, (snap) => {
      const items: ChatMessage[] = snap.docs.map((d) => {
        const data = d.data() as Omit<ChatMessage, 'id'>;
        return { id: d.id, ...data };
      });
      cb(items);
    });
  }

  async createSession(uid: string, title = '新语音对话'): Promise<ChatSession> {
    const id = crypto.randomUUID();
    const now = Date.now();
    const session: ChatSession = {
      id,
      title,
      createdAt: now,
      updatedAt: now,
    };
    await setDoc(doc(this.db, 'users', uid, 'sessions', id), {
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    });
    return session;
  }

  async updateSession(
    uid: string,
    sessionId: string,
    patch: Partial<Pick<ChatSession, 'title' | 'updatedAt' | 'rollingSummary'>>
  ): Promise<void> {
    await updateDoc(doc(this.db, 'users', uid, 'sessions', sessionId), {
      ...patch,
      updatedAt: patch.updatedAt ?? Date.now(),
    });
  }

  async deleteSession(uid: string, sessionId: string): Promise<void> {
    await deleteDoc(doc(this.db, 'users', uid, 'sessions', sessionId));
  }

  async saveMessage(uid: string, sessionId: string, message: ChatMessage): Promise<void> {
    // Strip undefined fields for Firestore compatibility
    const clean = JSON.parse(JSON.stringify(message)) as ChatMessage;
    await setDoc(doc(this.db, 'users', uid, 'sessions', sessionId, 'messages', message.id), clean);
    await updateDoc(doc(this.db, 'users', uid, 'sessions', sessionId), {
      updatedAt: Date.now(),
    });
  }
}
