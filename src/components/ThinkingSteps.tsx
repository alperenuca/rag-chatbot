'use client';

import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react';
import type { ChatTraceStep } from '@/lib/chat-stream';

const PHASE_LABEL: Record<ChatTraceStep['phase'], string> = {
  route: 'Yol',
  retrieve: 'Veri',
  filter: 'Filtre',
  llm: 'Model',
  tools: 'Araç',
  compose: 'Cevap',
};

export default function ThinkingSteps({
  steps,
  live = false,
}: {
  steps: ChatTraceStep[];
  /** Stream sırasında açık kalsın */
  live?: boolean;
}) {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (live) setOpen(true);
  }, [live, steps.length]);
  if (!live && !steps.length) return null;

  return (
    <div className="w-full max-w-full rounded-xl border border-neutral-200 bg-neutral-50/80 text-xs text-neutral-600">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left font-medium text-neutral-700 hover:bg-neutral-100/80"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
        )}
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-red-500" />
        <span>Nasıl yanıtladım</span>
        <span className="ml-auto font-normal text-neutral-400">
          {steps.length > 0 ? `${steps.length} adım` : 'bekleniyor'}
          {live ? ' · canlı' : ''}
        </span>
      </button>
      {open && (
        <ol className="space-y-1.5 border-t border-neutral-200 px-3 py-2">
          {steps.length === 0 && live && (
            <li className="text-neutral-400">Bağlantı kuruluyor, adımlar geliyor…</li>
          )}
          {steps.map((step, index) => (
            <li key={step.id} className="flex gap-2">
              <span className="mt-0.5 w-4 shrink-0 text-[10px] text-neutral-400">
                {index + 1}.
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="rounded bg-white px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-neutral-500 ring-1 ring-neutral-200">
                    {PHASE_LABEL[step.phase] ?? step.phase}
                  </span>
                  <span className="text-neutral-800">{step.label}</span>
                </div>
                {step.detail && (
                  <p className="mt-0.5 break-all font-mono text-[10px] text-neutral-400">
                    {step.detail}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
