import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import dotenv from 'dotenv';
import { createClient } from '@/lib/supabase/server';

// Yerelde .env.local'ı yükle. Vercel'de ortam değişkenleri zaten
// process.env üzerinden gelir; production'da dosya aramaya gerek yok.
if (process.env.NODE_ENV !== 'production') {
  dotenv.config({ path: '.env.local', override: true });
}

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
  'cerez', 'çerez', 'odeme', 'ödeme', 'fatura', 'e-fatura', 'efatura',
  'kdv', 'vkn', 'vergi', 'kurumsal', 'iyzico', 'havale', 'eft', 'taksit',
  'iban', 'nakit', 'kapıda', 'kapida', 'cod',
  'iptal', 'acil', 'telefon', 'mesai', 'değişiklik', 'degisiklik',
  'hasar', 'kirik', 'kırık', 'tutanak', 'yanlis urun', 'yanlış ürün',
  'adres', 'yanlis adres', 'yanlış adres', 'ikinci kargo',
  'dava', 'toplu dava', 'avukat', 'mahkeme', 'ihtilaf', 'uyuşmazlık',
  'almanya', 'avrupa', 'ab cayma', 'yurt dışı', 'yurtdışı',
  'çocuk', 'cocuk', 'ebeveyn', 'veli', 'kişisel veri', 'kvkk', 'veri sil',
  'iletisim', 'iletişim', 'sikayet', 'şikayet', 'sozlesme', 'sözleşme',
  'tahkim', 'sms', 'politika', 'hasarli', 'hasarlı', 'kusurlu', 'yasal',
];

function looksLikePolicyQuestion(text: string): boolean {
  const normalized = text.toLowerCase();
  return POLICY_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

/**
 * Basit Türkçe çekim sadeleştirme: "panoları" / "panosu" → "pano",
 * "çerçeveleri" → "çerçeve". Böylece kategori adı tekil olsa bile çoğul
 * kullanıcı ifadeleri eşleşir.
 */
function turkishStem(word: string): string {
  let w = word.toLocaleLowerCase('tr-TR').replace(/[^\p{L}\p{N}]/gu, '');
  if (!w) return w;

  const suffixes = [
    'larından',
    'lerinden',
    'lardan',
    'lerden',
    'ları',
    'leri',
    'lar',
    'ler',
    'asının',
    'esinin',
    'unun',
    'ünün',
    'ının',
    'inin',
    'ası',
    'esi',
    'usu',
    'üsü',
    'ısı',
    'isi',
    'su',
    'sı',
    'si',
    'sü',
    'ın',
    'in',
    'un',
    'ün',
  ];

  for (const suffix of suffixes) {
    if (w.length - suffix.length >= 3 && w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length);
      break;
    }
  }

  return w;
}

/**
 * Kullanıcının (veya search_products aracına verdiği) bir metin bilinen
 * kategori adlarından hangisine karşılık geliyorsa BULUNAN TÜM kategorileri
 * döner (örn. "afiş çerçevesi" -> ["Afiş Çerçevesi"]). Türkçe çekim ekleri
 * ("çerçeveleri", "panoları", "panosunu" vb.) için kök eşleşmesi yapılır.
 */
/**
 * "kaldırım panosu değil", "(pano değil)", "sadece çerçeve" gibi olumsuz /
 * dışlama ifadelerinde kategoriyi eşleşme listesinden düşür.
 */
function isCategoryNegatedInMessage(message: string, category: string): boolean {
  const text = message.toLocaleLowerCase('tr-TR');
  const cat = category.toLocaleLowerCase('tr-TR');
  const words = cat.split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;

  const escaped = words
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
  if (new RegExp(`${escaped}[^\\n.]{0,40}\\bdeğil\\b`, 'i').test(text)) return true;
  if (new RegExp(`\\bdeğil\\b[^\\n.]{0,40}${escaped}`, 'i').test(text)) return true;

  // "sadece çerçeve" / "afiş çerçevesi ... pano değil" → kaldırım panosunu ele
  if (/pano/i.test(cat)) {
    if (/\bsadece\s+(afiş\s+)?çerçeve/i.test(text)) return true;
    if (
      /\b(afiş\s+)?çerçeve/i.test(text) &&
      /\b(pano|kaldırım)\b[^\n.]{0,40}\bdeğil\b/i.test(text)
    ) {
      return true;
    }
    if (/\b(pano|kaldırım)\b[^\n.]{0,40}\bdeğil\b/i.test(text)) return true;
  }
  return false;
}

function findMentionedCategories(message: string, knownCategories: string[]): string[] {
  const normalizeWord = (word: string) =>
    word.toLocaleLowerCase('tr-TR').replace(/[^\p{L}\p{N}]/gu, '');
  const messageWords = message.split(/\s+/).map(normalizeWord).filter(Boolean);
  const messageStems = messageWords.map(turkishStem);

  const stemMatches = (catWord: string, msgWord: string) => {
    const catStem = turkishStem(catWord);
    const msgStem = turkishStem(msgWord);
    if (!catStem || !msgStem) return false;
    if (catStem === msgStem) return true;
    // Kısa kökler için önek: "pano" ⊂ "panosu" (stem sonrası zaten eşit olmalı)
    const stemLength = Math.min(4, catStem.length, msgStem.length);
    if (stemLength < 3) return false;
    return catStem.slice(0, stemLength) === msgStem.slice(0, stemLength);
  };

  let matches = knownCategories.filter((category) => {
    const normalizedMessage = message.toLocaleLowerCase('tr-TR');
    const normalizedCategory = category.toLocaleLowerCase('tr-TR');
    if (normalizedMessage.includes(normalizedCategory)) return true;

    // "kaldırım panosu" ↔ "kaldırım panoları" gibi çekimli tam ifade
    const categoryStemPhrase = category
      .split(/\s+/)
      .map((w) => turkishStem(normalizeWord(w)))
      .filter(Boolean)
      .join(' ');
    const messageStemPhrase = messageStems.filter(Boolean).join(' ');
    if (categoryStemPhrase && messageStemPhrase.includes(categoryStemPhrase)) return true;

    const categoryWords = category.split(/\s+/).map(normalizeWord).filter(Boolean);
    return categoryWords.every((catWord) =>
      messageWords.some((msgWord) => stemMatches(catWord, msgWord))
    );
  });

  matches = matches.filter((category) => !isCategoryNegatedInMessage(message, category));

  // Olumlu "çerçeve" isteği varken pano kategorisini ele (olumsuzluk kaçsa bile)
  if (matches.length > 1 && /\b(afiş\s*)?çerçeve/i.test(message)) {
    const withoutNegationParens = message.replace(/\([^)]*değil[^)]*\)/gi, '');
    const stillWantsPano =
      /\bkaldırım\b/i.test(withoutNegationParens) &&
      !isCategoryNegatedInMessage(message, 'Kaldırım Panosu');
    if (!stillWantsPano) {
      const frameOnly = matches.filter((c) => /çerçeve/i.test(c));
      if (frameOnly.length > 0) matches = frameOnly;
    }
  }

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
 * Kullanıcı mesajı bilinen bir kategoriye yönelik "listele / bilgi ver"
 * isteğiyse, search_products'ı modelin kararına bırakmadan doğrudan
 * çalıştırırız. Çekim farkları ("Kaldırım Panosu" vs "kaldırım panoları")
 * findMentionedCategories ile yakalanır. Sıralama/tekil ürün sorularında
 * tetiklenmez.
 */
function isLikelyDirectCategoryBrowse(message: string, knownCategories: string[]): string[] {
  if (looksLikeRankingOrSingleItemQuestion(message)) return [];

  const wordCount = message.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount === 0) return [];

  const browseIntent =
    /(hakkında|bilgi|göster|listele|neler var|hangileri|ürünler|almak istiyorum|incelemek|indirimli|kampanya|stokta|bütçe|\btl\b|lira|satın al)/i.test(
      message
    );

  // Kısa kategori cevabı ("afiş çerçevesi") veya biraz daha uzun browse
  // cümlesi ("kaldırım panoları hakkında bilgi almak istiyorum").
  if (wordCount > 6 && !browseIntent) return [];
  if (wordCount > 22) return [];

  return findMentionedCategories(message, knownCategories);
}

/**
 * Kullanıcı mesajından deterministik arama filtrelerini çıkarır.
 * Direct category browse yolunda tool çağrısı atlandığı için burada
 * uygulanmazsa bütçe/indirim/ölçü/stok kriterleri yok sayılır.
 */
function extractSearchFiltersFromMessage(message: string): Partial<SearchProductsArgs> {
  const text = message.toLocaleLowerCase('tr-TR');
  const filters: Partial<SearchProductsArgs> = {};

  // "1000 TL altı", "bende 1000 lira var", "1000 liram var"
  const maxPatterns = [
    /(\d+(?:[.,]\d+)?)\s*(?:tl|₺|lira|try)?\s*(?:altı|altında|kadar)/i,
    /(?:en fazla|maksimum|max\.?|en çok)\s*(\d+(?:[.,]\d+)?)\s*(?:tl|₺|lira|try)?/i,
    /(?:bütçe(?:m|niz|si)?|param|paramız|bende|elimde|cüzdanımda)\s*(?:ise\s*)?(\d+(?:[.,]\d+)?)\s*(?:tl|₺|lira(?:m|mız|nız)?|try)?/i,
    /(\d+(?:[.,]\d+)?)\s*(?:tl|₺|lira(?:m|mız|nız)?|try)\s*(?:bütçe(?:m|miz)?|param)?\s*var/i,
    /(?:bende|elimde)\s*(\d+(?:[.,]\d+)?)\s*(?:tl|₺|lira(?:m|mız|nız)?|try)?\s*var/i,
  ];

  for (const pattern of maxPatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const value = Number(match[1].replace(',', '.'));
      if (Number.isFinite(value) && value > 0) {
        filters.max_price = value;
        break;
      }
    }
  }

  // "1000 TL üzeri/üstünde", "en az 1000"
  const minPatterns = [
    /(\d+(?:[.,]\d+)?)\s*(?:tl|₺|lira|try)?\s*(?:üzeri|üstünde|üstü|ve üzeri)/i,
    /(?:en az|minimum|min\.?)\s*(\d+(?:[.,]\d+)?)\s*(?:tl|₺|lira|try)?/i,
  ];

  for (const pattern of minPatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const value = Number(match[1].replace(',', '.'));
      if (Number.isFinite(value) && value > 0) {
        filters.min_price = value;
        break;
      }
    }
  }

  const purchaseIntent =
    /(almak istiyorum|satın al|sipariş(?: etmek)?|alışveriş|ürün almak|alabilirim|alabilir\s*miyim|alayım|hangisini al|hangilerini al|ne alabilir)/i.test(
      text
    );

  // "Stokta olmayan en ucuz..." → out_of_stock; purchaseIntent burada in_stock
  // zorlamamalı (aksi halde stok=0 ürünler hiç bulunamaz).
  if (wantsOutOfStockProducts(message)) {
    filters.out_of_stock_only = true;
    if (/(en ucuz|en uygun fiyat|ucuz)/i.test(text)) {
      filters.sort_by = 'price_asc';
    }
  } else if (
    /(stokta olan|stoktakiler|stokta var|sadece stok|stokta olanlar)/i.test(text) ||
    purchaseIntent ||
    // Bütçe sorusu genelde "ne alabilirim" anlamına gelir → stoksuz gösterme
    filters.max_price != null
  ) {
    filters.in_stock_only = true;
  }

  // "İndirimdeki ürünü iade edebilir miyim?" → politika; indirimli ürün araması değil
  if (
    /(indirimli|indirimde|kampanyalı|kampanyada|kampanya|indirimdeki)/i.test(text) &&
    !/(iade|cayma|değişim|degisim)/i.test(text)
  ) {
    filters.on_discount_only = true;
  }

  // Boyut kodu: A0-A4 / B1-B3 veya 60x84 / 70x100
  const sizeCode = text.match(/\b([ab][0-4])\b/i);
  if (sizeCode?.[1]) {
    filters.dimension = sizeCode[1].toUpperCase();
  } else {
    const measure = text.match(/\b(\d{2,3})\s*[x×]\s*(\d{2,3})\b/i);
    if (measure) {
      filters.dimension = `${measure[1]}x${measure[2]}`;
    }
  }

  // Renk / görünüm — tek renk filtre; birden fazla renk = karşılaştırma (OR)
  const colors = extractColorsFromMessage(text);
  if (colors.length === 1) {
    filters.color = colors[0];
  } else if (colors.length > 1) {
    filters.colors = colors;
  }

  // Profil kalınlığı: "32 mm", "32mm profil"
  const profileMatch = text.match(/\b(\d{2})\s*mm\b/i);
  if (profileMatch?.[1]) {
    const mm = Number(profileMatch[1]);
    if (mm === 25 || mm === 32) {
      filters.profile_thickness_mm = mm;
    }
  }

  if (filters.max_price != null && filters.sort_by == null) {
    filters.sort_by = 'price_asc';
  }

  if (filters.sort_by == null) {
    filters.sort_by = inferSortByFromMessage(text);
  }

  return filters;
}

/**
 * "En ağır hangisi ve en ucuz mu?" gibi karma sorularda birincil sıralama
 * niteliğini seçer. "en ucuz mu?" karşılaştırması price_asc'e EZMEZ.
 */
