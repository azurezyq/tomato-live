import { Mic, MicOff, Square, Loader2, Sparkles, Radio } from 'lucide-react';
import type { EngineState } from '../types/chat';

interface VoiceOrbProps {
  state: EngineState;
  micRms: number;
  isLive: boolean;
  onToggleLive: () => void;
  onInterrupt: () => void;
}

const STATE_META: Record<EngineState, { label: string; color: string; ring: string; shadow: string }> = {
  IDLE: {
    label: '轻点麦克风，开启实时语音对话',
    color: 'text-[#847569]',
    ring: 'from-[#E05D44] to-[#F08A5D]',
    shadow: 'shadow-[#E05D44]/25',
  },
  WARMING: {
    label: '正在预热云端语音服务（约 1~2 秒）...',
    color: 'text-[#C27822]',
    ring: 'from-[#E5983B] to-[#F2B366]',
    shadow: 'shadow-[#E5983B]/25',
  },
  CONNECTING: {
    label: '正在连接 Transcribe Live...',
    color: 'text-[#C27822]',
    ring: 'from-[#E5983B] to-[#F2B366]',
    shadow: 'shadow-[#E5983B]/25',
  },
  LISTENING: {
    label: '聆听中 · 随时可以自然开口',
    color: 'text-[#357A5D]',
    ring: 'from-[#449371] to-[#63B18E]',
    shadow: 'shadow-[#449371]/25',
  },
  THINKING_FAST: {
    label: '快速起句中 (3.5 Flash-Lite)...',
    color: 'text-[#C27822]',
    ring: 'from-[#E5983B] to-[#EE8259]',
    shadow: 'shadow-[#E5983B]/25',
  },
  SPEAKING_FAST: {
    label: '首句播报中 · 后台联网搜索',
    color: 'text-[#C94E38]',
    ring: 'from-[#E05D44] to-[#F08A5D]',
    shadow: 'shadow-[#E05D44]/30',
  },
  SPEAKING_GROUNDED: {
    label: '联网精准播报中 (4 Hydrogen)',
    color: 'text-[#4F5DB8]',
    ring: 'from-[#5D6BC9] to-[#8778D4]',
    shadow: 'shadow-[#5D6BC9]/25',
  },
  INTERRUPTED: {
    label: '已温柔打断 · 切回聆听',
    color: 'text-[#C27822]',
    ring: 'from-[#E5983B] to-[#E05D44]',
    shadow: 'shadow-[#E5983B]/25',
  },
  ERROR: {
    label: '连接异常 · 可在调试面板查看详情',
    color: 'text-[#B84330]',
    ring: 'from-[#C94B35] to-[#DF6D58]',
    shadow: 'shadow-[#C94B35]/25',
  },
};

export function VoiceOrb({ state, micRms, isLive, onToggleLive, onInterrupt }: VoiceOrbProps) {
  const meta = STATE_META[state];
  const isSpeaking = state === 'SPEAKING_FAST' || state === 'SPEAKING_GROUNDED';
  const scale = isLive ? 1 + Math.min(0.24, micRms * 4.5) : 1;

  return (
    <div className="flex flex-col items-center justify-center py-2 md:py-3.5 gap-2">
      <div className="relative flex items-center justify-center">
        {isLive && (
          <div
            className={`absolute h-20 w-20 md:h-24 md:w-24 rounded-full bg-gradient-to-tr ${meta.ring} opacity-30 animate-pulse-ring`}
          />
        )}
        <button
          onClick={onToggleLive}
          style={{ transform: `scale(${scale.toFixed(3)})` }}
          className={`relative z-10 flex h-16 w-16 md:h-19 md:w-19 items-center justify-center rounded-full bg-gradient-to-tr ${meta.ring} text-[#FFFDF9] shadow-lg ${meta.shadow} transition-transform duration-75 cursor-pointer hover:brightness-105`}
          title={isLive ? '结束实时语音' : '开启实时语音'}
        >
          {state === 'WARMING' || state === 'CONNECTING' ? (
            <Loader2 className="h-7 w-7 animate-spin" />
          ) : isSpeaking ? (
            <Sparkles className="h-7 w-7" />
          ) : isLive ? (
            <Mic className="h-7 w-7" />
          ) : (
            <MicOff className="h-7 w-7 opacity-90" />
          )}
        </button>
      </div>

      <div className="flex items-center gap-2 text-xs font-medium">
        {isLive && <Radio className={`h-3.5 w-3.5 animate-pulse ${meta.color}`} />}
        <span className={meta.color}>{meta.label}</span>
        {(isSpeaking || state === 'THINKING_FAST') && (
          <button
            onClick={onInterrupt}
            className="ml-1.5 inline-flex items-center gap-1 rounded-full border border-[#E8C5B8] bg-[#FDF1EC] px-2.5 py-0.5 text-[11px] text-[#B84531] hover:bg-[#F9E3DA] transition cursor-pointer"
          >
            <Square className="h-2.5 w-2.5 fill-current" />
            <span>打断</span>
          </button>
        )}
      </div>
    </div>
  );
}
