'use client';

import { useState } from 'react';
import { BookOpen, ChevronDown, FileText, Package } from 'lucide-react';

export interface DocumentMetadata {
  source?: string;
  type?: string;
  title?: string;
  name?: string;
  sku?: string;
  category?: string;
  dimension?: string;
  material?: string;
  profile_thickness_mm?: string;
  color?: string;
  weight_kg?: number | null;
  price?: number | null;
  stock?: number;
  url?: string;
}

export interface DocumentSource {
  id?: string | number;
  content: string;
  similarity?: number;
  metadata?: DocumentMetadata;
}

function getSourceTitle(source: DocumentSource): string {
  const { metadata, content } = source;

  if (metadata?.type === 'product' && (metadata.title || metadata.name)) {
    return metadata.title ?? metadata.name!;
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
    <div className="rounded-xl border border-neutral-200 bg-white overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-neutral-50 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="flex-shrink-0 text-red-500">
            <SourceTypeIcon type={source.metadata?.type} />
          </span>
          <span className="truncate text-xs font-medium text-neutral-800">{title}</span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="hidden sm:inline-block text-[10px] uppercase tracking-wide font-semibold text-red-700 bg-red-50 px-2 py-0.5 rounded-full">
            {typeLabel}
          </span>
          {similarityPct !== null && (
            <span className="text-[10px] font-mono text-neutral-400">%{similarityPct}</span>
          )}
          <ChevronDown
            className={`w-3.5 h-3.5 text-neutral-400 transition-transform duration-200 ${
              expanded ? 'rotate-180' : ''
            }`}
          />
        </div>
      </button>
      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-neutral-100">
          <p className="text-xs text-neutral-600 whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto">
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
    <div className="mt-2 w-full">
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-expanded={isOpen}
        className="flex items-center gap-1.5 text-xs font-medium text-neutral-500 hover:text-red-600 transition-colors"
      >
        <ChevronDown
          className={`w-3.5 h-3.5 transition-transform duration-200 ${
            isOpen ? 'rotate-180' : '-rotate-90'
          }`}
        />
        Kaynaklar
        <span className="text-[10px] font-normal text-neutral-400">({sources.length})</span>
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
