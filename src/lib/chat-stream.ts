/**
 * Chat SSE: UI stream:true ister; eval/JSON varsayılan kalır.
 * event: status | step | meta | delta | done | error
 *
 * step = düşünce/adım şeffaflığı (yol, sorgu, belgeler)
 * delta = cevap metni akışı
 */

export type ChatTracePhase =
  | 'route'
  | 'retrieve'
  | 'filter'
  | 'llm'
  | 'tools'
  | 'compose';

export type ChatTraceStep = {
  id: string;
  phase: ChatTracePhase;
  label: string;
  detail?: string;
};

export type ChatStreamPayload = {
  reply: string;
  sources: unknown[];
  citations: unknown[];
  conversationId: string | null;
  conversationTitle: string | null;
  steps?: ChatTraceStep[];
};

export type StreamWorkCallbacks = {
  onDelta: (text: string) => void;
  onStep: (step: ChatTraceStep) => void;
};

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const;

export function encodeSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Yanıtı okunaklı parçalara böl; uzun metinde animasyon ~1.2s’yi aşmasın. */
export function chunkReplyForStream(text: string): string[] {
  if (!text) return [];
  const parts = text.match(/\S+\s*|\s+/g) ?? [text];
  const maxChunks = 48;
  if (parts.length <= maxChunks) return parts;
  const batch = Math.ceil(parts.length / maxChunks);
  const chunks: string[] = [];
  for (let i = 0; i < parts.length; i += batch) {
    chunks.push(parts.slice(i, i + batch).join(''));
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Hazır metni UI’da kelime kelime akıt (deterministik / tool sonrası). */
export async function emitReplyChunks(
  text: string,
  onDelta: (text: string) => void
): Promise<void> {
  if (!text) return;
  const chunks = chunkReplyForStream(text);
  const delayMs = chunks.length <= 12 ? 18 : chunks.length <= 28 ? 12 : 8;
  for (const chunk of chunks) {
    onDelta(chunk);
    await sleep(delayMs);
  }
}

/**
 * SSE’yi hemen açar. work içinde step + delta basılabilir.
 */
export function streamFromChatJsonWork(
  work: (cb: StreamWorkCallbacks) => Promise<Response>
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Seri yaz + yield: bazı Next/dev proxy’leri aksi halde tüm SSE’yi
      // start() kapanana kadar tutuyor → UI’da sadece nokta, sonra tek sefer cevap.
      let writeChain: Promise<void> = Promise.resolve();
      const send = (event: string, data: unknown) => {
        writeChain = writeChain.then(async () => {
          controller.enqueue(encoder.encode(encodeSseEvent(event, data)));
          await sleep(0);
        });
        return writeChain;
      };

      const liveSteps: ChatTraceStep[] = [];
      const onDelta = (text: string) => {
        if (!text) return;
        void send('delta', { text });
      };
      const onStep = (step: ChatTraceStep) => {
        liveSteps.push(step);
        void send('step', step);
      };

      try {
        await send('status', { phase: 'thinking' });

        const res = await work({ onDelta, onStep });
        await writeChain;

        let data: Record<string, unknown> = {};
        try {
          data = (await res.json()) as Record<string, unknown>;
        } catch {
          await send('error', { error: 'Yanıt okunamadı' });
          return;
        }

        if (!res.ok) {
          await send('error', {
            error:
              typeof data.error === 'string' ? data.error : 'Bir hata oluştu',
          });
          return;
        }

        const stepsFromBody = Array.isArray(data.steps)
          ? (data.steps as ChatTraceStep[])
          : liveSteps;

        const payload: ChatStreamPayload = {
          reply: typeof data.reply === 'string' ? data.reply : '',
          sources: Array.isArray(data.sources) ? data.sources : [],
          citations: Array.isArray(data.citations) ? data.citations : [],
          conversationId:
            typeof data.conversationId === 'string' ? data.conversationId : null,
          conversationTitle:
            typeof data.conversationTitle === 'string'
              ? data.conversationTitle
              : null,
          steps: stepsFromBody,
        };

        await send('meta', {
          conversationId: payload.conversationId,
          conversationTitle: payload.conversationTitle,
        });

        await send('done', payload);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Stream hatası';
        await send('error', { error: message });
      } finally {
        await writeChain.catch(() => undefined);
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

export type ChatSseHandlers = {
  onStatus?: (data: { phase?: string }) => void;
  onStep?: (step: ChatTraceStep) => void;
  onMeta?: (data: {
    conversationId?: string | null;
    conversationTitle?: string | null;
  }) => void;
  onDelta?: (text: string) => void;
  onDone?: (data: ChatStreamPayload) => void;
  onError?: (message: string) => void;
};

/** Tarayıcıda SSE gövdesini oku (fetch ReadableStream). */
export async function consumeChatSse(
  response: Response,
  handlers: ChatSseHandlers
): Promise<void> {
  if (!response.body) {
    handlers.onError?.('Boş stream yanıtı');
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const dispatch = (rawEvent: string) => {
    const lines = rawEvent.split('\n');
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return;
    let data: unknown;
    try {
      data = JSON.parse(dataLines.join('\n'));
    } catch {
      return;
    }

    if (event === 'status' && data && typeof data === 'object') {
      handlers.onStatus?.(data as { phase?: string });
    } else if (
      event === 'step' &&
      data &&
      typeof data === 'object' &&
      typeof (data as ChatTraceStep).id === 'string' &&
      typeof (data as ChatTraceStep).label === 'string'
    ) {
      handlers.onStep?.(data as ChatTraceStep);
    } else if (event === 'meta' && data && typeof data === 'object') {
      handlers.onMeta?.(
        data as {
          conversationId?: string | null;
          conversationTitle?: string | null;
        }
      );
    } else if (
      event === 'delta' &&
      data &&
      typeof data === 'object' &&
      typeof (data as { text?: unknown }).text === 'string'
    ) {
      handlers.onDelta?.((data as { text: string }).text);
    } else if (event === 'done' && data && typeof data === 'object') {
      handlers.onDone?.(data as ChatStreamPayload);
    } else if (
      event === 'error' &&
      data &&
      typeof data === 'object' &&
      typeof (data as { error?: unknown }).error === 'string'
    ) {
      handlers.onError?.((data as { error: string }).error);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      if (part.trim()) dispatch(part);
    }
  }
  if (buffer.trim()) dispatch(buffer);
}