function inferSortByFromMessage(text: string): SortBy | undefined {
  // "en ucuz mu?" / "en ucuz çerçeve mi?" — sıralama değil karşılaştırma
  const cheapCompareOnly = /\ben ucuz\b[\s\S]{0,40}\b(mu|mü|mi|mı)\b/i.test(text);
  const expensiveCompareOnly = /\ben pahal[ıi]\b[\s\S]{0,40}\b(mu|mü|mi|mı)\b/i.test(text);

  const whichHeavy =
    /(en ağır|en agir)\b[\s\S]{0,80}\b(hangisi|nedir|kilosu|\bkg\b)/i.test(text) ||
    /\b(hangisi|nedir)\b[\s\S]{0,80}\b(en ağır|en agir)\b/i.test(text);
  const whichLight =
    /\ben hafif\b[\s\S]{0,80}\b(hangisi|nedir)\b/i.test(text) ||
    /\b(hangisi|nedir)\b[\s\S]{0,80}\ben hafif\b/i.test(text);
  const whichExpensive =
    /(en pahalı|en pahali)\b[\s\S]{0,80}\b(hangisi|nedir)/i.test(text) ||
    /\b(hangisi|nedir)\b[\s\S]{0,80}\b(en pahalı|en pahali)\b/i.test(text);
  const whichCheap =
    /\ben ucuz\b[\s\S]{0,80}\b(hangisi|nedir|olan|ürün|çerçeve|pano|indirimli)/i.test(
      text
    ) || /\b(hangisi|nedir)\b[\s\S]{0,80}\ben ucuz\b/i.test(text);

  // Birincil soru ağırlıksa (veya "en ağır ... en ucuz mu?") weight kazanır
  if (whichHeavy || (/(en ağır|en agir)/i.test(text) && cheapCompareOnly)) {
    return 'weight_desc';
  }
  if (whichLight) return 'weight_asc';
  if (whichExpensive && !expensiveCompareOnly) return 'price_desc';
  if (whichCheap && !cheapCompareOnly) return 'price_asc';

  if (/(en pahalı|en pahali)/i.test(text) && !/(en ağır|en agir|en hafif)/i.test(text)) {
    return 'price_desc';
  }
  if (/\ben ucuz\b|\ben uygun\b/i.test(text) && !/(en ağır|en agir|en hafif)/i.test(text)) {
    return 'price_asc';
  }
  if (/(en ağır|en agir)/i.test(text)) return 'weight_desc';
  if (/\ben hafif\b/i.test(text)) return 'weight_asc';
  return undefined;
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

/** Kullanıcı kartlara ek olarak metinde fiyat/stok özeti istiyor mu? */
function wantsInlinePriceStockSummary(message: string): boolean {
  const text = message.toLocaleLowerCase('tr-TR');
  const asksFact = /(fiyat|stok|kaç adet|liste\s*fiyat|indirimli\s*fiyat)/i.test(text);
  const asksWrite =
    /(yaz|söyle|nedir|kaç|göster|her bir|adet(?:i|ini)?|fiyatını|stokunu)/i.test(text);
  return asksFact && asksWrite;
}

/** İki+ renk karşılaştırması için bağlama zorunlu fiyat özeti. */
function buildMultiColorCompareGuard(
  docs: MatchedDocument[],
  colors: string[]
): string {
  if (colors.length < 2) return '';
  const products = docs.filter((doc) => doc.metadata?.type === 'product');
  const lines = ['RENK KARŞILAŞTIRMASI (KESİN — her iki rengi de kullan, "bilmiyorum" DEME):'];

  for (const color of colors) {
    const needle = color.toLocaleLowerCase('tr-TR');
    const match = products.find((doc) => {
      const raw = doc.metadata?.color;
      return typeof raw === 'string' && raw.toLocaleLowerCase('tr-TR').includes(needle);
    });
    if (!match) {
      lines.push(`- ${color}: bu filtreyle ürün bulunamadı (uydurma).`);
      continue;
    }
    const title =
      typeof match.metadata?.title === 'string' ? match.metadata.title : 'Ürün';
    const price = match.metadata?.price;
    const stock = match.metadata?.stock;
    lines.push(
      `- ${color}: ${title} — ${typeof price === 'number' ? `${price} TL` : 'fiyat yok'}, stok ${
        typeof stock === 'number' ? stock : '?'
      }`
    );
  }

  lines.push(
    'Fiyat farkını sayısal hesapla (büyük − küçük); hangisinin daha ucuz olduğunu açıkça söyle.'
  );
  return `${lines.join('\n')}\n\n`;
}

/** Arama sonuçlarından kısa fiyat/stok özeti (modele + gerekirse yanıta). */
function buildProductPriceStockSummary(
  docs: MatchedDocument[],
  limit = 10
): string {
  const products = docs
    .filter((doc) => doc.metadata?.type === 'product')
    .slice(0, limit);
  if (products.length === 0) return '';

  const lines = products.map((doc, index) => {
    const title =
      typeof doc.metadata?.title === 'string' ? doc.metadata.title : 'Ürün';
    const price = doc.metadata?.price;
    const listPrice = doc.metadata?.list_price;
    const stock = doc.metadata?.stock;
    const priceBit =
      typeof price === 'number'
        ? typeof listPrice === 'number' && listPrice !== price
          ? `liste ${listPrice} TL / satış ${price} TL`
          : `${price} TL`
        : 'fiyat yok';
    const stockBit = typeof stock === 'number' ? `stok ${stock}` : 'stok yok';
    return `${index + 1}) ${title} — ${priceBit}, ${stockBit}`;
  });

  return [
    'FİYAT/STOK ÖZETİ (KESİN — kullanıcı istedi; kısa metinde AÇIKÇA yaz, sadece karta bırakma):',
    ...lines,
    '',
  ].join('\n');
}

/**
 * Kartlar gösterilecekken modelin yazdığı numaralı/madde ürün listelerini,
 * tabloları ve fiyat satırlarını temizler. Prompt kuralı 0 ihlal edilse bile
 * kullanıcıya çift liste (metin + kart) gitmesin.
 * @param allowPriceStockSummary kullanıcı özellikle fiyat/stok yazılmasını istediyse
 *        kısa numaralı özet satırlarını koru.
 */
function sanitizeProductCardReply(
  text: string,
  allowPriceStockSummary = false
): string {
  const marker = '__CARDS_PLACEHOLDER__';
  const lines = text.replaceAll(PRODUCT_CARDS_PLACEHOLDER, `\n${marker}\n`).split('\n');
  const kept: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      kept.push('');
      continue;
    }
    if (trimmed === marker) {
      kept.push(PRODUCT_CARDS_PLACEHOLDER);
      continue;
    }

    // Kullanıcı fiyat/stok istediğinde kısa "1) ... — 420 TL, stok 25" özetine izin ver
    if (
      allowPriceStockSummary &&
      /^\d+[\.\)]\s+/.test(trimmed) &&
      /(tl|₺|stok)/i.test(trimmed) &&
      trimmed.length < 220
    ) {
      kept.push(line);
      continue;
    }

    // "1. A3 Çerçeve - 670 TL", "2) ..."
    if (/^\d+[\.\)]\s+/.test(trimmed)) continue;
    // Markdown tablo
    if (/^\|/.test(trimmed) && trimmed.includes('|')) continue;
    if (/^:?-{3,}:?(\s*\|)/.test(trimmed)) continue;
    // Ürün/fiyat içeren bullet satırlar
    if (
      /^[-*•]\s+/.test(trimmed) &&
      /(tl|₺|stok|indirim|çerçeve|pano|\d+\s*tl)/i.test(trimmed)
    ) {
      continue;
    }
    // "Ürün Adı: ... | Fiyat: ..." gibi tek satır ürün dökümü
    if (
      /ürün adı\s*:/i.test(trimmed) ||
      (/\|\s*fiyat\s*:/i.test(trimmed) && /\d/.test(trimmed))
    ) {
      continue;
    }

    kept.push(line);
  }

  let result = kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!result.includes(PRODUCT_CARDS_PLACEHOLDER)) {
    result = `${result}\n\n${PRODUCT_CARDS_PLACEHOLDER}`.trim();
  }

  // Placeholder etrafındaki boşlukları sadeleştir
  result = result
    .replace(
      new RegExp(`\\n*${PRODUCT_CARDS_PLACEHOLDER.replace(/[[\]]/g, '\\$&')}\\n*`, 'g'),
      `\n\n${PRODUCT_CARDS_PLACEHOLDER}\n\n`
    )
    .trim();

  return result;
}

/**
 * "bu ürünün ağırlığı", "indirimli fiyatı nedir", "evet sipariş ver" gibi
 * mesajlar yeni bir arama değil; sohbette AZ ÖNCE konuşulan ürüne
 * gönderme yapar. Bu durumda rastgele vektör eşleşmesine güvenmek yerine
 * son konuşulan ürünü deterministik olarak bağlama kilitlememiz gerekir.
 */
function looksLikeProductFollowUp(message: string): boolean {
  const normalized = message.toLowerCase().trim();
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  if (!normalized) return false;

  // Katalog/liste aramaları takip sorusu değildir ("indirimli ürünler hangileri").
  // Dikkat: "gösterdiğin ürün" gibi takip ifadelerinde "göster" alt dizisi
  // geçer; bu yüzden kelime sınırı / tam ifade kullanıyoruz.
  if (looksLikeRankingOrSingleItemQuestion(normalized)) return false;
  const catalogListPatterns = [
    /\bürünler\b/,
    /\bhangileri\b/,
    /neler var/,
    /\bkampanyal[ıi]/,
    /\blistesi\b/,
    /\bgöster\b/,
    /\bkategori\b/,
  ];
  if (catalogListPatterns.some((pattern) => pattern.test(normalized))) return false;

  const referential = [
    'bu ürün', 'bu ürüne', 'bu ürünün', 'bu ürünü', 'bu üründen',
    'bu gösterdiğin', 'gösterdiğin ürün', 'gösterdiğin',
    'bunun', 'bunu', 'buna', 'bundan',
    'o ürün', 'o ürünün', 'onun', 'onu', 'şu ürün',
    'hakkında bilgi', 'detaylı bilgi', 'bilgi almak', 'detayını', 'detaylarını',
  ];
  if (referential.some((keyword) => normalized.includes(keyword))) return true;

  // Tekil ürün özelliği soruları (kısa): "ağırlığı ne", "indirimli fiyatı nedir"
  const propertyHints = [
    'ağırlık', 'ağırlığı', 'fiyat', 'fiyatı', 'indirimli fiyat', 'stok', 'stokta',
    'ölçü', 'ölçüsü', 'malzeme', 'malzemesi', 'renk', 'rengi', 'link',
    'kaç kg', 'kaç kilo', 'ne kadar',
  ];
  if (wordCount <= 8 && propertyHints.some((keyword) => normalized.includes(keyword))) {
    return true;
  }

  // "Evet, bu ürün hakkında bilgi..." gibi uzun onay + detay talepleri
  if (
    /^(evet|tamam|olur|ok|okay)/i.test(normalized) &&
    (normalized.includes('bilgi') ||
      normalized.includes('detay') ||
      normalized.includes('ürün') ||
      normalized.includes('sipariş') ||
      normalized.includes('satın'))
  ) {
    return true;
  }

  if (
    wordCount <= 6 &&
    /^(evet|tamam|olur|ok|okay|sipariş|alayım|almak istiyorum|satın al)/i.test(normalized)
  ) {
    return true;
  }

  return false;
}

/**
 * Metinde geçen bilinen ürün adlarından EN UZUN eşleşeni döner (kısa adların
 * uzun adların alt dizisi olmasına karşı).
 */
function findMentionedProductTitle(text: string, productTitles: string[]): string | null {
  const cleaned = text.replaceAll(PRODUCT_CARDS_PLACEHOLDER, '').toLowerCase();
  for (const title of productTitles) {
    if (title && cleaned.includes(title.toLowerCase())) return title;
  }
  return null;
}

/**
 * Sohbet geçmişinde (yeniden eskiye) en son adı geçen ürünün başlığını bulur.
 * Önce asistan yanıtlarına, sonra kullanıcı mesajlarına bakılır.
 */
function resolveLastDiscussedProductTitle(
  history: HistoryTurn[],
  productTitles: string[]
): string | null {
  if (productTitles.length === 0) return null;

  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].role !== 'assistant') continue;
    const found = findMentionedProductTitle(history[i].content, productTitles);
    if (found) return found;
  }
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].role !== 'user') continue;
    const found = findMentionedProductTitle(history[i].content, productTitles);
    if (found) return found;
  }
  return null;
}

/** Sidebar'da "Yeni Sohbet" olarak görünen / henüz gerçek başlık almamış sohbetler. */
function isPlaceholderConversationTitle(title: string | null | undefined): boolean {
  if (!title) return true;
  const normalized = title.trim().toLowerCase();
  return normalized === '' || normalized === 'yeni sohbet';
}

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
  /** true → yalnızca stok == 0 ürünler (stokta olmayanlar) */
  out_of_stock_only?: boolean;
  on_discount_only?: boolean;
  dimension?: string;
  color?: string;
  /** İki renk karşılaştırması ("kırmızı ile siyah") için OR filtresi */
  colors?: string[];
  /** Profil kalınlığı (mm), örn. 25 / 32 */
  profile_thickness_mm?: number;
  query_text?: string;
  sort_by?: SortBy;
  limit?: number;
}

// NOT: JS \b Unicode/Türkçe harflerde (ı, ş, ğ…) kırılır; \b kullanma.
const COLOR_HINTS: { re: RegExp; value: string }[] = [
  { re: /(?<!\p{L})ahşap(?!\p{L})/iu, value: 'ahşap' },
  { re: /(?<!\p{L})kahverengi(?!\p{L})/iu, value: 'kahverengi' },
  { re: /(?<!\p{L})(?:gümüş|gumus)(?!\p{L})/iu, value: 'gümüş' },
  { re: /(?<!\p{L})(?:kırık\s*beyaz|beyaz)(?!\p{L})/iu, value: 'beyaz' },
  { re: /(?<!\p{L})siyah(?!\p{L})/iu, value: 'siyah' },
  { re: /(?<!\p{L})(?:kırmızı|kirmizi)(?!\p{L})/iu, value: 'kırmızı' },
];

function extractColorsFromMessage(text: string): string[] {
  const found: string[] = [];
  for (const hint of COLOR_HINTS) {
    if (hint.re.test(text) && !found.includes(hint.value)) {
      found.push(hint.value);
    }
  }
  return found;
}

const FREE_SHIPPING_THRESHOLD_TL = 750;

function wantsOutOfStockProducts(message: string): boolean {
  return /(stokta olmayan|stokta olmayanlar|stokta yok|stoksuz|stok dışı|stokta bulunmayan|tükenen|bitmiş stok)/i.test(
    message
  );
}

/**
 * Mesajdan kargo karşılaştırması için sepet tutarını çıkarır.
 * "2 adet" gibi miktarları TL sanmaz; "720 TL" / "sepetim 720" tercih eder.
 */
function extractExplicitCartAmountTl(message: string): number | null {
  const text = message.toLocaleLowerCase('tr-TR');

  const withCurrency = [
    ...text.matchAll(/(\d+(?:[.,]\d+)?)\s*(?:tl|₺|lira|try)\b/gi),
  ]
    .map((m) => Number(m[1].replace(',', '.')))
    .filter((n) => Number.isFinite(n) && n >= 50);

  if (withCurrency.length > 0) {
    return Math.max(...withCurrency);
  }

  const sepetMatch = text.match(
    /(?:sepet(?:im|in|i)?|tutar(?:ı|i)?|toplam(?:ı|i)?)\s*(?:tam\s*)?(\d+(?:[.,]\d+)?)/i
  );
  if (sepetMatch?.[1]) {
    const amount = Number(sepetMatch[1].replace(',', '.'));
    if (Number.isFinite(amount) && amount >= 50) return amount;
  }

  return null;
}

