'use client';

import { useState } from 'react';
import { Bot, Check, Copy, User } from 'lucide-react';
import MarkdownContent from './MarkdownContent';
import SourcesAccordion, { DocumentSource } from './SourcesAccordion';

export interface ChatMessageData {
  role: 'user' | 'assistant';
  content: string;
  sources?: DocumentSource[];
  timestamp?: number;
}

function formatTime(timestamp?: number): string {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleTimeString('tr-TR', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function ChatMessage({ message }: { message: ChatMessageData }) {
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

  return (
    <div className={`group flex items-end gap-2 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      <div
        className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center ${
          isUser
            ? 'bg-indigo-600 text-white'
            : 'bg-slate-200 dark:bg-slate-600 text-slate-600 dark:text-slate-200'
        }`}
      >
        {isUser ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
      </div>

      <div className={`flex flex-col max-w-[80%] ${isUser ? 'items-end' : 'items-start'}`}>
        <div
          className={`rounded-2xl px-4 py-3 text-sm leading-relaxed ${
            isUser
              ? 'whitespace-pre-wrap bg-indigo-600 text-white rounded-br-none'
              : 'bg-slate-100 dark:bg-slate-700 text-slate-900 dark:text-slate-100 rounded-bl-none border border-slate-200 dark:border-slate-600'
          }`}
        >
          {isUser ? message.content : <MarkdownContent content={message.content} />}
        </div>

        <div className="flex items-center gap-2 mt-1 px-1 h-4">
          {message.timestamp && (
            <span className="text-[10px] text-slate-400 dark:text-slate-500">
              {formatTime(message.timestamp)}
            </span>
          )}
          <button
            type="button"
            onClick={handleCopy}
            title="Mesajı kopyala"
            className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400"
          >
            {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
          </button>
        </div>

        {!isUser && <SourcesAccordion sources={message.sources} />}
      </div>
    </div>
  );
}
