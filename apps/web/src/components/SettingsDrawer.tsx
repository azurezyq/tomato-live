import { X } from 'lucide-react';
import type { AppSettings, SttProviderMode, ThinkingLevel, TranscribeMode } from '../types/chat';

interface SettingsDrawerProps {
  open: boolean;
  settings: AppSettings;
  onChange: (next: AppSettings) => void;
  onClose: () => void;
}

const VOICES = ['Kore', 'Puck', 'Aoede', 'Charon', 'Fenrir', 'Zephyr', 'Leda', 'Orus'];

export function SettingsDrawer({ open, settings, onChange, onClose }: SettingsDrawerProps) {
  if (!open) return null;

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    onChange({ ...settings, [key]: value });
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-[#2D241E]/25 backdrop-blur-xs">
      <div className="w-full max-w-md bg-[#FFFDF9] border-l border-[#E8DDD0] h-full flex flex-col shadow-2xl shadow-[#2D241E]/15">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#E8DDD0] bg-[#FAF6F1]">
          <h2 className="text-sm font-semibold text-[#2D241E]">语音与模型设置</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-[#7D6F64] hover:text-[#2D241E] hover:bg-[#EDE4D9] cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5 text-xs">
          {/* STT section */}
          <section className="space-y-3">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[#9B8B7E]">
              语音识别 (STT)
            </h3>

            <label className="block space-y-1">
              <span className="text-[#4A3E35] font-medium">识别通道</span>
              <select
                value={settings.sttProvider}
                onChange={(e) => update('sttProvider', e.target.value as SttProviderMode)}
                className="w-full rounded-xl bg-[#FAF6F1] border border-[#E5D9CA] px-3 py-2 text-[#2D241E] focus:outline-none focus:border-[#E05D44]"
              >
                <option value="proxy">Gemini 3.5 Transcribe Live (Cloud Run Proxy)</option>
                <option value="webspeech">浏览器 Web Speech API (本地免代理演示)</option>
                <option value="manual">仅文字 / 调试注入模式</option>
              </select>
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="block space-y-1">
                <span className="text-[#4A3E35] font-medium">识别语言</span>
                <select
                  value={settings.sttLanguage}
                  onChange={(e) =>
                    update('sttLanguage', e.target.value as AppSettings['sttLanguage'])
                  }
                  className="w-full rounded-xl bg-[#FAF6F1] border border-[#E5D9CA] px-3 py-2 text-[#2D241E]"
                >
                  <option value="zh-CN">简体中文 (zh-CN)</option>
                  <option value="auto">自动检测 (中英混说)</option>
                  <option value="en-US">English (en-US)</option>
                </select>
              </label>

              <label className="block space-y-1">
                <span className="text-[#4A3E35] font-medium">转录模式</span>
                <select
                  value={settings.sttMode}
                  onChange={(e) => update('sttMode', e.target.value as TranscribeMode)}
                  className="w-full rounded-xl bg-[#FAF6F1] border border-[#E5D9CA] px-3 py-2 text-[#2D241E]"
                >
                  <option value="VERBATIM">VERBATIM (逐轮增量)</option>
                  <option value="SMART">SMART (去口癖整理)</option>
                </select>
              </label>
            </div>

            <label className="block space-y-1">
              <span className="text-[#4A3E35] font-medium">STT 模型 ID</span>
              <input
                type="text"
                value={settings.sttModel}
                onChange={(e) => update('sttModel', e.target.value)}
                className="w-full rounded-xl bg-[#FAF6F1] border border-[#E5D9CA] px-3 py-2 text-[#2D241E] font-mono"
              />
            </label>
          </section>

          {/* Dual LLM section */}
          <section className="space-y-3 pt-4 border-t border-[#EFE6DC]">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[#9B8B7E]">
              双模型文本生成
            </h3>

            <label className="block space-y-1">
              <span className="text-[#4A3E35] font-medium">首句低延迟模型 (Fast Drafter)</span>
              <input
                type="text"
                value={settings.fastModel}
                onChange={(e) => update('fastModel', e.target.value)}
                className="w-full rounded-xl bg-[#FAF6F1] border border-[#E5D9CA] px-3 py-2 text-[#2D241E] font-mono"
              />
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="block space-y-1">
                <span className="text-[#4A3E35] font-medium">主联网续写模型</span>
                <input
                  type="text"
                  value={settings.mainModel}
                  onChange={(e) => update('mainModel', e.target.value)}
                  className="w-full rounded-xl bg-[#FAF6F1] border border-[#E5D9CA] px-3 py-2 text-[#2D241E] font-mono"
                />
              </label>

              <label className="block space-y-1">
                <span className="text-[#4A3E35] font-medium">Hydrogen 思考强度</span>
                <select
                  value={settings.thinkingLevel}
                  onChange={(e) => update('thinkingLevel', e.target.value as ThinkingLevel)}
                  className="w-full rounded-xl bg-[#FAF6F1] border border-[#E5D9CA] px-3 py-2 text-[#2D241E]"
                >
                  <option value="low">low (实时语音推荐)</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                  <option value="xhigh">xhigh</option>
                </select>
              </label>
            </div>
          </section>

          {/* TTS section */}
          <section className="space-y-3 pt-4 border-t border-[#EFE6DC]">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[#9B8B7E]">
              流式语音合成 (Gemini TTS)
            </h3>

            <div className="grid grid-cols-2 gap-3">
              <label className="block space-y-1">
                <span className="text-[#4A3E35] font-medium">TTS 模型</span>
                <select
                  value={settings.ttsModel}
                  onChange={(e) => update('ttsModel', e.target.value)}
                  className="w-full rounded-xl bg-[#FAF6F1] border border-[#E5D9CA] px-3 py-2 text-[#2D241E] font-mono"
                >
                  <option value="gemini-3.8-flash-lite-tts">gemini-3.8-flash-lite-tts</option>
                  <option value="gemini-3.8-flash-tts">gemini-3.8-flash-tts</option>
                </select>
              </label>

              <label className="block space-y-1">
                <span className="text-[#4A3E35] font-medium">音色 (Voice)</span>
                <select
                  value={settings.ttsVoice}
                  onChange={(e) => update('ttsVoice', e.target.value)}
                  className="w-full rounded-xl bg-[#FAF6F1] border border-[#E5D9CA] px-3 py-2 text-[#2D241E]"
                >
                  {VOICES.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </section>

          {/* VAD & Barge-in */}
          <section className="space-y-3 pt-4 border-t border-[#EFE6DC]">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[#9B8B7E]">
              打断与本地 Hybrid VAD
            </h3>

            <label className="flex items-center justify-between">
              <span className="text-[#4A3E35] font-medium">允许插话打断 (Barge-In)</span>
              <input
                type="checkbox"
                checked={settings.bargeInEnabled}
                onChange={(e) => update('bargeInEnabled', e.target.checked)}
                className="accent-[#E05D44] h-4 w-4"
              />
            </label>

            <label className="block space-y-1">
              <div className="flex justify-between text-[#4A3E35]">
                <span>静音判停时长 (audioStreamEnd)</span>
                <span className="font-mono text-[#8C7B6E]">{settings.vadSilenceMs} ms</span>
              </div>
              <input
                type="range"
                min={250}
                max={1200}
                step={50}
                value={settings.vadSilenceMs}
                onChange={(e) => update('vadSilenceMs', Number(e.target.value))}
                className="w-full accent-[#E05D44]"
              />
            </label>

            <label className="block space-y-1">
              <div className="flex justify-between text-[#4A3E35]">
                <span>麦克风 VAD 能量阈值 (RMS)</span>
                <span className="font-mono text-[#8C7B6E]">
                  {settings.vadRmsThreshold.toFixed(3)}
                </span>
              </div>
              <input
                type="range"
                min={0.005}
                max={0.08}
                step={0.002}
                value={settings.vadRmsThreshold}
                onChange={(e) => update('vadRmsThreshold', Number(e.target.value))}
                className="w-full accent-[#E05D44]"
              />
            </label>
          </section>
        </div>
      </div>
    </div>
  );
}