/**
 * Kargo ücretsiz eşiğiyle ilgili sorularda modele kesin aritmetik ipucu verir;
 * "720 TL ücretsiz mi?" gibi sorularda Evet/Hayır çelişkisini engeller.
 */
function shippingThresholdHint(message: string): string {
  const text = message.toLocaleLowerCase('tr-TR');
  if (!/(kargo|ücretsiz kargo|ucretsiz kargo|kargo ücretsiz|kargo ucretsiz)/i.test(text)) {
    return '';
  }

  const amount = extractExplicitCartAmountTl(message);
  let comparison = '';
  if (amount != null) {
    comparison =
      amount >= FREE_SHIPPING_THRESHOLD_TL
        ? `Kullanıcının tutarı ${amount} TL ≥ ${FREE_SHIPPING_THRESHOLD_TL} → kargo ÜCRETSİZ. Cevaba "Evet" ile başla; sonra kuralı açıkla.`
        : `Kullanıcının tutarı ${amount} TL < ${FREE_SHIPPING_THRESHOLD_TL} → kargo ÜCRETSİZ DEĞİL. Cevaba "Hayır" ile başla; "ücretsiz olur" DEME. Eşik ${FREE_SHIPPING_THRESHOLD_TL} TL'dir.`;
  } else if (/(\d+)\s*adet/i.test(text)) {
    comparison =
      'NOT: Mesajda adet var ama açık TL tutarı yok. Birim fiyat × adet toplamını BAĞLAMDAKİ ürün fiyatından hesapla; "2 adet"i 2 TL sanma. Toplam ≥ 750 → ücretsiz, değilse değil.';
  }

  return [
    `KARGO ÜCRETSİZ EŞİĞİ (KESİN): ${FREE_SHIPPING_THRESHOLD_TL} TL ve üzeri siparişlerde kargo ücretsiz; altındaki siparişlerde kargo ücretli (alıcıya aittir).`,
    comparison,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * "En ucuz A4'ten 2 adet alırsam kargo ücretsiz mi?" → birim fiyatı DB'den alıp
 * sepet toplamını kesin hesaplar.
 */
async function shippingQuantityCartHint(
  message: string,
  supabase: Awaited<ReturnType<typeof createClient>>,
  knownCategories: string[]
): Promise<string> {
  if (!/(kargo|ücretsiz)/i.test(message)) return '';
  const qtyMatch = message.match(/(\d+)\s*adet/i);
  if (!qtyMatch?.[1]) return '';
  // Açık TL tutarı varsa miktar×fiyat hesabına gerek yok
  if (extractExplicitCartAmountTl(message) != null) return '';

  const qty = Number(qtyMatch[1]);
  if (!Number.isFinite(qty) || qty <= 0 || qty > 500) return '';

  const filters = extractSearchFiltersFromMessage(message);
  const categories = findMentionedCategories(message, knownCategories);
  const docs = await executeSearchProducts(supabase, knownCategories, {
    ...(categories[0] ? { category: categories[0] } : {}),
    dimension: filters.dimension,
    color: filters.color,
    in_stock_only: true,
    sort_by: filters.sort_by ?? 'price_asc',
    limit: 1,
  });

  const unit = docs[0]?.metadata?.price;
  const title = typeof docs[0]?.metadata?.title === 'string' ? docs[0].metadata.title : 'ürün';
  if (typeof unit !== 'number' || !Number.isFinite(unit) || unit <= 0) {
    return '';
  }

  const total = Math.round(unit * qty * 100) / 100;
  const free = total >= FREE_SHIPPING_THRESHOLD_TL;
  return [
    `SEPET HESABI (KESİN — KARGO): "${title}" birim fiyat ${unit} TL × ${qty} adet = ${total} TL.`,
    free
      ? `${total} TL ≥ ${FREE_SHIPPING_THRESHOLD_TL} TL → kargo ÜCRETSİZ. Cevaba "Evet" ile başla.`
      : `${total} TL < ${FREE_SHIPPING_THRESHOLD_TL} TL → kargo ÜCRETSİZ DEĞİL. Cevaba "Hayır" ile başla.`,
    'Adet sayısını (örn. 2) asla TL tutarı gibi kullanma.',
  ].join('\n');
}

/**
 * Ödeme yöntemi sorularında kabul edilen yöntemleri dayatır.
 * Kapıda nakit / COD belgede YOK — uydurulmasın.
 */
function paymentMethodsHint(message: string): string {
  const text = message.toLocaleLowerCase('tr-TR');
  if (
    !/(ödeme|odeme|kapıda|kapida|nakit|havale|eft|iban|iyzico|visa|mastercard|kredi kart|banka kart|cod|kapıda öde|teslimatta öde)/i.test(
      text
    )
  ) {
    return '';
  }

  const lines = [
    'ÖDEME YÖNTEMLERİ (KESİN — POLİTİKA): Kabul edilenler YALNIZCA: Visa, Mastercard, iyzico ve banka havalesi/EFT.',
    'KABUL EDİLMEYEN (KESİN): Kapıda nakit, kapıda kart, teslimatta ödeme, COD. Bunlar için "yapabilirsiniz / seçeneğimiz var" DEME — "Hayır, kapıda nakit/teslimatta ödeme sunulmuyor" de; kabul edilen yöntemleri listele.',
  ];

  if (/iban/i.test(text)) {
    lines.push(
      'IBAN: Politika metninde IBAN numarası YOK. Uydurma IBAN yazma. Havale/EFT kabul edildiğini söyle; IBAN için iletisim@ores.com.tr / telefon ile iletişime yönlendir.'
    );
  }

  return lines.join('\n');
}

/**
 * Belgede net yazmayan baskı/kurumsal fatura sorularında uydurma "mümkün/yapıyoruz"
 * cevaplarını engellemek için bağlam ipucu.
 */
function undocumentedCheckoutHint(message: string): string {
  const text = message.toLocaleLowerCase('tr-TR');
  const asksPrint = /(baskı|basım|tasarım|hazır.*gönder|afiş.*yap)/i.test(text);
  const asksCorpInvoice =
    /(kurumsal|kdv|vkn|e-fatura|efatura|şahıs kart|sahis kart|fatura)/i.test(text);
  if (!asksPrint && !asksCorpInvoice) return '';

  const lines = [
    'BELGEDE NET OLMAYAN HİZMET/FATURA (KESİN): Aşağıdaki noktalar politika/katalog metninde ayrıntılı geçmiyorsa "yapıyoruz / yapmıyoruz / mümkün / mümkün değil" diye KESİN iddia UYDURMA.',
  ];
  if (asksPrint) {
    lines.push(
      'Afiş baskı/tasarım: "Kataloğumuzda/politika metninde afiş baskı hizmeti geçmiyor" de; teyit için iletişim bilgilerini ver. "Hazır göndermelisiniz" diye kesin zorunluluk uydurma.'
    );
  }
  if (asksCorpInvoice) {
    lines.push(
      'Şahıs kartı + kurumsal KDV/e-fatura: Bilinen ödeme yöntemlerini (Visa, Mastercard, iyzico, havale/EFT) söyle; kurumsal fatura detayı belgede yoksa "bu detay belgelerimizde geçmiyor, teyit için iletişime geçin" de. "Mümkün / alabilirsiniz" UYDURMA.'
    );
  }
  return lines.join('\n');
}

/**
 * İade sorularında özellikle indirimli ürün istisnasını modele dayatır.
 * (Politika: indirimdeki ürünler iade kapsamı dışındadır.)
 * Not: "sipariş değişikliği" ≠ ürün takası; onu urgentSupportHint karşılar.
 */
/** Acil sipariş değişikliği/iptal — iade+takas ipuçlarını bastırmak için. */
function looksLikeUrgentOrderChange(text: string): boolean {
  const change =
    /(sipariş.*(değiş|degis|iptal)|değiştir|degistir|değişiklik|degisiklik|iptal et)/i.test(
      text
    );
  const urgentChannel =
    /(acil|hemen|telefon|açan yok|acan yok|mesai|akşam|gece|\d{1,2}\s*[:.]\s*\d{2})/i.test(
      text
    );
  return change && urgentChannel;
}

function returnPolicyHint(message: string): string {
  const text = message.toLocaleLowerCase('tr-TR');
  // Acil sipariş değişikliği sorusunda "iade+yeni sipariş" ipucu modele sızmasın
  if (looksLikeUrgentOrderChange(text)) return '';
  // Sipariş değişikliği/iptali (üründen bağımsız) buraya düşmesin
  if (
    /(sipariş\s*değiş|siparişi\s*değiş|sipariş\s*iptal|değişiklik)/i.test(text) &&
    !/\biade\b|\btakas\b/i.test(text)
  ) {
    return '';
  }
  if (!/(iade|cayma|\bdeğişim\b|\bdegisim\b|\btakas\b)/i.test(text)) return '';

  const misdirected =
    /(kağıthane|kagithane|merkez adres|doğrudan gönder|direkt gönder|kargoladım|kargoladim|teslim alınmış|teslim alinmis)/i.test(
      text
    );

  if (misdirected) {
    return [
      '=== ZORUNLU CEVAP (YANLIŞ İADE ADRESİ / TALEPSİZ GÖNDERİM) — ÖNCE BUNU UYGULA ===',
      'YANLIŞ: Cevaba "ürün incelenecek, 10 iş günü içinde para iadesi" ile başlamak (sanki usulüne uygun iade varmış gibi).',
      'DOĞRU SIRALAMA (bu sırayla yaz):',
      '1) Resmi iade adresi Sakarya 1. OSB 2. Cadde No:12, Arifiye / Sakarya. Kağıthane/İstanbul merkez adresi İADE ADRESİ DEĞİLDİR.',
      '2) İade talebi oluşturmadan / etiket almadan gönderilen ürünler kabul edilmeyebilir.',
      '3) Hemen sipariş + kargo takip no ile iletisim@ores.com.tr ve +90 264 531 00 10–11 (08:00–18:00) yazmasını söyle; operasyon paketi arasın.',
      '4) Usulüne uygun iade onaylanırsa para iadesi 10 iş günü (banka ek süre); onaydan 15 iş günü sonra hâlâ yoksa tekrar yazın — bunu ikincil bilgi olarak ver, ana cevap yapma.',
      'Kesin "paranız şu gün yatar / kargo teslim alındıysa iade kesin işler" DEME.',
    ].join('\n');
  }

  const lines = [
    'İADE ÖZETİ (KESİN): Genel iade süresi teslimattan sonra 14 gündür; ürün kullanılmamış, etiketli ve orijinal ambalajında olmalı. İade talebi iletisim@ores.com.tr üzerinden oluşturulur; kabul edilirse iade kargo etiketi + gönderim talimatı gelir.',
    'İADE ADRESİ (KESİN): Resmi iade adresi Sakarya 1. Organize Sanayi Bölgesi 2. Cadde No:12, 54590 Arifiye / Sakarya. Kağıthane/İstanbul merkez adresi iade adresi DEĞİLDİR.',
    'ÖNEMSİZ GÖNDERİM (KESİN): İade talebi oluşturulmadan doğrudan gönderilen ürünler kabul edilmez. Önce talep, sonra etiket/talimat, sonra gönderim.',
    'PARA İADESİ (KESİN — yalnızca usulüne uygun iade için): Ürün iade adresine ulaşır → incelenir → onay bildirilir → onaylanırsa 10 iş günü içinde orijinal ödeme yöntemine. Banka ek süre alabilir. Onaydan 15 iş günü geçtiyse hâlâ yoksa iletisim@ores.com.tr (+ telefon 08:00–18:00).',
    'İADE DIŞI (KESİN): İndirimdeki/kampanyalı ürünler ve hediye kartları iade edilemez.',
    'ÜRÜN DEĞİŞİMİ/TAKAS (KESİN): Doğrudan takas yok; teslim alınmış ürün için iade + yeni sipariş. Bunu kargoya çıkmamış sipariş iptaline uygulama.',
  ];

  if (/(indirim|kampanya)/i.test(text)) {
    lines.push(
      'BU SORU İNDİRİMLİ ÜRÜN İADESİ: Cevaba "Hayır" ile başla. İndirimdeki ürün iade edilemez. "14 gün içinde iade edebilirsiniz" DEME — bu genel kural indirimli ürüne uygulanmaz.'
    );
  }

  return lines.join('\n');
}

/**
 * Yurt dışı / AB cayma / "tanıdık getirsin" senaryosu.
 * ORES yurt dışına göndermez; kişisel taşıma ≠ AB'ye şirket sevkiyatı.
 */
function internationalReturnHint(message: string): string {
  const text = message.toLocaleLowerCase('tr-TR');
  if (
    !/(almanya|avrupa|ab\b|cayma|yurt dışı|yurtdışı|yurt disi|uluslararası|tanıdık|tanidik|getirt|getireceğ|getireceg|yurtdışına|yurt dışına)/i.test(
      text
    )
  ) {
    return '';
  }

  return [
    'YURT DIŞI / AB CAYMA (KESİN): Teslimat yalnızca Türkiye içindir; ORES yurt dışına kargo yapmaz. Bunu açıkça söyle.',
    'AB 14 gün gerekçesiz cayma: Politikada "ürünün Avrupa Birliği\'ne gönderilmesi durumunda" geçerlidir — yani ORES\'in AB\'ye sevkiyatı. Tanıdık/elden Almanya\'ya götürmek bu kapsamda varsayılmaz.',
    'YANLIŞ: "Evet, Almanya\'da yaşadığınız için AB cayma hakkınız var" (ORES AB\'ye göndermeden).',
    'DOĞRU: Yurt dışı gönderim yok; sipariş TR adresine teslim edilir. TR standart iade (teslimattan sonra 14 gün, kullanılmamış/orijinal ambalaj, makbuz) koşullarını özetle. Bu özel senaryo için kesin AB cayması vaat etme; sipariş detayı için iletisim@ores.com.tr / telefon yönlendir.',
  ].join('\n');
}

/**
 * Çocuk verileri / ebeveyn silme talebi (Gizlilik §6.8).
 */
function childDataHint(message: string): string {
  const text = message.toLocaleLowerCase('tr-TR');
  const childOrParent =
    /(çocuk|cocuk|oğl|oglum|oğul|oglu|kızım|kizim|kızın|kizin|ebeveyn|veli|vasi|yaşındaki|yasindaki|\d{1,2}\s*yaş|reşit değil|resit degil)/i.test(
      text
    );
  const dataOrDelete =
    /(kişisel veri|kisisel veri|veri|hesap|silin|silme|kvkk|gizlilik|bilgilerin)/i.test(
      text
    );
  if (!childOrParent || !dataOrDelete) return '';

  return [
    '=== ZORUNLU CEVAP (ÇOCUK VERİSİ §6.8) — ÖNCE BUNU UYGULA ===',
    'YANLIŞ: Sadece "iletisim@ores.com.tr yazın, silme yapılır" deyip politika maddelerini atlamak.',
    'DOĞRU SIRALAMA (bu noktaların hepsini kısaca yaz):',
    '1) Hizmetler çocuklar tarafından kullanılması için amaçlanmamıştır; çocuklar hakkında bilerek kişisel bilgi toplanmaz.',
    '2) Bilgisini paylaşmış bir çocuğun ebeveyni/vasisi silme talep edebilir — talebiniz bu kapsamdadır, geçerlidir.',
    '3) Politika notu: yürürlük tarihi itibarıyla 16 yaşın altındaki bireylerin kişisel bilgilerinin paylaşıldığına veya satıldığına dair bilgi bulunmamaktadır.',
    '4) Talebi iletmek için: iletisim@ores.com.tr ve +90 264 531 00 10–11 (08:00–18:00). Yanıt öncesi kimlik/hesap doğrulaması istenebilir.',
    'Anında silindi / chat üzerinden sildik diye vaat etme.',
  ].join('\n');
}

/**
 * Toplu dava / tahkim / avukat tehdidi: şartları doğru ve ölçülü aktar.
 */
function disputeLegalHint(message: string): string {
  const text = message.toLocaleLowerCase('tr-TR');
  if (
    !/(dava|toplu dava|tahkim|avukat|mahkeme|ihtilaf|uyuşmazlık|uyusmazlik|temsili dava|birleşik dava)/i.test(
      text
    )
  ) {
    return '';
  }

  return [
    'UYUŞMAZLIK / TAHKİM (KESİN — ÖLÇÜLÜ DİL): Mahkeme gibi "hakkınız yok" diye hüküm verme. Hizmet şartlarına göre özetle:',
    '1) Talepler bağlayıcı bireysel tahkim ile çözülür (İstanbul).',
    '2) Toplu, birleşik veya temsili davalara katılım feragati vardır; talepler bireysel ele alınır.',
    '3) Her taraf kendi avukatlık ücretinden kendisi sorumludur — "avukat masrafınızı size yükleriz/yükleyemezsiniz" diye kesin mahkeme hükmü verme; şart metnini aktar.',
    '4) Tahkimden vazgeçme (opt-out): ilk satın almadan itibaren 30 gün içinde yazılı bildirim (adres Kağıthane) mümkün olabilir — kısaca belirt.',
    'İletişim bilgilerini (iletisim@ores.com.tr, +90 264 531 00 10–11, 08:00–18:00) paylaş. Mümkünse önce ürün/sipariş sorununa yardım teklif et; hukuki danışmanlık verme.',
  ].join('\n');
}

/**
 * Yanlış/eksik teslimat adresi, geri dönen kargo, ikinci kargo ücreti, fatura adresi.
 */
function wrongAddressHint(message: string): string {
  const text = message.toLocaleLowerCase('tr-TR');
  // İade gönderimi / Kağıthane senaryosu → returnPolicyHint; teslimat adresi kuralını karıştırma
  if (/\biade\b|(kağıthane|kagithane)/i.test(text)) return '';
  if (
    !/(adres|yanlış gir|yanlis gir|başka şehir|baska sehir|geri dön|geri don|ikinci kargo|tekrar kargo|fatura adres|teslimat adres)/i.test(
      text
    )
  ) {
    return '';
  }

  return [
    'YANLIŞ / EKSİK ADRES (KESİN): Politikaya göre adresin doğru girilmesi müşteri sorumluluğundadır. Yanlış veya eksik adres bilgilerinden kaynaklanan gecikmelerden ORES sorumlu değildir. Bunu kibarca, suçlayıcı olmadan belirt.',
    'İkinci kargo ücreti / fatura adresi hemen değişsin: Belgede "ikinci kargo ücretsiz" veya "fatura adresi anında chat ile değişir" YOK. "Ücretsiz yeniden göndeririz / hemen değiştiririz / hata sistemimizde" diye KABUL veya UYDURMA yapma.',
    'Çözüm kanalı: sipariş numarası ile iletisim@ores.com.tr ve mesai içinde +90 264 531 00 10–11 (08:00–18:00). Operasyon ekibinin değerlendireceğini söyle.',
  ].join('\n');
}

/**
 * Hasarlı/kusurlu/yanlış ürün: genel iade belirsizliğine düşmeden doğru süreci ver.
 */
function damagedProductHint(message: string): string {
  const text = message.toLocaleLowerCase('tr-TR');
  if (
    !/(hasar|hasarlı|hasarli|kusur|kusurlu|kırık|kirik|bozuk|ezik|çatlak|catlak|yanlış ürün|yanlis urun|eksik ürün|eksik urun|tutanak)/i.test(
      text
    )
  ) {
    return '';
  }

  return [
    'HASARLI / KUSURLU / YANLIŞ ÜRÜN (KESİN): Müşteriye "genel iadede kargo kimi öder belirsiz" diye yetinme. Bu durumda derhal iletisim@ores.com.tr (+ gerekirse telefon) ile iletişime geçmesini söyle; ORES sorunu değerlendirip düzeltir.',
    'İade talebi kabul edilirse ORES iade kargo etiketi ve gönderim talimatı gönderir — etiket sürecini belirt. "Kargo ücretini kesin siz ödersiniz" veya "kesin biz öderiz" diye belgede olmayan kesin cümle UYDURMA; süreç iletişim + etiket üzerinden yürür.',
    'Teslim anında paket hasarlı/eksik/açılmışsa: mümkünse kargo görevlisi yanında tutanak tutulmalı, paket öyle teslim alınmamalıydı; yine de ORES ile iletişime geçilsin.',
    'İade talebi oluşturmadan ürünü kendi başına göndermesin.',
  ].join('\n');
}

/**
 * Acil sipariş / mesai dışı telefon / iptal tehdidi: çalışma saatleri + doğru kanal.
 */
function urgentSupportHint(message: string): string {
  const text = message.toLocaleLowerCase('tr-TR');
  const urgent =
    /(acil|hemen|açan yok|acan yok|yanıt vermez|cevap vermez|iptal edeceğ|sinir|beklet|ulaşamıyorum)/i.test(
      text
    );
  const orderChange =
    /(sipariş.*(değiş|degis|iptal)|değiştir|degistir|değişiklik|degisiklik|iptal et)/i.test(
      text
    );
  const phoneOrHours =
    /(telefon|arıyorum|aradım|açan yok|acan yok|mesai|çalışma saat|akşam|gece|arayabilir|\d{1,2}\s*[:.]\s*\d{2})/i.test(
      text
    );

  if (!urgent && !orderChange && !phoneOrHours) return '';

  if (looksLikeUrgentOrderChange(text) || (orderChange && (urgent || phoneOrHours))) {
    return [
      '=== ZORUNLU CEVAP (ACİL SİPARİŞ / MESAİ DIŞI) — ÖNCE BUNU UYGULA ===',
      'YANLIŞ (ASLA YAZMA): "Önce ürünü iade edin / iade edip yeni sipariş verin" — ürün teslim alındığı söylenmeden bunu önerme.',
      'DOĞRU SIRALAMA:',
      '1) Empati + telefon +90 264 531 00 10–11 yalnızca 08:00–18:00; akşam/gece açılmaması normal olabilir.',
      '2) Acil kayıt: HEMEN iletisim@ores.com.tr — sipariş numarası + ne değişsin/iptal.',
      '3) Yarın mesai içinde telefonu da dene.',
      '4) Chat üzerinden anlık iptal/değişiklik belgede yok; iade+yeni sipariş şablonunu KULLANMA.',
    ].join('\n');
  }

  const lines = [
    'İLETİŞİM / MESAİ (KESİN): Telefon +90 264 531 00 10–11, yalnızca 08:00–18:00. E-posta: iletisim@ores.com.tr (yanıt genelde 1–3 iş günü). İkisini de paylaş.',
  ];

  if (
    urgent ||
    phoneOrHours ||
    /(akşam|gece|21\s*[:.]|20\s*[:.]|19\s*[:.]|22\s*[:.]|23\s*[:.])/i.test(text)
  ) {
    lines.push(
      'MESAİ DIŞI / TELEFON AÇILMIYOR: Empatiyle belirt — telefon hattı 08:00–18:00 dışındadır, akşam/gece açılmaması normal olabilir. Yarın mesai içinde aramasını öner; acil kayıt için HEMEN iletisim@ores.com.tr yazmasını söyle (sipariş numarası + ne değişsin/iptal).'
    );
  }

  if (orderChange || /iptal/i.test(text)) {
    lines.push(
      'SİPARİŞ DEĞİŞİKLİĞİ / İPTAL ≠ ÜRÜN TAKASI: Kargoya çıkmamış/teslim alınmamış sipariş için ASLA varsayılan cevap "ürünü iade edip yeni sipariş verin" olmasın. Chat üzerinden anlık iptal belgede yok; sipariş no ile e-posta + mesai içi telefon yönlendir. Ürün zaten teslim alındıysa ve takas isteniyorsa o zaman iade + yeni sipariş kuralını uygula.'
    );
  }

  return lines.join('\n');
}

function withPolicyHints(message: string, contextText: string): string {
  // En kritik / çakışmaya açık ipuçları önce (model FAQ parçasına kaymasın)
  const hints = [
    childDataHint(message),
    urgentSupportHint(message),
    returnPolicyHint(message),
    internationalReturnHint(message),
    shippingThresholdHint(message),
    paymentMethodsHint(message),
    undocumentedCheckoutHint(message),
    damagedProductHint(message),
    wrongAddressHint(message),
    disputeLegalHint(message),
  ].filter(Boolean);
  if (hints.length === 0) return contextText;
  return `${hints.join('\n\n')}\n\n${contextText}`;
}

/** Filtreli arama 0 sonuç döndüğünde modelin "1 ürün var" uydurmasını engeller. */
function emptySearchGuard(
  docs: MatchedDocument[],
  filters: Partial<SearchProductsArgs>
): string {
  if (docs.length > 0) return '';
  const bits: string[] = [];
  if (filters.max_price != null) bits.push(`bütçe ≤ ${filters.max_price} TL`);
  if (filters.min_price != null) bits.push(`fiyat ≥ ${filters.min_price} TL`);
  if (filters.in_stock_only) bits.push('stok > 0');
  if (filters.out_of_stock_only) bits.push('stok = 0');
  if (filters.on_discount_only) bits.push('yalnızca indirimli');
  if (filters.dimension) bits.push(`ölçü ${filters.dimension}`);
  if (filters.profile_thickness_mm != null) {
    bits.push(`profil ${filters.profile_thickness_mm} mm`);
  }
  if (filters.colors?.length) bits.push(`renkler ${filters.colors.join('/')}`);
  else if (filters.color) bits.push(`renk ${filters.color}`);
  if (filters.category) bits.push(`kategori ${filters.category}`);
  const criteria = bits.length > 0 ? bits.join(', ') : 'verilen kriterler';
  return `ÖNEMLİ (BOŞ ARAMA): Bu filtrelerle (${criteria}) 0 ürün bulundu. ASLA "1 ürün var / yalnızca N ürün" diye uydurma. Kibarca bu kritere uyan ürün olmadığını söyle; gerekirse filtreyi gevşetmeyi (bütçe/stok) veya diğer kategoriyi öner.\n\n`;
}

function buildSearchProductsTool(knownCategoriesText: string): ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: 'search_products',
      description:
        'ORES ürün kataloğunda kesin kriterlere göre ürün arar/filtreler/sıralar. Kullanıcı bir fiyat filtresi ("500 TL altı", "1000 TL üzeri"), bir SIRALAMA/ÜSTÜNLÜK sorusu ("en ucuz", "en pahalı", "en ağır", "en hafif", "en çok stokta olan"), stok durumu ("stokta olanlar"), indirim durumu ("indirimli ürünler", "kampanyalılar") veya belirli bir kategori/ürün adı belirttiğinde MUTLAKA bu fonksiyonu çağır; bu tür filtrelemeleri/sıralamaları KENDİN (bağlamdaki metne bakarak) yapmaya ÇALIŞMA - context uzun olduğunda satır/ürün atlayabilir veya AĞIRLIK ile FİYATI birbirine karıştırabilirsin, bu fonksiyon veritabanından %100 doğru sonuç getirir. Kullanıcı TEK bir ürünü hedefliyorsa ("en ağır ürün HANGİSİ", "en pahalı ürün NEDİR" gibi) VE bir kategori belirtmediyse, category alanını BOŞ bırakarak fonksiyonu SADECE BİR KEZ çağır (TÜM kategorilerde arama yapılır) ve limit=1 vererek SADECE o 1 ürünün dönmesini sağla; bu durumda kategori kategori ayrı ayrı ÇAĞIRMA. Kullanıcı AÇIKÇA birden fazla kategori istediyse (örn. "iki kategori de") bu fonksiyonu her kategori için ayrı ayrı çağırabilirsin.',
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            description: `Ürün kategorisi. Kullanıcı belirli bir kategori BELİRTMEDİYSE (örn. "en ağır ürün hangisi" gibi genel bir soru) bu alanı BOŞ bırak; TÜM kategorilerde tek bir arama yapılır. Belirtildiyse şu bilinen kategorilerden birini kullan: ${knownCategoriesText}`,
          },
          max_price: {
            type: 'number',
            description:
              'Ürünün fiyatı bu değerden KÜÇÜK VEYA EŞİT olmalı (TL). "500 TL altı", "bende 1000 lira var", "bütçem 1000", "1000 TL\'ye kadar" gibi bütçe ifadelerinde max_price=o tutar.',
          },
          min_price: {
            type: 'number',
            description: 'Ürünün fiyatı bu değerden BÜYÜK OLMALI (TL). Örn. kullanıcı "1000 TL üzeri" derse min_price=1000.',
          },
          in_stock_only: {
            type: 'boolean',
            description:
              'true ise sadece stokta olan (stok > 0) ürünler döner. Kullanıcı "stokta olanlar" dediyse true. "Stokta olmayan" sorduğunda BUNU true yapma; out_of_stock_only kullan.',
          },
          out_of_stock_only: {
            type: 'boolean',
            description:
              'true ise sadece stokta OLMAYAN (stok = 0) ürünler döner. Kullanıcı "stokta olmayan", "stoksuz", "stokta yok olan" dediğinde MUTLAKA true ver; in_stock_only ile birlikte kullanma.',
          },
          on_discount_only: {
            type: 'boolean',
            description:
              'true ise sadece indirimde olan ürünler döner (has_discount=true). Kullanıcı "indirimli ürünler", "kampanyadakiler", "indirimde olanlar" dediğinde true ver.',
          },
          dimension: {
            type: 'string',
            description:
              'Boyut/ölçü filtresi. Kullanıcı "A2", "A1 çerçeve", "60x84" derse bu değeri ver (örn. "A2" veya "60x84").',
          },
          color: {
            type: 'string',
            description:
              'Tek renk filtresi. Kullanıcı yalnızca bir renk söylediyse ver. İki renk karşılaştırıyorsa (kırmızı ile siyah) color BOŞ bırak, colors kullan.',
          },
          colors: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Birden fazla renk karşılaştırması için (örn. ["kırmızı","siyah"]). Bu durumda color alanını doldurma.',
          },
          profile_thickness_mm: {
            type: 'number',
            description:
              'Profil kalınlığı mm. Kullanıcı "32 mm profil", "25mm çerçeve" dediyse 32 veya 25 ver. Katalogda tipik değerler 25 ve 32.',
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
  if (args.out_of_stock_only) {
    query = query.filter('metadata->stock', 'eq', 0);
  } else if (args.in_stock_only) {
    query = query.filter('metadata->stock', 'gt', 0);
  }
  if (args.on_discount_only) {
    query = query.eq('metadata->>has_discount', 'true');
  }
  if (args.dimension && args.dimension.trim()) {
    const safeDimension = args.dimension.trim().replace(/[(),%]/g, '');
    if (safeDimension) {
      query = query.ilike('metadata->>dimension', `%${safeDimension}%`);
    }
  }
  if (
    typeof args.profile_thickness_mm === 'number' &&
    Number.isFinite(args.profile_thickness_mm)
  ) {
    query = query.eq(
      'metadata->>profile_thickness_mm',
      String(Math.floor(args.profile_thickness_mm))
    );
  }

  // Tek renk SQL'de; çoklu renk Türkçe/OR sorunlarına takılmasın diye
  // sorgudan sonra bellek içi süzülür.
  const multiColors = (args.colors ?? [])
    .map((c) => c.trim().replace(/[(),%]/g, ''))
    .filter(Boolean);
  if (multiColors.length <= 1 && args.color && args.color.trim()) {
    const safeColor = args.color.trim().replace(/[(),%]/g, '');
    if (safeColor) {
      // "ahşap" çoğu üründe color değil title/material alanında geçer
      if (safeColor.toLocaleLowerCase('tr-TR') === 'ahşap') {
        query = query.or(
          `metadata->>title.ilike.%${safeColor}%,metadata->>material.ilike.%${safeColor}%`
        );
      } else {
        query = query.ilike('metadata->>color', `%${safeColor}%`);
      }
    }
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
  // Çoklu renk için SQL'de renk yok → daha geniş çekip bellekten süz.
  const limit =
    typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0
      ? Math.min(Math.floor(args.limit), 200)
      : 100;
  const fetchLimit = multiColors.length > 1 ? Math.max(limit, 100) : limit;

  const { data, error } = await query.limit(fetchLimit);

  if (error) {
    console.error('search_products sorgu hatası:', error);
    return [];
  }

  let rows = (data ?? []) as MatchedDocument[];

  if (multiColors.length > 1) {
    const needles = multiColors.map((c) => c.toLocaleLowerCase('tr-TR'));
    const matched: MatchedDocument[] = [];
    for (const needle of needles) {
      const hit = rows.find((doc) => {
        const raw = doc.metadata?.color;
        const title = doc.metadata?.title;
        const material = doc.metadata?.material;
        const blob = [raw, title, material]
          .filter((v): v is string => typeof v === 'string')
          .join(' ')
          .toLocaleLowerCase('tr-TR');
        return blob.includes(needle);
      });
      if (hit && !matched.includes(hit)) matched.push(hit);
    }
    // Her renkten birer ürün; yoksa renk içeren tüm satırlar
    if (matched.length > 0) {
      rows = matched;
    } else {
      rows = rows.filter((doc) => {
        const raw = typeof doc.metadata?.color === 'string' ? doc.metadata.color : '';
        const lower = raw.toLocaleLowerCase('tr-TR');
        return needles.some((n) => lower.includes(n));
      });
    }
  }

  return rows;
}

interface BuildSystemPromptParams {
  knownCategoriesText: string;
  contextText: string;
  hasProductCards: boolean;
  isAmbiguousGenericQuery: boolean;
  toolActive: boolean;
  pinnedFollowUpProduct?: boolean;
  /** Kargo eşiği vb. politika ipuçları için ham kullanıcı mesajı */
  userMessage?: string;
  /** DB'den hesaplanan sepet/kargo gibi kesin önekler */
  extraContextPrefix?: string;
}

function buildSystemPrompt({
  knownCategoriesText,
  contextText,
  hasProductCards,
  isAmbiguousGenericQuery,
  toolActive,
  pinnedFollowUpProduct = false,
  userMessage = '',
  extraContextPrefix = '',
}: BuildSystemPromptParams): string {
  const hinted = withPolicyHints(userMessage, contextText);
  const contextWithHints = extraContextPrefix
    ? `${extraContextPrefix}\n\n${hinted}`
    : hinted;
  return `Sen Ores.com.tr e-ticaret platformunun profesyonel, kibar ve çözüm odaklı AI Müşteri Danışmanısın.

GÖREVİN:
Kullanıcının sorularına sana verilen bağlamı (context) ve gerektiğinde search_products aracını kullanarak şık, anlaşılır ve e-ticaret standartlarına uygun yanıtlar vermek.

KAPSAM (ÇOK ÖNEMLİ — ASLA İHLAL ETME):
Sen YALNIZCA Ores.com.tr müşteri danışmanısın. Yanıt verebileceğin konular SADECE şunlardır:
- Mağaza ürünleri (afiş çerçevesi, kaldırım panosu vb.), fiyat, stok, ölçü, malzeme, ağırlık, indirim, sipariş yönlendirme
- Ürünle ilişkili hizmet/sipariş soruları: özel ölçü, özel üretim, ışıklı stand, afiş baskısı/tasarım, montaj, toptan/kurumsal alım — KAPSAM İÇİDİR; "yardımcı olamıyorum" diye REDDETME
- Kurumsal politikalar (iade, kargo, garanti, iletişim, gizlilik vb.)
- Ödeme ve faturalama (kabul edilen kartlar, iyzico, havale/EFT, şahıs/kurumsal fatura, KDV/VKN, e-fatura soruları) — bunlar KAPSAM İÇİDİR; "yardımcı olamıyorum" diye REDDETME
- Selamlaşma / sohbet nezaketi (kısa) ve ardından ürün/politika yardımına yönlendirme
KAPSAM DIŞI yalnızca ORES alışverişi/ürün/politika ile İLGİSİZ konular (ünlüler, spor, genel kültür, siyaset, hava durumu, ödev, kod yazma, diğer markalar, kişisel tavsiye vb.). Bunlar için kibarca reddet.
ÖNEMLİ AYIRIM: Kullanıcı çerçeve/pano/sipariş/ödeme/fatura/baskı/ölçü hakkında soruyorsa bu HER ZAMAN kapsam içidir — tüm mesajı Icardi red şablonuyla kapatma. Red yalnızca mesaj TAMAMEN alakasızsa.
KARMA SORU (ÇOK ÖNEMLİ): Mesaj hem ORES ürünü (çerçeve/ölçü/afiş) hem kapsam dışı (futbolcu/ünlü) içeriyorsa TÜMÜNÜ reddetme. Ürün kısmını cevapla; kapsam dışı kısmı tek cümlede geç (örn. "Sporcu/biyografi bilgisi veremem.").
SIRALAMA ÖNCELİĞİ: "En ağır hangisi ve en ucuz mu?" → önce en ağırı (kg) bul; "en ucuz mu?" sadece Evet/Hayır karşılaştırmasıdır, sıralamayı fiyata ÇEVİRME. AĞIRLIK ≠ FİYAT.
Örnek KAPSAM DIŞI (saf): Kullanıcı sadece "Mauro Icardi nerelidir?" derse → kibarca reddet; futbolcu biyografisi YAZMA.
Örnek KARMA: "Galatasaray afişi için hangi ölçü uygun ve Icardi hangi takımda?" → çerçeve ölçülerini/kategoriyi öner; Icardi sorusuna cevap VERME ("sporcu bilgisi veremem").
Örnek KAPSAM İÇİ (ödeme): "şahıs kartı + kurumsal fatura / e-fatura" → reddetme; belgede varsa söyle, yoksa uydurma, Kural 12 iletişim ver.
Örnek KAPSAM İÇİ (kapıda nakit / IBAN): "Kapıda nakit ödeyebilir miyim? Havale IBAN nerede?" → Kapıda nakit YOK (Hayır); kabul edilenler Visa/Mastercard/iyzico/havale-EFT; IBAN uydurma, iletişime yönlendir.
Örnek KAPSAM İÇİ (acil / mesai dışı): "Saat 21:00 acil sipariş değişikliği, telefon açılmıyor / iade edip yeniden mi alayım?" → Empati; telefon 08:00–18:00; iletisim@ores.com.tr + yarın telefon; ASLA "önce iade edip yeni sipariş verin" deme.
Örnek KAPSAM İÇİ (Kağıthane'ye iade kargosu): "Merkeze kargoladım, para ne zaman?" → Önce: iade adresi Sakarya/Arifiye (Kağıthane değil); talep+etiketsiz kabul edilmeyebilir; hemen iletişim. "10 iş günü"yi usulüne uygun onay sonrası ikincil bilgi yap.
Örnek KAPSAM İÇİ (çocuk verisi): "15 yaş oğlum hesap açtı, verilerini silin" → §6.8: çocuklara yönelik değil; ebeveyn silebilir; 16 yaş altı notu; e-posta+telefon. Sadece "mail atın" yetmez.
Örnek KAPSAM İÇİ (özel ölçü): "120x240 ışıklı stand" → reddetme; katalogda yoksa söyle; "üretiriz/üretmeyiz" uydurma; iletişim ver.
Örnek KAPSAM İÇİ (baskı): "afiş baskısı yapıyor musunuz?" → reddetme. Belgede hizmet yoksa: "Kataloğumuzda/politika metninde afiş baskı hizmeti geçmiyor" de. "Yapıyoruz / yapmıyoruz / mümkün" diye KESİN iddia UYDURMA; teyit için Kural 12 iletişim ver.
ÇİFT İSTEK: "Sizde X var mı? Yoksa en ucuz 3 çerçeveyi göster" → Önce X katalog kategorilerinde yoksa bunu söyle (iPhone kılıfı/mouse pad vb. YOK); sonra ikinci istek için search_products ile çerçeveleri getir. İlk soruyu yok sayma.

ARAÇ (TOOL) KULLANIMI (ÇOK ÖNEMLİ):
Kullanıcı fiyat filtresi, SIRALAMA ("en ucuz"/"en ağır"), stok durumu ("stokta olanlar" VEYA "stokta olmayanlar"), indirim veya kategori/ürün adı sorduğunda search_products çağır. "Stokta olmayan en ucuz çerçeve" için out_of_stock_only=true, sort_by=price_asc, ilgili category, gerekirse limit=1. Bu filtrelemeyi kendin yapma. Tek ürün sorularında limit=1. Politika/iletişim sorusunda araç gerekmeyebilir.

FORMAT VE YAZIM KURALLARI (KESİNLİKLE UYULMALIDIR):
0. ÜRÜN VERİSİNİ SADECE KART BİLEŞENİYLE SUN, ASLA TABLO/LİSTE YAZMA (EN ÖNEMLİ KURAL): Aşağıda "ÜRÜN KARTLARI HAZIR" notu verilmişse, bağlamdaki (arama sonucundaki) TÜM ürünler arayüzde otomatik olarak şık, kaydırılabilir kartlar (carousel) halinde cevabına yerleştirilecektir. Bu yüzden cevap METNİNDE ürün detaylarını ASLA tekrarlama:
   - Markdown tablosu YASAK
   - Madde işaretli liste YASAK ("- ...", "• ...")
   - Numaralı liste YASAK ("1. Ürün adı - 750 TL", "2) ..." gibi). Ürünleri ASLA 1-2-3 diye yazma; kartlar zaten gösterecek
   - Ürün adı, fiyat, stok, ölçü, ağırlık, malzeme, renk, link gibi alanları metinde satır satır dökmek YASAK
   - Tek bir ürün kartı olsa bile metinde o ürünün özelliklerini madde madde dökme
   Metinde SADECE kısa ve kibar bir özet cümle yaz (ör. "Evet, kriterinize uyan indirimli ürünlerimiz aşağıdadır."). Cevabın SADECE şu üç parçadan oluşmalı:
   (1) kısa, nazik bir özet (1-2 cümle; ürün detayı YOK),
   (2) DEĞİŞTİRMEDEN, tam olarak şu metin: [[URUN_KARTLARI]],
   (3) satışa ve detay soruya teşvik eden PROAKTİF bir kapanış sorusu (aşağıdaki Kapanış/CTA kuralına uy).
   Örnek: "Evet, indirimli ürünlerimiz aşağıdadır:\n\n[[URUN_KARTLARI]]\n\nListedeki ürünlerden ilgilendiğiniz veya detaylı bilgi almak istediğiniz bir model var mı?"
   İSTİSNA — FİYAT/STOK SORULDUYSA: Kullanıcı "fiyatını/stokunu yaz/söyle" veya bağlamda "FİYAT/STOK ÖZETİ" varsa, kartlara EK olarak kısa 1-2 cümle veya kısa numaralı özet satırında fiyat ve stoğu YAZ. "Yalnızca 1 ürün var" deme; sonuç sayısı bağlama uy.
   "ÜRÜN KARTLARI HAZIR" notu verilmemişse (hiç ürün bulunamadıysa veya soru genel/belirsizse) bu kural geçerli değildir; ilgili diğer kurallara göre normal, ürünsüz bir metin cevabı ver.
1. MÜŞTERİ HİZMETLERİ TONU VE KAPANIŞ (CTA): Yanıtına nazik bir giriş ile başla. Ürün kartları gösterildiğinde (listeleme/filtreleme sonrası) kapanışta SOĞUK/JENERİK ifadeler YASAKTIR — özellikle "Başka bir konuda yardımcı olmamı ister misiniz?" deme. Bunun yerine kullanıcıyı alışverişe ve detay sormaya teşvik eden proaktif, satış odaklı, interaktif bir soru sor. Örnek kapanışlar:
   - "Listedeki ürünlerden ilgilendiğiniz veya detaylı bilgi almak istediğiniz bir model var mı?"
   - "İhtiyacınıza en uygun olan boyutu seçmek için detaylarını incelememizi ister misiniz?"
   - "Bu modellerden hangisini daha yakından inceleyelim veya satın alma linkini paylaşayım?"
   Kart/ürün listesi YOKSA (politika, iletişim, genel yönlendirme vb.) kibar genel bir kapanış kullanabilirsin.
2. STOKTA OLMAYANLARI GİZLEME / STOK=0 SORULARI: search_products sonucunda stok 0 ürün varsa kartlarda "Stokta yok" olarak gösterilir; "stokta olmayan ürün yok" diye yalan söyleme. Kullanıcı "stokta olmayan en ucuz..." sorduğunda araç sonucundaki stok=0 ürünü göster. Stok 0 ise anında sipariş onaylama; "şu an stokta yok" de, stoktakilere veya iletişime yönlendir.
3. HAFIZAYI KORU VE ÜRÜN DETAYI (ÇOK ÖNEMLİ): Kullanıcı "evet", "tamam", "sipariş ver", "bu ürün hakkında bilgi", "gösterdiğin ürünün detayı" gibi onay/takip yanıtları verdiğinde, sohbet geçmişindeki en son konuşulan ürünü hatırla ve BAĞLAM BİLGİLERİ'ndeki o ürünün TAM içeriğini (açıklama, malzeme, ölçü, ağırlık, fiyat, stok, kullanım alanı vb.) kullanarak kibar, akıcı bir metinle cevap ver. ASLA "yalnızca ürün listesine erişebiliyorum", "detay veremiyorum", "sadece liste gösterebiliyorum" deme — bağlamda ürün bilgisi varsa DETAY VER. Sadece siteye link atıp geçiştirme; önce bağlamdaki bilgileri özetle, sonra isterse satın alma linkini ekle. Kapanışta yine proaktif sor (stok/sipariş/benzer model).
4. ASLA ÜRÜN İCAT ETME (EN ÖNEMLİ KURAL): Yalnızca aşağıdaki "BAĞLAM BİLGİLERİ" bölümünde (veya search_products sonucunda) ADI GEÇEN ürünleri, fiyatları, modelleri ve özellikleri kullan. Kendi genel bilgine veya tahminine dayanarak ASLA yeni bir ürün adı, model, fiyat veya kategori üretme/uydurma. Bağlamda/arama sonucunda kullanıcının istediği kritere uyan HİÇBİR ürün yoksa, bunu asla gizleme; kullanıcıya nazikçe bu kritere uyan bir ürün bulunmadığını söyle.
   ÖZEL ÖLÇÜ / ÖZEL ÜRETİM / BASKI / KATALOGDIŞI HİZMET: Kullanıcı standart dışı ölçü, ışıklı stand, baskı/tasarım, kurumsal fatura detayı sorduğunda ASLA kapsam dışı red verme. Bağlamda net yazmıyorsa: (1) "belgelerimizde/kataloğumuzda bu detay geçmiyor" de, (2) bilinen ürün/ölçüye değin (uydurma ekleme), (3) Kural 12 iletişim paylaş. YASAK uydurma kalıplar: "yapıyoruz", "yapmıyoruz", "mümkün", "mümkün değil", "mevcut değil" (belgede açıkça yoksa).
5. SADECE GERÇEK KATEGORİLERİ ÖNER: Aşağıdaki "KATALOĞUMUZDAKI GERÇEK KATEGORİLER" listesi, mağazamızda satılan TÜM kategorilerin kesin listesidir. Bir ürün/kategori bulunamadığında kullanıcıya alternatif önerirken SADECE bu listede yer alan kategori adlarını kullan. Bu listede olmayan bir kategori adını ("dekoratif ürünler", "mobilya", "ev eşyaları" gibi) ASLA var mış gibi öneri olarak söyleme; böyle bir şey söylersen ve kullanıcı onu sorarsa kendi kendinle çelişirsin. Listede tek bir kategori varsa, direkt o kategoriyi öner.
6. SİPARİŞ YÖNLENDİRME KURALI: Kullanıcı "sipariş etmek istiyorum", "satın al", "ekle" veya benzeri bir satın alma talebinde bulunduğunda ASLA kullanıcının KENDİ adres, telefon veya ödeme bilgisini İSTEME. "ÜRÜN KARTLARI HAZIR" varsa kart üzerindeki [İncele] butonu zaten satın alma sayfasına yönlendirir, ayrıca metin içinde link vermene gerek yok. Kartlar yoksa (örn. daha önce bahsedilen tek bir ürün için devam ediyorsan), bağlamdaki ilgili ürünün "Ürün Satın Alma Linki" değerini kullanarak kullanıcıyı doğrudan o ürünün satın alma sayfasına yönlendir.
    Örnek Yanıt Formatı (kart yokken): "A1 Alüminyum Çerçeve ürününü satın almak için [A1 Alüminyum Çerçeve](https://magaza.ores.com.tr/products/...) sayfasını ziyaret edebilirsiniz. Başka sorularınız olursa yanıtlamaktan memnuniyet duyarım."
    STOK KONTROLÜ (ÇOK ÖNEMLİ): Kullanıcı belirli bir ADET belirttiğinde ("3 adet almak istiyorum" gibi), bu adedi bağlamdaki ürünün gerçek Stok değeriyle KARŞILAŞTIR.
    - İstenen adet stoktan FAZLA ise: ASLA "X adet sipariş verebilirsiniz" diyerek onaylama. Bunun yerine kibarca stokta sadece o kadar (gerçek stok sayısı) adet bulunduğunu belirt ve mevcut stok kadarını sipariş edip edemeyeceğini sor.
    - İstenen adet stok kadar veya daha az ise: normal şekilde yönlendir.
    ÖNEMLİ AYRIM: Bu kural SADECE kullanıcının KENDİ kişisel bilgilerini (adı, adresi, telefonu, kartı) İSTEMENİ yasaklar. ORES'in KENDİ (şirketin) e-posta, telefon, adres gibi iletişim bilgilerini PAYLAŞMAK bu kuralı ihlal etmez; aksine Kural 11'e göre bu bilgiler istenirse paylaşılmalıdır.
7. LİNK GÜVENLİĞİ VE FORMATI: Kart yokken bir ürün linki paylaşırken SADECE bağlamdaki/arama sonucundaki o ürüne ait "Ürün Satın Alma Linki"/url değerini kullan; hiçbir zaman kendi başına bir URL üretme, tahmin etme veya linki olmayan bir ürüne link verme. İlgili ürünün linki yoksa link vermeden ürünü tanıt. Verdiğin linkleri her zaman markdown formatında [Metin](URL) şeklinde, tıklanabilir olarak yaz.
8. HİÇBİR ÜRÜNÜ ATLAMA: Kullanıcı bir kategorideki/kritere uyan ürünleri sorduğunda, sonuçta kaç ürün varsa (5, 10, 27 fark etmez) TÜMÜ otomatik olarak kartlarda gösterilir; giriş cümlende "birkaç örnek" gibi ifadelerle sayıyı azaltıyormuş gibi konuşma, TÜM sonuçlardan bahset.
9. SAYISAL/FİYAT/KARGO KARŞILAŞTIRMALARINDA TUTARLILIK (ÇOK ÖNEMLİ): Kullanıcı bir tutarın eşik altında/üstünde olup olmadığını sorduğunda ÖNCE aritmetik yap, SONRA cevapla. "Evet"/"Hayır" ile açıklama ASLA çelişmesin.
   KARGO ÖRNEĞİ: Ücretsiz kargo eşiği 750 TL. 720 TL → Hayır, ücretsiz değil (720 < 750). 800 TL → Evet, ücretsiz (800 ≥ 750). Bağlamda "KARGO ÜCRETSİZ EŞİĞİ" ipucu varsa ona uy.
10. SAYISAL YANIT HASSASİYETİ (İSTENEN ADET vs GERÇEK SONUÇ — ÇOK ÖNEMLİ): Kullanıcı belirli bir sayıda ürün istediğinde (örn. "en ucuz 3 ürün", "en pahalı 5 çerçeve") ve search_products / bağlam sonucunda istenenden DAHA AZ ürün döndüğünde, bunu ASLA gizleme veya yumuşatma. Metin yanıtında veritabanında/sonuçta TOPLAM kaç ürün bulunduğunu AÇIKÇA belirt. Belirsiz/yanıltıcı ifadeler YASAK:
   - YANLIŞ: "Evet, en ucuz kaldırım panolarımızdan biri aşağıda..." (sanki daha fazlası varmış gibi)
   - YANLIŞ: "İşte birkaç örnek..." / "en ucuz 3 ürünümüzden biri..."
   - DOĞRU: "Bu kategoride yalnızca 1 adet ürün bulunmaktadır. İlgili ürünü aşağıda inceleyebilirsiniz:"
   - DOĞRU: "İstediğiniz 3 ürün yerine bu kritere uyan yalnızca 2 ürün bulundu; ikisini de aşağıda görebilirsiniz:"
   İstenen adet kadar veya daha fazla sonuç varsa normal kısa özet yeterlidir; uydurma ürün ekleyerek sayıyı tamamlamaya ÇALIŞMA.
11. TEKNİK SORGULAR VE POLİTİKALAR (İADE/KARGO/ÖDEME/FATURA/HUKUK): Kullanıcı kargo, iade, ödeme, dava/tahkim, yurt dışı/AB cayma, çocuk verisi/ebeveyn silme soruyorsa KAPSAM İÇİ — reddetme. Bağlama uy: kargo 750; TR iade 14 gün (önce talep+etiket; adres Sakarya/Arifiye — Kağıthane iade adresi değil; talepsiz gönderim kabul edilmeyebilir); para iadesi onay sonrası 10 iş günü. Ödeme kart/iyzico/havale; kapıda nakit yok; hasar→iletişim; yanlış adres→müşteri sorumluluğu. YURT DIŞI: gönderim yok. AB cayma yalnızca ORES AB'ye gönderirse. ÇOCUK VERİSİ: §6.8 + iletişim. DAVA/TAHKİM: ölçülü dil. Uydurma yok; Kural 12.
12. GERÇEK İLETİŞİM BİLGİLERİNİ PAYLAŞ (ÇOK ÖNEMLİ): Kullanıcı iletişim, telefon açılmıyor, acil sipariş/iptal/değişiklik istediğinde ASLA genel "müşteri hizmetlerine ulaşın" deme. Bağlamdaki gerçek e-posta + telefon + çalışma saatlerini (08:00–18:00) DOĞRUDAN paylaş. Mesai dışıysa bunu açıkla. Sipariş değişikliği/iptali için varsayılan "iade+yeni sipariş" UYDURMA (ürün teslim alınmadıysa); e-posta ile sipariş no ile yazmasını söyle.
${
  toolActive
    ? `13. ARAÇ (search_products) SONUCU ÖNCEDEN FİLTRELENDİ (ÇOK ÖNEMLİ): Aşağıdaki BAĞLAM BİLGİLERİ, search_products fonksiyonunun sonucudur ve veritabanı tarafından senin istediğin kritere göre ZATEN TAM ve DOĞRU şekilde filtrelenmiştir. Bu sonuçları kendi başına tekrar filtreleme veya uydurma ürün eklemeye ÇALIŞMA; sonuçtaki gerçek ürün sayısını Kural 10'a göre dürüstçe belirt, hepsi kartlarda gösterilecek.`
    : ''
}
${
  isAmbiguousGenericQuery
    ? `14. GENEL/BELİRSİZ SORU KURALI: Kullanıcının mesajı belirli bir kategori veya ürün belirtmiyor (örn. "sizde neler var", "ne satıyorsunuz") ve bağlamda ya hiçbir gerçek ürün dokümanı yok ya da birden fazla FARKLI kategoriden ürün var. Bu durumda ASLA kendi kendine örnek/varsayımsal bir ürün listesi icat etme veya bağlamdaki ilgisiz (örn. politika) içerikten ürün üretme. Sadece aşağıdaki "KATALOĞUMUZDAKI GERÇEK KATEGORİLER" listesindeki kategori adlarını kullanıcıya söyle ve hangi kategoriyle ilgilendiğini sor.`
    : ''
}

KATALOĞUMUZDAKI GERÇEK KATEGORİLER:
${knownCategoriesText}
${hasProductCards ? `\nÜRÜN KARTLARI HAZIR: Bu sorguya uyan ürünler bulundu; arayüzde otomatik olarak yatay kart (carousel) halinde gösterilecek. Kural 0'a KESİNLİKLE uy: metinde ürün detayı / bullet listesi / tablo YAZMA; sadece kısa kibar özet + [[URUN_KARTLARI]] + proaktif satış odaklı kapanış sorusu. "Başka bir konuda yardımcı olmamı ister misiniz?" deme — yerine listedeki modele / boyuta / detaya yönlendiren interaktif bir soru sor. Kullanıcı belirli bir adet istediyse ve sonuç daha azsa Kural 10'a göre gerçek sayıyı açıkça yaz.\n` : ''}
${pinnedFollowUpProduct ? `\nTAKİP ÜRÜNÜ KİLİTLENDİ: Kullanıcı az önce gösterilen/konuşulan ürün hakkında bilgi istiyor. Aşağıdaki BAĞLAM BİLGİLERİ bu ürünün TAM kaydıdır. Kural 3'e uyarak özelliklerini, kullanımını, fiyat/stok bilgisini net ve yardımcı bir dille anlat. "Sadece listeye erişebiliyorum" deme. Kart yer tutucusu ([[URUN_KARTLARI]]) kullanma; bu bir detay cevabıdır.\n` : ''}
BAĞLAM BİLGİLERİ:
${contextWithHints}`;
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
    const shippingCartPrefix = await shippingQuantityCartHint(
      message,
      supabase,
      knownCategories
    );

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

    // Takip sorusuysa ("bu ürünün ağırlığı", "indirimli fiyatı nedir" vb.)
    // sohbette en son adı geçen ürünü bulup bağlama KİLİTLE. Böylece vektör
    // araması yanlış bir ürüne sapsa bile model doğru ürünün ağırlık/fiyat/
    // stok bilgisini görür.
    let pinnedFollowUpProduct = false;
    const isReferentialFollowUp = looksLikeProductFollowUp(message) && cleanHistory.length > 0;

    // Ürün başlıklarını her zaman çek: "Bilgi al" tıklamasında mevcut mesajda
    // tam ürün adı vardır; bunu geçmişteki eski ürüne tercih etmeliyiz.
    const { data: titleRows } = await supabase
      .from('documents')
      .select('metadata')
      .eq('metadata->>type', 'product');
    const productTitles = (titleRows ?? [])
      .map((row) => (row.metadata as { title?: string } | null)?.title?.trim())
      .filter((title): title is string => Boolean(title))
      .sort((a, b) => b.length - a.length);

    const mentionedInCurrentMessage = findMentionedProductTitle(message, productTitles);

    if (mentionedInCurrentMessage || isReferentialFollowUp) {
      // Öncelik:
      // 1) BU mesajda açıkça adı geçen ürün (Bilgi al tıklaması).
      // 2) Sohbet geçmişinde en son adı geçen ürün.
      // 3) Kartlı yanıtlarda metinde ad yoksa son asistan sources'undan çıkar.
      let lastProductTitle = mentionedInCurrentMessage;

      if (!lastProductTitle) {
        lastProductTitle = resolveLastDiscussedProductTitle(cleanHistory, productTitles);
      }

      if (!lastProductTitle && typeof conversationId === 'string') {
        const { data: lastAssistantRow } = await supabase
          .from('messages')
          .select('sources')
          .eq('conversation_id', conversationId)
          .eq('role', 'assistant')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        const sourceDocs = Array.isArray(lastAssistantRow?.sources)
          ? (lastAssistantRow.sources as MatchedDocument[])
          : [];
        const sourceTitles = sourceDocs
          .map((doc) => doc.metadata?.title?.trim())
          .filter((title): title is string => Boolean(title))
          .sort((a, b) => b.length - a.length);

        if (sourceTitles.length === 1) {
          lastProductTitle = sourceTitles[0];
        } else if (sourceTitles.length > 1) {
          lastProductTitle =
            findMentionedProductTitle(message, sourceTitles) ??
            resolveLastDiscussedProductTitle(cleanHistory, sourceTitles);
        }
      }

      if (lastProductTitle) {
        const { data: pinnedRows, error: pinError } = await supabase
          .from('documents')
          .select('content, metadata')
          .eq('metadata->>type', 'product')
          .eq('metadata->>title', lastProductTitle)
          .limit(1);

        if (pinError) {
          console.error('Takip ürünü kilitlenirken hata:', pinError);
        } else if (pinnedRows && pinnedRows.length > 0) {
          const nonProductDocs = documents.filter((doc) => doc.metadata?.type !== 'product');
          documents = [...(pinnedRows as MatchedDocument[]), ...nonProductDocs];
          pinnedFollowUpProduct = true;
        }
      }
    }

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
      // yanlışlıkla kategori listesi önerisine döner). Aynı şekilde takip
      // sorusunda ürünü kilitlemişsek de "hangi kategori?"e düşmemeliyiz.
      const isAmbiguousGenericQuery =
        !toolActive &&
        !pinnedFollowUpProduct &&
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
              // Metadata alanlarını (ağırlık, liste/indirimli fiyat, URL) modelin
              // okuduğu bağlama açıkça ekle. content'te olsa bile burada tekrar
              // etmek zarar vermez; content eski formatta kaldıysa kritik koruma
              // sağlar.
              const url = doc.metadata?.url;
              const weightKg = doc.metadata?.weight_kg;
              const listPrice = doc.metadata?.list_price;
              const salePrice = doc.metadata?.price;
              const hasDiscount = doc.metadata?.has_discount === true;
              const extraLines = [
                typeof weightKg === 'number' ? `Ağırlık: ${weightKg} kg` : null,
                typeof listPrice === 'number' ? `Liste Fiyatı: ${listPrice} TL` : null,
                typeof salePrice === 'number'
                  ? hasDiscount
                    ? `İndirimli / Satış Fiyatı: ${salePrice} TL (İndirimde)`
                    : `Satış Fiyatı: ${salePrice} TL (İndirim yok)`
                  : null,
                url ? `Ürün Satın Alma Linki: ${url}` : null,
              ]
                .filter((line): line is string => Boolean(line))
                .join('\n');
              return extraLines ? `${doc.content}\n${extraLines}` : doc.content;
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

    // Takip detay sorusu: son konuşulan ürün kilidi aktifse tool çağırmadan
    // doğrudan o ürünün tam içeriğiyle cevap ver (kart listesi değil, metin detay).
    if (pinnedFollowUpProduct) {
      const followUpDerived = buildDerivedPromptFields(documents, false);
      hasProductCards = false;

      const followUpCompletion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: buildSystemPrompt({
              knownCategoriesText,
              contextText: followUpDerived.contextText,
              hasProductCards: false,
              isAmbiguousGenericQuery: false,
              toolActive: false,
              pinnedFollowUpProduct: true,
              userMessage: message,
              extraContextPrefix: shippingCartPrefix,
            }),
          },
          ...historyMessages,
          { role: 'user', content: message },
        ],
        temperature: 0.2,
      });

      rawReply = followUpCompletion.choices[0].message.content ?? '';
    } else {
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
    const messageFilters = extractSearchFiltersFromMessage(message);

    // "Stokta olmayan en ucuz çerçeve" gibi sorularda tool_choice kaçabiliyor
    // ve purchaseIntent eskiden in_stock zorluyordu; buradan deterministik çek.
    if (messageFilters.out_of_stock_only) {
      const oosCategories = findMentionedCategories(message, knownCategories);
      const wantsSingle =
        looksLikeRankingOrSingleItemQuestion(message) ||
        /(en ucuz|en pahalı|hangisi|hangisini)/i.test(message);
      const oosDocs = await executeSearchProducts(supabase, knownCategories, {
        ...(oosCategories[0] ? { category: oosCategories[0] } : {}),
        ...messageFilters,
        out_of_stock_only: true,
        in_stock_only: false,
        sort_by: messageFilters.sort_by ?? 'price_asc',
        limit: wantsSingle ? 1 : 50,
      });
      const seenOos = new Set<string>();
      documents = oosDocs.filter((doc) => {
        const key = `${doc.metadata?.category ?? ''}|${doc.metadata?.title ?? ''}`;
        if (seenOos.has(key)) return false;
        seenOos.add(key);
        return true;
      });

      const oosDerived = buildDerivedPromptFields(documents, true);
      hasProductCards = oosDerived.hasProductCards;
      const oosGuard =
        documents.length > 0
          ? `ÖNEMLİ (STOK=0 ARAMA SONUCU): Veritabanı stok=0 filtresiyle ${documents.length} ürün buldu. ASLA "stokta olmayan ürün yok/bulunmamaktadır" DEME. Ürünü/kartları göster; stok 0 olduğu için anında sipariş onaylama, "şu an stokta yok" de.\n\n`
          : 'ÖNEMLİ (STOK=0 ARAMA SONUCU): Bu kritere uyan stok=0 ürün bulunamadı.\n\n';

      const oosCompletion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: buildSystemPrompt({
              knownCategoriesText,
              contextText: `${oosGuard}${oosDerived.contextText}`,
              hasProductCards: oosDerived.hasProductCards,
              isAmbiguousGenericQuery: oosDerived.isAmbiguousGenericQuery,
              toolActive: true,
              userMessage: message,
              extraContextPrefix: shippingCartPrefix,
            }),
          },
          ...historyMessages,
          { role: 'user', content: message },
        ],
        temperature: 0.2,
      });

      rawReply = oosCompletion.choices[0].message.content ?? '';
    } else if (messageFilters.on_discount_only && !looksLikePolicyQuestion(message)) {
      // "İndirimli A1 ... en pahalısı" — tool atlanırsa yanlış/boş cevap üretilmesin
      const discCategories = findMentionedCategories(message, knownCategories);
      const wantsSingle =
        looksLikeRankingOrSingleItemQuestion(message) ||
        /(en ucuz|en pahalı|en pahali|hangisi)/i.test(message);
      const discDocs = await executeSearchProducts(supabase, knownCategories, {
        ...(discCategories[0] ? { category: discCategories[0] } : {}),
        ...messageFilters,
        on_discount_only: true,
        sort_by: messageFilters.sort_by ?? 'price_asc',
        limit: wantsSingle ? 1 : 50,
      });
      const seenDisc = new Set<string>();
      documents = discDocs.filter((doc) => {
        const key = `${doc.metadata?.category ?? ''}|${doc.metadata?.title ?? ''}`;
        if (seenDisc.has(key)) return false;
        seenDisc.add(key);
        return true;
      });

      const discDerived = buildDerivedPromptFields(documents, true);
      hasProductCards = discDerived.hasProductCards;
      const discGuard = emptySearchGuard(documents, {
        ...messageFilters,
        on_discount_only: true,
        category: discCategories[0],
      });
      const discDoc = documents[0];
      const listPrice = discDoc?.metadata?.list_price;
      const salePrice = discDoc?.metadata?.price;
      const priceAskGuard =
        documents.length > 0 &&
        /(liste\s*fiyat|indirimli\s*fiyat|fiyatı\s*nedir|fiyati\s*nedir)/i.test(message)
          ? `FİYAT DETAYI (KESİN): ${
              typeof discDoc?.metadata?.title === 'string' ? discDoc.metadata.title : 'Ürün'
            } — Liste fiyatı: ${
              typeof listPrice === 'number' ? `${listPrice} TL` : 'yok'
            }; İndirimli/satış fiyatı: ${
              typeof salePrice === 'number' ? `${salePrice} TL` : 'yok'
            }. Metinde her iki fiyatı da AÇIKÇA yaz (sadece karta bırakma).\n\n`
          : '';

      const discCompletion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: buildSystemPrompt({
              knownCategoriesText,
              contextText: `${priceAskGuard}${discGuard}${discDerived.contextText}`,
              hasProductCards: discDerived.hasProductCards,
              isAmbiguousGenericQuery: discDerived.isAmbiguousGenericQuery,
              toolActive: true,
              userMessage: message,
              extraContextPrefix: shippingCartPrefix,
            }),
          },
          ...historyMessages,
          { role: 'user', content: message },
        ],
        temperature: 0.2,
      });

      rawReply = discCompletion.choices[0].message.content ?? '';
      // Model bazen fiyatları sadece karta bırakıyor; sorulduysa metne ekle.
      if (
        priceAskGuard &&
        typeof listPrice === 'number' &&
        typeof salePrice === 'number' &&
        (!rawReply.includes(String(listPrice)) || !rawReply.includes(String(salePrice)))
      ) {
        rawReply =
          `${rawReply}\n\nListe fiyatı: ${listPrice} TL, indirimli fiyat: ${salePrice} TL.`.trim();
      }
    } else if (
      // "En ucuz indirimli çerçeveyi alıp iade edebilir miyim?" — politika + ürün
      /(indirim|kampanya)/i.test(message) &&
      /(iade|cayma)/i.test(message)
    ) {
      const discRetCategories = findMentionedCategories(message, knownCategories);
      const discRetDocs = await executeSearchProducts(supabase, knownCategories, {
        ...(discRetCategories[0] ? { category: discRetCategories[0] } : {}),
        on_discount_only: true,
        sort_by: 'price_asc',
        limit: 1,
      });
      const seenDiscRet = new Set<string>();
      documents = discRetDocs.filter((doc) => {
        const key = `${doc.metadata?.category ?? ''}|${doc.metadata?.title ?? ''}`;
        if (seenDiscRet.has(key)) return false;
        seenDiscRet.add(key);
        return true;
      });

      const discRetDerived = buildDerivedPromptFields(documents, true);
      hasProductCards = discRetDerived.hasProductCards;
      const discRetDoc = documents[0];
      const discRetTitle =
        typeof discRetDoc?.metadata?.title === 'string'
          ? discRetDoc.metadata.title
          : 'İndirimli ürün';
      const discRetList = discRetDoc?.metadata?.list_price;
      const discRetSale = discRetDoc?.metadata?.price;
      const discRetGuard =
        documents.length > 0
          ? [
              '=== ZORUNLU CEVAP (İNDİRİMLİ ÜRÜN + İADE) ===',
              `Ürün: ${discRetTitle}`,
              typeof discRetList === 'number' && typeof discRetSale === 'number'
                ? `Liste fiyatı: ${discRetList} TL; indirimli/satış: ${discRetSale} TL. Her iki fiyatı da metinde yaz.`
                : 'Fiyatları bağlamdan yaz.',
              'İADE: Hayır — indirimdeki/kampanyalı ürünler iade edilemez. "14 gün iade edebilirsiniz" DEME.',
              '',
            ].join('\n')
          : 'İndirimli ürün bulunamadı; yine de genel kuralı söyle: indirimdeki ürünler iade edilemez.\n\n';

      const discRetCompletion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: buildSystemPrompt({
              knownCategoriesText,
              contextText: `${discRetGuard}${discRetDerived.contextText}`,
              hasProductCards: discRetDerived.hasProductCards,
              isAmbiguousGenericQuery: discRetDerived.isAmbiguousGenericQuery,
              toolActive: true,
              userMessage: message,
              extraContextPrefix: shippingCartPrefix,
            }),
          },
          ...historyMessages,
          { role: 'user', content: message },
        ],
        temperature: 0.2,
      });

      rawReply = discRetCompletion.choices[0].message.content ?? '';
      if (
        documents.length > 0 &&
        typeof discRetList === 'number' &&
        typeof discRetSale === 'number' &&
        (!rawReply.includes(String(discRetList)) || !rawReply.includes(String(discRetSale)))
      ) {
        rawReply =
          `${rawReply}\n\n${discRetTitle} — Liste: ${discRetList} TL, indirimli: ${discRetSale} TL. İndirimli ürünler iade edilemez.`.trim();
      }
    } else if (
      // "en ucuz 3 afiş çerçevesi" — ranking soruları direct-category'yi bypass
      // ettiği için tool çağrılmazsa kartsız kalabiliyor; burada zorla çek.
      findMentionedCategories(message, knownCategories).length > 0 &&
      /(en ucuz|en pahalı|en pahali|en ağır|en agir|en hafif)/i.test(message) &&
      !messageFilters.out_of_stock_only
    ) {
      const rankCategories = findMentionedCategories(message, knownCategories);
      const countMatch =
        message.match(/en (?:ucuz|pahalı|pahali|ağır|agir|hafif)\s+(\d+)/i) ||
        message.match(/(\d+)\s*(?:adet\s+)?(?:en ucuz|en pahalı|en pahali)/i) ||
        message.match(/en ucuz\s+(\d+)/i);
      const requestedCount = countMatch?.[1] ? Number(countMatch[1]) : NaN;
      const wantsSingle =
        looksLikeRankingOrSingleItemQuestion(message) &&
        !(Number.isFinite(requestedCount) && requestedCount > 1);
      const sortBy = messageFilters.sort_by ?? 'price_asc';

      // Beraberlik (aynı en düşük fiyat) için önce geniş çek, sonra kırp
      let rankDocs = await executeSearchProducts(supabase, knownCategories, {
        category: rankCategories[0],
        ...messageFilters,
        sort_by: sortBy,
        limit: 50,
      });
      const seenRank = new Set<string>();
      rankDocs = rankDocs.filter((doc) => {
        const key = `${doc.metadata?.category ?? ''}|${doc.metadata?.title ?? ''}`;
        if (seenRank.has(key)) return false;
        seenRank.add(key);
        return true;
      });

      if (Number.isFinite(requestedCount) && requestedCount > 0) {
        rankDocs = rankDocs.slice(0, Math.min(requestedCount, 50));
      } else if (wantsSingle) {
        if (sortBy === 'price_asc' || sortBy === 'price_desc') {
          const prices = rankDocs
            .map((doc) => doc.metadata?.price)
            .filter((price): price is number => typeof price === 'number');
          if (prices.length > 0) {
            const target =
              sortBy === 'price_asc' ? Math.min(...prices) : Math.max(...prices);
            const tied = rankDocs.filter((doc) => doc.metadata?.price === target);
            rankDocs = tied.length > 0 ? tied : rankDocs.slice(0, 1);
          } else {
            rankDocs = rankDocs.slice(0, 1);
          }
        } else {
          rankDocs = rankDocs.slice(0, 1);
        }
      }

      documents = rankDocs;

      const rankDerived = buildDerivedPromptFields(documents, true);
      hasProductCards = rankDerived.hasProductCards;
      const rankGuard = emptySearchGuard(documents, {
        ...messageFilters,
        category: rankCategories[0],
      });
      const countGuard =
        Number.isFinite(requestedCount) && requestedCount > 0
          ? `ÖNEMLİ: Kullanıcı ${requestedCount} ürün istedi; sonuçta ${documents.length} ürün var. Kural 10'a uy.\n\n`
          : wantsSingle && documents.length > 1
            ? `ÖNEMLİ: En ucuz/pahalı değerde ${documents.length} ürün BERABERE. "Yalnızca 1 ürün var" DEME; berabere ürünleri belirt.\n\n`
            : wantsSingle
              ? 'ÖNEMLİ: Bu, sıralama sonucundaki birincil üründür. Filtreye uyan başka ürün yokmuş gibi "kategoride yalnızca 1 ürün" DEME (bilmiyorsan söyleme).\n\n'
              : '';
      const priceStockGuard = wantsInlinePriceStockSummary(message)
        ? buildProductPriceStockSummary(documents)
        : '';
      const colorCompareGuard = buildMultiColorCompareGuard(
        documents,
        messageFilters.colors ?? []
      );

      const rankCompletion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: buildSystemPrompt({
              knownCategoriesText,
              contextText: `${countGuard}${colorCompareGuard}${priceStockGuard}${rankGuard}${rankDerived.contextText}`,
              hasProductCards: rankDerived.hasProductCards,
              isAmbiguousGenericQuery: rankDerived.isAmbiguousGenericQuery,
              toolActive: true,
              userMessage: message,
              extraContextPrefix: shippingCartPrefix,
            }),
          },
          ...historyMessages,
          { role: 'user', content: message },
        ],
        temperature: 0.2,
      });

      rawReply = rankCompletion.choices[0].message.content ?? '';
      if (priceStockGuard && !/\d+\s*tl/i.test(rawReply)) {
        const compact = buildProductPriceStockSummary(documents)
          .replace(/^FİYAT\/STOK ÖZETİ[^\n]*\n/, '')
          .trim();
        if (compact) {
          rawReply = `${rawReply}\n\n${compact}`.trim();
        }
      }
    } else if (
      // "1000 TL altı B2" / "32 mm" / "kırmızı ile siyah A1" — zorunlu filtreli arama
      (messageFilters.dimension ||
        messageFilters.max_price != null ||
        messageFilters.min_price != null ||
        messageFilters.color ||
        (messageFilters.colors && messageFilters.colors.length > 0) ||
        messageFilters.profile_thickness_mm != null) &&
      !messageFilters.out_of_stock_only
    ) {
      const filterCategories = findMentionedCategories(message, knownCategories);
      const wantsSingleFilter =
        looksLikeRankingOrSingleItemQuestion(message) &&
        !(messageFilters.colors && messageFilters.colors.length > 1) &&
        !/en (?:ucuz|pahalı|pahali|ağır|agir|hafif)\s+\d+/i.test(message);
      let filterDocs = await executeSearchProducts(supabase, knownCategories, {
        ...(filterCategories[0] ? { category: filterCategories[0] } : {}),
        ...messageFilters,
        // Çoklu renkte tek color ile ezilmesin
        color:
          messageFilters.colors && messageFilters.colors.length > 1
            ? undefined
            : messageFilters.color,
        sort_by: messageFilters.sort_by ?? 'price_asc',
        limit: 50,
      });
      const seenFilter = new Set<string>();
      filterDocs = filterDocs.filter((doc) => {
        const key = `${doc.metadata?.category ?? ''}|${doc.metadata?.title ?? ''}`;
        if (seenFilter.has(key)) return false;
        seenFilter.add(key);
        return true;
      });

      if (
        wantsSingleFilter &&
        !(messageFilters.colors && messageFilters.colors.length > 1)
      ) {
        if (
          messageFilters.sort_by === 'price_asc' ||
          messageFilters.sort_by === 'price_desc' ||
          messageFilters.sort_by == null
        ) {
          const prices = filterDocs
            .map((doc) => doc.metadata?.price)
            .filter((price): price is number => typeof price === 'number');
          if (prices.length > 0) {
            const target = Math.min(...prices);
            const tied = filterDocs.filter((doc) => doc.metadata?.price === target);
            filterDocs = tied.length > 0 ? tied : filterDocs.slice(0, 1);
          } else {
            filterDocs = filterDocs.slice(0, 1);
          }
        }
      }

      documents = filterDocs;

      const filterDerived = buildDerivedPromptFields(documents, true);
      hasProductCards = filterDerived.hasProductCards;
      const filterGuard = emptySearchGuard(documents, {
        ...messageFilters,
        category: filterCategories[0],
      });
      const priceStockGuard = wantsInlinePriceStockSummary(message)
        ? buildProductPriceStockSummary(documents)
        : '';
      const colorCompareGuard = buildMultiColorCompareGuard(
        documents,
        messageFilters.colors ?? []
      );
      const multiGuard =
        documents.length > 1
          ? `ÖNEMLİ: Filtreye uyan ${documents.length} ürün var; "yalnızca 1 ürün" DEME.\n\n`
          : '';

      const filterCompletion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: buildSystemPrompt({
              knownCategoriesText,
              contextText: `${multiGuard}${colorCompareGuard}${priceStockGuard}${filterGuard}${filterDerived.contextText}`,
              hasProductCards: filterDerived.hasProductCards,
              isAmbiguousGenericQuery: filterDerived.isAmbiguousGenericQuery,
              toolActive: true,
              userMessage: message,
              extraContextPrefix: shippingCartPrefix,
            }),
          },
          ...historyMessages,
          { role: 'user', content: message },
        ],
        temperature: 0.2,
      });

      rawReply = filterCompletion.choices[0].message.content ?? '';
      // Model tek renge kayarsa karşılaştırma özetini zorunlu ekle
      if (colorCompareGuard && (messageFilters.colors?.length ?? 0) > 1) {
        const prices = documents
          .map((doc) => doc.metadata?.price)
          .filter((price): price is number => typeof price === 'number');
        const hasBothPrices =
          prices.length >= 2 &&
          prices.every((price) => rawReply.includes(String(price)));
        if (!hasBothPrices) {
          const compact = colorCompareGuard
            .replace(/^RENK KARŞILAŞTIRMASI[^\n]*\n/, '')
            .trim();
          if (compact) {
            const nums = prices;
            let diffLine = '';
            if (nums.length >= 2) {
              const hi = Math.max(...nums);
              const lo = Math.min(...nums);
              diffLine = `\nFiyat farkı: ${hi - lo} TL; daha ucuz olan ${lo} TL olan modeldir.`;
            }
            rawReply = `${rawReply}\n\n${compact}${diffLine}`.trim();
          }
        }
      }
    } else if (directCategoryMatches.length > 0) {
      const categoryResultDocs: MatchedDocument[] = [];
      for (const category of directCategoryMatches) {
        categoryResultDocs.push(
          ...(await executeSearchProducts(supabase, knownCategories, {
            category,
            ...messageFilters,
          }))
        );
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
      const categoryGuard = emptySearchGuard(documents, {
        ...messageFilters,
        category: directCategoryMatches.join(' | '),
      });

      const categoryCompletion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: buildSystemPrompt({
              knownCategoriesText,
              contextText: `${categoryGuard}${categoryDerived.contextText}`,
              hasProductCards: categoryDerived.hasProductCards,
              isAmbiguousGenericQuery: categoryDerived.isAmbiguousGenericQuery,
              toolActive: true,
              userMessage: message,
              extraContextPrefix: shippingCartPrefix,
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
              userMessage: message,
              extraContextPrefix: shippingCartPrefix,
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

          // Model parametre unutursa bile mesajdan çıkarılan sert filtreler uygulanır
          // (bütçe, stok, indirim, ölçü, renk). Modelin verdiği değer önceliklidir.
          const outOfStock = Boolean(
            args.out_of_stock_only || messageFilters.out_of_stock_only
          );
          const mergedColors =
            (args.colors && args.colors.length > 0
              ? args.colors
              : messageFilters.colors) ?? [];
          const mergedArgs: SearchProductsArgs = {
            ...messageFilters,
            ...args,
            max_price: args.max_price ?? messageFilters.max_price,
            min_price: args.min_price ?? messageFilters.min_price,
            out_of_stock_only: outOfStock,
            // Stokta olmayan aramasında in_stock_only asla true kalmasın
            in_stock_only: outOfStock
              ? false
              : Boolean(args.in_stock_only || messageFilters.in_stock_only),
            on_discount_only: Boolean(args.on_discount_only || messageFilters.on_discount_only),
            dimension: args.dimension || messageFilters.dimension,
            profile_thickness_mm:
              args.profile_thickness_mm ?? messageFilters.profile_thickness_mm,
            colors: mergedColors.length > 1 ? mergedColors : undefined,
            color:
              mergedColors.length > 1
                ? undefined
                : args.color || messageFilters.color,
            sort_by: args.sort_by || messageFilters.sort_by,
          };

          // Bütçe/ölçü/profil/çoklu renk listesinde model limit=1 gönderirse kaçırma
          const wantsSingleTool =
            looksLikeRankingOrSingleItemQuestion(message) &&
            mergedColors.length < 2 &&
            !/en (?:ucuz|pahalı|pahali|ağır|agir|hafif)\s+\d+/i.test(message);
          if (
            !wantsSingleTool &&
            (mergedArgs.dimension ||
              mergedArgs.max_price != null ||
              mergedArgs.min_price != null ||
              mergedArgs.profile_thickness_mm != null ||
              (mergedArgs.colors && mergedArgs.colors.length > 1)) &&
            (mergedArgs.limit == null || mergedArgs.limit <= 1)
          ) {
            mergedArgs.limit = 50;
          }

          const results =
            toolCall.function.name === 'search_products'
              ? await executeSearchProducts(supabase, knownCategories, mergedArgs)
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
                list_price: doc.metadata?.list_price,
                has_discount: doc.metadata?.has_discount === true,
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
        const toolGuard = emptySearchGuard(documents, messageFilters);

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
                contextText: `${toolGuard}${toolDerived.contextText}`,
                hasProductCards: toolDerived.hasProductCards,
                isAmbiguousGenericQuery: toolDerived.isAmbiguousGenericQuery,
                toolActive: true,
                userMessage: message,
              extraContextPrefix: shippingCartPrefix,
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
    } // pinnedFollowUpProduct else sonu

    // Model, ürünleri kendisi yazmak yerine [[URUN_KARTLARI]] yer tutucusunu
    // kullanmalı (bkz. kural 0). Bu yer tutucuyu tabloyla değiştirmiyoruz;
    // olduğu gibi bırakıp frontend'e gönderiyoruz, çünkü frontend bu işareti
    // gördüğünde onu `sources` verisinden türettiği Yatay Kaydırılabilir Ürün
    // Kartları (carousel) bileşeniyle değiştirecek. Model yer tutucuyu
    // unutursa (nadiren olabilir) yanıtın sonuna ekleyerek kartların her
    // durumda kullanıcıya ulaşmasını garantiliyoruz; ürün kartı yoksa
    // olası bir yanlış kullanımı temizliyoruz.
    const replyWithPlaceholder = hasProductCards
      ? rawReply.includes(PRODUCT_CARDS_PLACEHOLDER)
        ? rawReply
        : `${rawReply}\n\n${PRODUCT_CARDS_PLACEHOLDER}`
      : rawReply.replaceAll(PRODUCT_CARDS_PLACEHOLDER, '');

    // Model yine de 1-2-3 ürün listesi yazarsa sunucuda temizle (kart + metin tekrarı olmasın).
    // Kullanıcı özellikle fiyat/stok istediyse kısa özet satırlarına izin ver.
    const allowPriceStockSummary = wantsInlinePriceStockSummary(message);
    let reply = hasProductCards
      ? sanitizeProductCardReply(replyWithPlaceholder, allowPriceStockSummary)
      : replyWithPlaceholder;

    if (
      hasProductCards &&
      allowPriceStockSummary &&
      documents.some((doc) => doc.metadata?.type === 'product') &&
      !/\d+\s*tl/i.test(reply)
    ) {
      const compact = buildProductPriceStockSummary(documents)
        .replace(/^FİYAT\/STOK ÖZETİ[^\n]*\n/, '')
        .trim();
      if (compact) {
        reply = reply.includes(PRODUCT_CARDS_PLACEHOLDER)
          ? reply.replace(
              PRODUCT_CARDS_PLACEHOLDER,
              `${compact}\n\n${PRODUCT_CARDS_PLACEHOLDER}`
            )
          : `${reply}\n\n${compact}`;
      }
    }

    // 5. Sohbeti ve mesajları kalıcı olarak sakla.
    const conversationResult = await ensureConversation(
      supabase,
      user.id,
      typeof conversationId === 'string' ? conversationId : undefined,
      message
    );
    const activeConversationId = conversationResult?.id ?? null;

    // Kart paneli gösterilmiyorsa sources'a baseline vektör çöpü yazma;
    // kart gösteriliyorsa yalnızca o yanıta ait ürün dokümanlarını sakla.
    const sourcesToPersist = hasProductCards
      ? documents.filter((doc) => doc.metadata?.type === 'product')
      : null;

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
          sources: sourcesToPersist,
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
      sources: sourcesToPersist ?? [],
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
 * henüz atanmamış (null) veya placeholder ("Yeni Sohbet") olan sohbetlere
 * ilk gerçek kullanıcı mesajından otomatik başlık atar.
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
      if (isPlaceholderConversationTitle(data.title as string | null)) {
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
