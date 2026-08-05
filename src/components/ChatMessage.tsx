'use client';

import { useState } from 'react';
import { Bot, Check, Copy, Flag, Loader2, User, X } from 'lucide-react';
import MarkdownContent from './MarkdownContent';
import ProductCarousel, { extractProductCards } from './ProductCarousel';
import SourcesAccordion, { type DocumentSource } from './SourcesAccordion';
import ThinkingSteps from './ThinkingSteps';
import type { ChatTraceStep } from '@/lib/chat-stream';
import { REPORT_REASON_MAX } from '@/lib/answer-reports';

export interface ChatMessageData {
  role: 'user' | 'assistant';
  content: string;
  /** DB mesaj id (rapor bağlamak için) */
  id?: string;
  /** Carousel + (gerekirse) kalıcı ürün kayıtları — tüm eşleşen ürünler */
  sources?: DocumentSource[];
  /** Kaynaklar paneli için kısa liste (opsiyonel; yoksa sources’tan kısaltılır) */
  citations?: DocumentSource[];
  timestamp?: number;
  /** SSE ile yazılırken true; kart/kaynak bitince kapanır */
  streaming?: boolean;
  /** Süreç adımları (düşünce şeffaflığı) */
  steps?: ChatTraceStep[];
  /** Bu cevap için rapor gönderildi */
  reported?: boolean;
}

// Backend, çoklu ürün yanıtlarında bu işareti metne yerleştirir (bkz.
// /api/chat/route.ts kural 0); burada onu, `sources` verisinden türetilen
// Yatay Kaydırılabilir Ürün Kartları (carousel) ile değiştiriyoruz. Bu
// sayede uzun ürün listeleri dikeyde sohbeti şişiren bir Markdown tablosu
// yerine, sabit yükseklikte yatayda kaydırılan kartlar olarak gösterilir.
const PRODUCT_CARDS_PLACEHOLDER = '[[URUN_KARTLARI]]';

