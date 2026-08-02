import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
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
 * kendisi önerip sonra "o da yok" diyerek kendisiyle çelişmesin (bkz. rule 7)
 * ve search_products aracını çağırırken sadece gerçek kategori adlarını
 * kullansın.
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

/**
 * Kullanıcının (veya search_products aracına verdiği) bir metin bilinen
 * kategori adlarından hangisine karşılık geliyorsa BULUNAN TÜM kategorileri
 * döner (örn. "afiş çerçevesi" -> ["Afiş Çerçevesi"]). Türkçe çekim ekleri
 * ("çerçeveleri", "panosunu" vb.) tam ifade eşleşmesini kaçırabileceğinden,
 * kelime köküne (ilk ~5 karakter) göre de eşleştirme yapılır.
 */
function findMentionedCategories(message: string, knownCategories: string[]): string[] {
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

  return matches.sort((a, b) => b.length - a.length);
}

// "En ağır", "en pahalı", "hangisi" gibi TEK bir ürünü hedefleyen sıralama/
// karşılaştırma sorularında otomatik kategori taramasını (bkz.
// isLikelyDirectCategoryBrowse) ZORLAMIYORUZ; bu durumlarda modelin
// search_products'ı doğru sort_by + limit=1 parametreleriyle çağırmasına
// izin veriyoruz ki yanıtta SADECE o 1 ürünün kartı görünsün.
const RANKING_OR_SINGLE_ITEM_KEYWORDS = [
  'en ağır', 'en hafif', 'en pahalı', 'en ucuz', 'en büyük', 'en küçük',
  'en yüksek', 'en düşük', 'hangisi', 'hangi ürün', 'kaçıncı', 'hangi biri',
];

function looksLikeRankingOrSingleItemQuestion(text: string): boolean {
  const normalized = text.toLowerCase();
  return RANKING_OR_SINGLE_ITEM_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

/**
 * Kullanıcı mesajı KISA ve doğrudan bilinen bir kategori adını içeriyorsa
 * (örn. botun "Afiş Çerçevesi mi, Kaldırım Panosu mu?" sorusuna sadece
 * "afiş çerçevesi" cevabı verildiğinde), bu net bir "kategoriyi listele"
 * isteğidir ve search_products'ı modelin kararına bırakmadan biz doğrudan
 * çalıştırırız (böylece match_count sınırlı baseline aramasına bağlı
 * kalınmaz). Bu tespiti KASITLI OLARAK katı tutuyoruz (tam ifade eşleşmesi +
 * en fazla ~6 kelime + sıralama/tekil ürün sorusu değil) ki "çerçevenin
 * ağırlığı kaç kilo" gibi tekil ürün detay sorularında veya "en ağır afiş
 * çerçevesi hangisi" gibi sıralama sorularında yanlışlıkla tüm kategoriyi
 * kart olarak göstermeyelim (bkz. Tool Output/Message State çakışması bug'ı).
 */
function isLikelyDirectCategoryBrowse(message: string, knownCategories: string[]): string[] {
  if (looksLikeRankingOrSingleItemQuestion(message)) return [];

  const wordCount = message.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount === 0 || wordCount > 6) return [];

  const normalizedMessage = message.toLowerCase();
  return knownCategories.filter((category) => normalizedMessage.includes(category.toLowerCase()));
}

/**
 * Model, [[URUN_KARTLARI]] yer tutucusunu tam olarak bu şekilde metne
 * yazmalıdır (bkz. kural 0). Frontend, mesaj içeriğinde bu işareti bulduğunda
 * onu, aynı yanıtla birlikte dönen `sources` (documents) verisinden türetilen
 * Yatay Kaydırılabilir Ürün Kartları (ProductCarousel) bileşeniyle
 * değiştirir. Böylece uzun ürün listeleri artık dikeyde sayfayı şişiren bir
 * Markdown tablosu yerine, chat'in dikey boyutunu sabit tutan bir carousel
 * olarak gösterilir.
 */
const PRODUCT_CARDS_PLACEHOLDER = '[[URUN_KARTLARI]]';

// ---------------------------------------------------------------------------
// OpenAI Function Calling (Tool Use): search_products
//
// Fiyat filtreleme ("500 TL altı") ve stok kontrolü gibi kesin/sayısal veri
// gerektiren işlemleri LLM'in context'inden serbest metin olarak "anlamasına"
// bırakmak yerine, model bu bilgiyi yapılandırılmış parametrelere (max_price,
// min_price, in_stock_only...) çevirip bu aracı çağırıyor; biz de sorguyu
// doğrudan Supabase'e (PostgREST üzerinden jsonb sayısal karşılaştırmalarla)
// atıp %100 doğru sonucu döndürüyoruz. Model yalnızca dönen veriyi (frontend'in
// ürün kartları olarak render edeceği [[URUN_KARTLARI]] yer tutucusuyla)
// sunmaktan sorumlu, filtrelemeden değil.
// ---------------------------------------------------------------------------

