import { useEffect, useMemo, useRef, useState } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth';
import { Bug, Download, Send, Settings, Sparkles } from 'lucide-react';
import { WebAudioPlayback, WebMicCapture } from './audio/audioManager';
import { AuthGate } from './components/AuthGate';
import { DebugDrawer } from './components/DebugDrawer';
import { SessionSidebar } from './components/SessionSidebar';
import { SettingsDrawer } from './components/SettingsDrawer';
import { TranscriptFeed } from './components/TranscriptFeed';
import { VoiceOrb } from './components/VoiceOrb';
import { debugStore } from './engine/debugStore';
import { LiveChatEngine, type LiveDraftState } from './engine/liveChatEngine';
import { getFirebaseServices, isFirebaseConfigured } from './lib/firebase';
import { usePwaInstall } from './lib/pwa';
import { deriveApiBaseUrl, VertexProxyGeminiService } from './services/geminiService';
import { FirestoreSessionStore } from './services/sessionStore';
import { ProxySttClient, WebSpeechSttClient } from './services/sttClient';
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type ChatMessage,
  type ChatSession,
  type EngineState,
} from './types/chat';

export function App() {
  const configured = isFirebaseConfigured();
  const firebase = useMemo(() => getFirebaseServices(), []);

  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(!configured);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [engineState, setEngineState] = useState<EngineState>('IDLE');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [draft, setDraft] = useState<LiveDraftState | null>(null);
  const [micRms, setMicRms] = useState(0);
  const [textInput, setTextInput] = useState('');
  const [bannerError, setBannerError] = useState<string | null>(null);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const { canInstall, promptInstall } = usePwaInstall();

  const sessionStore = useMemo(
    () => (firebase ? new FirestoreSessionStore(firebase.db) : null),
    [firebase]
  );

  const activeSessionRef = useRef<string | null>(null);
  const userRef = useRef<User | null>(null);
  activeSessionRef.current = activeSessionId;
  userRef.current = user;

  const engineRef = useRef<LiveChatEngine | null>(null);

  // Initialize LiveChatEngine routed through Cloud Run Vertex AI API
  useEffect(() => {
    if (!firebase || !sessionStore) return;

    const wsUrl = import.meta.env.VITE_STT_WS_URL || 'ws://localhost:8081/ws/stt';
    const gemini = new VertexProxyGeminiService(deriveApiBaseUrl(wsUrl), () =>
      userRef.current ? userRef.current.getIdToken() : Promise.resolve(undefined)
    );
    const playback = new WebAudioPlayback();
    const mic = new WebMicCapture();
    const stt = new ProxySttClient();

    const engine = new LiveChatEngine(
      { gemini, playback, mic, stt, debug: debugStore },
      settings,
      {
        onStateChange: (next) => setEngineState(next),
        onInterimTranscript: (text) => setInterimTranscript(text),
        onDraftChange: (d) => setDraft(d),
        onCommitMessage: (msg) => {
          const uid = userRef.current?.uid;
          const sid = activeSessionRef.current;
          if (uid && sid) {
            void sessionStore.saveMessage(uid, sid, msg);
            if (msg.role === 'user') {
              // Auto-title new session on first user utterance
              const title = msg.spokenText.slice(0, 18);
              void sessionStore.updateSession(uid, sid, { title });
            }
          }
        },
        onUpdateRollingSummary: (summary) => {
          const uid = userRef.current?.uid;
          const sid = activeSessionRef.current;
          if (uid && sid) {
            void sessionStore.updateSession(uid, sid, { rollingSummary: summary });
          }
        },
        onError: (err) => setBannerError(err),
      }
    );

    engineRef.current = engine;
    const unsubDebug = debugStore.subscribe(() => {
      setMicRms(debugStore.getSnapshot().audio.micRms);
    });

    return () => {
      unsubDebug();
      void engine.stopVoiceSession();
      void playback.dispose();
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firebase, sessionStore]);

  // Sync settings updates into engine
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.updateSettings(settings);
    engine.setSttAdapter(
      settings.sttProvider === 'webspeech' ? new WebSpeechSttClient() : new ProxySttClient()
    );
  }, [settings]);

  // Ctrl/Cmd + D toggles Debug Inspector
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        setDebugOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Firebase Auth listener + background Cloud Run warm-up
  useEffect(() => {
    if (!firebase) return;
    return onAuthStateChanged(firebase.auth, (u) => {
      setUser(u);
      setAuthReady(true);
      if (u) {
        const wsUrl = import.meta.env.VITE_STT_WS_URL || 'ws://localhost:8081/ws/stt';
        void fetch(`${deriveApiBaseUrl(wsUrl)}/health`).catch(() => {});
      }
    });
  }, [firebase]);

  // Firestore sessions subscription
  useEffect(() => {
    if (!user || !sessionStore) return;
    return sessionStore.subscribeSessions(user.uid, (list) => {
      setSessions(list);
      if (!activeSessionRef.current && list.length > 0) {
        setActiveSessionId(list[0].id);
      }
    });
  }, [user, sessionStore]);

  // Firestore messages subscription for active session
  useEffect(() => {
    if (!user || !sessionStore || !activeSessionId) {
      setMessages([]);
      return;
    }
    const currentSession = sessions.find((s) => s.id === activeSessionId);
    return sessionStore.subscribeMessages(user.uid, activeSessionId, (msgs) => {
      setMessages(msgs);
      engineRef.current?.loadSessionHistory(msgs, currentSession?.rollingSummary || '');
    });
  }, [user, sessionStore, activeSessionId, sessions]);

  const ensureActiveSession = async (): Promise<string | null> => {
    if (activeSessionRef.current) return activeSessionRef.current;
    if (!user || !sessionStore) return null;
    const created = await sessionStore.createSession(user.uid, '新语音对话');
    setActiveSessionId(created.id);
    activeSessionRef.current = created.id;
    return created.id;
  };

  const handleSignIn = async () => {
    if (!firebase) return;
    setAuthLoading(true);
    setAuthError(null);
    try {
      await signInWithPopup(firebase.auth, firebase.googleProvider);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleSignOut = async () => {
    await engineRef.current?.stopVoiceSession();
    if (firebase) await signOut(firebase.auth);
    setActiveSessionId(null);
    setSessions([]);
    setMessages([]);
  };

  const handleCreateSession = async () => {
    if (!user || !sessionStore) return;
    const created = await sessionStore.createSession(user.uid, '新语音对话');
    setActiveSessionId(created.id);
  };

  const handleDeleteSession = async (id: string) => {
    if (!user || !sessionStore) return;
    await sessionStore.deleteSession(user.uid, id);
    if (activeSessionId === id) {
      setActiveSessionId(null);
    }
  };

  const isLive = engineState !== 'IDLE' && engineState !== 'ERROR';

  const handleToggleLive = async () => {
    const engine = engineRef.current;
    if (!engine) return;
    setBannerError(null);

    if (isLive) {
      await engine.stopVoiceSession();
      return;
    }

    await ensureActiveSession();
    const idToken = user ? await user.getIdToken() : undefined;
    const wsUrl = import.meta.env.VITE_STT_WS_URL || 'ws://localhost:8081/ws/stt';
    await engine.startVoiceSession({ wsUrl, idToken });
  };

  const handleInjectOrSend = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || !engineRef.current) return;
    setBannerError(null);
    await ensureActiveSession();
    setTextInput('');
    await engineRef.current.injectUtterance(trimmed);
  };

  if (!configured || !authReady || !user) {
    return (
      <AuthGate
        configured={configured}
        loading={authLoading || !authReady}
        error={authError}
        onSignIn={handleSignIn}
      />
    );
  }

  return (
    <div className="h-[100dvh] w-full overflow-hidden flex bg-[#FAF6F1] text-[#2D241E]">
      <SessionSidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        userName={user.displayName || user.email || '用户'}
        userPhoto={user.photoURL}
        onSelectSession={(id) => setActiveSessionId(id)}
        onCreateSession={handleCreateSession}
        onDeleteSession={handleDeleteSession}
        onSignOut={handleSignOut}
      />

      {/* Main live-chat workspace */}
      <main className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Top bar */}
        <header className="shrink-0 min-h-14 pt-[env(safe-area-inset-top)] px-3.5 md:px-6 py-2 border-b border-[#E8DDD0] bg-[#FFFDF9]/90 backdrop-blur flex items-center justify-between gap-2.5">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="h-8 w-8 shrink-0 rounded-xl bg-gradient-to-br from-[#E05D44] to-[#F08A5D] flex items-center justify-center shadow-sm shadow-[#E05D44]/20">
              <Sparkles className="h-4 w-4 text-[#FFFDF9]" />
            </div>
            <div className="min-w-0">
              <h1 className="text-sm font-semibold text-[#2D241E] truncate">番茄实时语音</h1>
              <p className="text-[11px] text-[#8C7B6E] truncate font-mono">
                {settings.fastModel} → {settings.mainModel} + Search
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {canInstall && (
              <button
                onClick={() => void promptInstall()}
                className="inline-flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-xs font-medium bg-[#EAF5EF] text-[#2F7556] border border-[#C6E4D3] hover:bg-[#DCF0E4] transition cursor-pointer"
                title="安装到主屏幕 / 桌面应用"
              >
                <Download className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">安装应用</span>
              </button>
            )}
            <button
              onClick={() => setDebugOpen((v) => !v)}
              className={`inline-flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-xs font-medium transition cursor-pointer ${
                debugOpen
                  ? 'bg-[#FDF1EC] text-[#C94E38] border border-[#EFC9BC]'
                  : 'bg-[#FAF6F1] text-[#63564D] hover:bg-[#F1E8DD] border border-[#E5D9CA]'
              }`}
              title="切换开发者调试面板 (Ctrl/Cmd+D)"
            >
              <Bug className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">调试面板</span>
            </button>

            <button
              onClick={() => setSettingsOpen(true)}
              className="p-2 rounded-xl bg-[#FAF6F1] hover:bg-[#F1E8DD] border border-[#E5D9CA] text-[#63564D] hover:text-[#2D241E] cursor-pointer"
              title="语音与模型设置"
            >
              <Settings className="h-4 w-4" />
            </button>
          </div>
        </header>

        {bannerError && (
          <div className="mx-3.5 md:mx-4 mt-2.5 rounded-xl border border-[#EFC5BC] bg-[#FDF1EE] px-3.5 py-2 text-xs text-[#B2412D] flex items-center justify-between">
            <span>{bannerError}</span>
            <button
              onClick={() => setBannerError(null)}
              className="text-[#C94E38] hover:text-[#8F2E1E] ml-2 font-medium cursor-pointer"
            >
              关闭
            </button>
          </div>
        )}

        <TranscriptFeed
          messages={messages}
          interimTranscript={interimTranscript}
          draft={draft}
        />

        {/* Bottom voice orb + text fallback bar (safe-area aware for mobile Chrome / iOS) */}
        <footer className="shrink-0 border-t border-[#E8DDD0] bg-[#FFFDF9]/95 px-3.5 md:px-4 pt-1.5 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <VoiceOrb
            state={engineState}
            micRms={micRms}
            isLive={isLive}
            onToggleLive={handleToggleLive}
            onInterrupt={() => void engineRef.current?.simulateBargeIn()}
          />

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleInjectOrSend(textInput);
            }}
            className="max-w-2xl mx-auto mt-1 flex items-center gap-2"
          >
            <input
              type="text"
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              placeholder="也可以直接输入中文或英文发送测试..."
              className="flex-1 rounded-2xl bg-[#FAF6F1] border border-[#E5D9CA] px-3.5 py-2 text-sm md:text-xs text-[#2D241E] placeholder:text-[#A29387] focus:outline-none focus:border-[#E05D44]"
            />
            <button
              type="submit"
              disabled={!textInput.trim()}
              className="inline-flex items-center justify-center rounded-2xl bg-gradient-to-r from-[#E05D44] to-[#EB7852] hover:brightness-105 disabled:opacity-40 text-[#FFFDF9] px-3.5 py-2.5 text-xs font-medium transition cursor-pointer shadow-xs shrink-0"
            >
              <Send className="h-4 w-4 md:h-3.5 md:w-3.5" />
            </button>
          </form>
        </footer>
      </main>

      <DebugDrawer
        open={debugOpen}
        engineState={engineState}
        vadThreshold={settings.vadRmsThreshold}
        onClose={() => setDebugOpen(false)}
        onInjectUtterance={(text) => void handleInjectOrSend(text)}
        onSimulateBargeIn={() => void engineRef.current?.simulateBargeIn()}
      />

      <SettingsDrawer
        open={settingsOpen}
        settings={settings}
        onChange={setSettings}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}
export default App;
