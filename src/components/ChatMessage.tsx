'use client';

import { useState } from 'react';
import { Bot, Check, Copy, User } from 'lucide-react';
import MarkdownContent from './MarkdownContent';
import ProductCarousel, { extractProductCards } from './ProductCarousel';
import SourcesAccordion, { type DocumentSource } from './SourcesAccordion';

export interface ChatMessageData {
  role: 'user' | 'assistant';
  content: string;
  /** Carousel + (gerekirse) kalıcı ürün kayıtları — tüm eşleşen ürünler */
  sources?: DocumentSource[];
  /** Kaynaklar paneli için kısa liste (opsiyonel; yoksa sources’tan kısaltılır) */
  citations?: DocumentSource[];
  timestamp?: number;
  /** SSE ile yazılırken true; kart/kaynak bitince kapanır */
  streaming?: boolean;
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
}: {
  message: ChatMessageData;
  onAskAboutProduct?: (productTitle: string) => void;
  askDisabled?: boolean;
}) {
  const [copied, setCopied] = useState(false);
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

  const isStreaming = Boolean(message.streaming);
  const productCards = isUser ? [] : extractProductCards(message.sources);
  // Stream bitmeden kart/kaynak açma — yarım placeholder + boş sources titremesin
  const showCarousel =
    !isStreaming &&
    productCards.length > 0 &&
    message.content.includes(PRODUCT_CARDS_PLACEHOLDER);
  // Kartlar tüm ürünleri `sources`ta tutar; panelde 27 satır tekrarlama.
  const accordionSources = isUser || isStreaming
    ? undefined
    : message.citations && message.citations.length > 0
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

            {!showCarousel && !beforeText && (
              <div className="rounded-2xl px-4 py-3 text-sm leading-relaxed bg-white text-neutral-800 rounded-bl-md border border-neutral-200 shadow-sm shadow-neutral-900/5">
                {isStreaming && !message.content ? (
                  <div
                    className="flex items-center gap-1.5 py-0.5"
                    aria-label="Yanıt hazırlanıyor"
                  >
                    <div className="h-2 w-2 animate-bounce rounded-full bg-red-400" />
                    <div className="h-2 w-2 animate-bounce rounded-full bg-red-400 [animation-delay:0.2s]" />
                    <div className="h-2 w-2 animate-bounce rounded-full bg-red-400 [animation-delay:0.4s]" />
                  </div>
                ) : (
                  <>
                    <MarkdownContent content={displayContent} />
                    {isStreaming && (
                      <span
                        className="ml-0.5 inline-block h-4 w-0.5 translate-y-0.5 animate-pulse bg-red-500"
                        aria-hidden
                      />
                    )}
                  </>
                )}
              </div>
            )}

            {!isUser && !isStreaming && <SourcesAccordion sources={accordionSources} />}
          </div>
        )}

        <div className="flex items-center gap-2 mt-1 px-1 h-4">
          {message.timestamp && (
            <span className="text-[10px] text-neutral-400">{formatTime(message.timestamp)}</span>
          )}
          <button
            type="button"
            onClick={handleCopy}
            title="Mesajı kopyala"
            className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity text-neutral-400 hover:text-red-600"
          >
            {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
          </button>
        </div>
      </div>
    </div>
  );
}
