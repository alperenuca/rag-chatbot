'use client';

import { useState } from 'react';
import { BookOpen, ChevronDown, FileText, Package } from 'lucide-react';

export interface DocumentMetadata {
  source?: string;
  type?: string;
  name?: string;
  category?: string;
  price?: number;
  stock?: number;
}

export interface DocumentSource {
  id?: string | number;
  content: string;
  similarity?: number;
  metadata?: DocumentMetadata;
}

function getSourceTitle(source: DocumentSource): string {
  const { metadata, content } = source;

  if (metadata?.type === 'product' && metadata.name) {
    return metadata.name;
  }

  if (metadata?.type === 'policy') {
    const heading = content.match(/^#{1,3}\s*(.+)$/m);
    if (heading) return heading[1].trim();
  }

  const firstLine = content.split('\n').find((line) => line.trim().length > 0);
  return firstLine ? firstLine.replace(/^#+\s*/, '').slice(0, 60) : 'Kaynak';
}

function getTypeLabel(type?: string): string {
  if (type === 'product') return 'Ürün';
  if (type === 'policy') return 'Politika';
  return 'Belge';
}

function SourceTypeIcon({ type }: { type?: string }) {
  const className = 'w-3.5 h-3.5';
  if (type === 'product') return <Package className={className} />;
  if (type === 'policy') return <BookOpen className={className} />;
  return <FileText className={className} />;
}

function SourceCard({ source }: { source: DocumentSource }) {
  const [expanded, setExpanded] = useState(false);
  const title = getSourceTitle(source);
  const typeLabel = getTypeLabel(source.metadata?.type);
  const similarityPct =
    typeof source.similarity === 'number' ? Math.round(source.similarity * 100) : null;

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800/80 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700/60 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="flex-shrink-0 text-blue-600 dark:text-blue-400">
            <SourceTypeIcon type={source.metadata?.type} />
          </span>
          <span className="truncate text-xs font-medium text-gray-800 dark:text-gray-100">
            {title}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="hidden sm:inline-block text-[10px] uppercase tracking-wide font-semibold text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-900/40 px-2 py-0.5 rounded-full">
            {typeLabel}
          </span>
          {similarityPct !== null && (
            <span className="text-[10px] font-mono text-gray-400 dark:text-gray-500">
              %{similarityPct}
            </span>
          )}
          <ChevronDown
            className={`w-3.5 h-3.5 text-gray-400 transition-transform duration-200 ${
              expanded ? 'rotate-180' : ''
            }`}
          />
        </div>
      </button>
      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-gray-100 dark:border-gray-700">
          <p className="text-xs text-gray-600 dark:text-gray-300 whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto">
            {source.content}
          </p>
        </div>
      )}
    </div>
  );
}

export default function SourcesAccordion({ sources }: { sources?: DocumentSource[] }) {
  const [isOpen, setIsOpen] = useState(false);

  if (!sources || sources.length === 0) return null;

  return (
    <div className="mt-2 w-full max-w-[80%]">
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-expanded={isOpen}
        className="flex items-center gap-1.5 text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
      >
        <ChevronDown
          className={`w-3.5 h-3.5 transition-transform duration-200 ${
            isOpen ? 'rotate-180' : '-rotate-90'
          }`}
        />
        Kaynaklar
        <span className="text-[10px] font-normal text-gray-400 dark:text-gray-500">
          ({sources.length})
        </span>
      </button>

      {isOpen && (
        <div className="mt-2 space-y-1.5">
          {sources.map((source, index) => (
            <SourceCard key={source.id ?? index} source={source} />
          ))}
        </div>
      )}
    </div>
  );
}
