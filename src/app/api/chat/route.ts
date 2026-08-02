import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import { createClient } from '@/lib/supabase/server';

// .env.local dosyasındaki değişkenleri zorla yükle
dotenv.config({ path: '.env.local', override: true });

// OpenAI istemcisi
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

interface MatchedDocument {
  content: string;
  metadata?: {
    title?: string;
    url?: string;
    type?: string;
    category?: string;
    [key: string]: unknown;
  };
}

// OpenAI'a gönderilecek geçmiş uzunluğunu makul bir sınırda tut.
const MAX_HISTORY_TURNS = 20;

// Gerçek kategori listesini her istekte veritabanından çekmek yerine kısa
// süreliğine önbellekte tutuyoruz (kategoriler sık değişmez).
const CATEGORY_CACHE_TTL_MS = 10 * 60 * 1000;
let categoryCache: { categories: string[]; expiresAt: number } | null = null;

/**
 * Kataloğumuzda GERÇEKTEN var olan ürün kategorilerini döner. Bu liste
 * modele verilir ki model "dekoratif ürünler" gibi var olmayan bir kategoriyi
 * kendisi önerip sonra "o da yok" diyerek kendisiyle çelişmesin (bkz. rule 8).
 */
async function getKnownCategories(
  supabase: Awaited<ReturnType<typeof createClient>>
): Promise<string[]> {
  if (categoryCache && categoryCache.expiresAt > Date.now()) {
    return categoryCache.categories;
  }

  const { data, error } = await supabase
    .from('documents')
    .select('metadata')
    .eq('metadata->>type', 'product');

  if (error || !data) {
    console.error('Kategori listesi getirilemedi:', error);
    return categoryCache?.categories ?? [];
  }

  const categories = Array.from(
    new Set(
      data
        .map((row) => (row.metadata as { category?: string } | null)?.category?.trim())
        .filter((category): category is string => Boolean(category))
    )
  ).sort();

  categoryCache = { categories, expiresAt: Date.now() + CATEGORY_CACHE_TTL_MS };
  return categories;
}

/**
 * Kullanıcının mesajı bilinen bir kategori adını doğrudan içeriyorsa o
 * kategoriyi döner (örn. "afiş çerçevesi ürünleriniz neler" -> "Afiş Çerçevesi").
 * Türkçe çekim ekleri ("çerçeveleri", "panosunu" vb.) tam ifade eşleşmesini
 * kaçırabileceğinden, kelime köküne (ilk ~5 karakter) göre de eşleştirme
 * yapılır. En uzun (en spesifik) eşleşme öncelikli.
 */
// Kullanıcının mesajı politika/destek konularından (iade, kargo, gizlilik
// vb.) bahsediyorsa, ürün dokümanı eşleşmemesi normaldir; bu durumda
// "genel/belirsiz ürün sorusu" fallback'ini (kategori listesi önerisi)
// TETİKLEMEMELİYİZ ki gerçek politika soruları normal şekilde cevaplanabilsin.
const POLICY_KEYWORDS = [
  'iade', 'degisim', 'değişim', 'kargo', 'teslimat', 'garanti', 'gizlilik',
  'cerez', 'çerez', 'odeme', 'ödeme', 'fatura', 'iletisim', 'iletişim',
  'sikayet', 'şikayet', 'sozlesme', 'sözleşme', 'tahkim', 'sms', 'politika',
  'hasarli', 'hasarlı', 'kusurlu', 'yasal',
];

