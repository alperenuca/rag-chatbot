'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Bot, Loader2, Menu } from 'lucide-react';
import ChatMessage, { ChatMessageData } from '@/components/ChatMessage';
import AuthScreen from '@/components/AuthScreen';
import UserMenu from '@/components/UserMenu';
import ConversationSidebar, { ConversationSummary } from '@/components/ConversationSidebar';
import { useAuth } from '@/context/AuthContext';

const WELCOME_MESSAGE: ChatMessageData = {
  role: 'assistant',
  content: 'Merhaba! Ürünlerimiz ve politikalarımız hakkında size nasıl yardımcı olabilirim?',
  timestamp: Date.now(),
};

interface StoredMessageRow {
  role: 'user' | 'assistant';
  content: string;
  sources?: ChatMessageData['sources'];
  created_at: string;
}

export default function Home() {
  const { user, loading: authLoading } = useAuth();
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessageData[]>([WELCOME_MESSAGE]);
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, loading]);

  const loadConversationMessages = useCallback(async (id: string) => {
    setHistoryLoading(true);
    try {
      const response = await fetch(`/api/conversations/${id}`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Sohbet yüklenemedi.');
      }

      const rows: StoredMessageRow[] = data.messages ?? [];
      setMessages(
        rows.length > 0
          ? rows.map((row) => ({
              role: row.role,
              content: row.content,
              sources: row.sources,
              timestamp: new Date(row.created_at).getTime(),
            }))
          : [WELCOME_MESSAGE]
      );
    } catch (error) {
      console.error('Sohbet yüklenirken hata:', error);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const fetchConversations = useCallback(async () => {
    try {
      const response = await fetch('/api/conversations');
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Sohbet listesi yüklenemedi.');
      }

      const list: ConversationSummary[] = data.conversations ?? [];
      setConversations(list);

      if (list.length > 0) {
        setConversationId(list[0].id);
        await loadConversationMessages(list[0].id);
      } else {
        setConversationId(null);
        setMessages([WELCOME_MESSAGE]);
      }
    } catch (error) {
      console.error('Sohbet listesi yüklenirken hata:', error);
    } finally {
      setListLoading(false);
    }
  }, [loadConversationMessages]);

  // Kullanıcı giriş yaptığında sohbet listesini yükle, çıkış yaptığında sıfırla.
  // ÖNEMLİ: Supabase, sekme değiştirip geri gelindiğinde oturum belirtecini
  // arka planda tazeler ve bu her seferinde YENİ bir `user` nesne referansı
  // üretir. Bağımlılığı `user` nesnesi yerine sabit kalan `user?.id`'ye
  // bağlayarak, aynı kullanıcı için geçmişin gereksiz yere ve konuşmayı
  // sıfırlayarak yeniden çekilmesini engelliyoruz.
  const userId = user?.id ?? null;

  useEffect(() => {
    if (authLoading) return;

    if (userId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- kullanıcı değiştiğinde listeyi sunucudan çekmeden önce yükleniyor durumunu işaretliyoruz.
      setListLoading(true);
      fetchConversations();
    } else {
      setConversations([]);
      setConversationId(null);
      setMessages([WELCOME_MESSAGE]);
    }
  }, [userId, authLoading, fetchConversations]);

  const upsertConversationSummary = useCallback((id: string, title: string | null) => {
    setConversations((prev) => {
      const now = new Date().toISOString();
      const existing = prev.find((c) => c.id === id);
      const updated: ConversationSummary = existing
        ? { ...existing, title: title ?? existing.title, updated_at: now }
        : { id, title, created_at: now, updated_at: now };
      const rest = prev.filter((c) => c.id !== id);
      return [updated, ...rest];
    });
  }, []);

  const handleNewChat = async () => {
    setSidebarOpen(false);
    try {
      const response = await fetch('/api/conversations', { method: 'POST' });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Yeni sohbet oluşturulamadı.');
      }

      const newConversation = data.conversation as ConversationSummary;
      setConversations((prev) => [newConversation, ...prev]);
      setConversationId(newConversation.id);
      setMessages([WELCOME_MESSAGE]);
    } catch (error) {
      console.error('Yeni sohbet oluşturulurken hata:', error);
    }
  };

  const handleSelectConversation = (id: string) => {
    setSidebarOpen(false);
    if (id === conversationId) return;
    setConversationId(id);
    loadConversationMessages(id);
  };

  const handleDeleteConversation = async (id: string) => {
    try {
      const response = await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Sohbet silinemedi.');
      }

      const remaining = conversations.filter((c) => c.id !== id);
      setConversations(remaining);

      if (id === conversationId) {
        if (remaining.length > 0) {
          setConversationId(remaining[0].id);
          await loadConversationMessages(remaining[0].id);
        } else {
          setConversationId(null);
          setMessages([WELCOME_MESSAGE]);
        }
      }
    } catch (error) {
      console.error('Sohbet silinirken hata:', error);
    }
  };

  const sendMessage = useCallback(
    async (rawMessage: string) => {
      // historyLoading tamamlanmadan mesaj gönderilirse conversationId henüz
      // set edilmemiş olabilir; bu, aynı kullanıcı için yanlışlıkla ikinci bir
      // sohbet oturumu oluşmasına (ve görünen geçmişin "kaybolmasına") yol açar.
      const userMessage = rawMessage.trim();
      if (!userMessage || loading || historyLoading) return;

      // Karşılama mesajını OpenAI geçmişine gönderme; aksi halde model onu
      // gerçek bir asistan turu sanıp bağlamı bozabiliyor.
      const historyForRequest = messages
        .filter((msg) => !msg.content.startsWith('❌'))
        .filter((msg) => msg.content !== WELCOME_MESSAGE.content)
        .map((msg) => ({ role: msg.role, content: msg.content }));

      setInput('');
      setMessages((prev) => [
        ...prev,
        { role: 'user', content: userMessage, timestamp: Date.now() },
      ]);
      setLoading(true);

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: userMessage,
            history: historyForRequest,
            conversationId,
          }),
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || 'Bir hata oluştu');
        }

        if (data.conversationId) {
          setConversationId(data.conversationId);
          upsertConversationSummary(data.conversationId, data.conversationTitle ?? null);
        }

        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: data.reply, sources: data.sources, timestamp: Date.now() },
        ]);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Yanıt alınamadı.';
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: `❌ Hata: ${errorMessage}`,
            timestamp: Date.now(),
          },
        ]);
      } finally {
        setLoading(false);
      }
    },
    [loading, historyLoading, messages, conversationId, upsertConversationSummary]
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await sendMessage(input);
  };

  const handleAskAboutProduct = useCallback(
    (productTitle: string) => {
      void sendMessage(`${productTitle} hakkında detaylı bilgi verir misin?`);
    },
    [sendMessage]
  );

  // Giriş yapılmadan RAG asistanına erişilemez: önce yükleme, sonra
  // giriş/kayıt ekranı gösterilir; chat arayüzü yalnızca girişli kullanıcıya açılır.
  if (authLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#fefbfa]">
        <Loader2 className="h-6 w-6 animate-spin text-red-600" />
      </main>
    );
  }

  if (!user) {
    return <AuthScreen />;
  }

  const activeTitle = conversations.find((c) => c.id === conversationId)?.title;

  return (
    <div className="flex h-screen w-full overflow-hidden bg-[#fefbfa]">
      <ConversationSidebar
        conversations={conversations}
        activeConversationId={conversationId}
        loading={listLoading}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onSelect={handleSelectConversation}
        onNewChat={handleNewChat}
        onDelete={handleDeleteConversation}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <header className="flex items-center justify-between gap-3 border-b border-neutral-200 bg-white/85 px-4 py-3 backdrop-blur-sm">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              className="rounded-lg p-2 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 md:hidden"
              aria-label="Sohbet listesini aç"
            >
              <Menu className="h-5 w-5" />
            </button>
            <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-red-600 to-red-500 text-white shadow-sm shadow-red-600/25">
              <Bot className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold leading-tight text-neutral-800">
                {activeTitle || 'RAG Asistanı'}
              </h1>
              <span className="text-[11px] font-mono text-neutral-400">
                gpt-4o-mini + pgvector
              </span>
            </div>
          </div>
          <UserMenu />
        </header>

        {/* Mesaj Listesi */}
        <div className="flex-1 overflow-y-auto px-4 py-6 md:px-8">
          <div className="mx-auto max-w-3xl space-y-4">
            {historyLoading && (
              <div className="flex justify-center py-6 text-xs text-neutral-400">
                Sohbet yükleniyor…
              </div>
            )}

            {!historyLoading &&
              messages.map((msg, index) => (
                <ChatMessage
                  key={index}
                  message={msg}
                  onAskAboutProduct={handleAskAboutProduct}
                  askDisabled={loading || historyLoading}
                />
              ))}

            {loading && (
              <div className="flex items-end gap-2">
                <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-500 border border-neutral-200">
                  <Bot className="h-4 w-4" />
                </div>
                <div className="flex items-center gap-2 rounded-2xl rounded-bl-md border border-neutral-200 bg-white px-4 py-3 text-sm text-neutral-500 shadow-sm shadow-neutral-900/5">
                  <div className="h-2 w-2 animate-bounce rounded-full bg-red-400" />
                  <div className="h-2 w-2 animate-bounce rounded-full bg-red-400 [animation-delay:0.2s]" />
                  <div className="h-2 w-2 animate-bounce rounded-full bg-red-400 [animation-delay:0.4s]" />
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Input Formu */}
        <div className="border-t border-neutral-200 bg-white px-4 py-4 md:px-8">
          <form onSubmit={handleSubmit} className="mx-auto flex max-w-3xl gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={historyLoading}
              placeholder={
                historyLoading
                  ? 'Sohbet yükleniyor...'
                  : 'Ürün veya politika hakkında bir şey sorun...'
              }
              className="flex-1 rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-900 placeholder-neutral-400 transition-colors focus:border-red-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-100 disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={loading || historyLoading || !input.trim()}
              className="rounded-xl bg-gradient-to-r from-red-600 to-red-500 px-5 py-3 text-sm font-medium text-white shadow-sm shadow-red-600/25 transition-all hover:shadow-md hover:shadow-red-600/35 focus:outline-none disabled:opacity-50 disabled:shadow-none"
            >
              Gönder
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
