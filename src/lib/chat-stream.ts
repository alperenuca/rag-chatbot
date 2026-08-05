/**
 * Chat SSE: UI stream:true ister; eval/JSON varsayılan kalır.
 * event: status | meta | delta | done | error
 */

export type ChatStreamPayload = {
  reply: string;
  sources: unknown[];
  citations: unknown[];
  conversationId: string | null;
  conversationTitle: string | null;
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

/**
 * SSE’yi hemen açar (status: thinking), JSON chat işi bitince typewriter + done.
 * Böylece uzun LLM beklerken bağlantı ve UI balonu canlı kalır.
 */
export function streamFromChatJsonWork(
  work: () => Promise<Response>
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(encodeSseEvent(event, data)));
      };

      try {
        send('status', { phase: 'thinking' });

        const res = await work();
        let data: Record<string, unknown> = {};
        try {
          data = (await res.json()) as Record<string, unknown>;
        } catch {
          send('error', { error: 'Yanıt okunamadı' });
          return;
        }

        if (!res.ok) {
          send('error', {
            error:
              typeof data.error === 'string' ? data.error : 'Bir hata oluştu',
          });
          return;
        }

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
        };

        send('meta', {
          conversationId: payload.conversationId,
          conversationTitle: payload.conversationTitle,
        });

        const chunks = chunkReplyForStream(payload.reply);
        const delayMs =
          chunks.length <= 12 ? 18 : chunks.length <= 28 ? 12 : 8;
        for (const chunk of chunks) {
          send('delta', { text: chunk });
          await sleep(delayMs);
        }

        send('done', payload);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Stream hatası';
        send('error', { error: message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

/** @deprecated Tercihen streamFromChatJsonWork — hemen status gönderir */
export function streamChatPayloadAsSSE(payload: ChatStreamPayload): Response {
  return streamFromChatJsonWork(async () =>
    Response.json({
      reply: payload.reply,
      sources: payload.sources,
      citations: payload.citations,
      conversationId: payload.conversationId,
      conversationTitle: payload.conversationTitle,
    })
  );
}

export type ChatSseHandlers = {
  onStatus?: (data: { phase?: string }) => void;
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
