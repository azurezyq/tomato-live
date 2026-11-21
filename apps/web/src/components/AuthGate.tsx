import { Mic, ShieldCheck, AlertTriangle } from 'lucide-react';

interface AuthGateProps {
  configured: boolean;
  loading: boolean;
  error: string | null;
  onSignIn: () => void;
}

export function AuthGate({ configured, loading, error, onSignIn }: AuthGateProps) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#FAF6F1] via-[#F7EFE6] to-[#F2E6DA] px-4">
      <div className="w-full max-w-md rounded-3xl border border-[#E8DDD0] bg-[#FFFDF9]/95 p-8 shadow-xl shadow-[#D6C4B0]/25 backdrop-blur">
        <div className="flex items-center gap-3.5 mb-6">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-[#E05D44] to-[#F08A5D] shadow-md shadow-[#E05D44]/25">
            <Mic className="h-6 w-6 text-[#FFFDF9]" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-[#2D241E] tracking-tight">
              番茄实时语音 · Tomato Live
            </h1>
            <p className="text-xs text-[#8C7B6E] mt-0.5">
              Gemini 3.5 Transcribe · Flash-Lite + 4 Hydrogen 联网 · 流式语音
            </p>
          </div>
        </div>

        {!configured ? (
          <div className="rounded-2xl border border-[#EBCBA0] bg-[#FEF6EB] p-4 text-sm text-[#8F5A1C] space-y-2">
            <div className="flex items-center gap-2 font-medium">
              <AlertTriangle className="h-4 w-4 shrink-0 text-[#C87A24]" />
              <span>尚未配置 Firebase 环境变量</span>
            </div>
            <p className="text-xs text-[#8F5A1C]/90 leading-relaxed">
              请复制 <code className="rounded bg-[#F5E6D3] px-1.5 py-0.5">apps/web/.env.example</code> 为{' '}
              <code className="rounded bg-[#F5E6D3] px-1.5 py-0.5">apps/web/.env</code>，填入 Firebase
              配置并启用 Google 登录与 Firebase AI Logic，然后重启开发服务器。
            </p>
          </div>
        ) : (
          <>
            <p className="text-sm text-[#63564D] leading-relaxed mb-6">
              使用 Google 账号登录，即可同步你的语音对话记录，体验温暖流畅、随时可打断的双模型实时语音对话。
            </p>

            {error && (
              <div className="mb-4 rounded-xl border border-[#EFC5BC] bg-[#FDF1EE] px-3.5 py-2.5 text-xs text-[#B2412D]">
                {error}
              </div>
            )}

            <button
              onClick={onSignIn}
              disabled={loading}
              className="w-full flex items-center justify-center gap-2.5 rounded-2xl bg-gradient-to-r from-[#E05D44] to-[#EB7852] px-4 py-3.5 text-sm font-medium text-[#FFFDF9] shadow-md shadow-[#E05D44]/20 hover:brightness-105 active:scale-[0.99] transition disabled:opacity-60 cursor-pointer"
            >
              <ShieldCheck className="h-4 w-4" />
              <span>{loading ? '正在登录...' : '使用 Google 账号登录'}</span>
            </button>
          </>
        )}
      </div>
    </div>
  );
}
