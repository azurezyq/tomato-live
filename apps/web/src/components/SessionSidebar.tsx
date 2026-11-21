import { MessageSquarePlus, Trash2, LogOut, MessageCircle } from 'lucide-react';
import type { ChatSession } from '../types/chat';

interface SessionSidebarProps {
  sessions: ChatSession[];
  activeSessionId: string | null;
  userName: string;
  userPhoto?: string | null;
  onSelectSession: (id: string) => void;
  onCreateSession: () => void;
  onDeleteSession: (id: string) => void;
  onSignOut: () => void;
}

export function SessionSidebar({
  sessions,
  activeSessionId,
  userName,
  userPhoto,
  onSelectSession,
  onCreateSession,
  onDeleteSession,
  onSignOut,
}: SessionSidebarProps) {
  return (
    <aside className="hidden md:flex w-64 shrink-0 flex-col border-r border-[#E8DDD0] bg-[#F3ECE3]/85">
      <div className="p-4 border-b border-[#E8DDD0]">
        <button
          onClick={onCreateSession}
          className="w-full flex items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-[#E05D44] to-[#EC7B52] hover:brightness-105 text-[#FFFDF9] text-sm font-medium px-3 py-2.5 transition cursor-pointer shadow-sm shadow-[#E05D44]/20"
        >
          <MessageSquarePlus className="h-4 w-4" />
          <span>新建语音会话</span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2.5 space-y-1">
        {sessions.length === 0 ? (
          <p className="text-xs text-[#9C8D80] text-center py-8">暂无历史会话</p>
        ) : (
          sessions.map((s) => {
            const active = s.id === activeSessionId;
            return (
              <div
                key={s.id}
                onClick={() => onSelectSession(s.id)}
                className={`group flex items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-sm cursor-pointer transition ${
                  active
                    ? 'bg-[#FFFDF9] text-[#2D241E] font-medium shadow-xs border border-[#E8DDD0]'
                    : 'text-[#6A5D53] hover:bg-[#FAF6F1]/80 hover:text-[#2D241E]'
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <MessageCircle
                    className={`h-4 w-4 shrink-0 ${active ? 'text-[#E05D44]' : 'text-[#A29387]'}`}
                  />
                  <span className="truncate">{s.title || '新语音对话'}</span>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteSession(s.id);
                  }}
                  title="删除会话"
                  className="opacity-0 group-hover:opacity-100 p-1 rounded-lg hover:bg-[#F3E4DF] text-[#9C8D80] hover:text-[#C94B35] transition cursor-pointer"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })
        )}
      </div>

      <div className="p-3 border-t border-[#E8DDD0] flex items-center justify-between gap-2 bg-[#EFE6DC]/60">
        <div className="flex items-center gap-2.5 min-w-0">
          {userPhoto ? (
            <img
              src={userPhoto}
              alt={userName}
              className="h-7 w-7 rounded-full ring-2 ring-[#FFFDF9]"
            />
          ) : (
            <div className="h-7 w-7 rounded-full bg-[#E5D7C8] flex items-center justify-center text-xs font-medium text-[#4A3E35]">
              {userName.slice(0, 1).toUpperCase()}
            </div>
          )}
          <span className="text-xs text-[#4A3E35] font-medium truncate">{userName}</span>
        </div>
        <button
          onClick={onSignOut}
          title="退出登录"
          className="p-1.5 rounded-lg text-[#7D6F64] hover:text-[#2D241E] hover:bg-[#E8DDD0]/70 transition cursor-pointer"
        >
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </aside>
  );
}