type SortBy = 'price_asc' | 'price_desc' | 'weight_asc' | 'weight_desc' | 'stock_asc' | 'stock_desc';

interface SearchProductsArgs {
  category?: string;
  max_price?: number;
  min_price?: number;
  in_stock_only?: boolean;
  query_text?: string;
  sort_by?: SortBy;
  limit?: number;
}

function buildSearchProductsTool(knownCategoriesText: string): ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: 'search_products',
      description:
        'ORES ürün kataloğunda kesin kriterlere göre ürün arar/filtreler/sıralar. Kullanıcı bir fiyat filtresi ("500 TL altı", "1000 TL üzeri"), bir SIRALAMA/ÜSTÜNLÜK sorusu ("en ucuz", "en pahalı", "en ağır", "en hafif", "en çok stokta olan"), stok durumu ("stokta olanlar") veya belirli bir kategori/ürün adı belirttiğinde MUTLAKA bu fonksiyonu çağır; bu tür filtrelemeleri/sıralamaları KENDİN (bağlamdaki metne bakarak) yapmaya ÇALIŞMA - context uzun olduğunda satır/ürün atlayabilir veya AĞIRLIK ile FİYATI birbirine karıştırabilirsin, bu fonksiyon veritabanından %100 doğru sonuç getirir. Kullanıcı TEK bir ürünü hedefliyorsa ("en ağır ürün HANGİSİ", "en pahalı ürün NEDİR" gibi) VE bir kategori belirtmediyse, category alanını BOŞ bırakarak fonksiyonu SADECE BİR KEZ çağır (TÜM kategorilerde arama yapılır) ve limit=1 vererek SADECE o 1 ürünün dönmesini sağla; bu durumda kategori kategori ayrı ayrı ÇAĞIRMA. Kullanıcı AÇIKÇA birden fazla kategori istediyse (örn. "iki kategori de") bu fonksiyonu her kategori için ayrı ayrı çağırabilirsin.',
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            description: `Ürün kategorisi. Kullanıcı belirli bir kategori BELİRTMEDİYSE (örn. "en ağır ürün hangisi" gibi genel bir soru) bu alanı BOŞ bırak; TÜM kategorilerde tek bir arama yapılır. Belirtildiyse şu bilinen kategorilerden birini kullan: ${knownCategoriesText}`,
          },
          max_price: {
            type: 'number',
            description: 'Ürünün fiyatı bu değerden KÜÇÜK OLMALI (TL). Örn. kullanıcı "500 TL altı" derse max_price=500.',
          },
          min_price: {
            type: 'number',
            description: 'Ürünün fiyatı bu değerden BÜYÜK OLMALI (TL). Örn. kullanıcı "1000 TL üzeri" derse min_price=1000.',
          },
          in_stock_only: {
            type: 'boolean',
            description: 'true ise sadece stokta olan (stok > 0) ürünler döner. Kullanıcı "stokta olanlar" gibi bir şey söylemediyse belirtme/false bırak.',
          },
          query_text: {
            type: 'string',
            description: 'Ürün adında aranacak serbest metin (örn. bir model kodu, malzeme veya renk). Sadece belirli bir ürün/anahtar kelime aranıyorsa doldur.',
          },
          sort_by: {
            type: 'string',
            enum: ['price_asc', 'price_desc', 'weight_asc', 'weight_desc', 'stock_asc', 'stock_desc'],
            description:
              'Sonuçları sıralamak için kullan. FİYAT (TL) ve AĞIRLIK (kg) birbirinden TAMAMEN FARKLI alanlardır, ASLA karıştırma: "en pahalı"->price_desc, "en ucuz"->price_asc, "en ağır"->weight_desc, "en hafif"/"en ince"->weight_asc, "en çok stokta olan"->stock_desc.',
          },
          limit: {
            type: 'number',
            description:
              'Döndürülecek maksimum ürün sayısı. Kullanıcı TEK bir ürün istiyorsa ("en ağır ürün hangisi" gibi) limit=1 ver; bir liste/kategori istiyorsa BELİRTME (varsayılan olarak tüm eşleşen sonuçlar döner).',
          },
        },
      },
    },
  };
}

/**
 * search_products aracının gerçek uygulaması: parametreleri doğrudan
 * Supabase sorgusuna çevirir. Fiyat/stok karşılaştırmaları PostgREST'in
 * jsonb sayısal filtreleme desteğiyle (`metadata->price` üzerinde lte/gte)
 * veritabanı seviyesinde yapılır; böylece LLM'in kendi matematiğine hiç
 * ihtiyaç kalmaz.
 */
