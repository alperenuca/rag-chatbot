'use client';

import { MessageSquare, MessageSquarePlus, Trash2, X } from 'lucide-react';

export interface ConversationSummary {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

interface ConversationSidebarProps {
  conversations: ConversationSummary[];
  activeConversationId: string | null;
  loading: boolean;
  isOpen: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onDelete: (id: string) => void;
}

function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays <= 0) {
    return date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  }
  if (diffDays === 1) return 'Dün';
  if (diffDays < 7) return `${diffDays} gün önce`;
  return date.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit' });
}

export default function ConversationSidebar({
  conversations,
  activeConversationId,
  loading,
  isOpen,
  onClose,
  onSelect,
  onNewChat,
  onDelete,
}: ConversationSidebarProps) {
  const handleDelete = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (window.confirm('Bu sohbeti silmek istediğinize emin misiniz?')) {
      onDelete(id);
    }
  };

  return (
    <>
      {isOpen && (
        <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={onClose} />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-72 flex-shrink-0 flex-col border-r border-slate-200 bg-slate-50 transition-transform duration-200 dark:border-slate-800 dark:bg-slate-950 md:static md:translate-x-0 ${
          isOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between gap-2 p-3">
          <button
            type="button"
            onClick={onNewChat}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-indigo-500"
          >
            <MessageSquarePlus className="h-4 w-4" />
            Yeni Sohbet
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-slate-400 hover:bg-slate-200 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-200 md:hidden"
            aria-label="Kenar çubuğunu kapat"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-1 overflow-y-auto px-2 pb-3">
          {loading && (
            <p className="px-3 py-2 text-xs text-slate-400 dark:text-slate-500">Yükleniyor…</p>
          )}

          {!loading && conversations.length === 0 && (
            <p className="px-3 py-8 text-center text-xs leading-relaxed text-slate-400 dark:text-slate-500">
              Henüz sohbetiniz yok.
              <br />
              Yukarıdan yeni bir sohbet başlatın.
            </p>
          )}

          {conversations.map((conv) => {
            const isActive = conv.id === activeConversationId;
            return (
              <div
                key={conv.id}
                role="button"
                tabIndex={0}
                onClick={() => onSelect(conv.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onSelect(conv.id);
                }}
                className={`group flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2.5 transition-colors ${
                  isActive
                    ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300'
                    : 'text-slate-600 hover:bg-slate-200/70 dark:text-slate-300 dark:hover:bg-slate-800/70'
                }`}
              >
                <MessageSquare className="h-4 w-4 flex-shrink-0 opacity-70" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{conv.title || 'Yeni Sohbet'}</p>
                  <p className="truncate text-[11px] text-slate-400 dark:text-slate-500">
                    {formatRelativeDate(conv.updated_at)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={(e) => handleDelete(e, conv.id)}
                  title="Sohbeti sil"
                  className="flex-shrink-0 rounded-md p-1.5 text-slate-400 opacity-0 transition-opacity hover:bg-red-100 hover:text-red-600 focus:opacity-100 group-hover:opacity-100 dark:hover:bg-red-900/30 dark:hover:text-red-400"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      </aside>
    </>
  );
}
