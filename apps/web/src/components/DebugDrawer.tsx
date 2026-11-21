import { useEffect, useState } from 'react';
import {
  Activity,
  Bug,
  Download,
  Gauge,
  Layers,
  Play,
  Scissors,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { debugStore, type DebugSnapshot } from '../engine/debugStore';
import type { DebugCategory, EngineState } from '../types/chat';

interface DebugDrawerProps {
  open: boolean;
  engineState: EngineState;
  vadThreshold: number;
  onClose: () => void;
  onInjectUtterance: (text: string) => void;
  onSimulateBargeIn: () => void;
}

type DebugTab = 'waterfall' | 'events' | 'audio' | 'context' | 'sim';

const CATEGORIES: Array<DebugCategory | 'ALL'> = [
  'ALL',
  'STATE',
  'STT',
  'VAD',
  'LLM',
  'TTS',
  'AUDIO',
  'CONTEXT',
  'ERROR',
];

const CATEGORY_COLORS: Record<DebugCategory, string> = {
  STATE: 'bg-[#EDE5DB] text-[#5C4F45]',
  STT: 'bg-[#E6F4EC] text-[#2F7556]',
  VAD: 'bg-[#E3F3F1] text-[#2A7269]',
  LLM: 'bg-[#EEF0FC] text-[#4C5AB5]',
  TTS: 'bg-[#FEF4E6] text-[#B86E1D]',
  AUDIO: 'bg-[#FBECE6] text-[#B84531]',
  CONTEXT: 'bg-[#F3ECFA] text-[#6B4CA8]',
  ERROR: 'bg-[#FCE8E6] text-[#B43326]',
};

export function DebugDrawer({
  open,
  engineState,
  vadThreshold,
  onClose,
  onInjectUtterance,
  onSimulateBargeIn,
}: DebugDrawerProps) {
  const [tab, setTab] = useState<DebugTab>('waterfall');
  const [filter, setFilter] = useState<DebugCategory | 'ALL'>('ALL');
  const [snapshot, setSnapshot] = useState<DebugSnapshot>(() => debugStore.getSnapshot());
  const [simText, setSimText] = useState('今天北京天气怎么样，顺便推荐两个适合去的室内展馆？');

  useEffect(() => {
    if (!open) return;
    setSnapshot(debugStore.getSnapshot());
    return debugStore.subscribe(() => {
      setSnapshot(debugStore.getSnapshot());
    });
  }, [open]);

  if (!open) return null;

  const filteredEvents =
    filter === 'ALL'
      ? snapshot.events
      : snapshot.events.filter((e) => e.category === filter);

  const handleExport = () => {
    const blob = new Blob([debugStore.exportJson()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tomato-live-trace-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <aside className="fixed inset-0 z-40 md:static md:inset-auto w-full md:w-[440px] lg:w-[480px] shrink-0 border-l border-[#E8DDD0] bg-[#FAF6F1] flex flex-col h-[100dvh] md:h-full pb-[env(safe-area-inset-bottom)]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#E8DDD0] bg-[#F3ECE3]/80">
        <div className="flex items-center gap-2">
          <Bug className="h-4 w-4 text-[#E05D44]" />
          <span className="text-xs font-semibold text-[#2D241E]">开发者调试面板</span>
          <span className="rounded-md bg-[#FFFDF9] border border-[#E5D9CA] px-1.5 py-0.5 text-[10px] font-mono text-[#63564D]">
            {engineState}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleExport}
            title="导出调试 Trace JSON"
            className="p-1.5 rounded-lg hover:bg-[#E8DDD0]/70 text-[#7D6F64] hover:text-[#2D241E] cursor-pointer"
          >
            <Download className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={onClose}
            title="关闭调试面板 (Ctrl/Cmd+D)"
            className="p-1.5 rounded-lg hover:bg-[#E8DDD0]/70 text-[#7D6F64] hover:text-[#2D241E] cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-[#E8DDD0] bg-[#FFFDF9] text-[11px] font-medium">
        {(
          [
            ['waterfall', '延迟瀑布图', Gauge],
            ['events', '事件日志', Terminal],
            ['audio', '音频缓冲', Activity],
            ['context', '上下文溯源', Layers],
            ['sim', '模拟测试', Play],
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex-1 flex items-center justify-center gap-1 py-2.5 border-b-2 transition cursor-pointer ${
              tab === id
                ? 'border-[#E05D44] text-[#C94E38] bg-[#FAF6F1]/70'
                : 'border-transparent text-[#847569] hover:text-[#2D241E]'
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{label}</span>
          </button>
        ))}
      </div>

      {/* Tab Body */}
      <div className="flex-1 overflow-y-auto p-4 text-xs">
        {tab === 'waterfall' && (
          <div className="space-y-3">
            {snapshot.latencies.length === 0 ? (
              <p className="text-[#9C8D80] text-center py-8">
                发送一条语音或文字消息后，这里将展示每轮的延迟瀑布图。
              </p>
            ) : (
              [...snapshot.latencies].reverse().map((m) => {
                const maxBar = Math.max(
                  m.groundedCompleteMs ?? 0,
                  m.ttsFirstAudioMs ?? 0,
                  m.fastDraftMs ?? 0,
                  1500
                );
                return (
                  <div
                    key={m.turnId}
                    className="rounded-2xl border border-[#E8DDD0] bg-[#FFFDF9] p-3.5 space-y-2 shadow-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[11px] text-[#2D241E] truncate">
                        #{m.turnId} · {m.userText}
                      </span>
                      {m.interrupted && (
                        <span className="rounded-md bg-[#FDF1EC] text-[#BC4B36] border border-[#F0D3C9] px-1.5 py-0.5 text-[10px] shrink-0">
                          已打断 {m.bargeInStopMs !== undefined ? `${m.bargeInStopMs}ms` : ''}
                        </span>
                      )}
                    </div>

                    <MetricBar label="STT 判停" ms={m.sttFinalizeMs} max={maxBar} color="bg-[#449371]" />
                    <MetricBar label="Flash-Lite 首句" ms={m.fastDraftMs} max={maxBar} color="bg-[#E5983B]" />
                    <MetricBar label="TTS 首音 (TTFA)" ms={m.ttsFirstAudioMs} max={maxBar} color="bg-[#E05D44]" />
                    <MetricBar label="Hydrogen 首字" ms={m.groundedFirstTokenMs} max={maxBar} color="bg-[#5D6BC9]" />
                    <MetricBar label="S1→S2 衔接间隙" ms={m.handoffGapMs} max={maxBar} color="bg-[#D98A2B]" />
                  </div>
                );
              })
            )}
          </div>
        )}

        {tab === 'events' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2 pb-2">
              <div className="flex flex-wrap gap-1">
                {CATEGORIES.map((cat) => (
                  <button
                    key={cat}
                    onClick={() => setFilter(cat)}
                    className={`rounded-md px-1.5 py-0.5 text-[10px] font-mono cursor-pointer ${
                      filter === cat
                        ? 'bg-[#E05D44] text-[#FFFDF9]'
                        : 'bg-[#FFFDF9] border border-[#E8DDD0] text-[#7D6F64] hover:text-[#2D241E]'
                    }`}
                  >
                    {cat}
                  </button>
                ))}
              </div>
              <button
                onClick={() => debugStore.clearEvents()}
                title="清空日志"
                className="p-1 rounded-lg hover:bg-[#EDE4D9] text-[#7D6F64] cursor-pointer"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="space-y-1.5 font-mono text-[11px]">
              {[...filteredEvents].reverse().map((ev) => (
                <div
                  key={ev.id}
                  className="rounded-xl border border-[#E8DDD0] bg-[#FFFDF9] p-2.5 space-y-1"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="text-[#9C8D80]">
                      {new Date(ev.ts).toISOString().slice(11, 23)}
                    </span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[9px] font-semibold ${CATEGORY_COLORS[ev.category]}`}
                    >
                      {ev.category}
                    </span>
                    <span className="text-[#2D241E] break-all">{ev.message}</span>
                  </div>
                  {ev.payload !== undefined && (
                    <pre className="text-[10px] text-[#63564D] bg-[#FAF6F1] border border-[#EFE6DC] rounded-lg p-2 overflow-x-auto max-h-28">
                      {JSON.stringify(ev.payload, null, 2)}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'audio' && (
          <div className="space-y-4">
            <div className="rounded-2xl border border-[#E8DDD0] bg-[#FFFDF9] p-3.5 space-y-2">
              <div className="flex justify-between text-[11px]">
                <span className="text-[#4A3E35] font-medium">麦克风 RMS 能量 / VAD 阈值</span>
                <span className="font-mono text-[#8C7B6E]">
                  {snapshot.audio.micRms.toFixed(4)} / {vadThreshold.toFixed(3)}
                </span>
              </div>
              <div className="relative h-3 rounded-full bg-[#EFE6DC] overflow-hidden">
                <div
                  className={`h-full transition-all duration-75 ${
                    snapshot.audio.vadActive ? 'bg-[#449371]' : 'bg-[#E5983B]'
                  }`}
                  style={{ width: `${Math.min(100, (snapshot.audio.micRms / 0.1) * 100)}%` }}
                />
                <div
                  className="absolute top-0 bottom-0 w-0.5 bg-[#E05D44]"
                  style={{ left: `${Math.min(100, (vadThreshold / 0.1) * 100)}%` }}
                  title="VAD Threshold"
                />
              </div>
              <div className="flex items-center gap-3 text-[11px] text-[#7D6F64] font-mono">
                <span>VAD: {snapshot.audio.vadActive ? 'SPEAKING' : 'SILENT'}</span>
                <span>缓冲: {snapshot.audio.bufferedMs} ms</span>
                <span>增益: {snapshot.audio.gain.toFixed(2)}</span>
              </div>
            </div>

            <div className="rounded-2xl border border-[#E8DDD0] bg-[#FFFDF9] p-3.5 space-y-2.5">
              <h4 className="text-[11px] font-semibold text-[#4A3E35]">
                24kHz PCM 播报进度 (用于精确打断截断)
              </h4>
              {snapshot.audio.segments.length === 0 ? (
                <p className="text-[#9C8D80] text-[11px]">当前无排队音频片段</p>
              ) : (
                snapshot.audio.segments.map((seg) => {
                  const pct =
                    seg.totalSamples > 0
                      ? Math.min(100, Math.round((seg.samplesPlayed / seg.totalSamples) * 100))
                      : 0;
                  const isActive = seg.segmentId === snapshot.audio.activeSegmentId;
                  return (
                    <div key={seg.segmentId} className="space-y-1">
                      <div className="flex justify-between text-[11px]">
                        <span className="font-mono text-[#2D241E] truncate max-w-[72%]">
                          [{seg.stage}] {seg.text}
                        </span>
                        <span className="font-mono text-[#8C7B6E]">
                          {pct}% {isActive ? '▶' : ''}
                        </span>
                      </div>
                      <div className="h-1.5 rounded-full bg-[#EFE6DC] overflow-hidden">
                        <div
                          className={`h-full ${
                            seg.stage === 'fast' ? 'bg-[#E5983B]' : 'bg-[#5D6BC9]'
                          }`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}

        {tab === 'context' && (
          <div className="space-y-4">
            {snapshot.context.rollingSummary && (
              <div className="rounded-2xl border border-[#D8DCF5] bg-[#EEF0FC] p-3 space-y-1">
                <h4 className="text-[11px] font-semibold text-[#4C5AB5]">滚动摘要 (Rolling Summary)</h4>
                <p className="text-[11px] text-[#3B4485] leading-relaxed">
                  {snapshot.context.rollingSummary}
                </p>
              </div>
            )}

            {snapshot.context.lastGrounding && (
              <div className="rounded-2xl border border-[#DFD6F2] bg-[#F6F2FC] p-3 space-y-2">
                <h4 className="text-[11px] font-semibold text-[#664AA3]">
                  最近一次 Google 搜索溯源 (GroundingMetadata)
                </h4>
                {snapshot.context.lastGrounding.searchQueries.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {snapshot.context.lastGrounding.searchQueries.map((q, idx) => (
                      <span
                        key={idx}
                        className="rounded-md bg-[#FFFDF9] border border-[#DFD6F2] px-2 py-0.5 text-[10px] font-mono text-[#5B4294]"
                      >
                        🔍 {q}
                      </span>
                    ))}
                  </div>
                )}
                <ul className="space-y-1 text-[11px]">
                  {snapshot.context.lastGrounding.sources.map((s) => (
                    <li key={s.url} className="truncate">
                      <a
                        href={s.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[#4C5AB5] hover:underline"
                      >
                        {s.title}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="space-y-2">
              <h4 className="text-[11px] font-semibold text-[#4A3E35]">
                当前注入给 LLM 的精确上下文 ({snapshot.context.history.length} 轮)
              </h4>
              {snapshot.context.history.length === 0 ? (
                <p className="text-[#9C8D80] text-[11px]">上下文为空</p>
              ) : (
                snapshot.context.history.map((item, i) => (
                  <div
                    key={i}
                    className={`rounded-xl border p-2.5 text-[11px] space-y-1 ${
                      item.interrupted
                        ? 'border-[#F0D3C9] bg-[#FDF1EC]'
                        : 'border-[#E8DDD0] bg-[#FFFDF9]'
                    }`}
                  >
                    <div className="flex items-center justify-between font-mono text-[10px]">
                      <span className={item.role === 'user' ? 'text-[#C94E38]' : 'text-[#4C5AB5]'}>
                        {item.role.toUpperCase()}
                      </span>
                      {item.interrupted && (
                        <span className="text-[#BC4B36]">已按实际播报截断</span>
                      )}
                    </div>
                    <p className="text-[#2D241E] whitespace-pre-wrap">{item.text}</p>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {tab === 'sim' && (
          <div className="space-y-4">
            <div className="rounded-2xl border border-[#E8DDD0] bg-[#FFFDF9] p-3.5 space-y-2.5">
              <h4 className="text-[11px] font-semibold text-[#2D241E]">
                注入模拟发言（免麦克风测试双模型流水线）
              </h4>
              <textarea
                rows={3}
                value={simText}
                onChange={(e) => setSimText(e.target.value)}
                className="w-full rounded-xl bg-[#FAF6F1] border border-[#E5D9CA] p-2.5 text-xs text-[#2D241E] focus:outline-none focus:border-[#E05D44]"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => onInjectUtterance(simText)}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-[#E05D44] to-[#EB7852] hover:brightness-105 text-[#FFFDF9] py-2 text-xs font-medium cursor-pointer"
                >
                  <Play className="h-3.5 w-3.5" />
                  <span>发送测试发言</span>
                </button>
                <button
                  onClick={onSimulateBargeIn}
                  className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-[#F0D3C9] bg-[#FDF1EC] hover:bg-[#F9E3DA] text-[#B84531] px-3 py-2 text-xs font-medium cursor-pointer"
                >
                  <Scissors className="h-3.5 w-3.5" />
                  <span>模拟打断</span>
                </button>
              </div>
            </div>

            <div className="rounded-2xl border border-[#E8DDD0] bg-[#FFFDF9] p-3.5 space-y-2">
              <h4 className="text-[11px] font-semibold text-[#2D241E]">快捷中文测试语料</h4>
              <div className="flex flex-wrap gap-1.5">
                {[
                  '今天上海气温多少度，需要带伞吗？',
                  '帮我查一下最近 SpaceX 星舰试飞的最新进展',
                  '等等，先别说这个了，帮我推荐一家北京好吃的铜锅涮肉',
                  '用简单的话解释一下什么是 WebAudio AudioWorklet',
                ].map((sample) => (
                  <button
                    key={sample}
                    onClick={() => {
                      setSimText(sample);
                      onInjectUtterance(sample);
                    }}
                    className="text-left rounded-xl bg-[#FAF6F1] hover:bg-[#F1E8DD] border border-[#E8DDD0] px-2.5 py-1.5 text-[11px] text-[#4A3E35] cursor-pointer"
                  >
                    {sample}
                  </button>
                ))}
              </div>
            </div>

            <button
              onClick={handleExport}
              className="w-full inline-flex items-center justify-center gap-2 rounded-xl border border-[#E5D9CA] bg-[#FFFDF9] hover:bg-[#F3ECE3] text-[#4A3E35] py-2 text-xs font-medium cursor-pointer"
            >
              <Download className="h-3.5 w-3.5" />
              <span>导出完整调试日志 (JSON)</span>
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}

function MetricBar({
  label,
  ms,
  max,
  color,
}: {
  label: string;
  ms?: number;
  max: number;
  color: string;
}) {
  const pct = ms !== undefined ? Math.min(100, Math.max(2, (ms / max) * 100)) : 0;
  return (
    <div className="space-y-0.5">
      <div className="flex justify-between text-[10px]">
        <span className="text-[#7D6F64]">{label}</span>
        <span className="font-mono text-[#2D241E]">{ms !== undefined ? `${ms} ms` : '—'}</span>
      </div>
      <div className="h-1.5 rounded-full bg-[#EFE6DC] overflow-hidden">
        {ms !== undefined && <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />}
      </div>
    </div>
  );
}