function looksLikePolicyQuestion(text: string): boolean {
  const normalized = text.toLowerCase();
  return POLICY_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

function findMentionedCategory(message: string, knownCategories: string[]): string | null {
  const normalizeWord = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const messageWords = message.split(/\s+/).map(normalizeWord).filter(Boolean);

  const stemMatches = (word: string, target: string) => {
    const stemLength = Math.min(5, word.length);
    return word.slice(0, stemLength) === target.slice(0, stemLength);
  };

  const matches = knownCategories.filter((category) => {
    const normalizedMessage = message.toLowerCase();
    if (normalizedMessage.includes(category.toLowerCase())) return true;

    const categoryWords = category.split(/\s+/).map(normalizeWord).filter(Boolean);
    return categoryWords.every((catWord) =>
      messageWords.some((msgWord) => stemMatches(catWord, msgWord))
    );
  });

  if (matches.length === 0) return null;
  return matches.sort((a, b) => b.length - a.length)[0];
}

export async function POST(req: NextRequest) {
  try {
    const { message, conversationId, history } = await req.json();

    if (!message || typeof message !== 'string') {
      return NextResponse.json(
        { error: 'Genişletilmiş veya geçerli bir mesaj belirtilmedi.' },
        { status: 400 }
      );
    }

    const cleanHistory: HistoryTurn[] = Array.isArray(history)
      ? history
          .filter(
            (turn): turn is HistoryTurn =>
              turn &&
              (turn.role === 'user' || turn.role === 'assistant') &&
              typeof turn.content === 'string' &&
              !turn.content.startsWith('❌')
          )
          .slice(-MAX_HISTORY_TURNS)
      : [];

    // Supabase SSR istemcisi: pgvector aramasını ve oturum/kimlik bilgisini
    // aynı istekten okur.
    const supabase = await createClient();

    const {
      data: { user },
    } = await supabase.auth.getUser();

    // RAG asistanı yalnızca giriş yapmış kullanıcılara açıktır.
    if (!user) {
      return NextResponse.json(
        { error: 'Bu özelliği kullanmak için giriş yapmanız gerekiyor.' },
        { status: 401 }
      );
    }

    const knownCategories = await getKnownCategories(supabase);
    const knownCategoriesText =
      knownCategories.length > 0
        ? knownCategories.join(', ')
        : 'Kategori bilgisi şu anda alınamadı.';

    // Kullanıcı doğrudan bilinen bir kategori adından bahsediyorsa (örn.
    // "afiş çerçevesi ürünleriniz neler"), vektör aramasının rastgele TOP-5
    // sonucuna güvenmek yerine o kategorideki TÜM ürünleri veritabanından
    // çekiyoruz. Aksi halde 27 ürünlü bir kategoride sadece 5'i gösterilip
    // "eksik ürün gösteriyor" hissi yaratıyordu.
    //
    // Kategori adı SADECE şu anki mesajda değil, son mesajlarda (kendi veya
    // asistanın önceki yanıtında) da geçmiş olabilir. Örn. kullanıcı önce
    // "ürün satın alacağım" der, asistan "Afiş çerçevelerimiz mevcut" diye
    // yanıtlar, sonra kullanıcı "kaç adet ürününüz var" diye sorar - bu son
    // mesajda kategori adı geçmez ama konuşma bağlamında bellidir. Bu yüzden
    // önce şu anki mesaja, bulunamazsa son mesajlara (geçmişe) bakıyoruz;
    // böylece takip soruları da TÜM ürünler üzerinden doğru cevaplanır.
    const recentHistoryText = cleanHistory
      .slice(-6)
      .map((turn) => turn.content)
      .join(' ');
    const mentionedCategory =
      findMentionedCategory(message, knownCategories) ??
      findMentionedCategory(recentHistoryText, knownCategories);

    let documents: MatchedDocument[] = [];
    let usedCategoryBrowse = false;

    if (mentionedCategory) {
      const { data: categoryDocs, error: categoryError } = await supabase
        .from('documents')
        .select('content, metadata')
        .eq('metadata->>category', mentionedCategory)
        .order('metadata->>title', { ascending: true })
        .limit(50);

      if (categoryError) {
        console.error('Kategori ürünleri getirilemedi:', categoryError);
      } else if (categoryDocs && categoryDocs.length > 0) {
        documents = categoryDocs as MatchedDocument[];
        usedCategoryBrowse = true;
      }
    }

    if (!usedCategoryBrowse) {
      // 1. Kullanıcının sorduğu soru için embedding üret.
      //
      // Takip soruları ("bu ürün 500 TL'nin altında mı?", "peki stok durumu
      // ne?" gibi) tek başına, önceki bağlam olmadan embed edilirse ilgisiz
      // dokümanlarla eşleşebilir (çünkü "bu ürün" gibi zamirler hangi ürünü
      // kastettiğini anlatmaz). Bu yüzden son asistan yanıtını da embedding
      // girdisine ekleyerek aramayı konuşmanın bağlamına göre yönlendiriyoruz;
      // böylece hem doğru ürün bulunur hem de kullanıcıya gösterilen
      // "Kaynaklar" gerçekten konuşulan ürünle eşleşir.
      const lastAssistantMessage = cleanHistory
        .filter((turn) => turn.role === 'assistant')
        .slice(-1)[0]?.content;
      const embeddingInput = lastAssistantMessage
        ? `${lastAssistantMessage.slice(0, 2000)}\n\n${message}`
        : message;

      const embeddingResponse = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: embeddingInput,
      });
      const queryEmbedding = embeddingResponse.data[0].embedding;

      // 2. Supabase'deki `match_documents` SQL fonksiyonunu çağır.
      //
      // Politika dokümanları (iade/kargo/garanti vb.) uzun başlıklı markdown
      // metinleri olduğundan embedding benzerlikleri ürün dokümanlarına göre
      // daha düşük çıkabiliyor (örn. "iade politikanız nedir" sorgusu, gerçek
      // "İade Politikası" bölümüyle sadece ~0.26 benzerlik veriyor). Ürünler
      // için 0.3 eşiği isabetli olsa da politika sorularında bu eşik gerçek
      // içeriği eleyip context'i boş bırakabilir; bu da modelin (Rule 12'ye
      // aykırı şekilde) kendi genel bilgisinden uydurma bir politika cevabı
      // vermesine yol açar. Bu yüzden politika niyeti tespit edilen sorularda
      // eşiği gevşetiyoruz.
      const isPolicyQuestion = looksLikePolicyQuestion(message);
      const { data: matchedDocs, error } = await supabase.rpc('match_documents', {
        query_embedding: queryEmbedding,
        match_threshold: isPolicyQuestion ? 0.15 : 0.3, // Benzerlik eşiği
        match_count: 8,       // En yakın 8 içerik
      });

      if (error) {
        console.error('Supabase Vektör Arama Hatası:', error);
        return NextResponse.json(
          { error: 'Veritabanı araması sırasında hata oluştu.' },
          { status: 500 }
        );
      }

      documents = (matchedDocs ?? []) as MatchedDocument[];
    }

    // Kullanıcı belirli bir kategori/ürün belirtmemişse (örn. "sizde neler
    // var") vektör araması ya (a) hiçbir gerçek ÜRÜN dokümanına isabet
    // etmeyebilir (örn. bunun yerine zayıf bir benzerlikle politika metnine
    // eşleşebilir - "İçindekiler" gibi) ya da (b) birden fazla FARKLI
    // kategoriden ürün getirebilir. Her iki durumda da bu istek "kategori
    // bazlı gözat" değil "genel bilgi" isteğidir ve modelin bağlamdaki
    // rastgele/ilgisiz içerikten uydurma bir ürün tablosu kurmasını (örn.
    // sahte ürün/fiyat üretmesini veya kategori adını ürün adı gibi
    // kullanmasını) önlemek için modeli sadece gerçek kategori listesini
    // önermeye yönlendiriyoruz.
    const productDocuments = documents.filter((doc) => doc.metadata?.type === 'product');
    const distinctResultCategories = new Set(
      productDocuments
        .map((doc) => doc.metadata?.category?.trim())
        .filter((category): category is string => Boolean(category))
    );
    const isAmbiguousGenericQuery =
      !usedCategoryBrowse &&
      !looksLikePolicyQuestion(message) &&
      (productDocuments.length === 0 || distinctResultCategories.size > 1);

    // 3. İlgili dokümanları bağlam (context) haline getir. Ürünün satın alma
    // linkini (metadata.url) de bağlama ekliyoruz ki model sipariş taleplerinde
    // kullanıcıyı doğru sayfaya yönlendirebilsin (kendi link üretmesin).
    const hasRelevantContext = documents.length > 0;
    const contextText = hasRelevantContext
      ? documents
          .map((doc) => {
            const url = doc.metadata?.url;
            return url ? `${doc.content}\nÜrün Satın Alma Linki: ${url}` : doc.content;
          })
          .join('\n\n---\n\n')
      : 'BAĞLAMDA HİÇBİR İLGİLİ ÜRÜN BULUNAMADI. Kataloğumuzda bu isteğe uyan bir ürün yok.';

    // 4. Sistem Prompt'u hazırla ve GPT modeline gönder
    const systemPrompt = `Sen Ores.com.tr e-ticaret platformunun profesyonel, kibar ve çözüm odaklı AI Müşteri Danışmanısın.

GÖREVİN:
Kullanıcının sorularına sana verilen bağlamı (context) kullanarak şık, anlaşılır ve e-ticaret standartlarına uygun yanıtlar vermek.

FORMAT VE YAZIM KURALLARI (KESİNLİKLE UYULMALIDIR):
1. ÇOKLU ÜRÜNLERDE TABLO KULLAN: Çoklu ürün listelerken dümdüz metin listesi kullanma. Ürünleri şık ve okunaklı bir Markdown TABLOSU (Table) formatında sun.
   Tablo kolonları: | Ürün Adı | Detay/Ölçü | Fiyat | Stok | İşlem |
   İşlem sütununa ilgili ürünün [İncele](URL) linkini ekle (bağlamda o ürüne ait link yoksa bu hücreyi boş bırak, link icat etme).
   Örnek İdeal Format:
   | Ürün Adı | Detay/Ölçü | Fiyat | Stok | İşlem |
   |---|---|---|---|---|
   | B1 | 70x100 cm | 2.365 TL | 21 | [İncele](URL) |
   | B2 | 50x70 cm | 1.510 TL | 18 | [İncele](URL) |
   ÖNEMLİ: "Ürün Adı" sütununa SADECE bağlamdaki o ürünün gerçek "Ürün Adı:" alanını yaz. Kategori adını ("Afiş Çerçevesi", "Kaldırım Panosu" gibi) hiçbir zaman ürün adı olarak kullanma; kategori ile ürün adı farklı şeylerdir.
2. VARYASYONLARI BİRLEŞTİR: Aynı ürün grubunun farklı boyut/varyasyonlarını ayrı ayrı paragraflar halinde tekrar tekrar tanıtma; her varyasyonu tablonun farklı bir satırı olarak, "Detay/Ölçü" sütununda ayırt ederek sun.
3. MÜŞTERİ HİZMETLERİ TONU: Yanıtına nazik bir giriş ile başla ('Evet, ahşap desenli modellerimiz mevcuttur...') ve tablodan sonra kullanıcıya yardımcı olacak yönlendirici bir soru sor.
4. STOKTA OLMAYANLAR: Stokta olmayan ürünleri tablodan çıkarma; Stok sütununda "0 (Stokta yok)" şeklinde belirt. ÖNEMLİ: Bağlamda bir ürün varsa (stok 0 dahi olsa) bunu ASLA "bu kategoride ürün yok" diyerek gizleme; ürünü tabloya adıyla mutlaka ekle ve stok durumunu açıkça yaz. "Ürün yok" cevabı SADECE bağlamda o kategoriyle ilgili hiçbir ürün dokümanı yoksa verilir.
5. HAFIZAYI KORU: Kullanıcı "evet", "tamam", "sipariş ver" gibi onay/devam niteliğinde kısa yanıtlar verdiğinde, sohbet geçmişindeki en son konuşulan ürünü ve detaylarını hatırla. Başlangıç mesajına dönme; kaldığın yerden o ürünle ilgili sipariş veya detaylandırma sürecine devam et.
6. ASLA ÜRÜN İCAT ETME (EN ÖNEMLİ KURAL): Yalnızca aşağıdaki "BAĞLAM BİLGİLERİ" bölümünde ADI GEÇEN ürünleri, fiyatları, modelleri ve özellikleri kullan. Kendi genel bilgine veya tahminine dayanarak ASLA yeni bir ürün adı, model, fiyat veya kategori üretme/uydurma. Bağlamda kullanıcının istediği kategoriyle ilgili HİÇBİR ürün yoksa (örn. bağlamda "BAĞLAMDA HİÇBİR İLGİLİ ÜRÜN BULUNAMADI" notu varsa), bunu asla gizleme; kullanıcıya nazikçe bu kategoride şu anda ürün bulunmadığını söyle.
7. SADECE GERÇEK KATEGORİLERİ ÖNER: Aşağıdaki "KATALOĞUMUZDAKI GERÇEK KATEGORİLER" listesi, mağazamızda satılan TÜM kategorilerin kesin listesidir. Bir ürün/kategori bulunamadığında kullanıcıya alternatif önerirken SADECE bu listede yer alan kategori adlarını kullan. Bu listede olmayan bir kategori adını ("dekoratif ürünler", "mobilya", "ev eşyaları" gibi) ASLA var mış gibi öneri olarak söyleme; böyle bir şey söylersen ve kullanıcı onu sorarsa kendi kendinle çelişirsin. Listede tek bir kategori varsa, direkt o kategoriyi öner.
8. SİPARİŞ YÖNLENDİRME KURALI: Kullanıcı "sipariş etmek istiyorum", "satın al", "ekle" veya benzeri bir satın alma talebinde bulunduğunda ASLA adres, telefon veya ödeme bilgisi İSTEME. Bunun yerine, bağlamdaki ilgili ürünün "Ürün Satın Alma Linki" değerini kullanarak kullanıcıyı doğrudan o ürünün satın alma sayfasına yönlendir.
    Örnek Yanıt Formatı: "A1 Alüminyum Çerçeve ürününü satın almak için [A1 Alüminyum Çerçeve](https://magaza.ores.com.tr/products/...) sayfasını ziyaret edebilirsiniz. Başka sorularınız olursa yanıtlamaktan memnuniyet duyarım."
    STOK KONTROLÜ (ÇOK ÖNEMLİ): Kullanıcı belirli bir ADET belirttiğinde ("3 adet almak istiyorum" gibi), bu adedi bağlamdaki ürünün gerçek Stok değeriyle KARŞILAŞTIR.
    - İstenen adet stoktan FAZLA ise: ASLA "X adet sipariş verebilirsiniz" diyerek onaylama. Bunun yerine kibarca stokta sadece o kadar (gerçek stok sayısı) adet bulunduğunu belirt, mevcut stok kadarını sipariş edip edemeyeceğini sor ve yine de satın alma linkini paylaş (linkten adet seçimi kullanıcının kendisi tarafından yapılacaktır).
    - İstenen adet stok kadar veya daha az ise: normal şekilde satın alma linkine yönlendir.
9. LİNK GÜVENLİĞİ VE FORMATI: Bir ürün linki paylaşırken (tablo içindeki "İncele" linki dahil) SADECE bağlamdaki o ürüne ait "Ürün Satın Alma Linki" değerini kullan; hiçbir zaman kendi başına bir URL üretme, tahmin etme veya bağlamda linki olmayan bir ürüne link verme. Bağlamda ilgili ürünün linki yoksa link vermeden ürünü tanıt. Verdiğin linkleri her zaman markdown formatında [Metin](URL) şeklinde, tıklanabilir olarak yaz.
10. HİÇBİR ÜRÜNÜ ATLAMA: Kullanıcı bir kategorideki ürünleri sorduğunda, bağlamda o kategoriye ait kaç ürün varsa (5, 10, 27 fark etmez) TÜMÜNÜ tabloya ekle; "birkaç örnek" göstererek veya sayıyı azaltarak kısaltma yapma. Tablo uzun olsa da tam ve eksiksiz olmalı.
11. SAYISAL/FİYAT KARŞILAŞTIRMALARINDA TUTARLILIK (ÇOK ÖNEMLİ): Kullanıcı bir fiyatın/sayının belirli bir değerin altında, üstünde veya eşit olup olmadığını sorduğunda ("500 TL'nin altında mı?", "1000 TL'den ucuz mu?" gibi), ÖNCE aritmetik karşılaştırmayı zihninde doğru şekilde yap, SONRA cevabına başla. Cevabının başındaki "Evet"/"Hayır" ifadesi ile devamındaki açıklama ASLA birbiriyle çelişmemeli (örn. "Hayır, fiyatı 420 TL'dir, bu da 500 TL'nin altında" demek yasaktır - 420 < 500 olduğu için doğru cevap "Evet"tir). Cevap vermeden önce karşılaştırmayı iki kez kontrol et.
12. TEKNİK SORGULAR VE POLİTİKALAR (İADE/KARGO): Eğer kullanıcı kargo süresi, iade koşulları veya garanti gibi bir kurumsal politika soruyorsa, bağlamdaki kurumsal politika dokümanlarına dayanarak kısa ve net cevap ver. Politika bilgisi bağlamda yoksa uydurma yapma, müşteri hizmetleri ekibine yönlendir.
${
  isAmbiguousGenericQuery
    ? `13. GENEL/BELİRSİZ SORU KURALI: Kullanıcının mesajı belirli bir kategori veya ürün belirtmiyor (örn. "sizde neler var", "ne satıyorsunuz") ve bağlamda ya hiçbir gerçek ürün dokümanı yok ya da birden fazla FARKLI kategoriden ürün var. Bu durumda ASLA kendi kendine örnek/varsayımsal bir ürün tablosu icat etme veya bağlamdaki ilgisiz (örn. politika) içerikten ürün üretme. Sadece aşağıdaki "KATALOĞUMUZDAKI GERÇEK KATEGORİLER" listesindeki kategori adlarını kullanıcıya söyle ve hangi kategoriyle ilgilendiğini sor.`
    : ''
}

KATALOĞUMUZDAKI GERÇEK KATEGORİLER:
${knownCategoriesText}

BAĞLAM BİLGİLERİ:
${contextText}`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        ...cleanHistory.map((turn) => ({ role: turn.role, content: turn.content })),
        { role: 'user', content: message },
      ],
      temperature: 0.2,
    });

    const reply = completion.choices[0].message.content;

    // 5. Sohbeti ve mesajları kalıcı olarak sakla.
    const conversationResult = await ensureConversation(
      supabase,
      user.id,
      typeof conversationId === 'string' ? conversationId : undefined,
      message
    );
    const activeConversationId = conversationResult?.id ?? null;

    if (activeConversationId) {
      const { error: insertError } = await supabase.from('messages').insert([
        {
          conversation_id: activeConversationId,
          user_id: user.id,
          role: 'user',
          content: message,
        },
        {
          conversation_id: activeConversationId,
          user_id: user.id,
          role: 'assistant',
          content: reply,
          sources: documents,
        },
      ]);

      if (insertError) {
        // Mesajlar kaydedilemese bile yanıtı kullanıcıya döndürmeye devam et;
        // ancak hatayı sessizce yutmayıp logla (örn. şema henüz kurulmamışsa
        // burada görünür).
        console.error('Mesajlar kaydedilemedi:', insertError);
      }
    } else {
      console.error('Sohbet oturumu oluşturulamadığı için mesajlar kaydedilmedi.');
    }

    return NextResponse.json({
      reply,
      sources: documents,
      conversationId: activeConversationId,
      conversationTitle: conversationResult?.title ?? null,
    });
  } catch (err: unknown) {
    console.error('Chat API Error:', err);
    const errorMessage = err instanceof Error ? err.message : 'Sunucu hatası';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}