function formatTime(timestamp?: number): string {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleTimeString('tr-TR', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function ChatMessage({
  message,
  onAskAboutProduct,
  askDisabled = false,
  reportContext,
  onReport,
}: {
  message: ChatMessageData;
  onAskAboutProduct?: (productTitle: string) => void;
  askDisabled?: boolean;
  /** Rapor için önceki kullanıcı sorusu + sohbet id */
  reportContext?: {
    userQuestion: string;
    conversationId: string | null;
  };
  onReport?: (payload: {
    reason: string;
    assistantReply: string;
    userQuestion: string;
    conversationId: string | null;
    messageId?: string;
  }) => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [reportBusy, setReportBusy] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const isUser = message.role === 'user';

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Panoya erişim reddedilirse sessizce yok say
    }
  };

  const handleSubmitReport = async () => {
    if (!onReport || reportBusy) return;
    const trimmed = reason.trim();
    if (trimmed.length < 3) {
      setReportError('Lütfen en az 3 karakterlik bir açıklama yazın.');
      return;
    }
    setReportBusy(true);
    setReportError(null);
    try {
      await onReport({
        reason: trimmed,
        assistantReply: message.content,
        userQuestion: reportContext?.userQuestion ?? '',
        conversationId: reportContext?.conversationId ?? null,
        messageId: message.id,
      });
      setReportOpen(false);
      setReason('');
    } catch (err) {
      setReportError(err instanceof Error ? err.message : 'Rapor gönderilemedi.');
    } finally {
      setReportBusy(false);
    }
  };

  const isStreaming = Boolean(message.streaming);
  const productCards = isUser ? [] : extractProductCards(message.sources);
  // Stream bitmeden kart/kaynak açma — yarım placeholder + boş sources titremesin
  const showCarousel =
    !isStreaming &&
    productCards.length > 0 &&
    message.content.includes(PRODUCT_CARDS_PLACEHOLDER);
  // Kartlar tüm ürünleri `sources`ta tutar; panelde 27 satır tekrarlama.
  // citations açıkça geldiyse (boş dizi dahil) ona uy — aksi halde politika
  // cevabında boş citations varken sources’taki ürünler panele sızıyordu.
  const accordionSources = isUser || isStreaming
    ? undefined
    : message.citations !== undefined
      ? message.citations
      : showCarousel
        ? message.sources?.slice(0, 3)
        : message.sources;
  const displayContent = isStreaming
    ? message.content.replaceAll(PRODUCT_CARDS_PLACEHOLDER, '')
    : message.content;
  const [beforeText, afterText] = showCarousel
    ? (() => {
        const [first, ...rest] = displayContent.split(PRODUCT_CARDS_PLACEHOLDER);
        return [first.trim(), rest.join(PRODUCT_CARDS_PLACEHOLDER).trim()];
      })()
    : [displayContent, ''];

  const canReport =
    !isUser &&
    !isStreaming &&
    Boolean(onReport) &&
    !message.content.startsWith('❌') &&
    message.content.trim().length > 0;

  return (
    <div className={`group flex items-end gap-2 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      <div
        className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center ${
          isUser
            ? 'bg-gradient-to-br from-red-600 to-red-500 text-white'
            : 'bg-neutral-100 text-neutral-500 border border-neutral-200'
        }`}
      >
        {isUser ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
      </div>

      <div
        className={`flex flex-col ${showCarousel ? 'max-w-[92%] sm:max-w-[90%]' : 'max-w-[80%]'} ${
          isUser ? 'items-end' : 'items-start'
        }`}
      >
        {isUser ? (
          <div className="rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap bg-gradient-to-br from-red-600 to-red-500 text-white rounded-br-md shadow-sm shadow-red-600/20">
            {message.content}
          </div>
        ) : (
          <div className="flex w-full flex-col gap-2">
            {(isStreaming || (message.steps && message.steps.length > 0)) && (
              <ThinkingSteps steps={message.steps ?? []} live={isStreaming} />
            )}
            {beforeText && (
              <div className="rounded-2xl px-4 py-3 text-sm leading-relaxed bg-white text-neutral-800 rounded-bl-md border border-neutral-200 shadow-sm shadow-neutral-900/5">
                <MarkdownContent content={beforeText} />
                {isStreaming && (
                  <span
                    className="ml-0.5 inline-block h-4 w-0.5 translate-y-0.5 animate-pulse bg-red-500"
                    aria-hidden
                  />
                )}
              </div>
            )}

            {showCarousel && (
              <ProductCarousel
                products={productCards}
                onAskAboutProduct={onAskAboutProduct}
                askDisabled={askDisabled}
              />
            )}

            {afterText && (
              <div className="rounded-2xl px-4 py-3 text-sm leading-relaxed bg-white text-neutral-800 rounded-bl-md border border-neutral-200 shadow-sm shadow-neutral-900/5">
                <MarkdownContent content={afterText} />
              </div>
            )}

            {/* Adım paneli varken boş cevapta ekstra nokta balonu gösterme */}
            {!showCarousel && !beforeText && !(isStreaming && !message.content) && (
              <div className="rounded-2xl px-4 py-3 text-sm leading-relaxed bg-white text-neutral-800 rounded-bl-md border border-neutral-200 shadow-sm shadow-neutral-900/5">
                <MarkdownContent content={displayContent} />
                {isStreaming && (
                  <span
                    className="ml-0.5 inline-block h-4 w-0.5 translate-y-0.5 animate-pulse bg-red-500"
                    aria-hidden
                  />
                )}
              </div>
            )}
            {!showCarousel && !beforeText && isStreaming && !message.content && (
              <div className="rounded-2xl px-4 py-2 text-xs text-neutral-400 border border-dashed border-neutral-200 bg-white/60">
                Cevap metni hazırlanıyor…
              </div>
            )}

            {!isUser && !isStreaming && <SourcesAccordion sources={accordionSources} />}

            {reportOpen && canReport && (
              <div className="w-full rounded-xl border border-neutral-200 bg-neutral-50 p-3 text-xs">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="font-medium text-neutral-700">Cevabı raporla</p>
                  <button
                    type="button"
                    onClick={() => {
                      setReportOpen(false);
                      setReportError(null);
                    }}
                    className="rounded p-0.5 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700"
                    aria-label="Kapat"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <p className="mb-2 text-neutral-500">
                  Kısa bir açıklama yazın; yönetim paneline iletilir.
                </p>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value.slice(0, REPORT_REASON_MAX))}
                  rows={3}
                  maxLength={REPORT_REASON_MAX}
                  placeholder="Örn. Fiyat yanlış / ürün listesi eksik / politika hatası…"
                  className="w-full resize-none rounded-lg border border-neutral-200 bg-white px-2.5 py-2 text-sm text-neutral-800 placeholder:text-neutral-400 focus:border-red-400 focus:outline-none focus:ring-2 focus:ring-red-100"
                />
                <div className="mt-2 flex items-center justify-between gap-2">
                  <span className="text-[10px] text-neutral-400">
                    {reason.trim().length}/{REPORT_REASON_MAX}
                  </span>
                  <button
                    type="button"
                    disabled={reportBusy || reason.trim().length < 3}
                    onClick={() => void handleSubmitReport()}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-red-500 disabled:opacity-50"
                  >
                    {reportBusy ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Flag className="h-3 w-3" />
                    )}
                    Gönder
                  </button>
                </div>
                {reportError && (
                  <p className="mt-2 text-[11px] text-red-600">{reportError}</p>
                )}
              </div>
            )}
          </div>
        )}

        <div className="mt-1 flex min-h-4 items-center gap-2 px-1">
          {message.timestamp && (
            <span className="text-[10px] text-neutral-400">{formatTime(message.timestamp)}</span>
          )}
          <button
            type="button"
            onClick={handleCopy}
            title="Mesajı kopyala"
            className="opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 text-neutral-400 hover:text-red-600"
          >
            {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
          </button>
          {canReport && !message.reported && (
            <button
              type="button"
              onClick={() => {
                setReportOpen((v) => !v);
                setReportError(null);
              }}
              title="Cevabı raporla"
              className="inline-flex items-center gap-1 text-[10px] text-neutral-400 opacity-0 transition-opacity hover:text-red-600 group-hover:opacity-100 focus:opacity-100"
            >
              <Flag className="h-3 w-3" />
              Raporla
            </button>
          )}
          {message.reported && (
            <span className="text-[10px] text-neutral-400">Raporlandı</span>
          )}
        </div>
      </div>
    </div>
  );
}