async function executeSearchProducts(
  supabase: Awaited<ReturnType<typeof createClient>>,
  knownCategories: string[],
  args: SearchProductsArgs
): Promise<MatchedDocument[]> {
  let query = supabase.from('documents').select('content, metadata').eq('metadata->>type', 'product');

  if (args.category && args.category.trim()) {
    // Modelin verdiği serbest metin, bilinen kategori adıyla tam örtüşmeyebilir
    // (örn. "çerçeveler" vs "Afiş Çerçevesi"); önce fuzzy eşleştirmeyi dene,
    // bulunamazsa ILIKE ile geniş bir eşleşmeye düş.
    const resolvedCategory = findMentionedCategories(args.category, knownCategories)[0];
    query = resolvedCategory
      ? query.eq('metadata->>category', resolvedCategory)
      : query.ilike('metadata->>category', `%${args.category.trim()}%`);
  }

  if (typeof args.max_price === 'number' && Number.isFinite(args.max_price)) {
    query = query.filter('metadata->price', 'lte', args.max_price);
  }
  if (typeof args.min_price === 'number' && Number.isFinite(args.min_price)) {
    query = query.filter('metadata->price', 'gte', args.min_price);
  }
  if (args.in_stock_only) {
    query = query.filter('metadata->stock', 'gt', 0);
  }
  if (args.query_text && args.query_text.trim()) {
    // Virgül/parantez gibi PostgREST'in `or()` sözdizimini bozabilecek
    // karakterleri temizleyerek güvenli bir ILIKE deseni oluştur.
    const safeQueryText = args.query_text.trim().replace(/[(),%]/g, '');
    if (safeQueryText) {
      query = query.ilike('metadata->>title', `%${safeQueryText}%`);
    }
  }

  // Sıralama: kullanıcı "en ağır"/"en pahalı" gibi bir üstünlük sorusu
  // sorduğunda model sort_by parametresini dolduruyor; AĞIRLIK (weight_kg)
  // ile FİYAT (price) burada AYRI jsonb alanlarına karşılık geldiğinden
  // model bu ikisini karıştırsa bile veritabanı sorgusu doğru alanda sıralar.
  const sortColumnByKey: Record<SortBy, { column: string; ascending: boolean }> = {
    price_asc: { column: 'metadata->price', ascending: true },
    price_desc: { column: 'metadata->price', ascending: false },
    weight_asc: { column: 'metadata->weight_kg', ascending: true },
    weight_desc: { column: 'metadata->weight_kg', ascending: false },
    stock_asc: { column: 'metadata->stock', ascending: true },
    stock_desc: { column: 'metadata->stock', ascending: false },
  };
  const sortConfig = args.sort_by ? sortColumnByKey[args.sort_by] : undefined;

  query = sortConfig
    ? query.order(sortConfig.column, { ascending: sortConfig.ascending, nullsFirst: false })
    : query.order('metadata->>category', { ascending: true }).order('metadata->>title', { ascending: true });

  // Kullanıcı "en ağır ürün hangisi" gibi TEK bir ürün istediğinde model
  // limit=1 gönderir; bu sayede yanıtta sadece o 1 ürünün kartı görünür.
  // Aksi halde (liste isteklerinde) varsayılan üst sınır 100'dür.
  const limit =
    typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0
      ? Math.min(Math.floor(args.limit), 200)
      : 100;

  const { data, error } = await query.limit(limit);

  if (error) {
    console.error('search_products sorgu hatası:', error);
    return [];
  }

  return (data ?? []) as MatchedDocument[];
}

interface BuildSystemPromptParams {
  knownCategoriesText: string;
  contextText: string;
  hasProductCards: boolean;
  isAmbiguousGenericQuery: boolean;
  toolActive: boolean;
}