interface ConversationResult {
  id: string;
  title: string | null;
}

/**
 * İlk kullanıcı mesajından kısa, okunabilir bir sohbet başlığı üretir
 * (sidebar'da "Yeni Sohbet" yerine gösterilir).
 */
function buildTitle(message: string): string {
  const trimmed = message.trim().replace(/\s+/g, ' ');
  return trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed;
}

/**
 * Verilen conversationId kullanıcıya aitse onu döner; geçersizse veya
 * belirtilmemişse kullanıcı için yeni bir sohbet oturumu oluşturur. Başlığı
 * henüz atanmamış (null) sohbetlere -"Yeni Sohbet" butonuyla oluşturulmuş
 * boş sohbetler dahil- ilk mesajdan otomatik başlık atar.
 */
async function ensureConversation(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  conversationId: string | undefined,
  firstMessage: string
): Promise<ConversationResult | null> {
  if (conversationId) {
    const { data } = await supabase
      .from('conversations')
      .select('id, title')
      .eq('id', conversationId)
      .eq('user_id', userId)
      .maybeSingle();

    if (data?.id) {
      if (!data.title) {
        const title = buildTitle(firstMessage);
        await supabase.from('conversations').update({ title }).eq('id', data.id);
        return { id: data.id as string, title };
      }
      return { id: data.id as string, title: data.title as string };
    }
  }

  const title = buildTitle(firstMessage);
  const { data: newConversation, error } = await supabase
    .from('conversations')
    .insert({ user_id: userId, title })
    .select('id, title')
    .single();

  if (error || !newConversation) {
    console.error('Sohbet oturumu oluşturulamadı:', error);
    return null;
  }

  return { id: newConversation.id as string, title: newConversation.title as string };
}
