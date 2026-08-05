/**
 * Chat SSE: UI stream:true ister; eval/JSON varsayılan kalır.
 * event: meta | delta | done | error
 */

export type ChatStreamPayload = {
  reply: string;
  sources: unknown[];
  citations: unknown[];
  conversationId: string | null;
  conversationTitle: string | null;
};

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

/** Tam payload hazır olduktan sonra SSE typewriter yanıtı. */
export function streamChatPayloadAsSSE(payload: ChatStreamPayload): Response {
  const encoder = new TextEncoder();
  const chunks = chunkReplyForStream(payload.reply);
  const delayMs = chunks.length <= 12 ? 18 : chunks.length <= 28 ? 12 : 8;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(encodeSseEvent(event, data)));
      };

      try {
        send('meta', {
          conversationId: payload.conversationId,
          conversationTitle: payload.conversationTitle,
        });

        for (const chunk of chunks) {
          send('delta', { text: chunk });
          await sleep(delayMs);
        }

        send('done', {
          reply: payload.reply,
          sources: payload.sources,
          citations: payload.citations,
          conversationId: payload.conversationId,
          conversationTitle: payload.conversationTitle,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Stream hatası';
        send('error', { error: message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

export type ChatSseHandlers = {
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

    if (event === 'meta' && data && typeof data === 'object') {
      handlers.onMeta?.(data as { conversationId?: string | null; conversationTitle?: string | null });
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
