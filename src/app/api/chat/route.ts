import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import dotenv from 'dotenv';

// .env.local dosyasındaki değişkenleri zorla yükle
dotenv.config({ path: '.env.local', override: true });

// Supabase istemcisi
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// OpenAI istemcisi
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function POST(req: NextRequest) {
  try {
    const { message } = await req.json();

    if (!message || typeof message !== 'string') {
      return NextResponse.json(
        { error: 'Genişletilmiş veya geçerli bir mesaj belirtilmedi.' },
        { status: 400 }
      );
    }

    // 1. Kullanıcının sorduğu soru için embedding üret
    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: message,
    });
    const queryEmbedding = embeddingResponse.data[0].embedding;

    // 2. Supabase'deki `match_documents` SQL fonksiyonunu çağır
    const { data: documents, error } = await supabase.rpc('match_documents', {
      query_embedding: queryEmbedding,
      match_threshold: 0.3, // Benzerlik eşiği
      match_count: 5,       // En yakın 5 içerik
    });

    if (error) {
      console.error('Supabase Vektör Arama Hatası:', error);
      return NextResponse.json(
        { error: 'Veritabanı araması sırasında hata oluştu.' },
        { status: 500 }
      );
    }

    // 3. İlgili dokümanları bağlam (context) haline getir
    const contextText =
      documents && documents.length > 0
        ? documents.map((doc: { content: string }) => doc.content).join('\n\n---\n\n')
        : 'İlgili bilgi bulunamadı.';

    // 4. Sistem Prompt'u hazırla ve GPT modeline gönder
    const systemPrompt = `Sen bir e-ticaret müşteri hizmetleri asistanısın. 
Aşağıda verilen bağlam (context) bilgilerini kullanarak kullanıcının sorusuna nazik, doğru ve net bir cevap ver. 
Eğer verilen bağlamda aranan bilgi tam olarak yoksa, bilmediğini nazikçe ifade et ve kesinlikle yanlış bilgi üretme.

BAĞLAM BİLGİLERİ:
${contextText}`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message },
      ],
      temperature: 0.2,
    });

    const reply = completion.choices[0].message.content;

    return NextResponse.json({
      reply,
      sources: documents, // İleride arayüzde kaynak göstermek istersen
    });
  } catch (err: unknown) {
    console.error('Chat API Error:', err);
    const errorMessage = err instanceof Error ? err.message : 'Sunucu hatası';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}