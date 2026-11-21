import { useEffect, useRef } from 'react';
import { ExternalLink, Globe, Zap, Scissors, Sparkles } from 'lucide-react';
import type { ChatMessage } from '../types/chat';
import type { LiveDraftState } from '../engine/liveChatEngine';

interface TranscriptFeedProps {
  messages: ChatMessage[];
  interimTranscript: string;
  draft: LiveDraftState | null;
}

export function TranscriptFeed({ messages, interimTranscript, draft }: TranscriptFeedProps) {
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, interimTranscript, draft?.fastOpening, draft?.groundedContinuation]);

  if (messages.length === 0 && !interimTranscript && !draft) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
        <div className="h-14 w-14 rounded-3xl bg-[#F4E9DE] border border-[#E8DDD0] flex items-center justify-center mb-4">
          <Sparkles className="h-6 w-6 text-[#E05D44]" />
        </div>
        <p className="text-base font-medium text-[#2D241E] mb-2">
          你好，我是番茄实时语音助手
        </p>
        <p className="text-xs text-[#7D6F64] max-w-md leading-relaxed">
          点击下方麦克风即可开始自然对话。Flash-Lite 将在约 0.3 秒内快速起句播报，同时
          Gemini 4 Hydrogen 在后台结合 Google 搜索续写精准回答；你随时可以插话打断。
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 md:px-8 py-5 space-y-4">
      {messages.map((msg) => {
        const isUser = msg.role === 'user';
        const unspokenTail =
          msg.interrupted && msg.fullGeneratedText
            ? computeUnspokenRemainder(msg.spokenText, msg.fullGeneratedText)
            : '';

        return (
          <div key={msg.id} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] md:max-w-[74%] rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-xs ${
                isUser
                  ? 'bg-gradient-to-br from-[#E05D44] to-[#EA7853] text-[#FFFDF9] rounded-br-sm shadow-[#E05D44]/15'
                  : 'bg-[#FFFDF9] border border-[#E8DDD0] text-[#2D241E] rounded-bl-sm shadow-[#D6C4B0]/20'
              }`}
            >
              {!isUser && (
                <div className="flex flex-wrap items-center gap-1.5 mb-2 text-[11px]">
                  {msg.fastOpening && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-[#FEF4E6] text-[#B86E1D] border border-[#F2DFC2] px-2 py-0.5 font-medium">
                      <Zap className="h-3 w-3" />
                      Flash-Lite 首句
                    </span>
                  )}
                  {msg.groundingSources && msg.groundingSources.length > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-[#EEF0FC] text-[#4C5AB5] border border-[#D8DCF5] px-2 py-0.5 font-medium">
                      <Globe className="h-3 w-3" />
                      Hydrogen 联网
                    </span>
                  )}
                  {msg.interrupted && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-[#FDF1EC] text-[#BC4B36] border border-[#F0D3C9] px-2 py-0.5 font-medium">
                      <Scissors className="h-3 w-3" />
                      已打断
                    </span>
                  )}
                  {msg.latencyMetrics?.ttsFirstAudioMs !== undefined && (
                    <span className="text-[#9B8B7E] font-mono text-[10px]">
                      TTFA {msg.latencyMetrics.ttsFirstAudioMs}ms
                    </span>
                  )}
                </div>
              )}

              <p className="whitespace-pre-wrap break-words">
                <span>{msg.spokenText}</span>
                {unspokenTail && (
                  <span
                    className="text-[#B4A599] line-through decoration-[#E05D44]/40 ml-1"
                    title="未播报部分（未写入模型上下文）"
                  >
                    {unspokenTail}
                  </span>
                )}
              </p>

              {!isUser && msg.groundingSources && msg.groundingSources.length > 0 && (
                <div className="mt-2.5 pt-2.5 border-t border-[#EFE6DC] flex flex-wrap gap-1.5">
                  {msg.groundingSources.slice(0, 5).map((src) => (
                    <a
                      key={src.url}
                      href={src.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 rounded-lg bg-[#F7F1E9] hover:bg-[#EFE5D8] border border-[#E8DDD0] px-2 py-1 text-[11px] text-[#5C4F45] transition max-w-[220px]"
                    >
                      <ExternalLink className="h-3 w-3 shrink-0 text-[#8F7F72]" />
                      <span className="truncate">{src.title}</span>
                    </a>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}

      {/* Live streaming assistant draft */}
      {draft && (
        <div className="flex justify-start">
          <div className="max-w-[85%] md:max-w-[74%] rounded-2xl rounded-bl-sm px-4 py-3 text-sm leading-relaxed bg-[#FFFDF9] border border-[#EAB6A5] text-[#2D241E] shadow-sm shadow-[#E05D44]/10">
            <div className="flex items-center gap-1.5 mb-2 text-[11px]">
              <span className="inline-flex items-center gap-1 rounded-full bg-[#FEF4E6] text-[#B86E1D] border border-[#F2DFC2] px-2 py-0.5 font-medium">
                <Zap className="h-3 w-3" />
                实时播报中
              </span>
              {draft.groundedContinuation && (
                <span className="inline-flex items-center gap-1 rounded-full bg-[#EEF0FC] text-[#4C5AB5] border border-[#D8DCF5] px-2 py-0.5 font-medium">
                  <Globe className="h-3 w-3" />
                  Hydrogen 续写
                </span>
              )}
            </div>
            <p className="whitespace-pre-wrap break-words">
              <span className="text-[#8F5318]">{draft.fastOpening}</span>
              <span className="text-[#2D241E]">{draft.groundedContinuation}</span>
              <span className="inline-block w-1.5 h-4 bg-[#E05D44] ml-0.5 align-middle animate-pulse rounded-full" />
            </p>
          </div>
        </div>
      )}

      {/* Live interim user speech */}
      {interimTranscript && (
        <div className="flex justify-end">
          <div className="max-w-[85%] md:max-w-[74%] rounded-2xl rounded-br-sm px-4 py-2.5 text-sm bg-[#FBECE6] border border-[#EFC9BC] text-[#8F3A2B] italic">
            {interimTranscript}
            <span className="inline-block w-1.5 h-3.5 bg-[#E05D44] ml-1 align-middle animate-pulse rounded-full" />
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}

function computeUnspokenRemainder(spokenText: string, fullText: string): string {
  const cleanSpoken = spokenText
    .replace(/——\[用户打断\]$/, '')
    .replace(/\s*—\s*\[interrupted by user\]$/, '')
    .replace(/^\[尚未播报即被用户打断\]$/, '')
    .replace(/^\[interrupted before audio began\]$/, '');

  if (!cleanSpoken) return fullText;
  if (fullText.startsWith(cleanSpoken)) {
    return fullText.slice(cleanSpoken.length);
  }
  return '';
}
