'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Bot, Loader2, Menu } from 'lucide-react';
import ChatMessage, { ChatMessageData } from '@/components/ChatMessage';
import AuthScreen from '@/components/AuthScreen';
import UserMenu from '@/components/UserMenu';
import ConversationSidebar, { ConversationSummary } from '@/components/ConversationSidebar';
import { useAuth } from '@/context/AuthContext';
import {
  consumeChatSse,
  emitReplyChunks,
  type ChatStreamPayload,
  type ChatTraceStep,
} from '@/lib/chat-stream';
import type { DocumentSource } from '@/components/SourcesAccordion';

const WELCOME_MESSAGE: ChatMessageData = {
  role: 'assistant',
  content: 'Merhaba! Ürünlerimiz ve politikalarımız hakkında size nasıl yardımcı olabilirim?',
  timestamp: Date.now(),
};

const LOCAL_PENDING_STEP: ChatTraceStep = {
  id: 'local-pending',
  phase: 'route',
  label: 'İstek gönderildi, süreç izleniyor…',
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
        .filter((msg) => !msg.streaming)
        .filter((msg) => msg.content.trim().length > 0)
        .filter((msg) => !msg.content.startsWith('❌'))
        .filter((msg) => msg.content !== WELCOME_MESSAGE.content)
        .map((msg) => ({ role: msg.role, content: msg.content }));

      setInput('');
      const assistantTs = Date.now();
      setMessages((prev) => [
        ...prev,
        { role: 'user', content: userMessage, timestamp: Date.now() },
        {
          role: 'assistant',
          content: '',
          streaming: true,
          steps: [LOCAL_PENDING_STEP],
          timestamp: assistantTs,
        },
      ]);
      setLoading(true);

      const patchLastAssistant = (patch: Partial<ChatMessageData>) => {
        setMessages((prev) => {
          const next = [...prev];
          for (let i = next.length - 1; i >= 0; i -= 1) {
            if (next[i].role === 'assistant') {
              next[i] = { ...next[i], ...patch };
              break;
            }
          }
          return next;
        });
      };

      const appendAssistantStep = (step: ChatTraceStep) => {
        setMessages((prev) => {
          const next = [...prev];
          for (let i = next.length - 1; i >= 0; i -= 1) {
            if (next[i].role === 'assistant' && next[i].streaming) {
              const prevSteps = (next[i].steps ?? []).filter(
                (s) => s.id !== LOCAL_PENDING_STEP.id
              );
              if (prevSteps.some((s) => s.id === step.id)) break;
              next[i] = {
                ...next[i],
                steps: [...prevSteps, step],
              };
              break;
            }
          }
          return next;
        });
      };

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: userMessage,
            history: historyForRequest,
            conversationId,
            stream: true,
          }),
        });

        const contentType = response.headers.get('content-type') ?? '';
        const isSse = contentType.includes('text/event-stream');

        // Hata veya JSON (eval / eski API) — SSE değilse
        if (!response.ok || !isSse) {
          const data = await response.json().catch(() => ({}));
          if (!response.ok) {
            throw new Error(
              typeof data.error === 'string' ? data.error : 'Bir hata oluştu'
            );
          }
          if (data.conversationId) {
            setConversationId(data.conversationId);
            upsertConversationSummary(
              data.conversationId,
              data.conversationTitle ?? null
            );
          }
          const reply = typeof data.reply === 'string' ? data.reply : '';
          const steps = Array.isArray(data.steps)
            ? (data.steps as ChatTraceStep[])
            : undefined;
          if (steps?.length) patchLastAssistant({ steps });
          // JSON tek seferde gelir — kelime kelime yaz
          if (reply) {
            await emitReplyChunks(reply, (chunk) => {
              setMessages((prev) => {
                const next = [...prev];
                for (let i = next.length - 1; i >= 0; i -= 1) {
                  if (next[i].role === 'assistant' && next[i].streaming) {
                    next[i] = {
                      ...next[i],
                      content: `${next[i].content}${chunk}`,
                    };
                    break;
                  }
                }
                return next;
              });
            });
          }
          patchLastAssistant({
            content: reply,
            sources: data.sources as DocumentSource[] | undefined,
            citations: data.citations as DocumentSource[] | undefined,
            steps,
            streaming: false,
          });
          return;
        }

        let assembled = '';
        let liveStreaming = false;
        let lastDeltaAt = 0;
        // Obje ile tut: callback atamasını TS daraltmasın
        const sseBox: { done: ChatStreamPayload | null } = { done: null };
        const seenStepIds = new Set<string>();
        let stepQueue: Promise<void> = Promise.resolve();

        await consumeChatSse(response, {
          onMeta: (meta) => {
            if (meta.conversationId) {
              setConversationId(meta.conversationId);
              upsertConversationSummary(
                meta.conversationId,
                meta.conversationTitle ?? null
              );
            }
          },
          onStep: (step) => {
            if (seenStepIds.has(step.id)) return;
            seenStepIds.add(step.id);
            // Buffer’lı SSE’de adımlar aynı anda gelir → UI’da kademeli göster
            stepQueue = stepQueue.then(async () => {
              appendAssistantStep(step);
              await new Promise((r) => setTimeout(r, 90));
            });
          },
          onDelta: (text) => {
            assembled += text;
            const now = performance.now();
            if (lastDeltaAt > 0 && now - lastDeltaAt > 45) {
              liveStreaming = true;
            }
            lastDeltaAt = now;
            if (liveStreaming) {
              patchLastAssistant({ content: assembled });
            }
          },
          onDone: (data) => {
            sseBox.done = data;
            if (data.conversationId) {
              setConversationId(data.conversationId);
              upsertConversationSummary(
                data.conversationId,
                data.conversationTitle ?? null
              );
            }
          },
          onError: (message) => {
            throw new Error(message);
          },
        });

        await stepQueue;

        const completed = sseBox.done;
        const reply =
          typeof completed?.reply === 'string' && completed.reply.length > 0
            ? completed.reply
            : assembled;
        if (!reply.trim() && !completed) {
          throw new Error('Yanıt tamamlanamadı.');
        }

        // Proxy tüm gövdeyi tuttuysa delta’lar tek tick’te gelir → burada typewriter
        if (!liveStreaming && reply) {
          patchLastAssistant({ content: '' });
          await emitReplyChunks(reply, (chunk) => {
            setMessages((prev) => {
              const next = [...prev];
              for (let i = next.length - 1; i >= 0; i -= 1) {
                if (next[i].role === 'assistant' && next[i].streaming) {
                  next[i] = {
                    ...next[i],
                    content: `${next[i].content}${chunk}`,
                  };
                  break;
                }
              }
              return next;
            });
          });
        } else if (reply) {
          patchLastAssistant({ content: reply });
        }

        patchLastAssistant({
          content: reply,
          sources: completed?.sources as DocumentSource[] | undefined,
          citations: completed?.citations as DocumentSource[] | undefined,
          steps: completed?.steps,
          streaming: false,
        });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Yanıt alınamadı.';
        patchLastAssistant({
          content: `❌ Hata: ${errorMessage}`,
          streaming: false,
          sources: undefined,
          citations: undefined,
        });
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