function buildSystemPrompt({
  knownCategoriesText,
  contextText,
  hasProductCards,
  isAmbiguousGenericQuery,
  toolActive,
}: BuildSystemPromptParams): string {
  return `Sen Ores.com.tr e-ticaret platformunun profesyonel, kibar ve çözüm odaklı AI Müşteri Danışmanısın.

GÖREVİN:
Kullanıcının sorularına sana verilen bağlamı (context) ve gerektiğinde search_products aracını kullanarak şık, anlaşılır ve e-ticaret standartlarına uygun yanıtlar vermek.

ARAÇ (TOOL) KULLANIMI (ÇOK ÖNEMLİ):
Kullanıcı bir fiyat filtresi ("500 TL altı", "1000 TL üzeri"), bir SIRALAMA/ÜSTÜNLÜK sorusu ("en ucuz", "en pahalı", "en ağır", "en hafif", "en çok stokta olan"), stok durumu ("stokta olanlar") veya kesin bir kategori/ürün adı sorduğunda search_products fonksiyonunu çağır; bu filtrelemeyi/sıralamayı bağlamdaki metne bakarak KENDİN yapmaya ÇALIŞMA (uzun listelerde satır/ürün atlayabilir veya AĞIRLIK ile FİYATI karıştırabilirsin - bunlar ayrı alanlardır). Fonksiyon sonucu veritabanından %100 doğru gelir, sen sadece bu sonucu kurallara uygun şekilde sunmaktan sorumlusun. Kullanıcı "en ağır/en pahalı ürün HANGİSİ" gibi TEK bir ürünü hedefliyorsa search_products'ı limit=1 ile çağır ki sonuçta ve dolayısıyla kartlarda SADECE o 1 ürün görünsün. Kullanıcı politika/iletişim/genel bir soru sorduysa (aşağıdaki BAĞLAM BİLGİLERİ zaten yeterliyse) aracı çağırmana gerek yok.

FORMAT VE YAZIM KURALLARI (KESİNLİKLE UYULMALIDIR):
0. ÜRÜN VERİSİNİ SADECE KART BİLEŞENİYLE SUN, ASLA TABLO/LİSTE YAZMA (EN ÖNEMLİ KURAL): Aşağıda "ÜRÜN KARTLARI HAZIR" notu verilmişse, bağlamdaki (arama sonucundaki) TÜM ürünler arayüzde otomatik olarak şık, kaydırılabilir kartlar (carousel) halinde cevabına yerleştirilecektir. Bu yüzden ürün bilgilerini (ad, fiyat, stok, ölçü vb.) cevap metninde ASLA Markdown tablosu, madde işaretli/numaralı liste veya "- Fiyat: ... / - Stok: ..." gibi alt satırlar halinde YAZMA/TEKRARLAMA/KOPYALAMA. Cevabın SADECE şu üç parçadan oluşmalı:
   (1) kısa, nazik bir giriş cümlesi (ürün detaylarını TEKRAR ETME, sadece "evet böyle ürünlerimiz var" gibi genel bir ifade kullan),
   (2) DEĞİŞTİRMEDEN, tam olarak şu metin: [[URUN_KARTLARI]],
   (3) kullanıcıya yardımcı olacak kısa bir kapanış sorusu.
   Örnek: "Evet, 1100 TL'nin altında olan ürünlerimiz aşağıdadır:\n\n[[URUN_KARTLARI]]\n\nBaşka bir konuda yardımcı olmamı ister misiniz?"
   "ÜRÜN KARTLARI HAZIR" notu verilmemişse (hiç ürün bulunamadıysa veya soru genel/belirsizse) bu kural geçerli değildir; ilgili diğer kurallara göre normal, ürünsüz bir metin cevabı ver.
1. MÜŞTERİ HİZMETLERİ TONU: Yanıtına nazik bir giriş ile başla ('Evet, ahşap desenli modellerimiz mevcuttur...') ve kartlardan sonra kullanıcıya yardımcı olacak yönlendirici bir soru sor.
2. STOKTA OLMAYANLARI GİZLEME: search_products sonucunda/bağlamda bir ürün varsa (stok 0 dahi olsa) bu ürün otomatik olarak kartlarda (stok durumu açıkça "Stokta yok" olarak) gösterilir; sen bunu görmezden gelip "bu kategoride ürün yok" DEME. "Ürün yok" cevabı SADECE o kategoriyle ilgili hiçbir ürün dokümanı/kartı yoksa verilir.
3. HAFIZAYI KORU: Kullanıcı "evet", "tamam", "sipariş ver" gibi onay/devam niteliğinde kısa yanıtlar verdiğinde, sohbet geçmişindeki en son konuşulan ürünü ve detaylarını hatırla. Başlangıç mesajına dönme; kaldığın yerden o ürünle ilgili sipariş veya detaylandırma sürecine devam et.
4. ASLA ÜRÜN İCAT ETME (EN ÖNEMLİ KURAL): Yalnızca aşağıdaki "BAĞLAM BİLGİLERİ" bölümünde (veya search_products sonucunda) ADI GEÇEN ürünleri, fiyatları, modelleri ve özellikleri kullan. Kendi genel bilgine veya tahminine dayanarak ASLA yeni bir ürün adı, model, fiyat veya kategori üretme/uydurma. Bağlamda/arama sonucunda kullanıcının istediği kritere uyan HİÇBİR ürün yoksa, bunu asla gizleme; kullanıcıya nazikçe bu kritere uyan bir ürün bulunmadığını söyle.
5. SADECE GERÇEK KATEGORİLERİ ÖNER: Aşağıdaki "KATALOĞUMUZDAKI GERÇEK KATEGORİLER" listesi, mağazamızda satılan TÜM kategorilerin kesin listesidir. Bir ürün/kategori bulunamadığında kullanıcıya alternatif önerirken SADECE bu listede yer alan kategori adlarını kullan. Bu listede olmayan bir kategori adını ("dekoratif ürünler", "mobilya", "ev eşyaları" gibi) ASLA var mış gibi öneri olarak söyleme; böyle bir şey söylersen ve kullanıcı onu sorarsa kendi kendinle çelişirsin. Listede tek bir kategori varsa, direkt o kategoriyi öner.
6. SİPARİŞ YÖNLENDİRME KURALI: Kullanıcı "sipariş etmek istiyorum", "satın al", "ekle" veya benzeri bir satın alma talebinde bulunduğunda ASLA kullanıcının KENDİ adres, telefon veya ödeme bilgisini İSTEME. "ÜRÜN KARTLARI HAZIR" varsa kart üzerindeki [İncele] butonu zaten satın alma sayfasına yönlendirir, ayrıca metin içinde link vermene gerek yok. Kartlar yoksa (örn. daha önce bahsedilen tek bir ürün için devam ediyorsan), bağlamdaki ilgili ürünün "Ürün Satın Alma Linki" değerini kullanarak kullanıcıyı doğrudan o ürünün satın alma sayfasına yönlendir.
    Örnek Yanıt Formatı (kart yokken): "A1 Alüminyum Çerçeve ürününü satın almak için [A1 Alüminyum Çerçeve](https://magaza.ores.com.tr/products/...) sayfasını ziyaret edebilirsiniz. Başka sorularınız olursa yanıtlamaktan memnuniyet duyarım."
    STOK KONTROLÜ (ÇOK ÖNEMLİ): Kullanıcı belirli bir ADET belirttiğinde ("3 adet almak istiyorum" gibi), bu adedi bağlamdaki ürünün gerçek Stok değeriyle KARŞILAŞTIR.
    - İstenen adet stoktan FAZLA ise: ASLA "X adet sipariş verebilirsiniz" diyerek onaylama. Bunun yerine kibarca stokta sadece o kadar (gerçek stok sayısı) adet bulunduğunu belirt ve mevcut stok kadarını sipariş edip edemeyeceğini sor.
    - İstenen adet stok kadar veya daha az ise: normal şekilde yönlendir.
    ÖNEMLİ AYRIM: Bu kural SADECE kullanıcının KENDİ kişisel bilgilerini (adı, adresi, telefonu, kartı) İSTEMENİ yasaklar. ORES'in KENDİ (şirketin) e-posta, telefon, adres gibi iletişim bilgilerini PAYLAŞMAK bu kuralı ihlal etmez; aksine Kural 11'e göre bu bilgiler istenirse paylaşılmalıdır.
7. LİNK GÜVENLİĞİ VE FORMATI: Kart yokken bir ürün linki paylaşırken SADECE bağlamdaki/arama sonucundaki o ürüne ait "Ürün Satın Alma Linki"/url değerini kullan; hiçbir zaman kendi başına bir URL üretme, tahmin etme veya linki olmayan bir ürüne link verme. İlgili ürünün linki yoksa link vermeden ürünü tanıt. Verdiğin linkleri her zaman markdown formatında [Metin](URL) şeklinde, tıklanabilir olarak yaz.
8. HİÇBİR ÜRÜNÜ ATLAMA: Kullanıcı bir kategorideki/kritere uyan ürünleri sorduğunda, sonuçta kaç ürün varsa (5, 10, 27 fark etmez) TÜMÜ otomatik olarak kartlarda gösterilir; giriş cümlende "birkaç örnek" gibi ifadelerle sayıyı azaltıyormuş gibi konuşma, TÜM sonuçlardan bahset.
9. SAYISAL/FİYAT KARŞILAŞTIRMALARINDA TUTARLILIK (ÇOK ÖNEMLİ): Kullanıcı bir fiyatın/sayının belirli bir değerin altında, üstünde veya eşit olup olmadığını sorduğunda ("500 TL'nin altında mı?", "1000 TL'den ucuz mu?" gibi), ÖNCE aritmetik karşılaştırmayı zihninde doğru şekilde yap, SONRA cevabına başla. Cevabının başındaki "Evet"/"Hayır" ifadesi ile devamındaki açıklama ASLA birbiriyle çelişmemeli. Cevap vermeden önce karşılaştırmayı iki kez kontrol et.
10. TEKNİK SORGULAR VE POLİTİKALAR (İADE/KARGO): Eğer kullanıcı kargo süresi, iade koşulları veya garanti gibi bir kurumsal politika soruyorsa, bağlamdaki kurumsal politika dokümanlarına dayanarak kısa ve net cevap ver. Politika bilgisi bağlamda yoksa uydurma yapma, müşteri hizmetleri ekibine yönlendir.
11. GERÇEK İLETİŞİM BİLGİLERİNİ PAYLAŞ (ÇOK ÖNEMLİ): Kullanıcı "sizinle iletişime geçmek istiyorum", "iletişim bilgileriniz nedir", "telefon numaranız/adresiniz/e-postanız nedir" gibi bir talepte bulunduğunda, ASLA sadece "web sitesini ziyaret edin" veya "müşteri hizmetlerine ulaşın" gibi genel bir cevapla geçme. Bağlamda "Şirket ve İletişim Bilgileri" bölümünde gerçek e-posta, telefon numarası ve/veya adres bilgisi varsa, bunları DOĞRUDAN ve eksiksiz şekilde paylaş. Bu bilgiler bağlamda yoksa (ve sadece o zaman) genel bir yönlendirme yap.
${
  toolActive
    ? `12. ARAÇ (search_products) SONUCU ÖNCEDEN FİLTRELENDİ (ÇOK ÖNEMLİ): Aşağıdaki BAĞLAM BİLGİLERİ, search_products fonksiyonunun sonucudur ve veritabanı tarafından senin istediğin kritere göre ZATEN TAM ve DOĞRU şekilde filtrelenmiştir. Bu sonuçları kendi başına tekrar filtreleme, sayma veya yorumlamaya ÇALIŞMA; sonuçta ne kadar ürün varsa hepsi otomatik olarak kartlarda gösterilecek.`
    : ''
}
${
  isAmbiguousGenericQuery
    ? `13. GENEL/BELİRSİZ SORU KURALI: Kullanıcının mesajı belirli bir kategori veya ürün belirtmiyor (örn. "sizde neler var", "ne satıyorsunuz") ve bağlamda ya hiçbir gerçek ürün dokümanı yok ya da birden fazla FARKLI kategoriden ürün var. Bu durumda ASLA kendi kendine örnek/varsayımsal bir ürün listesi icat etme veya bağlamdaki ilgisiz (örn. politika) içerikten ürün üretme. Sadece aşağıdaki "KATALOĞUMUZDAKI GERÇEK KATEGORİLER" listesindeki kategori adlarını kullanıcıya söyle ve hangi kategoriyle ilgilendiğini sor.`
    : ''
}

KATALOĞUMUZDAKI GERÇEK KATEGORİLER:
${knownCategoriesText}
${hasProductCards ? `\nÜRÜN KARTLARI HAZIR: Bu sorguya uyan ürünler bulundu; arayüzde otomatik olarak yatay kart (carousel) halinde gösterilecek. Kural 0'a göre sadece [[URUN_KARTLARI]] yer tutucusunu kullan.\n` : ''}
BAĞLAM BİLGİLERİ:
${contextText}`;
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

    // 1. Kullanıcının sorduğu soru için baseline (temel) bağlamı vektör
    // aramasıyla oluştur. Bu bağlam iki amaca hizmet eder: (a) politika/
    // iletişim/genel sorularda doğrudan cevap için yeterli olabilir, (b) ilk
    // model çağrısında modele "elimde zaten şu bilgi var, gerekirse
    // search_products aracını da çağırabilirim" demesi için zemin sağlar.
    //
    // Takip soruları ("bu ürün 500 TL'nin altında mı?" gibi) tek başına,
    // önceki bağlam olmadan embed edilirse ilgisiz dokümanlarla eşleşebilir;
    // bu yüzden son asistan yanıtını da embedding girdisine ekliyoruz.
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

    // Politika dokümanları (iade/kargo/garanti vb.) uzun başlıklı markdown
    // metinleri olduğundan embedding benzerlikleri ürün dokümanlarına göre
    // daha düşük çıkabiliyor; bu yüzden politika niyeti tespit edilen
    // sorularda benzerlik eşiğini gevşetiyoruz.
    const isPolicyQuestion = looksLikePolicyQuestion(message);
    const { data: matchedDocs, error: matchError } = await supabase.rpc('match_documents', {
      query_embedding: queryEmbedding,
      match_threshold: isPolicyQuestion ? 0.15 : 0.3,
      match_count: 8,
    });

    if (matchError) {
      console.error('Supabase Vektör Arama Hatası:', matchError);
      return NextResponse.json(
        { error: 'Veritabanı araması sırasında hata oluştu.' },
        { status: 500 }
      );
    }

    let documents: MatchedDocument[] = (matchedDocs ?? []) as MatchedDocument[];

    const buildDerivedPromptFields = (docs: MatchedDocument[], toolActive: boolean) => {
      const productDocuments = docs.filter((doc) => doc.metadata?.type === 'product');
      const distinctResultCategories = new Set(
        productDocuments
          .map((doc) => doc.metadata?.category?.trim())
          .filter((category): category is string => Boolean(category))
      );
      // search_products aracı çağrıldıysa istek zaten kesin bir kritere göre
      // yapılmış demektir; bu durumda "genel/belirsiz soru" fallback'ini
      // tetiklemiyoruz (aksi halde tool sonucu az ürün döndürdüğünde model
      // yanlışlıkla kategori listesi önerisine döner).
      const isAmbiguousGenericQuery =
        !toolActive &&
        !looksLikePolicyQuestion(message) &&
        (productDocuments.length === 0 || distinctResultCategories.size > 1);

      // ÖNEMLİ (Tool Output/Message State bug fix'i): Kartlar SADECE bu
      // mesaj için gerçekten bir search_products (veya ona eşdeğer
      // deterministik kategori taraması) çalıştırılıp sonuç bulunduğunda
      // gösterilir. Baseline (toolActive:false) vektör aramasının rastgele
      // eşleştirdiği ürünler ASLA kart olarak render edilmez; aksi halde
      // ilgisiz takip mesajlarının altında da eski/varsayılan bir ürün kartı
      // listesi tekrar tekrar belirebiliyordu.
      const hasProductCards = toolActive && productDocuments.length > 0;

      const hasRelevantContext = docs.length > 0;
      const contextText = hasRelevantContext
        ? docs
            .map((doc) => {
              const url = doc.metadata?.url;
              return url ? `${doc.content}\nÜrün Satın Alma Linki: ${url}` : doc.content;
            })
            .join('\n\n---\n\n')
        : toolActive
          ? 'ARAMA SONUCU: search_products aracı, belirtilen kritere (kategori/fiyat/stok) uyan hiçbir ürün bulamadı.'
          : 'BAĞLAMDA HİÇBİR İLGİLİ ÜRÜN BULUNAMADI. Kataloğumuzda bu isteğe uyan bir ürün yok.';

      return { isAmbiguousGenericQuery, hasProductCards, contextText };
    };

    const baseline = buildDerivedPromptFields(documents, false);

    const tools = [buildSearchProductsTool(knownCategoriesText)];

    const historyMessages: ChatCompletionMessageParam[] = cleanHistory.map((turn) => ({
      role: turn.role,
      content: turn.content,
    }));

    let rawReply: string;
    let hasProductCards = false;

    // Kullanıcı mesajı KISA ve doğrudan bilinen bir kategori adını içeriyorsa
    // (örn. botun "Afiş Çerçevesi mi, Kaldırım Panosu mu?" sorusuna sadece
    // "afiş çerçevesi" cevabı verildiğinde), modelin search_products aracını
    // çağırıp çağırmamasına bağlı kalmadan (tool_choice:'auto' her zaman
    // güvenilir tetiklenmeyebilir) o kategorideki TÜM ürünleri BİZ doğrudan
    // ve deterministik şekilde çekiyoruz. Bu, gerçek bir tool çağrısıyla
    // birebir aynı search_products mantığını kullandığı için "kartlar sadece
    // tool çıktısından gelir" kuralını bozmaz; sadece ekstra bir ilk model
    // çağrısına (tool_choice kararına) ihtiyaç duymadan aynı sonuca ulaşır.
    const directCategoryMatches = isLikelyDirectCategoryBrowse(message, knownCategories);

    if (directCategoryMatches.length > 0) {
      const categoryResultDocs: MatchedDocument[] = [];
      for (const category of directCategoryMatches) {
        categoryResultDocs.push(...(await executeSearchProducts(supabase, knownCategories, { category })));
      }
      const seen = new Set<string>();
      documents = categoryResultDocs.filter((doc) => {
        const key = `${doc.metadata?.category ?? ''}|${doc.metadata?.title ?? ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      const categoryDerived = buildDerivedPromptFields(documents, true);
      hasProductCards = categoryDerived.hasProductCards;

      const categoryCompletion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: buildSystemPrompt({
              knownCategoriesText,
              contextText: categoryDerived.contextText,
              hasProductCards: categoryDerived.hasProductCards,
              isAmbiguousGenericQuery: categoryDerived.isAmbiguousGenericQuery,
              toolActive: true,
            }),
          },
          ...historyMessages,
          { role: 'user', content: message },
        ],
        temperature: 0.2,
      });

      rawReply = categoryCompletion.choices[0].message.content ?? '';
    } else {
      // 2. İlk model çağrısı: model, elindeki baseline bağlamla doğrudan
      // cevap verebilir YA DA kesin filtreleme/sıralama gerektiren bir istek
      // için search_products aracını çağırabilir (tool_choice: 'auto').
      // ÖNEMLİ: baseline (toolActive:false) yanıtında hasProductCards HER
      // ZAMAN false'tur; kartlar sadece gerçek bir tool çağrısı sonucunda
      // (aşağıdaki if bloğunda) gösterilir (bkz. Tool Output/Message State
      // bug fix'i).
      const firstCompletion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: buildSystemPrompt({
              knownCategoriesText,
              contextText: baseline.contextText,
              hasProductCards: false,
              isAmbiguousGenericQuery: baseline.isAmbiguousGenericQuery,
              toolActive: false,
            }),
          },
          ...historyMessages,
          { role: 'user', content: message },
        ],
        tools,
        tool_choice: 'auto',
        temperature: 0.2,
      });

      const firstMessage = firstCompletion.choices[0].message;
      const toolCalls = firstMessage.tool_calls ?? [];

      rawReply = firstMessage.content ?? '';

      if (toolCalls.length > 0) {
        // 3. Model bir veya daha fazla search_products çağrısı istedi (örn.
        // kullanıcı "iki kategori de" dediğinde model her kategori için ayrı
        // bir çağrı yapabilir, veya "en ağır ürün hangisi" için sort_by +
        // limit=1 gönderir). Her çağrıyı gerçek bir Supabase sorgusuna
        // çevirip sonuçları topluyoruz.
        const toolResultDocs: MatchedDocument[] = [];
        const toolResponseMessages: ChatCompletionMessageParam[] = [];

        for (const toolCall of toolCalls) {
          if (toolCall.type !== 'function') continue;

          let args: SearchProductsArgs = {};
          try {
            args = JSON.parse(toolCall.function.arguments || '{}');
          } catch (parseError) {
            console.error('search_products argümanları parse edilemedi:', parseError);
          }

          const results =
            toolCall.function.name === 'search_products'
              ? await executeSearchProducts(supabase, knownCategories, args)
              : [];

          toolResultDocs.push(...results);

          const productResults = results.filter((doc) => doc.metadata?.type === 'product');
          toolResponseMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify({
              count: productResults.length,
              products: productResults.map((doc) => ({
                title: doc.metadata?.title,
                category: doc.metadata?.category,
                dimension: doc.metadata?.dimension,
                price: doc.metadata?.price,
                weight_kg: doc.metadata?.weight_kg,
                stock: doc.metadata?.stock,
                url: doc.metadata?.url,
              })),
            }),
          });
        }

        // Aynı ürün birden fazla tool çağrısında (örn. çakışan filtrelerde)
        // tekrar dönebilir; kategori+ürün adına göre tekilleştir.
        const seen = new Set<string>();
        documents = toolResultDocs.filter((doc) => {
          const key = `${doc.metadata?.category ?? ''}|${doc.metadata?.title ?? ''}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        const toolDerived = buildDerivedPromptFields(documents, true);
        hasProductCards = toolDerived.hasProductCards;

        // 4. İkinci model çağrısı: model artık search_products sonuçlarına
        // (tool mesajları + güncellenmiş sistem prompt'u) sahip; sadece
        // sonucu kurallara uygun şekilde sunması gerekiyor.
        const secondCompletion = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: buildSystemPrompt({
                knownCategoriesText,
                contextText: toolDerived.contextText,
                hasProductCards: toolDerived.hasProductCards,
                isAmbiguousGenericQuery: toolDerived.isAmbiguousGenericQuery,
                toolActive: true,
              }),
            },
            ...historyMessages,
            { role: 'user', content: message },
            {
              role: 'assistant',
              content: firstMessage.content,
              tool_calls: toolCalls,
            },
            ...toolResponseMessages,
          ],
          temperature: 0.2,
        });

        rawReply = secondCompletion.choices[0].message.content ?? '';
      } else {
        // Tool çağrılmadı: bu mesajda kesinlikle kart gösterilmeyecek,
        // `documents` baseline (vektör arama) sonuçlarında kalır (sadece
        // kaydetme/log amaçlı; kart render'ını etkilemez).
        hasProductCards = false;
      }
    }

    // Model, ürünleri kendisi yazmak yerine [[URUN_KARTLARI]] yer tutucusunu
    // kullanmalı (bkz. kural 0). Bu yer tutucuyu tabloyla değiştirmiyoruz;
    // olduğu gibi bırakıp frontend'e gönderiyoruz, çünkü frontend bu işareti
    // gördüğünde onu `sources` verisinden türettiği Yatay Kaydırılabilir Ürün
    // Kartları (carousel) bileşeniyle değiştirecek. Model yer tutucuyu
    // unutursa (nadiren olabilir) yanıtın sonuna ekleyerek kartların her
    // durumda kullanıcıya ulaşmasını garantiliyoruz; ürün kartı yoksa
    // olası bir yanlış kullanımı temizliyoruz.
    const reply = hasProductCards
      ? rawReply.includes(PRODUCT_CARDS_PLACEHOLDER)
        ? rawReply
        : `${rawReply}\n\n${PRODUCT_CARDS_PLACEHOLDER}`
      : rawReply.replaceAll(PRODUCT_CARDS_PLACEHOLDER, '');

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
