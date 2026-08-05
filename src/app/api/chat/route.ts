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
  id?: string | number;
  content: string;
  similarity?: number;
  metadata?: {
    title?: string;
    url?: string;
    type?: string;
    category?: string;
    source?: string;
    sku?: string;
    [key: string]: unknown;
  };
}

const MAX_CITATION_SOURCES = 3;
/** Zayıf vektör eşleşmelerinde Kaynaklar şişmesin (sosyal medya → 3× %40 chunk). */
const MIN_CITATION_SIMILARITY = 0.48;

/** İçindekiler / kapak gibi düşük değerli politika chunk'larını kaynak listesinden çıkar. */
function isLowValuePolicyChunk(doc: MatchedDocument): boolean {
  if (doc.metadata?.type !== 'policy') return false;
  const heading = doc.content.match(/^#{1,3}\s*(.+)$/m)?.[1]?.trim() ?? '';
  const head = heading.toLocaleLowerCase('tr-TR');
  const bodyStart = doc.content.trim().slice(0, 120).toLocaleLowerCase('tr-TR');
  return (
    /^içindekiler$/.test(head) ||
    head.includes('içindekiler') ||
    bodyStart.startsWith('# ores') ||
    /^#+\s*içindekiler/m.test(doc.content.toLocaleLowerCase('tr-TR'))
  );
}

/** Sosyal medya / telefon / e-posta gibi tek gerçek kaynaklı sorular */
function looksLikeNarrowContactQuestion(message: string): boolean {
  return /(sosyal\s*medya|instagram|facebook|youtube|twitter|linkedin|whatsapp|telefon(?:unuz|unuzu)?|e-?posta|email|mail\s*adres|iletişim\s*bilgi|çalışma\s*saat|müşteri\s*hizmet)/i.test(
    message
  );
}

/** Soruda geçen iletişim/politika terimleri chunk metninde yoksa kaynak sayma */
function policyChunkRelevantToMessage(
  doc: MatchedDocument,
  message: string
): boolean {
  const msg = message.toLocaleLowerCase('tr-TR');
  const content = doc.content.toLocaleLowerCase('tr-TR');
  const topicTerms = [
    'sosyal',
    'instagram',
    'facebook',
    'youtube',
    'twitter',
    'linkedin',
    'whatsapp',
    'telefon',
    'e-posta',
    'email',
    'iade',
    'kargo',
    'teslimat',
    'garanti',
    'gizlilik',
    'ödeme',
    'fatura',
    'kvkk',
  ];
  const mentioned = topicTerms.filter((term) => msg.includes(term));
  if (mentioned.length === 0) return true;
  return mentioned.some((term) => content.includes(term));
}

/**
 * Selamlaşma / kimlik / nezaket — cevap sistem prompt'undan gelir; kaynak gösterme.
 */
function looksLikeGreetingOrChitchat(message: string): boolean {
  const text = message.toLocaleLowerCase('tr-TR').trim();
  if (!text) return true;

  const wordCount = text.split(/\s+/).filter(Boolean).length;

  if (
    /^(merhaba|selam|selamlar|hey|hi|hello|günaydın|iyi\s*akşamlar|iyi\s*günler|slm)[\s!.?]*$/i.test(
      text
    )
  ) {
    return true;
  }

  // "merhaba sen kimsin", "sen kimsin?", "kimsin"
  if (
    wordCount <= 10 &&
    /(sen\s+kimsin|kimsin|adın\s+ne|adın\s+nedir|ne\s+yapıyorsun|nasılsın|kim\s+olduğunu)/i.test(
      text
    )
  ) {
    return true;
  }

  if (
    /^(teşekkür(?:ler)?|sağ\s*ol|sağol|tamam|ok|okay|peki|eyvallah)[\s!.?]*$/i.test(
      text
    )
  ) {
    return true;
  }

  return false;
}

/**
 * Yanıtta kullanılan ürün/politika kayıtlarını UI "Kaynaklar" paneli için hazırlar.
 * Ürün kartlı cevaplarda ürünler; aksi halde bağlamdaki policy (+ varsa ürün) chunk'ları.
 * Selamlaşma/kimlik sorularında boş döner (kaynak yanıltıcı olmasın).
 */
function dedupeDocuments(docs: MatchedDocument[]): MatchedDocument[] {
  const seen = new Set<string>();
  return docs.filter((doc) => {
    const key = `${doc.metadata?.type ?? ''}|${doc.metadata?.source ?? ''}|${
      doc.metadata?.title ?? doc.metadata?.sku ?? doc.content.slice(0, 80)
    }`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * UI "Kaynaklar" paneli için en fazla MAX_CITATION_SOURCES kayıt.
 * Ürün kartları buna BAĞLI DEĞİLDİR — kartlar buildProductCardSources ile gelir.
 */
function buildCitationSources(
  documents: MatchedDocument[],
  hasProductCards: boolean,
  message: string
): MatchedDocument[] {
  if (looksLikeGreetingOrChitchat(message)) return [];
  if (!documents.length) return [];

  const bySimilarity = (docs: MatchedDocument[]) =>
    [...docs].sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));

  // Kartlı cevapta kaynak panelinde tüm ürünleri tekrar dökme; birkaç örnek yeter
  if (hasProductCards) {
    const products = documents.filter((doc) => doc.metadata?.type === 'product');
    return bySimilarity(dedupeDocuments(products)).slice(0, MAX_CITATION_SOURCES);
  }

  let policies = documents.filter(
    (doc) => doc.metadata?.type === 'policy' && !isLowValuePolicyChunk(doc)
  );
  // "sosyal medya" sorusunda gizlilik/yasal chunk'ları ele — içerik eşleşmesi
  const topicalPolicies = policies.filter((doc) =>
    policyChunkRelevantToMessage(doc, message)
  );
  if (topicalPolicies.length > 0) {
    policies = topicalPolicies;
  }

  const products = documents.filter((doc) => doc.metadata?.type === 'product');
  const pool =
    policies.length > 0
      ? [...bySimilarity(policies), ...bySimilarity(products)]
      : products.length > 0
        ? bySimilarity(products)
        : bySimilarity(documents.filter((doc) => !isLowValuePolicyChunk(doc)));

  let ranked = dedupeDocuments(pool);

  // Zayıf eşleşmeleri kes (en iyi kaynağı her zaman tut)
  if (ranked.length > 1 && typeof ranked[0].similarity === 'number') {
    const top = ranked[0].similarity;
    ranked = ranked.filter((doc, index) => {
      if (index === 0) return true;
      if (typeof doc.similarity !== 'number') return false;
      if (doc.similarity < MIN_CITATION_SIMILARITY) return false;
      return doc.similarity >= top - 0.06;
    });
  }

  // İletişim / sosyal medya → tek kaynak yeterli
  const limit = looksLikeNarrowContactQuestion(message) ? 1 : MAX_CITATION_SOURCES;
  return ranked.slice(0, limit);
}

/**
 * Carousel için TÜM eşleşen ürünler. Eskiden citation cap (3) aynı diziye
 * uygulanıyordu → "afiş çerçevesi"nde 27 yerine 3 kart görünüyordu.
 */
function buildProductCardSources(
  documents: MatchedDocument[],
  hasProductCards: boolean
): MatchedDocument[] {
  if (!hasProductCards) return [];
  return dedupeDocuments(
    documents.filter((doc) => doc.metadata?.type === 'product')
  );
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

  // Tek kelime alias: "çerçeveyi/çerçeve" → Afiş Çerçevesi (her iki kelime şartı olmasa da)
  // NOT: JS \b Türkçe harflerde (ç/ş/ı…) kırılır; \p{L} lookbehind kullan.
  if (matches.length === 0) {
    const wantsFrame = /(?<!\p{L})çerçeve/iu.test(message);
    const wantsPano = /(?<!\p{L})(?:pano|kaldırım)/iu.test(message);
    if (wantsFrame) {
      const frameCat = knownCategories.find(
        (c) => /çerçeve/i.test(c) && !isCategoryNegatedInMessage(message, c)
      );
      if (frameCat) matches.push(frameCat);
    }
    if (wantsPano && !wantsFrame) {
      const panoCat = knownCategories.find(
        (c) => /pano/i.test(c) && !isCategoryNegatedInMessage(message, c)
      );
      if (panoCat) matches.push(panoCat);
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
  if (wantsAllCatalogProducts(message)) return [];

  // Fiyat aralığı / ölçü / renk gibi sert filtre varsa kategori "tümünü listele"
  // yoluna düşme — filter branch uygulasın.
  const filters = extractSearchFiltersFromMessage(message);
  if (
    filters.max_price != null ||
    filters.min_price != null ||
    filters.dimension ||
    filters.color ||
    (filters.colors && filters.colors.length > 0) ||
    filters.profile_thickness_mm != null ||
    filters.corner_type != null
  ) {
    return [];
  }

  const wordCount = message.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount === 0) return [];

  const browseIntent =
    /(hakkında|bilgi|göster|listele|neler var|hangileri|ürünler|almak istiyorum|incelemek|indirimli|kampanya|stokta|bütçe|\btl\b|lira|satın al|görmek)/i.test(
      message
    );

  // Kısa kategori cevabı ("afiş çerçevesi") veya biraz daha uzun browse
  // cümlesi ("kaldırım panoları hakkında bilgi almak istiyorum").
  if (wordCount > 6 && !browseIntent) return [];
  if (wordCount > 22) return [];

  return findMentionedCategories(message, knownCategories);
}

/** "Tüm ürünleri göster / katalogdaki her şey / hepsine bakmak istiyorum" */
function wantsAllCatalogProducts(message: string): boolean {
  const t = message.toLocaleLowerCase('tr-TR').trim();
  if (
    /^(hepsi|hepsine|hepsini|tümü|tumü|hepsine\s+bak(?:mak)?(?:\s+istiyorum)?)\s*[.!]?\s*$/i.test(
      t
    )
  ) {
    return true;
  }
  return /(tüm\s*ürün|tum\s*urun|bütün\s*ürün|butun\s*urun|tüm\s*katalog|katalogdaki\s*her|hepsini\s*(göster|gör|göstermek|görmek|listele|incele|iste|istem)|hepsine\s*(bak|bakmak|göz|incele)|tümüne\s*(bak|bakmak|göz)|bütün\s*katalog|mağazadaki\s*tüm|ürünlerinizi\s*(görmek|incelemek)|hepsine\s*bakmak\s*ist)/i.test(
    t
  );
}

/** "27 adet yok mu? / kaç ürün var?" — sayıyı DB'den doğrula */
function looksLikeCatalogCountQuestion(message: string): boolean {
  return /(kaç\s*(adet|ürün)|(?:\d+)\s*adet.{0,40}(?:yok\s*mu|değil\s*mi|var\s*mı|değil)|daha\s*fazla\s*ürün|hepsi\s*bu|yalnızca\s*\d+|sadece\s*\d+\s*ürün|bu kadar\s*mı)/i.test(
    message
  );
}

function inferCategoryFromHistory(
  history: HistoryTurn[],
  message: string,
  knownCategories: string[]
): string | null {
  const fromMessage = findMentionedCategories(message, knownCategories);
  if (fromMessage[0]) return fromMessage[0];
  const blob = [...history]
    .slice(-6)
    .map((turn) => turn.content)
    .join(' ');
  return findMentionedCategories(blob, knownCategories)[0] ?? null;
}

/**
 * Bütçe takibinde kategori: sadece KULLANICININ seçtiği.
 * Asistanın "afiş çerçevesi veya kaldırım panosu" menüsü kategori sayılmaz
 * (aksi halde "800 lira altında" yanlışlıkla panoya kilitlenir).
 */
function inferUserCommittedCategoryFromHistory(
  history: HistoryTurn[],
  message: string,
  knownCategories: string[]
): string | null {
  const fromMessage = findMentionedCategories(message, knownCategories);
  if (fromMessage.length === 1) return fromMessage[0];
  if (fromMessage.length > 1) return fromMessage[0];

  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].role !== 'user') continue;
    const cats = findMentionedCategories(history[i].content, knownCategories);
    if (cats.length === 1) return cats[0];
    if (cats.length > 1) return cats[0];
  }
  return null;
}

/** "evet başka kategoride olsun" — ürün pin'i değil, kategori pivotu */
function looksLikeAcceptAlternateCategory(message: string): boolean {
  const t = message.toLocaleLowerCase('tr-TR');
  if (/(başka|diğer|farklı)\s+(bir\s+)?kategori/i.test(t)) return true;
  if (/kategoride\s+(olsun|bakar|bakayım|olur|ister)/i.test(t)) return true;
  if (
    /^(evet|tamam|olur)\b/i.test(t.trim()) &&
    /(başka|diğer).{0,24}(kategori|ürün)/i.test(t) &&
    !/(bu\s+ürün|bunun|bilgi\s*almak|incelemek\s*ister)/i.test(t)
  ) {
    return true;
  }
  return false;
}

/** "evet" / "evet ," / "tamam" — tek başına onay */
function looksLikeBareAffirmative(message: string): boolean {
  const t = message
    .toLocaleLowerCase('tr-TR')
    .trim()
    .replace(/[,.!;:…]+$/g, '')
    .trim();
  return /^(evet|tamam|olur|ok|okay|peki|tabii|tabi|isterim)$/i.test(t);
}

/** Son asistan "başka kategori / daha yüksek bütçe?" teklifi yaptı mı */
function lastAssistantOfferedAlternateCategory(history: HistoryTurn[]): boolean {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].role !== 'assistant') continue;
    return /(başka\s+(bir\s+)?kategori|diğer\s+kategori|yüksek\s+bir\s+bütçe|ör\.\s*afiş|örneğin\s*afiş)/i.test(
      history[i].content
    );
  }
  return false;
}

/** Açık pivot VEYA asistan teklifine çıplak "evet" */
function shouldAcceptAlternateCategory(
  message: string,
  history: HistoryTurn[]
): boolean {
  if (history.length === 0) return false;
  if (looksLikeAcceptAlternateCategory(message)) return true;
  return (
    looksLikeBareAffirmative(message) &&
    lastAssistantOfferedAlternateCategory(history)
  );
}

/** Son kullanıcı mesajlarından bütçe (max_price) taşı */
function inferMaxPriceFromHistory(history: HistoryTurn[]): number | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].role !== 'user') continue;
    const price = extractSearchFiltersFromMessage(history[i].content).max_price;
    if (typeof price === 'number' && price > 0) return price;
  }
  return null;
}

/**
 * Asistanın önerdiği alternatif kategori ("ör. afiş çerçevesi").
 * Yoksa bilinen kategorilerden, kullanıcıyı sıkıştıran kategorinin dışındakini seç.
 */
function inferSuggestedAlternateCategory(
  history: HistoryTurn[],
  knownCategories: string[]
): string | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].role !== 'assistant') continue;
    const content = history[i].content;
    const orMatch = content.match(/(?:ör\.|örneğin|mesela)\s*([^).,\n]+)/i);
    if (orMatch?.[1]) {
      const fromHint = findMentionedCategories(orMatch[1], knownCategories)[0];
      if (fromHint) return fromHint;
    }
    const cats = findMentionedCategories(content, knownCategories);
    const frame = cats.find((c) => /çerçeve/i.test(c));
    if (frame && cats.some((c) => /pano/i.test(c))) return frame;
  }

  const stuck = inferCategoryFromHistory(history, '', knownCategories);
  return knownCategories.find((c) => c !== stuck) ?? knownCategories[0] ?? null;
}

/** "her çerçevenin profili 25 mm mi?" — tek ürüne/filtreye kilitleme */
function looksLikeUniversalProfileQuestion(message: string): boolean {
  const t = message.toLocaleLowerCase('tr-TR');
  if (!/(profil|kalınl[ıi]k|\d+\s*mm)/i.test(t)) return false;
  return /(her\s+çerçeve|her\s+ürün|hepsi|hepsinin|hepsinde|tüm\s+çerçeve|tümünün|bütün\s+çerçeve|hepsi\s+\d+\s*mm)/i.test(
    t
  );
}

/**
 * Katalog profil soruları — pin yasak.
 * "kaç mmlik ürünler var", "hangi ürünün kalınlığı 35 mm"
 * NOT: "bu ürünün kalınlığı ne?" (tek ürün takibi)
 */
function looksLikeProfileCatalogQuestion(message: string): boolean {
  if (looksLikeUniversalProfileQuestion(message)) return true;
  const t = message.toLocaleLowerCase('tr-TR');
  if (/(bu\s+ürün|bunun|gösterdiğin|o\s+ürünün|şu\s+ürün)/i.test(t)) {
    return false;
  }
  if (/(kaç\s*mm|mm'?lik|mmlik)/i.test(t)) return true;
  if (/hangi\s+ürün/i.test(t) && /(mm|profil|kalınl)/i.test(t)) return true;
  if (
    /\d{2}\s*mm/i.test(t) &&
    /(ürünler(?:i|in|ini|imiz)?|ürünlerini|listele|göster|incele)/i.test(t)
  ) {
    return true;
  }
  if (/(profil|kalınlık).{0,24}(kaç|neler|hangi|var\s*mı|mevcut)/i.test(t)) {
    return true;
  }
  return false;
}

/** "her fiyatta olabilir" → önceki profil kalsın, fiyat kısıtı kalksın. */
function looksLikeAnyPriceFollowUp(message: string): boolean {
  const t = message.toLocaleLowerCase('tr-TR');
  return /(her\s+fiyat|fiyat\s+(?:fark\s*etmez|önemli\s+değil|önemsiz)|bütçe\s+(?:fark\s*etmez|yok)|fiyat\s+kısıt(?:ı|laması)?\s+yok)/i.test(
    t
  );
}

function inferLastRequestedProfileMm(history: HistoryTurn[]): number | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].role !== 'user') continue;
    const mm = extractClaimedProfileMm(history[i].content);
    if (
      mm != null &&
      /(mm|profil|kalınl)/i.test(history[i].content)
    ) {
      return mm;
    }
  }
  return null;
}

function extractClaimedProfileMm(message: string): number | null {
  // "35 mm", "35mm", "35 mmdir" (\b mm\b "mmdir"de kırılır)
  const match = message.match(/(\d{2})\s*mm/i);
  if (!match?.[1]) return null;
  const mm = Number(match[1]);
  return Number.isFinite(mm) && mm >= 10 && mm <= 80 ? mm : null;
}

function collectProfileThicknessesMm(docs: MatchedDocument[]): number[] {
  const set = new Set<number>();
  for (const doc of docs) {
    const raw = doc.metadata?.profile_thickness_mm;
    const mm =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string' && raw.trim() && !Number.isNaN(Number(raw))
          ? Number(raw)
          : NaN;
    if (Number.isFinite(mm)) set.add(mm);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * Mesajda yeni bir arama kriteri (renk, ölçü, profil, bütçe) var mı?
 * "A2 ölçüsünde var mı" gibi sorular son gösterilen ürünün takibi değil,
 * kataloğa yapılan yeni bir aramadır.
 */
function hasNewSearchCriterion(message: string): boolean {
  const filters = extractSearchFiltersFromMessage(message);
  return (
    filters.color != null ||
    (filters.colors?.length ?? 0) > 0 ||
    filters.dimension != null ||
    filters.profile_thickness_mm != null ||
    filters.corner_type != null ||
    filters.max_price != null ||
    filters.min_price != null
  );
}

/** "var mı" / "göster" / "istiyorum" — katalogda arama isteği */
function asksCatalogLookup(message: string): boolean {
  const t = message.toLocaleLowerCase('tr-TR');
  return /(var\s*mı|var\s*mi|varmı|mevcut\s*mu|bulunuyor\s*mu|bulunur\s*mu|göster|listele|istiyorum|arıyorum|olanlar|olan\s*var|hangi|neler)/i.test(
    t
  );
}

/** "hangi renkler var" / "renk seçenekleri neler" — tek ürün değil, katalog dökümü */
function looksLikeColorCatalogQuestion(message: string): boolean {
  const t = message.toLocaleLowerCase('tr-TR');
  if (!/renk|renkler|renkte|renginde/i.test(t)) return false;
  // "bu ürünün rengi ne?" tek ürün sorusudur
  if (/(bu|şu|o)\s+(ürün|çerçeve|pano|model)|bunun|onun\s+reng/i.test(t)) return false;
  return /(hangi\s+renk|ne\s+renk|renkler\s+(?:var|mevcut|neler)|renk\s*(?:seçenek|çeşit)|renkleri\s+(?:neler|nedir|var)|kaç\s+renk|renklerde)/i.test(
    t
  );
}

/**
 * "kırmızı renkte ürün var mı" — belirli bir rengin katalogda olup olmadığı.
 * Son konuşulan ürüne ait takip sorusu DEĞİL; yeni bir arama.
 */
function looksLikeColorAvailabilityQuestion(message: string): boolean {
  const t = message.toLocaleLowerCase('tr-TR');
  if (extractColorsFromMessage(t).length === 0) return false;
  if (/(bu|şu|o)\s+(ürün|çerçeve|pano|model)|bunun|bunu\b/i.test(t)) return false;
  return /(var\s*mı|var\s*mi|varmı|mevcut\s*mu|bulunuyor\s*mu|bulunur\s*mu|olan\s*var|istiyorum|arıyorum|göster|listele|olsun)/i.test(
    t
  );
}

/**
 * Katalogdaki renkleri ürün sayısıyla toplar. Tek kayıtta "Beyaz, Gümüş" gibi
 * çoklu değerler olabildiği için virgülden ayırıyoruz.
 */
function collectColorsFromDocs(
  docs: MatchedDocument[]
): { label: string; count: number }[] {
  const counts = new Map<string, { label: string; count: number }>();
  for (const doc of docs) {
    if (doc.metadata?.type !== 'product') continue;
    const raw = doc.metadata?.color;
    if (typeof raw !== 'string' || !raw.trim()) continue;
    for (const part of raw.split(/[,/]/)) {
      const label = part.trim();
      if (!label) continue;
      const key = label.toLocaleLowerCase('tr-TR');
      const existing = counts.get(key);
      if (existing) existing.count += 1;
      else counts.set(key, { label, count: 1 });
    }
  }
  return [...counts.values()].sort(
    (a, b) => b.count - a.count || a.label.localeCompare(b.label, 'tr')
  );
}

/** "18 tane / 18 adet alabilir miyim?" — miktar; bütçe (TL) değil */
function extractRequestedPurchaseQty(message: string): number | null {
  const match = message.match(/(\d+)\s*(?:adet|tane|parça)\b/i);
  if (!match?.[1]) return null;
  const qty = Number(match[1]);
  if (!Number.isFinite(qty) || qty <= 0 || qty > 500) return null;
  return qty;
}

/** "15 tane alayım / alabilir miyim / sipariş vermek istiyorum" */
const PURCHASE_QTY_INTENT_RE =
  /(alabilir|almak|alay[ıi]m|al[ıi]r[ıi]m|sipariş|sat[ıi]n|kargo|kargola|gönder|isterim)/i;

function looksLikeQuantityPurchaseQuestion(message: string): boolean {
  return (
    extractRequestedPurchaseQty(message) != null &&
    PURCHASE_QTY_INTENT_RE.test(message)
  );
}

/** "5311 TL elimde var, bu ürünü alabilir miyim?" — katalog bütçe filtresi değil */
function looksLikeAffordabilityQuestion(message: string): boolean {
  const t = message.toLocaleLowerCase('tr-TR');
  // "18 tane alabilir miyim" → stok/adet; asla bütçe sanma
  if (looksLikeQuantityPurchaseQuestion(message)) return false;
  if (/(neden\s*alamam|neden\s*alamıyorum|neden\s*olmaz|neden\s*alamaz)/i.test(t)) {
    return true;
  }
  if (
    /((?:elimde|bende|cüzdanımda).{0,40}\d+|\d+.{0,40}(?:elimde|bende)\s*var)/i.test(t) &&
    /(alabilir|almak|yeter|ürün|satın)/i.test(t)
  ) {
    return true;
  }
  // Para birimi zorunlu — çıplak "18 alabilir miyim" bütçe değildir
  if (
    /\d+(?:[.,]\d+)?\s*(?:tl|₺|lira)\b/.test(t) &&
    /(bu\s+ürünü?\s*)?(alabilir\s*miyim|almak\s*ister|ile\s*al)/i.test(t)
  ) {
    return true;
  }
  return false;
}

function extractAffordabilityAmount(message: string): number | null {
  if (looksLikeQuantityPurchaseQuestion(message)) return null;
  const t = message.toLocaleLowerCase('tr-TR');
  const patterns = [
    /(\d+(?:[.,]\d+)?)\s*(?:tl|₺|lira|try)?\s*(?:elimde|bende)/i,
    /(?:elimde|bende|cüzdanımda)\s*(\d+(?:[.,]\d+)?)/i,
    /(\d+(?:[.,]\d+)?)\s*(?:tl|₺|lira)?\s*[ey]'?(?:ye|e)?\s*neden\s*alam/i,
    /(\d+(?:[.,]\d+)?)\s*(?:tl|₺|lira|try)\b/i,
  ];
  for (const pattern of patterns) {
    const match = t.match(pattern);
    if (match?.[1]) {
      const value = Number(match[1].replace(',', '.'));
      if (Number.isFinite(value) && value > 0) return value;
    }
  }
  return null;
}

function buildAffordabilityReply(
  amount: number,
  product: MatchedDocument
): string | null {
  const price = product.metadata?.price;
  if (typeof price !== 'number' || !Number.isFinite(price)) return null;
  const title =
    typeof product.metadata?.title === 'string' && product.metadata.title.trim()
      ? product.metadata.title.trim()
      : 'Bu ürün';
  const stock = product.metadata?.stock;
  const url =
    typeof product.metadata?.url === 'string' ? product.metadata.url.trim() : '';
  const linkBit = url ? ` Satın alma: [${title}](${url}).` : '';

  if (amount >= price) {
    const stockBit =
      typeof stock === 'number' && stock <= 0
        ? ` Bütçeniz yeterli; ancak ürün şu an stokta yok — stok veya alternatif için yardımcı olabilirim.`
        : linkBit ||
          ' Mağaza sayfasından sipariş verebilirsiniz.';
    return `Evet — elinizdeki ${amount} TL yeterli (satış fiyatı ${price} TL). Ödeme ${price} TL üzerinden alınır; elinizde fazlası olması sorunu değil.${stockBit}`;
  }

  const gap = Math.round((price - amount) * 100) / 100;
  return `Hayır — "${title}" satış fiyatı ${price} TL. Elinizdeki ${amount} TL yetersiz (fark ${gap} TL).`;
}

/** Kilitli ürün için "N adet/tane alabilir miyim?" → stok karşılaştırması */
function buildStockQuantityReply(qty: number, product: MatchedDocument): string {
  const title =
    typeof product.metadata?.title === 'string' && product.metadata.title.trim()
      ? product.metadata.title.trim()
      : 'Bu ürün';
  const stock = product.metadata?.stock;
  if (typeof stock !== 'number' || !Number.isFinite(stock)) {
    return `"${title}" için stok bilgisini doğrulayamadım; teyit için iletişime geçebilirsiniz.`;
  }
  if (stock <= 0) {
    return `Hayır — "${title}" şu an stokta yok; ${qty} adet gönderemiyoruz.`;
  }
  if (stock < qty) {
    return `Hayır — "${title}" için stokta yalnızca ${stock} adet var; ${qty} adet için stok yetersiz.`;
  }
  return `Evet — "${title}" için stokta ${stock} adet var; ${qty} adet sipariş verebilirsiniz.`;
}

/** Kilitli ürün + "N adet kargolar mısınız / kargo ücretsiz mi?" */
function buildPinnedShippingQuantityReply(
  message: string,
  product: MatchedDocument
): string | null {
  if (!/(kargo|ücretsiz|kargola)/i.test(message)) return null;
  const qty = extractRequestedPurchaseQty(message);
  if (qty == null) return null;
  const unit = product.metadata?.price;
  const title =
    typeof product.metadata?.title === 'string' && product.metadata.title.trim()
      ? product.metadata.title.trim()
      : 'Bu ürün';
  if (typeof unit !== 'number' || !Number.isFinite(unit) || unit <= 0) return null;

  const stock = product.metadata?.stock;
  if (typeof stock === 'number' && stock < qty) {
    return `Hayır — "${title}" için stokta yalnızca ${stock} adet var; ${qty} adet kargolayamayız.`;
  }

  const total = Math.round(unit * qty * 100) / 100;
  const free = total >= FREE_SHIPPING_THRESHOLD_TL;
  if (free) {
    return `Evet — "${title}" birim ${unit} TL × ${qty} adet = ${total} TL; ücretsiz kargo eşiği ${FREE_SHIPPING_THRESHOLD_TL} TL olduğu için kargo ücretsiz olur.`;
  }
  return `Hayır — "${title}" birim ${unit} TL × ${qty} adet = ${total} TL; ücretsiz kargo için ${FREE_SHIPPING_THRESHOLD_TL} TL eşiğinin altında. Kargo ücretli olabilir.`;
}

/**
 * Kullanıcı mesajından deterministik arama filtrelerini çıkarır.
 * Direct category browse yolunda tool çağrısı atlandığı için burada
 * uygulanmazsa bütçe/indirim/ölçü/stok kriterleri yok sayılır.
 */
function extractSearchFiltersFromMessage(message: string): Partial<SearchProductsArgs> {
  const text = message.toLocaleLowerCase('tr-TR');
  const filters: Partial<SearchProductsArgs> = {};

  // "5311 elimde var alabilir miyim?" → max_price DEĞİL (yeterlilik sorusu)
  const affordabilityNotBudget =
    looksLikeAffordabilityQuestion(message) &&
    !/(\d+(?:[.,]\d+)?)\s*(?:tl|₺|lira|try)?\s*(?:altı|altında|kadar)/i.test(text) &&
    !/(en fazla|maksimum|max\.?)\s*\d+/i.test(text);
  // "sepetimde 751 TL var kargo ücreti öder miyim?" → bütçe filtresi DEĞİL
  const cartShippingNotBudget = looksLikeCartShippingFeeQuestion(message);
  const skipBudgetFromAmount = affordabilityNotBudget || cartShippingNotBudget;

  // "300 TL ile 700 TL arasında" / "300-700 TL arası"
  const rangeMatch = text.match(
    /(\d+(?:[.,]\d+)?)\s*(?:tl|₺|lira|try)?\s*(?:ile|-|–|—)\s*(\d+(?:[.,]\d+)?)\s*(?:tl|₺|lira|try)?\s*(?:arasında|aras[ıi]|aral[ıi][gğ][ıi]nda)/i
  );
  if (!skipBudgetFromAmount && rangeMatch?.[1] && rangeMatch?.[2]) {
    const a = Number(rangeMatch[1].replace(',', '.'));
    const b = Number(rangeMatch[2].replace(',', '.'));
    if (Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0) {
      filters.min_price = Math.min(a, b);
      filters.max_price = Math.max(a, b);
      filters.min_price_exclusive = false;
    }
  }

  // "1000 TL altı", "bende 1000 lira var", "1000 liram var"
  const maxPatterns = [
    /(\d+(?:[.,]\d+)?)\s*(?:tl|₺|lira|try)?\s*(?:altı|altında|kadar)/i,
    /(?:en fazla|maksimum|max\.?|en çok)\s*(\d+(?:[.,]\d+)?)\s*(?:tl|₺|lira|try)?/i,
    /(?:bütçe(?:m|niz|si)?|param|paramız|bende|elimde|cüzdanımda)\s*(?:ise\s*)?(\d+(?:[.,]\d+)?)\s*(?:tl|₺|lira(?:m|mız|nız)?|try)?/i,
    /(\d+(?:[.,]\d+)?)\s*(?:tl|₺|lira(?:m|mız|nız)?|try)\s*(?:bütçe(?:m|miz)?|param)?\s*var/i,
    /(?:bende|elimde)\s*(\d+(?:[.,]\d+)?)\s*(?:tl|₺|lira(?:m|mız|nız)?|try)?\s*var/i,
  ];

  if (!skipBudgetFromAmount && filters.max_price == null) {
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
  }

  // "1000 TL üzeri/üstünde" → exclusive; "en az 1000" → inclusive
  if (filters.min_price == null) {
    const exclusiveMin = text.match(
      /(\d+(?:[.,]\d+)?)\s*(?:tl|₺|lira|try)?\s*(?:üzeri|üstünde|üstü|ve üzeri)/i
    );
    if (exclusiveMin?.[1]) {
      const value = Number(exclusiveMin[1].replace(',', '.'));
      if (Number.isFinite(value) && value > 0) {
        filters.min_price = value;
        filters.min_price_exclusive = true;
      }
    } else {
      const inclusiveMin = text.match(
        /(?:en az|minimum|min\.?)\s*(\d+(?:[.,]\d+)?)\s*(?:tl|₺|lira|try)?/i
      );
      if (inclusiveMin?.[1]) {
        const value = Number(inclusiveMin[1].replace(',', '.'));
        if (Number.isFinite(value) && value > 0) {
          filters.min_price = value;
        }
      }
    }
  }

  const purchaseIntent =
    /(almak istiyorum|satın al|sipariş(?: etmek)?|alışveriş|ürün almak|alabilirim|alabilir\s*miyim|alayım|hangisini al|hangilerini al|ne alabilir)/i.test(
      text
    );
  // "bilgi almak isterim / incelemek isterim" satın alma değil — stok=0 ürünü gizleme
  const infoBrowseOnly =
    /(bilgi\s*almak|hakkında\s*bilgi|incelemek|inceleyeyim|görmek\s*ister|neler\s*var)/i.test(
      text
    ) && !/(satın\s*al|sipariş|kaç\s*adet\s*al)/i.test(text);

  // "Stokta olmayan en ucuz..." → out_of_stock; purchaseIntent burada in_stock
  // zorlamamalı (aksi halde stok=0 ürünler hiç bulunamaz).
  if (wantsOutOfStockProducts(message)) {
    filters.out_of_stock_only = true;
    if (/(en ucuz|en uygun fiyat|ucuz)/i.test(text)) {
      filters.sort_by = 'price_asc';
    }
  } else if (
    !infoBrowseOnly &&
    (/(stokta olan|stoktakiler|stokta var|stokta bulunan|stokta bulunanlar|sadece stok|stokta olanlar|şu an stokta)/i.test(
      text
    ) ||
      purchaseIntent ||
      // Bütçe sorusu genelde "ne alabilirim" anlamına gelir → stoksuz gösterme
      filters.max_price != null)
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

  // Köşe tipi: "gönye köşeli" / "rondo köşe"
  const cornerType = extractCornerTypeFromMessage(message);
  if (cornerType) {
    filters.corner_type = cornerType;
  }

  // Renk / görünüm — tek renk filtre; birden fazla renk = karşılaştırma (OR)
  const colors = extractColorsFromMessage(text);
  if (colors.length === 1) {
    filters.color = colors[0];
  } else if (colors.length > 1) {
    filters.colors = colors;
  }

  // Profil: "32 mm" / "35mmdir" — evrensel/katalog sorusunda filtreye çevirme
  // (aksi halde sadece o mm kalır veya pin yolu saçmalar).
  if (
    !looksLikeUniversalProfileQuestion(message) &&
    !looksLikeProfileCatalogQuestion(message)
  ) {
    const claimedMm = extractClaimedProfileMm(message);
    if (claimedMm != null) {
      filters.profile_thickness_mm = claimedMm;
    }
  } else if (
    looksLikeProfileCatalogQuestion(message) &&
    /hangi\s+ürün|hangisi|var\s*mı|yok\s*mu/i.test(message)
  ) {
    // "hangi ürün 35 mm?" → filtrele; "kaç mm var?" → filtreleme
    const claimedMm = extractClaimedProfileMm(message);
    if (claimedMm != null) {
      filters.profile_thickness_mm = claimedMm;
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

type SuperlativeKind = 'cheapest' | 'priciest' | 'heaviest' | 'lightest';

const SUPERLATIVE_PATTERNS: { kind: SuperlativeKind; label: string; pattern: RegExp }[] = [
  { kind: 'cheapest', label: 'en ucuz', pattern: /en ucuz/i },
  { kind: 'priciest', label: 'en pahalı', pattern: /en pahalı|en pahali/i },
  { kind: 'heaviest', label: 'en ağır', pattern: /en ağır|en agir/i },
  { kind: 'lightest', label: 'en hafif', pattern: /en hafif/i },
];

function findSuperlativeDoc(
  docs: MatchedDocument[],
  kind: SuperlativeKind
): { doc: MatchedDocument; value: number } | null {
  const byPrice = kind === 'cheapest' || kind === 'priciest';
  const entries = docs
    .map((doc) => ({
      doc,
      value: byPrice ? doc.metadata?.price : doc.metadata?.weight_kg,
    }))
    .filter((entry): entry is { doc: MatchedDocument; value: number } => typeof entry.value === 'number');
  if (entries.length === 0) return null;
  const wantsMax = kind === 'priciest' || kind === 'heaviest';
  return entries.reduce((best, entry) =>
    (wantsMax ? entry.value > best.value : entry.value < best.value) ? entry : best
  );
}

/**
 * "En ağır çerçeve aynı zamanda en ucuz mu?" gibi iki üstünlük içeren sorularda
 * iki ucu katalogdan hesaplar (LLM'e bırakılmaz).
 */
function buildCrossSuperlativeReply(message: string, docs: MatchedDocument[]): string {
  const asked = SUPERLATIVE_PATTERNS.filter((entry) => entry.pattern.test(message));
  if (asked.length < 2) return '';
  const products = docs.filter((doc) => doc.metadata?.type === 'product');
  if (products.length === 0) return '';

  const lines: string[] = [];
  const titles: string[] = [];
  for (const { kind, label } of asked) {
    const best = findSuperlativeDoc(products, kind);
    if (!best) continue;
    const title = typeof best.doc.metadata?.title === 'string' ? best.doc.metadata.title : 'Ürün';
    const unit = kind === 'cheapest' || kind === 'priciest' ? 'TL' : 'kg';
    lines.push(`- ${label}: ${title} — ${best.value} ${unit}`);
    titles.push(title);
  }
  if (lines.length < 2) return '';

  const sameProduct = titles.every((title) => title === titles[0]);
  const verdict = sameProduct
    ? 'Evet — bu iki uç aynı ürün.'
    : 'Hayır — bu iki uç farklı ürünler; ağırlık ile fiyat aynı şey değildir.';
  return `${verdict}\n\n${lines.join('\n')}\n\nBu modellerden hangisini daha yakından inceleyelim?`;
}

/** @deprecated prompt guard; cevap artık buildCrossSuperlativeReply ile üretilir */
function buildCrossSuperlativeGuard(message: string, docs: MatchedDocument[]): string {
  const reply = buildCrossSuperlativeReply(message, docs);
  return reply ? `ÇOKLU ÜSTÜNLÜK KARŞILAŞTIRMASI (KESİN):\n${reply}\n\n` : '';
}

interface DeterministicListingOptions {
  docs: MatchedDocument[];
  message: string;
  kind:
    | 'filter'
    | 'rank'
    | 'category'
    | 'all'
    | 'count'
    | 'oos'
    | 'discount'
    | 'alternate'
    | 'tool';
  category?: string | null;
  categories?: string[];
  maxPrice?: number;
  minPrice?: number;
  color?: string;
  colors?: string[];
  dimension?: string;
  profileMm?: number | null;
  cornerType?: CornerType | null;
  cornerCounts?: { gönye: number; rondo: number } | null;
  requestedCount?: number;
  wantsSingle?: boolean;
  sortBy?: SortBy;
  /** Çoklu üstünlük için kırpılmamış havuz */
  rankPool?: MatchedDocument[];
  alternateBudget?: number | null;
}

/**
 * DB arama sonucundan kartlı ürün cevabı üretir. Hesap/filtre LLM'e bırakılmaz;
 * metin yalnızca kısa özet + [[URUN_KARTLARI]] + CTA (veya özel karşılaştırma).
 */
function buildDeterministicListingReply(opts: DeterministicListingOptions): {
  reply: string;
  hasProductCards: boolean;
  bypassCardSanitize: boolean;
} {
  const products = opts.docs.filter((doc) => doc.metadata?.type === 'product');
  const count = products.length;
  const scopeLabel = opts.category
    ? `"${opts.category}" kategorisinde`
    : opts.categories && opts.categories.length > 0
      ? `"${opts.categories.join(' / ')}" kategorisinde`
      : 'kataloğumuzda';
  const cta =
    'Listedeki ürünlerden ilgilendiğiniz veya detaylı bilgi almak istediğiniz bir model var mı?';

  // 1) Renk karşılaştırması
  const colors = opts.colors ?? [];
  if (colors.length > 1) {
    const compare = buildColorCompareReply(
      products,
      colors,
      opts.message,
      opts.dimension
    );
    if (compare) {
      const hasAny = colors.some((color) => findDocByColor(products, color));
      return {
        reply: hasAny
          ? `${compare}\n\n${PRODUCT_CARDS_PLACEHOLDER}`
          : compare,
        hasProductCards: hasAny,
        bypassCardSanitize: true,
      };
    }
  }

  // 2) Çoklu üstünlük (en ağır + en ucuz …)
  const pool = opts.rankPool ?? products;
  const cross = buildCrossSuperlativeReply(opts.message, pool);
  if (cross) {
    return {
      reply:
        count > 0
          ? `${cross}\n\n${PRODUCT_CARDS_PLACEHOLDER}`
          : cross,
      hasProductCards: count > 0,
      bypassCardSanitize: true,
    };
  }

  // 3) Boş sonuç
  if (count === 0) {
    if (opts.kind === 'alternate') {
      return {
        reply: `Üzgünüm, "${opts.category ?? 'bu kategori'}"${
          opts.alternateBudget != null
            ? ` için ${opts.alternateBudget} TL altında`
            : ''
        } şu an uygun ürün bulamadım. Bütçeyi yükseltmek veya başka bir filtre denemek ister misiniz?`,
        hasProductCards: false,
        bypassCardSanitize: false,
      };
    }
    if (opts.maxPrice != null && opts.category) {
      return {
        reply: `Hayır, ${scopeLabel} ${opts.maxPrice} TL ve altında ürün bulunmamaktadır. Daha yüksek bir bütçe veya başka bir kategori denemek ister misiniz?`,
        hasProductCards: false,
        bypassCardSanitize: false,
      };
    }
    if (opts.kind === 'oos') {
      return {
        reply: `${scopeLabel} şu an stokta olmayan ürün bulunamadı. Stoktakileri listelememi ister misiniz?`,
        hasProductCards: false,
        bypassCardSanitize: false,
      };
    }
    if (opts.kind === 'discount') {
      return {
        reply: `${scopeLabel} şu an indirimli ürün bulunamadı. Başka bir filtre denemek ister misiniz?`,
        hasProductCards: false,
        bypassCardSanitize: false,
      };
    }
    const bits: string[] = [];
    if (opts.dimension) bits.push(`${opts.dimension} ölçü`);
    if (opts.color) bits.push(`${opts.color} renk`);
    if (opts.profileMm != null) bits.push(`${opts.profileMm} mm profil`);
    if (opts.cornerType) bits.push(`${opts.cornerType} köşe`);
    if (opts.maxPrice != null) bits.push(`${opts.maxPrice} TL altı`);
    const criteria = bits.length > 0 ? bits.join(' + ') : 'bu';
    return {
      reply: `${scopeLabel} ${criteria} kriterlerine uyan ürün bulunamadı. Filtreyi gevşetmeyi veya başka bir kategori denemeyi ister misiniz?`,
      hasProductCards: false,
      bypassCardSanitize: false,
    };
  }

  // 4) Dolu sonuç — kısa özet
  const allOos = products.every((doc) => doc.metadata?.stock === 0);
  // oos kind zaten özetinde stok durumunu söylüyor; tekrarlama.
  const stockNote =
    allOos && opts.kind !== 'oos' ? ' Bu ürünler şu an stokta yok.' : '';

  let summary: string;
  if (opts.kind === 'all') {
    summary = `Mağazamızdaki ${count} ürünü aşağıda inceleyebilirsiniz.`;
  } else if (opts.kind === 'count' || opts.kind === 'category') {
    summary = `${scopeLabel} toplam ${count} ürün bulunmaktadır. İlgili ürünleri aşağıda görebilirsiniz.`;
  } else if (opts.kind === 'alternate') {
    summary = `"${opts.category}" kategorisinde${
      opts.alternateBudget != null ? ` ${opts.alternateBudget} TL altındaki` : ''
    } ürünlerimizi aşağıda inceleyebilirsiniz.`;
  } else if (opts.kind === 'oos') {
    summary =
      count === 1
        ? `${scopeLabel} stokta olmayan ürün aşağıdadır; şu an stokta yok.`
        : `${scopeLabel} stokta olmayan ${count} ürün aşağıdadır; şu an stokta yoklar.`;
  } else if (opts.kind === 'discount') {
    summary =
      count === 1
        ? `${scopeLabel} indirimli ürün aşağıdadır.`
        : `${scopeLabel} ${count} indirimli ürün aşağıdadır.`;
  } else if (opts.cornerType && opts.cornerCounts) {
    summary = `${scopeLabel} gönye köşe ${opts.cornerCounts.gönye} ürün, rondo köşe ${opts.cornerCounts.rondo} ürün bulunuyor. Aşağıdaki kartlarda ${opts.cornerType} köşeli ${count} ürünü görüyorsunuz.`;
  } else if (opts.profileMm != null) {
    summary = `Evet — ${opts.profileMm} mm profil kalınlığında ${count} ürün var. Tümünü aşağıdaki kartlarda inceleyebilirsiniz.`;
  } else if (opts.color) {
    summary = `Evet, ${opts.color} renkte ${count} ürünümüz aşağıdadır.`;
  } else if (opts.minPrice != null && opts.maxPrice != null) {
    summary = `Evet, ${opts.minPrice}–${opts.maxPrice} TL arasında${
      opts.dimension ? ` ${opts.dimension} ölçüsünde` : ''
    } ${count} ürün aşağıdadır.`;
  } else if (opts.dimension && opts.maxPrice != null) {
    summary = `Evet, ${opts.dimension} ölçüsünde ${opts.maxPrice} TL altı/eşit ${count} ürün aşağıdadır.`;
  } else if (opts.dimension) {
    summary = `Evet, ${opts.dimension} ölçüsünde ${count} ürünümüz aşağıdadır.`;
  } else if (opts.maxPrice != null) {
    summary = `Evet, ${opts.maxPrice} TL altı/eşit ${count} ürün aşağıdadır.`;
  } else if (opts.minPrice != null) {
    summary = `Evet, ${opts.minPrice} TL ve üzeri ${count} ürün aşağıdadır.`;
  } else if (opts.wantsSingle || opts.kind === 'rank') {
    const title =
      typeof products[0].metadata?.title === 'string'
        ? products[0].metadata.title
        : 'ürün';
    const price = products[0].metadata?.price;
    const weight = products[0].metadata?.weight_kg;
    const sortHint =
      opts.sortBy === 'weight_desc'
        ? 'En ağır'
        : opts.sortBy === 'weight_asc'
          ? 'En hafif'
          : opts.sortBy === 'price_desc'
            ? 'En pahalı'
            : 'En ucuz';
    if (opts.requestedCount && opts.requestedCount > 0) {
      summary =
        count < opts.requestedCount
          ? `İstediğiniz ${opts.requestedCount} yerine bu kritere uyan ${count} ürün bulundu; aşağıda görebilirsiniz.`
          : `${sortHint} ${count} ürün aşağıdadır.`;
    } else if (count > 1) {
      summary = `${sortHint} değerde ${count} ürün berabere; aşağıda görebilirsiniz.`;
    } else {
      const priceBit = typeof price === 'number' ? ` (${price} TL)` : '';
      const weightBit = typeof weight === 'number' ? `, ${weight} kg` : '';
      summary = `${scopeLabel} ${sortHint.toLocaleLowerCase('tr-TR')} ürün: ${title}${priceBit}${weightBit}.`;
    }
  } else {
    summary = `Evet, kriterinize uyan ${count} ürün aşağıdadır.`;
  }

  // "50 adet / 18 tane almak istiyorum" → stok yetersizse onaylama
  const askedQty = extractRequestedPurchaseQty(opts.message);
  if (
    askedQty != null &&
    Number.isFinite(askedQty) &&
    askedQty > 0 &&
    products.length === 1 &&
    typeof products[0].metadata?.stock === 'number' &&
    products[0].metadata.stock < askedQty
  ) {
    const stock = products[0].metadata.stock;
    const title =
      typeof products[0].metadata?.title === 'string'
        ? products[0].metadata.title
        : 'Bu ürün';
    summary = `Hayır — ${title} için stokta yalnızca ${stock} adet var; ${askedQty} adet için stok yetersiz.`;
  }

  let body = `${summary}${stockNote}\n\n${PRODUCT_CARDS_PLACEHOLDER}\n\n${cta}`;

  // İndirim + fiyat sorusu: liste/indirimli fiyatı metne yaz
  if (
    opts.kind === 'discount' &&
    /(liste\s*fiyat|indirimli\s*fiyat|fiyatı\s*nedir|fiyati\s*nedir)/i.test(opts.message)
  ) {
    const doc = products[0];
    const title =
      typeof doc.metadata?.title === 'string' ? doc.metadata.title : 'Ürün';
    const listPrice = doc.metadata?.list_price;
    const salePrice = doc.metadata?.price;
    body = `${title} — Liste: ${
      typeof listPrice === 'number' ? `${listPrice} TL` : 'yok'
    }; İndirimli/satış: ${
      typeof salePrice === 'number' ? `${salePrice} TL` : 'yok'
    }.\n\n${PRODUCT_CARDS_PLACEHOLDER}\n\n${cta}`;
  }

  if (wantsInlinePriceStockSummary(opts.message)) {
    const priceStock = buildProductPriceStockSummary(products)
      .replace(/^FİYAT\/STOK ÖZETİ[^\n]*\n/, '')
      .trim();
    if (priceStock) {
      body = `${summary}${stockNote}\n\n${priceStock}\n\n${PRODUCT_CARDS_PLACEHOLDER}\n\n${cta}`;
    }
  }

  return { reply: body, hasProductCards: true, bypassCardSanitize: false };
}

/** İki+ renk karşılaştırması için bağlama zorunlu fiyat özeti. */
function buildMultiColorCompareGuard(
  docs: MatchedDocument[],
  colors: string[]
): string {
  if (colors.length < 2) return '';
  const products = docs.filter((doc) => doc.metadata?.type === 'product');
  const lines = [
    'RENK KARŞILAŞTIRMASI (KESİN): Her rengi ayrı yaz. Olmayan renk için ürün UYDURMA; "katalogda bu ölçü+renk yok" de.',
  ];
  let foundPrices = 0;

  for (const color of colors) {
    const needle = color.toLocaleLowerCase('tr-TR');
    const match = products.find((doc) => {
      const raw = doc.metadata?.color;
      return typeof raw === 'string' && raw.toLocaleLowerCase('tr-TR').includes(needle);
    });
    if (!match) {
      lines.push(`- ${color}: katalogda bu filtreyle (ölçü+renk) ürün YOK.`);
      continue;
    }
    const title =
      typeof match.metadata?.title === 'string' ? match.metadata.title : 'Ürün';
    const price = match.metadata?.price;
    const stock = match.metadata?.stock;
    if (typeof price === 'number') foundPrices += 1;
    lines.push(
      `- ${color}: ${title} — ${typeof price === 'number' ? `${price} TL` : 'fiyat yok'}, stok ${
        typeof stock === 'number' ? stock : '?'
      }`
    );
  }

  if (foundPrices >= 2) {
    lines.push(
      'Fiyat farkını sayısal hesapla (büyük − küçük); hangisinin daha ucuz olduğunu açıkça söyle.'
    );
  } else {
    lines.push(
      'Her iki renkte de fiyat yoksa fark hesaplama; var olanı söyle, olmayanı "katalogda yok" de.'
    );
  }
  return `${lines.join('\n')}\n\n`;
}

function findDocByColor(
  products: MatchedDocument[],
  color: string
): MatchedDocument | undefined {
  const needle = color.toLocaleLowerCase('tr-TR');
  return products.find((doc) => {
    const raw = doc.metadata?.color;
    return typeof raw === 'string' && raw.toLocaleLowerCase('tr-TR').includes(needle);
  });
}

function capitalizeTr(value: string): string {
  return value ? value.charAt(0).toLocaleUpperCase('tr-TR') + value.slice(1) : value;
}

/**
 * Renk karşılaştırmasını doğrudan veriden yazar. Modelin ürettiği metin
 * eksik kaldığında ya da iç talimat kalıplarını kopyaladığında bunu kullanıyoruz;
 * kullanıcıya "filtre", "ölçü+renk" gibi iç ifadeler asla gitmesin.
 */
function buildColorCompareReply(
  docs: MatchedDocument[],
  colors: string[],
  message: string,
  dimension?: string
): string {
  if (colors.length < 2) return '';
  const products = docs.filter((doc) => doc.metadata?.type === 'product');
  const sizeLabel = dimension ? `${dimension} ölçüsünde ` : '';
  const lines: string[] = [];
  const prices: number[] = [];

  // Kullanıcı hangi rengi önce yazdıysa cevapta da o sırayla görünsün
  const text = message.toLocaleLowerCase('tr-TR');
  const mentionIndex = (color: string) => {
    const at = text.indexOf(color.toLocaleLowerCase('tr-TR'));
    return at < 0 ? Number.MAX_SAFE_INTEGER : at;
  };
  const orderedColors = [...colors].sort((a, b) => mentionIndex(a) - mentionIndex(b));

  for (const color of orderedColors) {
    const label = capitalizeTr(color);
    const match = findDocByColor(products, color);
    if (!match) {
      lines.push(
        `- ${label}: kataloğumuzda ${sizeLabel}${color.toLocaleLowerCase('tr-TR')} model bulunmuyor.`
      );
      continue;
    }
    const title =
      typeof match.metadata?.title === 'string' ? match.metadata.title : 'Ürün';
    const price = match.metadata?.price;
    const stock = match.metadata?.stock;
    if (typeof price === 'number') prices.push(price);
    const priceBit = typeof price === 'number' ? `${price} TL` : 'fiyat bilgisi yok';
    const stockBit =
      typeof stock === 'number'
        ? stock > 0
          ? `, stok ${stock}`
          : ', şu an stokta yok'
        : '';
    lines.push(`- ${label}: ${title} — ${priceBit}${stockBit}`);
  }
  if (lines.length < 2) return '';

  const diffLine =
    prices.length >= 2
      ? `\n\nFiyat farkı ${Math.max(...prices) - Math.min(...prices)} TL; daha ucuz olan ${Math.min(
          ...prices
        )} TL olan model.`
      : '';
  const intro = dimension
    ? `${dimension} ölçüsünde renk karşılaştırması:`
    : 'Renk karşılaştırması:';
  return `${intro}\n\n${lines.join(
    '\n'
  )}${diffLine}\n\nHangi modeli daha yakından incelemek istersiniz?`;
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

  // "evet başka kategoride olsun" → pin değil; alternatif kategori araması
  if (looksLikeAcceptAlternateCategory(message)) return false;
  // "kaç mmlik ürünler var" / "hangi ürün 35 mm" → pin değil
  if (looksLikeProfileCatalogQuestion(message)) return false;
  // "hangi renkler var" / "kırmızı renkte ürün var mı" → yeni arama, pin değil
  if (looksLikeColorCatalogQuestion(message)) return false;
  if (looksLikeColorAvailabilityQuestion(message)) return false;

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
    /kategoride/,
  ];
  if (catalogListPatterns.some((pattern) => pattern.test(normalized))) return false;

  // "anladım 100 adet sipariş vermek istiyorum" → son ürün stok/sipariş;
  // "50 adet kırmızı A4 almak istiyorum" (yeni kriter) → pin değil.
  if (
    looksLikeQuantityPurchaseQuestion(message) &&
    !hasNewSearchCriterion(message)
  ) {
    return true;
  }

  const referential = [
    'bu ürün', 'bu ürüne', 'bu ürünün', 'bu ürünü', 'bu üründen',
    'bu gösterdiğin', 'gösterdiğin ürün', 'gösterdiğin',
    'bunun', 'bunu', 'buna', 'bundan',
    'o ürün', 'o ürünün', 'onun', 'onu', 'şu ürün',
    'hakkında bilgi', 'detaylı bilgi', 'bilgi almak', 'detayını', 'detaylarını',
  ];
  if (referential.some((keyword) => normalized.includes(keyword))) return true;

  // Yeni kriter + katalog isteği ("A2 ölçüsünde var mı", "32 mm olanları göster")
  // yeni aramadır. Yeterlilik sorusu ("5311 elimde var, alabilir miyim?") ise
  // kilitli ürünün fiyatına ihtiyaç duyduğu için takip sorusu kalmalı.
  if (
    !looksLikeAffordabilityQuestion(message) &&
    hasNewSearchCriterion(message) &&
    asksCatalogLookup(message)
  ) {
    return false;
  }

  // Tekil ürün özelliği soruları (kısa): "ağırlığı ne", "indirimli fiyatı nedir"
  const propertyHints = [
    'ağırlık', 'ağırlığı', 'fiyat', 'fiyatı', 'indirimli fiyat', 'stok', 'stokta',
    'ölçü', 'ölçüsü', 'malzeme', 'malzemesi', 'renk', 'rengi', 'link',
    'profil', 'profili', 'kalınlık', 'kalınlığı', 'köşe', 'köşesi',
    'kaç kg', 'kaç kilo', 'ne kadar', 'kaç mm',
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
  /** true → fiyat > min_price ("1000 TL üzeri"); false/undefined → >= */
  min_price_exclusive?: boolean;
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
  /** Köşe tipi: "gönye" veya "rondo" */
  corner_type?: CornerType;
  query_text?: string;
  sort_by?: SortBy;
  limit?: number;
}

type CornerType = 'gönye' | 'rondo';

/**
 * Köşe tipi metadata'da tutulmuyor (yalnızca content metninde "Köşe Tipi: ..."
 * ve ürün adında geçiyor); bu yüzden filtre bellek içinde uygulanıyor.
 */
function docMatchesCornerType(doc: MatchedDocument, corner: CornerType): boolean {
  const title = typeof doc.metadata?.title === 'string' ? doc.metadata.title : '';
  const blob = `${doc.content ?? ''} ${title}`.toLocaleLowerCase('tr-TR');
  const cornerField = blob.match(/köşe tipi\s*:\s*([^|]+)/i)?.[1] ?? blob;
  return corner === 'gönye'
    ? /gönye|gonye/i.test(cornerField)
    : /rondo/i.test(cornerField);
}

function extractCornerTypeFromMessage(message: string): CornerType | null {
  const t = message.toLocaleLowerCase('tr-TR');
  if (/(gönye|gonye)/i.test(t)) return 'gönye';
  if (/rondo/i.test(t)) return 'rondo';
  return null;
}

/**
 * "Gönye köşeli istiyorum" / "rondo olsun" → köşe kriteri.
 * "Bilgi al" ile gelen uzun ürün adındaki "Gönye Köşe" → kriter sayma
 * (aksi halde sonraki "100 adet sipariş" gönye kataloğuna düşer).
 */
function looksLikeCornerBrowseIntent(message: string): boolean {
  const corner = extractCornerTypeFromMessage(message);
  if (!corner) return false;
  const t = message.toLocaleLowerCase('tr-TR');
  // Ürün başlığı yapıştırma: ölçü + marka/model kalıbı
  if (
    message.length > 45 &&
    /\d+\s*[x×]\s*\d+\s*cm/i.test(t) &&
    /(açılır\s*kapanır|alüminyum|çerçeve|pano)/i.test(t)
  ) {
    return false;
  }
  return /(köşe|köşeli|istiyorum|arıyorum|olsun|ihtiyac|olanlar|var\s*m[ıi]|göster|liste)/i.test(
    t
  );
}

/**
 * "Gönye köşeli ürüne ihtiyacım var" dedikten sonra "afiş çerçevesi" yazan
 * kullanıcı köşe tipini tekrar yazmıyor; kriteri son turlardan taşı.
 */
function inferCornerTypeFromHistory(history: HistoryTurn[]): CornerType | null {
  const userTurns = history.filter((turn) => turn.role === 'user').slice(-4);
  for (let i = userTurns.length - 1; i >= 0; i -= 1) {
    const content = userTurns[i].content;
    if (!looksLikeCornerBrowseIntent(content)) continue;
    const corner = extractCornerTypeFromMessage(content);
    if (corner) return corner;
  }
  return null;
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
/** Teslimattan sonra standart iade penceresi (politikalar.md §3.1) */
const RETURN_WINDOW_DAYS = 14;

/** "11 gün sonrasında iade" / "15. günde" → gün sayısı */
function extractReturnDayOffset(message: string): number | null {
  const t = message.toLocaleLowerCase('tr-TR');
  if (!/(iade|cayma|geri\s*ver)/i.test(t)) return null;
  const patterns = [
    /(\d+)\s*gün\s*(?:sonra(?:sında)?|geçtikten(?:\s*sonra)?|geçince)/i,
    /(\d+)\s*\.\s*gün(?:ünde|unde)?/i,
    /(?:teslim(?:den|attan)?|aldıktan\s*sonra)\s*(\d+)\s*gün/i,
    /(\d+)\s*gün\s*(?:içinde|içerisinde)\s*iade/i,
  ];
  for (const pattern of patterns) {
    const match = t.match(pattern);
    if (match?.[1]) {
      const day = Number(match[1]);
      if (Number.isFinite(day) && day > 0 && day <= 365) return day;
    }
  }
  return null;
}

function buildReturnDayWindowReply(day: number): string {
  if (day <= RETURN_WINDOW_DAYS) {
    return `Evet — teslimattan sonra ${day}. günde iade talebi, ${RETURN_WINDOW_DAYS} günlük iade süresi içindedir (${day} ≤ ${RETURN_WINDOW_DAYS}). Ürünün kullanılmamış, etiketli ve orijinal ambalajında olması gerekir; talebi iletisim@ores.com.tr üzerinden oluşturabilirsiniz. İndirimli/kampanyalı ürünler bu genel kuralın dışındadır (iade edilemez).`;
  }
  return `Hayır — standart iade süresi teslimattan sonra ${RETURN_WINDOW_DAYS} gündür. ${day}. gün bu sürenin dışındadır (${day} > ${RETURN_WINDOW_DAYS}). Özel durumlar için iletisim@ores.com.tr veya +90 264 531 00 10–11 (08:00–18:00) ile iletişime geçebilirsiniz.`;
}

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
 * "sepetimde 751 TL var kargo ücreti öder miyim?" — politika/eşik sorusu;
 * "751 TL altı ürün" bütçe araması değil.
 */
function looksLikeCartShippingFeeQuestion(message: string): boolean {
  const t = message.toLocaleLowerCase('tr-TR');
  if (!/kargo/i.test(t)) return false;
  if (looksLikePartialReturnShippingDispute(message)) return false;
  // "en ucuz A4'ten 2 adet kargo ücretsiz mi?" → ürün×adet yolu
  if (
    extractRequestedPurchaseQty(message) != null &&
    /(en\s+ucuz|en\s+pahal[ıi]|afiş|çerçeve|pano|\bA\d\b|\d+\s*mm)/i.test(t)
  ) {
    return false;
  }
  const feeAsk =
    /(kargo\s*ücret|ücret(?:i|ini)?\s*öder|öder\s*miyim|ödeyecek\s*miyim|ücretsiz\s*kargo|kargo\s*ücretsiz|ucretsiz\s*kargo|kargo\s*ucretsiz|kargo\s*var\s*m[ıi]|kargo\s*alı[nr]|kargo\s*öde)/i.test(
      t
    );
  if (!feeAsk) return false;
  return extractExplicitCartAmountTl(message) != null || /sepet/i.test(t);
}

/** Sepet tutarı × ücretsiz kargo eşiği — LLM/ürün listesi yok. */
function buildCartShippingFeeReply(message: string): string | null {
  if (!looksLikeCartShippingFeeQuestion(message)) return null;

  const afterAdd = extractHypotheticalCartAfterAddTl(message);
  const amount = extractExplicitCartAmountTl(message);
  if (amount == null) return null;

  // "kargo ücreti" — "kargo ücretsiz" ile karışmasın
  const asksPayFee =
    /(öder|ödeyecek|kargo\s*ücreti\b|ücret(?:i|ini)?\s*(?:öder|var\s*m))/i.test(
      message.toLocaleLowerCase('tr-TR')
    );
  const asksFree =
    /(ücretsiz\s*m[ıi]|ucretsiz\s*m[ıi]|kargo\s*ücretsiz|kargo\s*ucretsiz|ücretsiz\s*olur)/i.test(
      message
    );

  if (afterAdd != null) {
    const freeAfter = afterAdd >= FREE_SHIPPING_THRESHOLD_TL;
    if (freeAfter) {
      return `Şu an sepetiniz ${amount} TL; belirttiğiniz ekleme sonrası ${afterAdd} TL ≥ ${FREE_SHIPPING_THRESHOLD_TL} TL olacağı için o zaman kargo ücretsiz olur.`;
    }
    return `Şu an sepetiniz ${amount} TL; ekleme sonrası ${afterAdd} TL hâlâ ${FREE_SHIPPING_THRESHOLD_TL} TL eşiğinin altında — kargo ücretsiz olmaz.`;
  }

  const free = amount >= FREE_SHIPPING_THRESHOLD_TL;
  if (free) {
    if (asksPayFee && !asksFree) {
      return `Hayır — sepet tutarınız ${amount} TL, ücretsiz kargo eşiği ${FREE_SHIPPING_THRESHOLD_TL} TL ve üzeri olduğu için kargo ücreti ödemezsiniz.`;
    }
    return `Evet — sepet tutarınız ${amount} TL ≥ ${FREE_SHIPPING_THRESHOLD_TL} TL; kargo ücretsizdir.`;
  }

  const gap = Math.round((FREE_SHIPPING_THRESHOLD_TL - amount) * 100) / 100;
  if (asksPayFee && !asksFree) {
    return `Evet — sepet tutarınız ${amount} TL, ücretsiz kargo eşiği ${FREE_SHIPPING_THRESHOLD_TL} TL altındadır; kargo ücreti ödersiniz. Eşiğe ${gap} TL daha eklemeniz gerekir.`;
  }
  return `Hayır — sepet tutarınız ${amount} TL < ${FREE_SHIPPING_THRESHOLD_TL} TL; kargo ücretsiz değildir (kargo alıcıya aittir). Eşiğe ${gap} TL kalıyor.`;
}

/**
 * "Sepetim 749 TL, 1 TL daha eklesem" → varsayımsal yeni toplam (750).
 */
function extractHypotheticalCartAfterAddTl(message: string): number | null {
  const text = message.toLocaleLowerCase('tr-TR');
  const addMatch = text.match(
    /(\d+(?:[.,]\d+)?)\s*(?:tl|₺|lira)?\s*daha\s*(?:ekle|eklersem|eklesem|ekleyince|eklersem)/i
  );
  if (!addMatch?.[1]) return null;
  const add = Number(addMatch[1].replace(',', '.'));
  if (!Number.isFinite(add) || add <= 0 || add > 5000) return null;

  const base = extractExplicitCartAmountTl(message);
  if (base == null) return null;
  return Math.round((base + add) * 100) / 100;
}

/**
 * Kısmi iade sonrası "ücretsiz kargo iade tutarından kesilsin mi?" tuzağı.
 * Sipariş anı eşiği (750) ile karıştırılmamalı; kesilir/kesilmez uydurulmamalı.
 */
function looksLikePartialReturnShippingDispute(message: string): boolean {
  const text = message.toLocaleLowerCase('tr-TR');
  if (!/\biade\b/.test(text)) return false;
  const shipping =
    /(kargo|ücretsiz kargo|ucretsiz kargo|kargo ücretsiz|kargo ucretsiz)/i.test(text);
  if (!shipping) return false;
  const disputeOrDeduct =
    /(kes|düş|dus|çıkar|cikar|yasal|haklı|hakli|doğru mu|dogru mu|geri alın|geri alin|iademden|iade tutar)/i.test(
      text
    );
  const partialContext =
    /(birini|bir ürün|bir urun|kısmi|kismi|kalan ürün|kalan urun|iki ürün|iki urun|2 ürün|2 urun|her biri|ürünlerden bir)/i.test(
      text
    );
  return disputeOrDeduct || partialContext;
}

function partialReturnShippingHint(message: string): string {
  if (!looksLikePartialReturnShippingDispute(message)) return '';

  const asksInvoice =
    /(fatura|e-fatura|efatura|yeni fatura|düzeltilmiş fatura|duzeltilmis fatura)/i.test(
      message
    );

  const lines = [
    '=== ZORUNLU CEVAP (KISMİ İADE + GİDEN KARGO ÜCRETİ) — ÖNCE BUNU UYGULA ===',
    'YANLIŞ: "Sipariş 1000 ≥ 750 olduğu için ücretsiz kargo iade tutarından KESİLMEZ / kesilemez" diye kesin iddia — bu senaryo belgede ayrıca düzenlenmez.',
    'YANLIŞ: "Kalan tutar 500 < 750 olduğu için kargo kesilir" diye kesin iddia — bu da belgede yok.',
    'YANLIŞ: "Yasal / yasal değil" diye hukuk hükmü verme.',
    'DOĞRU SIRALAMA:',
    `1) Ücretsiz kargo eşiği ${FREE_SHIPPING_THRESHOLD_TL} TL — sipariş ANINDA sepette uygulanır; bunu kısa belirt.`,
    '2) Kısmi iade sonrası, siparişte ücretsiz uygulanmış GİDEN kargo bedelinin para iadesinden düşülüp düşülmeyeceği belgelerimizde ayrıca yazılmıyor; kesin "kesilir/kesilmez" DEME.',
    '3) Sipariş numarası ile teyit: iletisim@ores.com.tr ve +90 264 531 00 10–11 (08:00–18:00).',
    '4) Usulüne uygun iade onaylandıysa para iadesi 10 iş günü (orijinal ödeme yöntemi; banka ek süre). Onaydan 15 iş günü sonra hâlâ yoksa tekrar yazın.',
  ];
  if (asksInvoice) {
    lines.push(
      '5) Kalan ürün için yeni/düzeltilmiş fatura: belgede yok → uydurma; aynı iletişim kanallarına yönlendir.'
    );
  }
  return lines.join('\n');
}

/**
 * Kargo ücretsiz eşiğiyle ilgili sorularda modele kesin aritmetik ipucu verir;
 * "720 TL ücretsiz mi?" gibi sorularda Evet/Hayır çelişkisini engeller.
 * Kısmi iade + kargo kesintisi sorularında DEVRE DIŞI (partialReturnShippingHint).
 */
function shippingThresholdHint(message: string): string {
  const text = message.toLocaleLowerCase('tr-TR');
  if (!/(kargo|ücretsiz kargo|ucretsiz kargo|kargo ücretsiz|kargo ucretsiz)/i.test(text)) {
    return '';
  }
  // Kısmi iade / kargo geri alma tuzağında "1000 ≥ 750 → ÜCRETSİZ" ipucu YANLIŞ yönlendirir
  if (looksLikePartialReturnShippingDispute(message)) {
    return '';
  }

  const afterAdd = extractHypotheticalCartAfterAddTl(message);
  const amount = extractExplicitCartAmountTl(message);
  let comparison = '';
  if (afterAdd != null && amount != null) {
    const free = afterAdd >= FREE_SHIPPING_THRESHOLD_TL;
    comparison = free
      ? `HİPOTETİK SEPET: Şu an ${amount} TL; belirtilen ekleme sonrası ${afterAdd} TL ≥ ${FREE_SHIPPING_THRESHOLD_TL} → o zaman kargo ÜCRETSİZ. "Şu an ücretsiz değil; X TL ekleyince evet" diye cevapla. Sadece mevcut ${amount} TL'ye bakıp "Hayır" deyip bırakma.`
      : `HİPOTETİK SEPET: Şu an ${amount} TL; ekleme sonrası ${afterAdd} TL hâlâ < ${FREE_SHIPPING_THRESHOLD_TL} → kargo ücretsiz OLMAZ.`;
  } else if (amount != null) {
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
 * sepet toplamını kesin hesaplar (LLM yok).
 */
async function resolveShippingQuantityCart(
  message: string,
  supabase: Awaited<ReturnType<typeof createClient>>,
  knownCategories: string[]
): Promise<{
  docs: MatchedDocument[];
  unit: number;
  qty: number;
  total: number;
  free: boolean;
  title: string;
} | null> {
  if (!/(kargo|ücretsiz)/i.test(message)) return null;
  if (looksLikePartialReturnShippingDispute(message)) return null;
  const qty = extractRequestedPurchaseQty(message);
  if (qty == null) return null;
  // Açık TL tutarı varsa miktar×fiyat hesabına gerek yok
  if (extractExplicitCartAmountTl(message) != null) return null;

  const filters = extractSearchFiltersFromMessage(message);
  const categories = findMentionedCategories(message, knownCategories);
  const frameCategory =
    categories[0] ??
    knownCategories.find((category) => /çerçeve/i.test(category)) ??
    null;
  const docs = await executeSearchProducts(supabase, knownCategories, {
    ...(frameCategory ? { category: frameCategory } : {}),
    dimension: filters.dimension,
    color: filters.color,
    in_stock_only: true,
    sort_by: filters.sort_by ?? 'price_asc',
    limit: 1,
  });

  const unit = docs[0]?.metadata?.price;
  const title = typeof docs[0]?.metadata?.title === 'string' ? docs[0].metadata.title : 'ürün';
  if (typeof unit !== 'number' || !Number.isFinite(unit) || unit <= 0) {
    return null;
  }

  const total = Math.round(unit * qty * 100) / 100;
  const free = total >= FREE_SHIPPING_THRESHOLD_TL;
  return { docs, unit, qty, total, free, title };
}

async function shippingQuantityCartHint(
  message: string,
  supabase: Awaited<ReturnType<typeof createClient>>,
  knownCategories: string[]
): Promise<string> {
  const cart = await resolveShippingQuantityCart(message, supabase, knownCategories);
  if (!cart) return '';
  return [
    `SEPET HESABI (KESİN — KARGO): "${cart.title}" birim fiyat ${cart.unit} TL × ${cart.qty} adet = ${cart.total} TL.`,
    cart.free
      ? `${cart.total} TL ≥ ${FREE_SHIPPING_THRESHOLD_TL} TL → kargo ÜCRETSİZ. Cevaba "Evet" ile başla.`
      : `${cart.total} TL < ${FREE_SHIPPING_THRESHOLD_TL} TL → kargo ÜCRETSİZ DEĞİL. Cevaba "Hayır" ile başla.`,
    'Adet sayısını (örn. 2) asla TL tutarı gibi kullanma.',
  ].join('\n');
}

function buildShippingQuantityCartReply(cart: {
  docs: MatchedDocument[];
  unit: number;
  qty: number;
  total: number;
  free: boolean;
  title: string;
}): { reply: string; hasProductCards: boolean } {
  const head = cart.free
    ? `Evet — "${cart.title}" birim ${cart.unit} TL × ${cart.qty} adet = ${cart.total} TL; ücretsiz kargo eşiği ${FREE_SHIPPING_THRESHOLD_TL} TL olduğu için kargo ücretsiz olur.`
    : `Hayır — "${cart.title}" birim ${cart.unit} TL × ${cart.qty} adet = ${cart.total} TL; ücretsiz kargo için ${FREE_SHIPPING_THRESHOLD_TL} TL eşiğinin altında kalıyor.`;
  return {
    reply: `${head}\n\n${PRODUCT_CARDS_PLACEHOLDER}\n\nBu modeli inceleyelim mi?`,
    hasProductCards: cart.docs.length > 0,
  };
}

/**
 * "Sizde X var mı? Yoksa en ucuz 3 çerçeveyi göster" — katalog dışı ürünü
 * reddedip ikinci isteği SQL ile karşılar.
 */
async function buildAbsentThenFallbackReply(
  message: string,
  supabase: Awaited<ReturnType<typeof createClient>>,
  knownCategories: string[]
): Promise<{ reply: string; docs: MatchedDocument[]; hasProductCards: boolean } | null> {
  if (!/(yoksa|değilse|degilse)/i.test(message)) return null;
  const parts = message.split(/yoksa|değilse|degilse/i);
  if (parts.length < 2) return null;
  const first = parts[0] ?? '';
  const second = parts.slice(1).join(' ');
  if (!/var\s*m[ıi]|yok\s*mu|bulun/i.test(first)) return null;

  // İlk kısımda bilinen kategori yoksa ve katalog-dışı bir şey soruluyorsa devam.
  const firstCats = findMentionedCategories(first, knownCategories);
  const absentHints: string[] = [];
  if (/mouse\s*pad/i.test(first)) absentHints.push('mouse pad');
  if (/iphone|kılıf|kilif/i.test(first)) absentHints.push('iPhone kılıfı');
  if (/koltuk|masa|laptop|telefon/i.test(first) && firstCats.length === 0) {
    const rough = first
      .replace(/sizde|var mı|var mi|yok mu| bulur musunuz|\?/gi, '')
      .trim();
    if (rough) absentHints.push(rough.slice(0, 48));
  }
  if (absentHints.length === 0 && firstCats.length === 0) {
    absentHints.push('istediğiniz ürün');
  }
  if (firstCats.length > 0 && absentHints.length === 0) return null;

  const secondFilters = extractSearchFiltersFromMessage(second);
  const secondCats = findMentionedCategories(second, knownCategories);
  const frameCategory =
    secondCats[0] ??
    knownCategories.find((category) => /çerçeve/i.test(category)) ??
    null;
  const countMatch = second.match(/en (?:ucuz|pahalı|pahali|ağır|agir|hafif)\s+(\d+)/i);
  const limit =
    countMatch?.[1] && Number.isFinite(Number(countMatch[1]))
      ? Math.min(Number(countMatch[1]), 50)
      : 3;

  const docs = await executeSearchProducts(supabase, knownCategories, {
    ...(frameCategory ? { category: frameCategory } : {}),
    ...secondFilters,
    sort_by: secondFilters.sort_by ?? 'price_asc',
    limit,
  });

  const absentLabel = [...new Set(absentHints)].join(' / ');
  const listing = buildDeterministicListingReply({
    docs,
    message: second,
    kind: 'rank',
    category: frameCategory,
    requestedCount: limit,
    wantsSingle: false,
    sortBy: secondFilters.sort_by ?? 'price_asc',
  });

  return {
    reply: `Hayır — kataloğumuzda ${absentLabel} bulunmamaktadır.\n\n${listing.reply}`,
    docs,
    hasProductCards: listing.hasProductCards,
  };
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
 * Belgede net yazmayan baskı/kurumsal fatura/KDV sorularında uydurmayı engelle.
 */
function undocumentedCheckoutHint(message: string): string {
  const text = message.toLocaleLowerCase('tr-TR');
  const asksPrint = /(baskı|basım|tasarım|hazır.*gönder|afiş.*yap)/i.test(text);
  const asksKdv =
    /(kdv|katma\s*değer|vergi\s*oran|%\s*\d+)/i.test(text) ||
    /(fatura).{0,40}(oran|yüzde|kdv)/i.test(text);
  const asksPartialInvoice =
    /\bfatura\b/i.test(text) &&
    /(iade|kısmi|kismi|kalan ürün|kalan urun|yeni fatura|düzeltil|duzeltil)/i.test(text);
  const asksCorpInvoice =
    /(kurumsal|vkn|e-fatura|efatura|şahıs kart|sahis kart|vergi\s*no|vergi\s*kimlik)/i.test(
      text
    ) ||
    (/\bfatura\b/i.test(text) && !asksKdv && !asksPartialInvoice);
  if (!asksPrint && !asksCorpInvoice && !asksKdv && !asksPartialInvoice) return '';

  // KDV oranı sorusu: zorunlu iskelet (model %18 vb. uydurmasın)
  if (asksKdv) {
    return [
      '=== ZORUNLU CEVAP (KDV / FATURA ORANI) — ÖNCE BUNU UYGULA ===',
      'YANLIŞ: "%18", "%20", "%8", "standart KDV oranımız X" diye oran UYDURMA — politika metninde fatura KDV oranı YOK.',
      'DOĞRU:',
      '1) Belgelerimizde/politika metninde fatura KDV oranı belirtilmiyor; kesin oran söyleyemem.',
      '2) Kurumsal fatura / VKN yeterli mi gibi detaylar da belgede net değilse aynı şekilde uydurma; teyit için iletişime yönlendir.',
      '3) Bilinen şirket vergi no (6450038153) belgede geçiyorsa paylaşabilirsin; bu bir KDV oranı DEĞİLDİR.',
      '4) iletisim@ores.com.tr ve +90 264 531 00 10–11 (08:00–18:00) ver.',
    ].join('\n');
  }

  if (asksPartialInvoice) {
    return [
      '=== ZORUNLU CEVAP (KISMİ İADE / YENİ FATURA) — ÖNCE BUNU UYGULA ===',
      'YANLIŞ: "Evet yeni fatura kesilir" / "Hayır kesilmez" diye kesin iddia — belgede yok.',
      'DOĞRU: Kısmi iade sonrası kalan ürün için yeni/düzeltilmiş fatura belgelerimizde geçmiyor; teyit için iletisim@ores.com.tr ve +90 264 531 00 10–11 (08:00–18:00).',
    ].join('\n');
  }

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
      'Şahıs kartı + kurumsal KDV/e-fatura/VKN: Bilinen ödeme yöntemlerini (Visa, Mastercard, iyzico, havale/EFT) söyle; kurumsal fatura prosedürü belgede yoksa "bu detay belgelerimizde geçmiyor, teyit için iletişime geçin" de. KDV oranı UYDURMA. "Mümkün / alabilirsiniz / VKN yeter" UYDURMA.'
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

  const returnDay = extractReturnDayOffset(message);
  if (returnDay != null && !/(indirim|kampanya)/i.test(text)) {
    if (returnDay <= RETURN_WINDOW_DAYS) {
      lines.push(
        `İADE GÜN KARŞILAŞTIRMASI (KESİN): Kullanıcı ${returnDay}. gün / ${returnDay} gün sonra diyor. ${returnDay} ≤ ${RETURN_WINDOW_DAYS} → süre İÇİNDE. "mümkün değil / maalesef olmaz" DEME. Cevaba "Evet" ile başla; ${RETURN_WINDOW_DAYS} gün kuralını ve kullanılmamış/ambalaj koşullarını söyle.`
      );
    } else {
      lines.push(
        `İADE GÜN KARŞILAŞTIRMASI (KESİN): ${returnDay} > ${RETURN_WINDOW_DAYS} → süre DIŞINDA. Cevaba "Hayır" ile başla; süre ${RETURN_WINDOW_DAYS} gündür de.`
      );
    }
  }

  if (
    /(duvara as|asmış|astım|astim|montaj|kullandım|kullandim|kullanılmış|kullanilmis|açtım ambalaj|actim ambalaj|beğenmedim|begenmedim)/i.test(
      text
    )
  ) {
    lines.push(
      'KULLANILMIŞ / MONTAJLI ÜRÜN: İade için ürün kullanılmamış, etiketli ve orijinal ambalajında olmalı. Duvara asılmış / kullanılmış ürün bu koşulları bozmuş olabilir — "evet iade edebilirsiniz" diye garanti VERME; koşulları söyle, net durum için iletisim@ores.com.tr + telefon yönlendir.'
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

/**
 * Ürün dokümanını modele verilecek metne çevirir.
 *
 * `compact` modda `content` HİÇ kullanılmaz: ihtiyaç duyulan tüm alanlar
 * (ölçü, profil, renk, ağırlık, fiyat, stok) metadata'da mevcut. Böylece
 * ürün başına ~2.400 karakterlik pazarlama açıklaması ve content ile
 * çakışan tekrar satırları bağlama hiç girmez — liste/filtre/sıralama
 * yanıtlarında bu bilgi zaten kartlarda gösteriliyor.
 *
 * `detail` modda (takip detayı, kartsız tek ürün cevabı) uzun açıklama ve
 * satın alma linki eklenir; Kural 3'ün istediği detay formatı korunur.
 */
function formatProductForPrompt(
  doc: MatchedDocument,
  mode: 'compact' | 'detail'
): string {
  const meta = doc.metadata ?? {};
  const str = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() ? value.trim() : null;
  const num = (value: unknown): number | null => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && !Number.isNaN(Number(value))) {
      return Number(value);
    }
    return null;
  };

  const title = str(meta.title);
  // Metadata bozuk/eksikse eski davranışa düş: ham content her zaman doğrudur.
  if (!title) return doc.content;

  const profileMm = num(meta.profile_thickness_mm);
  const listPrice = num(meta.list_price);
  const salePrice = num(meta.price);
  const hasDiscount = meta.has_discount === true;
  const stock = num(meta.stock);
  // Köşe tipi henüz metadata'da tutulmuyor; content'ten oku.
  const cornerType =
    str(meta.corner_type) ?? doc.content.match(/Köşe Tipi:\s*([^|\n]+)/i)?.[1]?.trim() ?? null;

  const priceText =
    salePrice != null
      ? hasDiscount && listPrice != null
        ? `Liste ${listPrice} TL / İndirimli ${salePrice} TL (İndirimde)`
        : `Fiyat ${salePrice} TL (İndirim yok)`
      : null;

  const fields = [
    `Ürün: ${title}`,
    str(meta.category) ? `Kategori: ${meta.category}` : null,
    str(meta.dimension) ? `Ölçü: ${meta.dimension}` : null,
    profileMm != null ? `Profil: ${profileMm} mm` : null,
    cornerType ? `Köşe: ${cornerType}` : null,
    str(meta.material) ? `Malzeme: ${meta.material}` : null,
    str(meta.color) ? `Renk: ${meta.color}` : null,
    num(meta.weight_kg) != null ? `Ağırlık: ${num(meta.weight_kg)} kg` : null,
    priceText,
    stock != null ? `Stok: ${stock}` : null,
  ].filter((field): field is string => Boolean(field));

  const compactLine = fields.join(' | ');
  if (mode === 'compact') return compactLine;

  const description = doc.content.match(/Açıklama:\s*([\s\S]+)$/)?.[1]?.trim() ?? null;
  const url = str(meta.url);
  return [
    compactLine,
    description ? `Açıklama: ${description}` : null,
    url ? `Ürün Satın Alma Linki: ${url}` : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join('\n');
}

function withPolicyHints(message: string, contextText: string): string {
  // En kritik / çakışmaya açık ipuçları önce (model FAQ parçasına kaymasın)
  const hints = [
    partialReturnShippingHint(message),
    undocumentedCheckoutHint(message),
    childDataHint(message),
    urgentSupportHint(message),
    returnPolicyHint(message),
    internationalReturnHint(message),
    shippingThresholdHint(message),
    paymentMethodsHint(message),
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
  if (filters.corner_type) bits.push(`${filters.corner_type} köşe`);
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
          corner_type: {
            type: 'string',
            enum: ['gönye', 'rondo'],
            description:
              'Köşe tipi filtresi. Kullanıcı "gönye köşe(li)" dediyse "gönye", "rondo köşe(li)" dediyse "rondo" ver. Katalogda her iki tip de var; kullanıcı birini istediyse diğerini sonuçlara KARIŞTIRMA.',
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
 * Politika / belirsiz sorular için baseline vektör bağlamı.
 * Deterministik ürün yolları (pin, filtre, kategori tarama) bu aramayı
 * kullanmaz — orada sonuç SQL'den gelir ve vektör çağrısı boşa gider.
 */
async function fetchBaselineDocuments(
  supabase: Awaited<ReturnType<typeof createClient>>,
  message: string,
  cleanHistory: HistoryTurn[]
): Promise<{ documents: MatchedDocument[]; error: unknown | null }> {
  // Takip soruları tek başına embed edilirse sapabiliyor; son asistan
  // yanıtını da embedding girdisine ekle.
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

  // Politika chunk'ları ürünlere göre daha düşük benzerlik verebiliyor.
  const isPolicyQuestion = looksLikePolicyQuestion(message);
  const { data: matchedDocs, error: matchError } = await supabase.rpc('match_documents', {
    query_embedding: queryEmbedding,
    match_threshold: isPolicyQuestion ? 0.15 : 0.3,
    match_count: 8,
  });

  if (matchError) {
    return { documents: [], error: matchError };
  }

  return {
    documents: (matchedDocs ?? []) as MatchedDocument[],
    error: null,
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
    // "1000 TL üzeri" → > 1000; "en az 1000" → >= 1000
    query = query.filter(
      'metadata->price',
      args.min_price_exclusive ? 'gt' : 'gte',
      args.min_price
    );
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
  // Köşe tipi bellek içinde süzüldüğü için önce geniş çekip sonra kırpıyoruz;
  // aksi halde limit=1 isteğinde yanlış köşe tipi tek sonuç olarak dönerdi.
  const fetchLimit =
    multiColors.length > 1 || args.corner_type ? Math.max(limit, 200) : limit;

  const { data, error } = await query.limit(fetchLimit);

  if (error) {
    console.error('search_products sorgu hatası:', error);
    return [];
  }

  let rows = (data ?? []) as MatchedDocument[];

  if (args.corner_type) {
    const corner = args.corner_type;
    rows = rows.filter((doc) => docMatchesCornerType(doc, corner));
    rows = rows.slice(0, limit);
  }

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

type PromptLane = 'product' | 'detail' | 'policy' | 'general';
type PolicyPack = 'iade' | 'kargo' | 'odeme' | 'destek' | 'genel';

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

function resolvePromptLane(params: BuildSystemPromptParams): PromptLane {
  if (params.pinnedFollowUpProduct) return 'detail';
  if (params.toolActive || params.hasProductCards) return 'product';
  if (looksLikePolicyQuestion(params.userMessage ?? '')) return 'policy';
  return 'general';
}

/** Mesaja göre politika paketlerini seç; karışık sorularda birden fazla döner. */
function detectPolicyPacks(message: string): PolicyPack[] {
  const t = message.toLocaleLowerCase('tr-TR');
  const packs = new Set<PolicyPack>();

  if (
    /iade|değişim|degisim|cayma|iptal|hasar|kırık|kirik|kusurlu|tutanak|kullanılmış|kullanilmis|hediye\s*kart/.test(
      t
    )
  ) {
    packs.add('iade');
  }
  if (
    /kargo|teslimat|ücretsiz\s*kargo|ucretsiz\s*kargo|yurt\s*d[ıi][şs][ıi]|yurtd[ıi][şs][ıi]|kıbrıs|kibris|kktc|almanya|avrupa|\bab\b/.test(
      t
    ) ||
    /ikinci\s*kargo|yanl[ıi][şs]\s*adres/.test(t)
  ) {
    packs.add('kargo');
  }
  if (
    /ödeme|odeme|fatura|e-?fatura|kdv|vkn|vergi|iyzico|havale|eft|taksit|iban|nakit|kap[ıi]da|visa|mastercard|kart/.test(
      t
    )
  ) {
    packs.add('odeme');
  }
  if (
    /telefon|mesai|acil|iletişim|iletisim|şikayet|sikayet|değişiklik|degisiklik|açılmıyor|acilmiyor/.test(
      t
    )
  ) {
    packs.add('destek');
  }
  if (
    /çocuk|cocuk|ebeveyn|veli|kvkk|gizlilik|çerez|cerez|kişisel\s*veri|kisisel\s*veri|dava|tahkim|avukat|mahkeme|yasal|sözleşme|sozlesme/.test(
      t
    )
  ) {
    packs.add('genel');
  }

  // Politika niyeti var ama paket seçilemediyse güvenli fallback
  if (packs.size === 0 && looksLikePolicyQuestion(message)) {
    packs.add('genel');
    packs.add('iade');
    packs.add('kargo');
    packs.add('odeme');
    packs.add('destek');
  }

  return Array.from(packs);
}

function policyPackText(pack: PolicyPack): string {
  switch (pack) {
    case 'iade':
      return `POLİTİKA PAKETİ — İADE:
- TR iade: teslimattan sonra 14 gün; önce talep+etiket; adres Sakarya/Arifiye (Kağıthane iade adresi DEĞİL); talepsiz gönderim kabul edilmeyebilir.
- İade günü: "11 gün sonra" → 11≤14 EVET; "15 gün" → HAYIR. Evet/Hayır ile süre ASLA çelişmesin.
- Para iadesi: onay sonrası 10 iş günü (usulüne uygun iade sonrası).
- Kısmi iade + giden kargo kesintisi: sipariş anı 750 eşiğini söyle; giden kargonun iadeden düşülmesi belgede yok → kesin kesilir/kesilmez/yasal deme; iletişime yönlendir. "KARGO ÜCRETSİZ → ÜCRETSİZ" ipucunu bu senaryoya uygulama.
- Kullanılmış/hediye kartı/doğrudan takas: belgede yoksa uydurma; koşulları özetle veya iletişime yönlendir.
- Örnek: Kağıthane'ye kargoladım → önce yanlış adres uyarısı + iletişim; 10 iş günü ikincil.`;
    case 'kargo':
      return `POLİTİKA PAKETİ — KARGO:
- Ücretsiz kargo eşiği 750 TL (sipariş anı). 720 → Hayır ücretsiz değil; 800 → Evet ücretsiz. Evet/Hayır ile aritmetik çelişmesin.
- Yurt dışı / Kıbrıs / KKTC gönderim yok. AB cayma yalnızca ORES AB'ye gönderirse.
- Hasarlı paket → tutanak + iletişim. Yanlış teslimat adresi → müşteri sorumluluğu / ikinci kargo belgede varsa ona uy.
- Bağlamda "KARGO ÜCRETSİZ EŞİĞİ" ipucu varsa ona uy.`;
    case 'odeme':
      return `POLİTİKA PAKETİ — ÖDEME/FATURA:
- Kabul: Visa/Mastercard, iyzico, havale/EFT. Kapıda nakit YOK. IBAN uydurma → iletişime yönlendir.
- KDV oranı belgede yok → "%18/%20" UYDURMA; "belgelerimizde KDV oranı yok" + iletişim.
- Şahıs kartı + kurumsal fatura/e-fatura/VKN: bilinen ödemeleri söyle; prosedür belgede yoksa uydurma, iletişime yönlendir.
- Örnek: kapıda nakit / IBAN → Hayır nakit; kart/iyzico/havale; IBAN için iletişim.`;
    case 'destek':
      return `POLİTİKA PAKETİ — DESTEK/İLETİŞİM:
- Gerçek e-posta + telefon + 08:00–18:00 DOĞRUDAN paylaş; "müşteri hizmetlerine ulaşın" deme.
- Mesai dışı / telefon açılmıyor: empati; yarın ara; acil için e-posta + sipariş no.
- Sipariş değişiklik/iptal (teslim alınmadıysa): varsayılan "iade edip yeni sipariş" UYDURMA.`;
    case 'genel':
      return `POLİTİKA PAKETİ — GENEL/HUKUK/GİZLİLİK:
- Politika/ödeme/iade/kargo soruları KAPSAM İÇİ — reddetme. Uydurma yok; belgede yoksa iletişime yönlendir.
- Çocuk verisi §6.8: çocuklara yönelik değil; ebeveyn silebilir; 16 yaş altı notu; e-posta+telefon (sadece "mail atın" yetmez).
- Dava/tahkim/"yasal mı": ölçülü dil; mahkeme hükmü verme.
- Yurt dışı/AB cayma: gönderim yok; AB cayma yalnızca ORES AB'ye gönderirse.`;
  }
}

const PROMPT_BASE = `Sen Ores.com.tr e-ticaret platformunun profesyonel, kibar ve çözüm odaklı AI Müşteri Danışmanısın.

GÖREVİN:
Kullanıcının sorularına sana verilen bağlamı (context) ve gerektiğinde search_products aracını kullanarak şık, anlaşılır ve e-ticaret standartlarına uygun yanıtlar vermek.

KAPSAM (ÇOK ÖNEMLİ):
Yalnızca ORES ürünleri, sipariş, ödeme/fatura ve kurumsal politikalar. Ürünle ilişkili özel ölçü/baskı/montaj/kurumsal alım KAPSAM İÇİ — reddetme.
KAPSAM DIŞI: ünlü/spor/genel kültür vb. — kibarca reddet. Çerçeve/pano/sipariş/ödeme sorusu HER ZAMAN kapsam içi.
KARMA: ürün + kapsam dışı → ürünü cevapla; kapsam dışıya tek cümle ("sporcu bilgisi veremem").
Örnek dışı: sadece "Icardi nerelidir?" → reddet. Örnek karma: afiş ölçüsü + Icardi → ölçüye cevap ver, Icardi'ye cevap verme.

ASLA ÜRÜN/FİYAT/POLİTİKA UYDURMA: Yalnızca BAĞLAM BİLGİLERİ ve search_products sonuçlarını kullan. Belgede yoksa "geçmiyor" de; iletişime yönlendir (e-posta+telefon+08:00–18:00).`;

const PROMPT_PRODUCT_RULES = `ÜRÜN KURALLARI:
ARAÇ: Fiyat filtresi, sıralama (en ucuz/en ağır), stok, indirim, kategori → search_products. Filtrelemeyi kendin yapma. Tek ürün → limit=1. "Stokta olmayan en ucuz…" → out_of_stock_only=true, sort_by=price_asc.
SIRALAMA: "En ağır ve en ucuz mu?" → önce ağırlık (kg); "en ucuz mu?" Evet/Hayır'dır, sıralamayı fiyata çevirme. AĞIRLIK ≠ FİYAT.
ÇİFT İSTEK: "X var mı? Yoksa en ucuz 3 çerçeve" → önce X yoksa söyle; sonra search_products.
0. ÜRÜN KARTLARI HAZIR ise metinde tablo/liste/ürün detayı YASAK. Sadece: kısa özet + [[URUN_KARTLARI]] + proaktif satış kapanışı. "Başka konuda yardımcı olayım mı?" deme.
   İSTİSNA: fiyat/stok sorulduysa veya "FİYAT/STOK ÖZETİ" varsa kısa özet satırında yaz.
1. Kartlı kapanış satış odaklı olsun (model/boyut/detay sor).
2. Stok 0'ı gizleme; sipariş onaylama; "şu an stokta yok" de.
4. Özel ölçü/baskı: reddetme; "yapıyoruz/yapmıyoruz/mümkün" uydurma; iletişim ver.
5. Alternatif kategori önerirken SADECE listedeki gerçek kategoriler.
6. Sipariş: kullanıcının adres/telefon/kartını İSTEME. Kart varsa [İncele]; yoksa bağlamdaki satın alma linki. Adet > stok ise onaylama.
7. Link: sadece bağlamdaki URL; markdown [Metin](URL).
8. Sonuçtaki TÜM ürünler kartta; "birkaç örnek" deme.
9-BÜTÇE: "elimde X TL var bu ürünü alayım mı?" → X≥fiyat EVET (fazla para sorun değil); X<fiyat HAYIR+fark. Katalog "X altı var mı?" ile karıştırma.
10. İstenen adetten az sonuç varsa gerçek sayıyı açıkça yaz; uydurma ürün ekleme.`;

const PROMPT_DETAIL_RULES = `ÜRÜN DETAY KURALLARI:
Takip/onay ("evet", "detay", "bu ürün hakkında bilgi") → BAĞLAM'daki kilitli ürünün TAM içeriğiyle cevap ver. "Sadece listeye erişebiliyorum" deme. [[URUN_KARTLARI]] kullanma (kart istenmedikçe).
SIRALAMA (ZORUNLU):
(1) Kısa giriş (2) **Ürün Özellikleri** madde madde (3) **Fiyat/Stok** (4) uzun açıklama EN SONA (5) link + kapanış.
YANLIŞ: uzun açıklamayı başa koyma.
Link: sadece bağlamdaki URL. Siparişte kullanıcının kişisel bilgisini isteme.
BÜTÇE: "elimde X TL" → X≥fiyat EVET; X<fiyat HAYIR+fark.`;

const PROMPT_TOOL_ACTIVE =
  'ARAÇ SONUCU ÖNCEDEN FİLTRELENDİ: BAĞLAM search_products çıktısıdır; tekrar filtreleme veya uydurma ürün ekleme. Gerçek sayıyı dürüstçe belirt.';

const PROMPT_AMBIGUOUS =
  'GENEL/BELİRSİZ SORU: Belirli kategori/ürün yoksa ürün listesi UYDURMA. Sadece gerçek kategori listesini sor ve hangi kategoriyle ilgilendiğini sor.';

function buildSystemPrompt(params: BuildSystemPromptParams): string {
  const {
    knownCategoriesText,
    contextText,
    hasProductCards,
    isAmbiguousGenericQuery,
    toolActive,
    pinnedFollowUpProduct = false,
    userMessage = '',
    extraContextPrefix = '',
  } = params;

  const lane = resolvePromptLane(params);
  // Ürün yolunda da mesaj kargo/iade içeriyorsa ilgili paketleri ekle (karışık soru).
  // Saf ürün sorusunda detect boş döner → politika few-shot'ları yüklenmez.
  let policyPacks = detectPolicyPacks(userMessage);
  if (lane === 'product' || lane === 'detail') {
    policyPacks = policyPacks.filter((pack) => pack !== 'genel');
  }

  const sections: string[] = [PROMPT_BASE];

  if (lane === 'product' || lane === 'general') {
    sections.push(PROMPT_PRODUCT_RULES);
  }
  if (lane === 'detail') {
    sections.push(PROMPT_DETAIL_RULES);
  }
  if (lane === 'policy' || policyPacks.length > 0) {
    const packsToUse =
      policyPacks.length > 0
        ? policyPacks
        : (['genel', 'iade', 'kargo', 'odeme', 'destek'] as PolicyPack[]);
    sections.push(...packsToUse.map(policyPackText));
  }
  if (lane === 'general') {
    // Fallback ilk çağrı: kısa araç notu yeter; ağır politika few-shot'ları
    // yalnızca detectPolicyPacks tetiklenirse yukarıda eklendi.
    sections.push(
      'ARAÇ: Filtre/sıralama/stok/indirim sorularında search_products çağır. Saf politika sorusunda araç gerekmeyebilir.'
    );
  }

  if (toolActive) sections.push(PROMPT_TOOL_ACTIVE);
  if (isAmbiguousGenericQuery) sections.push(PROMPT_AMBIGUOUS);

  sections.push(`KATALOĞUMUZDAKI GERÇEK KATEGORİLER:\n${knownCategoriesText}`);

  if (hasProductCards) {
    sections.push(
      'ÜRÜN KARTLARI HAZIR: kısa özet + [[URUN_KARTLARI]] + satış odaklı kapanış. Metinde ürün detayı/tablo/liste YASAK. İstenen adetten az sonuç varsa gerçek sayıyı yaz.'
    );
  }
  if (pinnedFollowUpProduct) {
    sections.push(
      'TAKİP ÜRÜNÜ KİLİTLENDİ: BAĞLAM bu ürünün tam kaydıdır. Detay sırasına uy; uzun açıklamayı başa koyma.'
    );
  }

  const hinted = withPolicyHints(userMessage, contextText);
  const contextWithHints = extraContextPrefix
    ? `${extraContextPrefix}\n\n${hinted}`
    : hinted;
  sections.push(`BAĞLAM BİLGİLERİ:\n${contextWithHints}`);

  const prompt = sections.join('\n\n');
  if (process.env.CHAT_DEBUG_PROMPT === '1') {
    console.log(
      `[prompt] lane=${lane} packs=${policyPacks.join(',') || '-'} chars=${prompt.length} ~token=${Math.round(prompt.length / 3.2)}`
    );
  }
  return prompt;
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

    // Baseline vektör araması artık her istekte çalışmaz: pin / filtre /
    // kategori gibi deterministik ürün yolları SQL sonucunu kullanır.
    // Embedding + match_documents yalnızca aşağıda fallback (politika /
    // belirsiz / tool) yoluna düşüldüğünde çağrılır.
    let documents: MatchedDocument[] = [];

    // Takip sorusuysa ("bu ürünün ağırlığı", "indirimli fiyatı nedir" vb.)
    // sohbette en son adı geçen ürünü bulup bağlama KİLİTLE.
    let pinnedFollowUpProduct = false;
    // "evet ," + önceki "başka kategori ister misiniz?" → pin DEĞİL, alternatif arama
    const acceptAlternateCategory = shouldAcceptAlternateCategory(
      message,
      cleanHistory
    );
    const relaxedProfileMm = looksLikeAnyPriceFollowUp(message)
      ? inferLastRequestedProfileMm(cleanHistory)
      : null;
    const isReferentialFollowUp =
      !acceptAlternateCategory &&
      relaxedProfileMm == null &&
      (looksLikeProductFollowUp(message) ||
        looksLikeAffordabilityQuestion(message)) &&
      cleanHistory.length > 0;

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

      // Kartlı cevapta metinde ürün adı olmayabiliyor ("kaldırım panosu… aşağıda").
      // Takip ("evet incelemek isterim") için geçmişteki kategoride tek ürün varsa onu kilitle.
      if (!lastProductTitle && isReferentialFollowUp) {
        const histCategory = inferCategoryFromHistory(
          cleanHistory,
          message,
          knownCategories
        );
        if (histCategory) {
          const catDocs = await executeSearchProducts(supabase, knownCategories, {
            category: histCategory,
            limit: 5,
          });
          const titles = catDocs
            .map((doc) =>
              typeof doc.metadata?.title === 'string' ? doc.metadata.title.trim() : ''
            )
            .filter(Boolean);
          if (titles.length === 1) {
            lastProductTitle = titles[0];
          }
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
          // Yalnızca kilitlenen ürün: vektörden gelen alakasız politika
          // chunk'larını detay bağlamına karıştırma (~3–4k token tasarruf).
          documents = pinnedRows as MatchedDocument[];
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

      // Sonuçtaki her ürün stok 0 ise model bunu atlayıp "inceleyebilirsiniz"
      // deyip geçebiliyordu; kullanıcı ancak kartta fark ediyordu.
      const allResultsOutOfStock =
        toolActive &&
        productDocuments.length > 0 &&
        productDocuments.every((doc) => doc.metadata?.stock === 0);
      const outOfStockHint = allResultsOutOfStock
        ? `ÖNEMLİ (STOK DURUMU — KESİN): Bu sonuçtaki ${
            productDocuments.length === 1 ? 'ürünün' : 'ürünlerin tamamının'
          } stok adedi 0. Kısa özet cümlende bunu AÇIKÇA belirt ("şu an stokta yok"); ürünü stoktaymış gibi "hemen satın alabilirsiniz" DEME. Kartları yine göster; stok/alternatif için iletişime veya diğer modellere yönlendir.\n\n`
        : '';

      // Uzun açıklama + satın alma linki yalnızca metin cevabının bunlara
      // gerçekten ihtiyaç duyduğu iki durumda gönderilir: kilitlenmiş takip
      // ürünü (Kural 3 detay sırası) ve kartsız tek/çift ürün cevabı. Liste
      // ve filtre yanıtlarında detaylar kartlarda göründüğü için bağlama
      // sadece kompakt alan satırı girer.
      const productMode: 'compact' | 'detail' =
        pinnedFollowUpProduct || (!hasProductCards && productDocuments.length <= 2)
          ? 'detail'
          : 'compact';

      const hasRelevantContext = docs.length > 0;
      const contextBody = hasRelevantContext
        ? docs
            .map((doc) =>
              doc.metadata?.type === 'product'
                ? formatProductForPrompt(doc, productMode)
                : doc.content
            )
            .join('\n\n---\n\n')
        : toolActive
          ? 'ARAMA SONUCU: search_products aracı, belirtilen kritere (kategori/fiyat/stok) uyan hiçbir ürün bulamadı.'
          : 'BAĞLAMDA HİÇBİR İLGİLİ ÜRÜN BULUNAMADI. Kataloğumuzda bu isteğe uyan bir ürün yok.';
      const contextText = `${outOfStockHint}${contextBody}`;

      return { isAmbiguousGenericQuery, hasProductCards, contextText };
    };

    const tools = [buildSearchProductsTool(knownCategoriesText)];

    const historyMessages: ChatCompletionMessageParam[] = cleanHistory.map((turn) => ({
      role: turn.role,
      content: turn.content,
    }));

    let rawReply: string;
    let hasProductCards = false;
    // Sunucuda üretilen karşılaştırma metinleri kart temizleyicisinden geçmemeli;
    // aksi halde "- Kırmızı: ... 465 TL" gibi satırlar silinip cevap yarım kalıyor.
    let bypassCardSanitize = false;

    // Takip detay sorusu: son konuşulan ürün kilidi aktifse tool çağırmadan
    // doğrudan o ürünün tam içeriğiyle cevap ver (kart listesi değil, metin detay).
    if (pinnedFollowUpProduct) {
      const followUpDerived = buildDerivedPromptFields(documents, false);
      // "incelemek / göstermek isterim" → kart da gelsin; sadece metin detayda
      // "aşağıda" deyip kartsız kalmasın (kaldırım panosu stok=0 senaryosu).
      // Çıplak "evet" kart açmasın (bütçe/kategori teklifine evet → pin yoluna düşmemeli;
      // yine düşerse Poster Swing kartı basılmasın).
      const wantsCardWithDetail =
        /(incele|göster|kart|ürünü\s*gör|aşağıda)/i.test(message) ||
        (/^(evet|tamam|olur)\b/i.test(message.trim()) &&
          !looksLikeBareAffirmative(message) &&
          /(bilgi|detay|ürün|sipariş|satın|incele)/i.test(message));
      const productDocs = documents.filter((doc) => doc.metadata?.type === 'product');
      hasProductCards = wantsCardWithDetail && productDocs.length > 0;

      const pinnedProduct = productDocs[0];

      // "18 tane alabilir miyim?" / "15 tane alayım" → stok; LLM "Ancak" tuzağı yok
      const askedQty = extractRequestedPurchaseQty(message);
      const stockQtyReply =
        askedQty != null &&
        pinnedProduct &&
        looksLikeQuantityPurchaseQuestion(message) &&
        !/(kargo|ücretsiz|kargola)/i.test(message)
          ? buildStockQuantityReply(askedQty, pinnedProduct)
          : null;

      // "bu üründen 18 adet kargolar mısınız?" → kilitli ürün fiyatı × adet
      const pinnedShipReply =
        pinnedProduct && !stockQtyReply
          ? buildPinnedShippingQuantityReply(message, pinnedProduct)
          : null;

      // "5311 TL elimde var alabilir miyim?" → fiyat ile karşılaştır
      const affordAmount =
        !stockQtyReply &&
        !pinnedShipReply &&
        looksLikeAffordabilityQuestion(message)
          ? extractAffordabilityAmount(message)
          : null;
      const affordReply =
        affordAmount != null && pinnedProduct
          ? buildAffordabilityReply(affordAmount, pinnedProduct)
          : null;

      if (stockQtyReply) {
        rawReply = stockQtyReply;
        hasProductCards = false;
      } else if (pinnedShipReply) {
        rawReply = pinnedShipReply;
        hasProductCards = false;
      } else if (affordReply) {
        rawReply = affordReply;
        hasProductCards = false;
      } else {
      // "profil kalınlığı ne?" → metadata'da varsa kesin cevap (content'te olmayabilir)
      let propertyGuard = '';
      if (/(profil|kalınl[ıi]k|kaç\s*mm)/i.test(message)) {
        const pinned = productDocs[0];
        const raw = pinned?.metadata?.profile_thickness_mm;
        const mm =
          typeof raw === 'number'
            ? raw
            : typeof raw === 'string' && raw.trim() && !Number.isNaN(Number(raw))
              ? Number(raw)
              : null;
        if (mm != null) {
          propertyGuard = `ÖZELLİK CEVABI (KESİN): Bu ürünün profil kalınlığı ${mm} mm. "Bilgim yok / belirtilmemiş" DEME; cevaba "${mm} mm" yaz.\n\n`;
        }
      }

      const detailOrderGuard = hasProductCards
        ? `DETAY + KART (KESİN): Kısa giriş, sonra [[URUN_KARTLARI]], ardından Kural 3 sırasıyla özellikler → fiyat/stok → uzun açıklama. "Aşağıda" deyip kart/yer tutucu unutma. Stok 0 olsa bile kartı göster ("Stokta yok").\n\n`
        : 'DETAY FORMATI (KESİN): Önce **Ürün Özellikleri** (madde madde), sonra **Fiyat/Stok**, en sonda uzun açıklama. "Aşağıda inceleyebilirsiniz" deyip boş bırakma — metinde özellikleri yaz. Uzun metni başa yazma.\n\n';

      const followUpCompletion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: buildSystemPrompt({
              knownCategoriesText,
              contextText: `${propertyGuard}${detailOrderGuard}${followUpDerived.contextText}`,
              hasProductCards,
              isAmbiguousGenericQuery: false,
              toolActive: hasProductCards,
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
      if (propertyGuard) {
        const mmMatch = propertyGuard.match(/profil kalınlığı (\d+(?:\.\d+)?) mm/i);
        const mm = mmMatch?.[1];
        if (
          mm &&
          !new RegExp(`${mm}\\s*mm`, 'i').test(rawReply)
        ) {
          rawReply = `Bu ürünün profil kalınlığı ${mm} mm'dir. Başka bir özellik (ölçü, ağırlık, stok) sormak ister misiniz?`;
        }
      }
      if (hasProductCards && !rawReply.includes(PRODUCT_CARDS_PLACEHOLDER)) {
        rawReply = `${rawReply}\n\n${PRODUCT_CARDS_PLACEHOLDER}`;
      }
      }
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
    // "Gönye köşeli ürün istiyorum" → "afiş çerçevesi": köşe kriteri önceki
    // turda kaldığı için bu mesajda yok; taşımazsak rondo ürünler de listelenir.
    // Sipariş/adet/takip detayında taşıma: "Bilgi al" başlığındaki Gönye,
    // "100 adet sipariş"i gönye kataloğuna çevirmesin.
    const skipCornerFromHistory =
      looksLikeQuantityPurchaseQuestion(message) ||
      looksLikeAffordabilityQuestion(message) ||
      looksLikeProductFollowUp(message);
    if (messageFilters.corner_type == null && !skipCornerFromHistory) {
      const cornerFromHistory = inferCornerTypeFromHistory(cleanHistory);
      if (cornerFromHistory) {
        messageFilters.corner_type = cornerFromHistory;
      }
    }
    if (relaxedProfileMm != null) {
      messageFilters.profile_thickness_mm = relaxedProfileMm;
      messageFilters.max_price = undefined;
      messageFilters.min_price = undefined;
      messageFilters.min_price_exclusive = undefined;
    }

    // Adet × fiyat kargo ve "X var mı? Yoksa Y göster" çift isteği — LLM'siz.
    const cartShippingFeeReply = buildCartShippingFeeReply(message);
    const shippingCartResult = cartShippingFeeReply
      ? null
      : await resolveShippingQuantityCart(
          message,
          supabase,
          knownCategories
        );
    const dualRequestResult =
      cartShippingFeeReply || shippingCartResult
        ? null
        : await buildAbsentThenFallbackReply(message, supabase, knownCategories);

    // Renk dökümü: "hangi renkler var?" → modelin "genellikle çeşitli renkler"
    // gibi geçiştirmesi yerine katalogdaki gerçek renkleri say.
    if (looksLikeColorCatalogQuestion(message)) {
      const explicitCategory = findMentionedCategories(message, knownCategories)[0] ?? null;
      const scopeCategory =
        explicitCategory ??
        inferUserCommittedCategoryFromHistory(cleanHistory, message, knownCategories);
      const surveyDocs = await executeSearchProducts(supabase, knownCategories, {
        ...(scopeCategory ? { category: scopeCategory } : {}),
        limit: 200,
      });
      const colors = collectColorsFromDocs(surveyDocs);
      const scopeLabel = scopeCategory
        ? `"${scopeCategory}" kategorisinde`
        : 'kataloğumuzda';

      documents = [];
      hasProductCards = false;
      rawReply =
        colors.length > 0
          ? `${scopeLabel} mevcut renkler: ${colors
              .map((color) => `${color.label} (${color.count} ürün)`)
              .join(', ')}.\n\nHangi renkteki modelleri göstermemi istersiniz?`
          : `${scopeLabel} ürünlerde renk bilgisi bulunmuyor; dilerseniz ölçü veya bütçeye göre liste çıkarabilirim.`;
    } else if (looksLikeProfileCatalogQuestion(message) || relaxedProfileMm != null) {
      const claimed = extractClaimedProfileMm(message) ?? relaxedProfileMm;
      const frameScoped =
        looksLikeUniversalProfileQuestion(message) || /çerçeve/i.test(message);
      // Profil kataloğunda eski kategoriyi taşıma: 35 mm panodan sonra
      // "25 mm ürünleri göster" tüm katalogda yeni ve bağımsız aramadır.
      const explicitlyMentionedCategory =
        findMentionedCategories(message, knownCategories)[0] ?? null;
      const scopeCategory =
        explicitlyMentionedCategory ??
        (frameScoped
          ? knownCategories.find((c) => /çerçeve/i.test(c)) ?? null
          : null);

      const wantsProductForMm =
        claimed != null &&
        (/hangi\s+ürün|hangisi|var\s*mı|yok\s*mu|bulun/i.test(message) ||
          /(ürünler(?:i|in|ini|imiz)?|ürünlerini|listele|göster|incele)/i.test(
            message
          ) ||
          relaxedProfileMm != null ||
          messageFilters.profile_thickness_mm != null);

      if (wantsProductForMm && claimed != null) {
        let profileDocs = await executeSearchProducts(supabase, knownCategories, {
          ...(scopeCategory ? { category: scopeCategory } : {}),
          profile_thickness_mm: claimed,
          sort_by: 'price_asc',
          limit: 50,
        });
        // Kategori daraltması 35 mm panoyu kaçırırsa tüm katalogda ara
        if (profileDocs.length === 0 && scopeCategory) {
          profileDocs = await executeSearchProducts(supabase, knownCategories, {
            profile_thickness_mm: claimed,
            sort_by: 'price_asc',
            limit: 50,
          });
        }
        documents = profileDocs;
        const profileDerived = buildDerivedPromptFields(documents, true);
        hasProductCards = profileDerived.hasProductCards;
        if (documents.length === 0) {
          const surveyDocs = await executeSearchProducts(supabase, knownCategories, {
            limit: 200,
          });
          const allProfiles = collectProfileThicknessesMm(surveyDocs);
          rawReply = `Hayır — ${claimed} mm profil kalınlığında ürün bulunamadı. Mevcut profiller: ${
            allProfiles.length ? allProfiles.map((mm) => `${mm} mm`).join(', ') : 'bilinmiyor'
          }.`;
          hasProductCards = false;
        } else {
          rawReply = `Evet — ${claimed} mm profil kalınlığında ${documents.length} ürün var. Tümünü aşağıdaki kartlarda inceleyebilirsiniz.\n\n${PRODUCT_CARDS_PLACEHOLDER}\n\nİlgilendiğiniz modeli inceleyelim mi?`;
          hasProductCards = true;
        }
      } else {
        const surveyDocs = await executeSearchProducts(supabase, knownCategories, {
          ...(scopeCategory ? { category: scopeCategory } : {}),
          limit: 200,
        });
        const profiles = collectProfileThicknessesMm(surveyDocs);
        const scopeLabel = scopeCategory
          ? `"${scopeCategory}" kategorisinde`
          : 'katalogda';
        const listBit =
          profiles.length > 0
            ? profiles.map((mm) => `${mm} mm`).join(', ')
            : 'bilinmiyor';

        documents = [];
        hasProductCards = false;
        if (
          looksLikeUniversalProfileQuestion(message) &&
          claimed != null &&
          profiles.length === 1 &&
          profiles[0] === claimed
        ) {
          rawReply = `Evet — ${scopeLabel} ürünlerin profil kalınlığı ${claimed} mm.`;
        } else if (
          looksLikeUniversalProfileQuestion(message) &&
          claimed != null &&
          profiles.includes(claimed) &&
          profiles.length > 1
        ) {
          rawReply = `Hayır — ${scopeLabel} yalnızca ${claimed} mm değil. Mevcut profil kalınlıkları: ${listBit}. İsterseniz ${profiles
            .filter((p) => p !== claimed)
            .map((p) => `${p} mm`)
            .join(' veya ')} modelleri de gösterebilirim.`;
        } else if (
          looksLikeUniversalProfileQuestion(message) &&
          claimed != null &&
          !profiles.includes(claimed)
        ) {
          rawReply = `Hayır — ${scopeLabel} ${claimed} mm profil bulunmuyor. Mevcut profiller: ${listBit}.`;
        } else {
          rawReply = `${scopeLabel} mevcut profil kalınlıkları: ${listBit}.`;
        }
      }
    } else if (cartShippingFeeReply) {
      // "sepetimde 751 TL kargo ücreti öder miyim?" → eşik cevabı; 751 TL altı katalog DEĞİL
      documents = [];
      hasProductCards = false;
      bypassCardSanitize = true;
      rawReply = cartShippingFeeReply;
    } else if (shippingCartResult) {
      documents = shippingCartResult.docs;
      const shippingReply = buildShippingQuantityCartReply(shippingCartResult);
      rawReply = shippingReply.reply;
      hasProductCards = shippingReply.hasProductCards;
    } else if (dualRequestResult) {
      documents = dualRequestResult.docs;
      rawReply = dualRequestResult.reply;
      hasProductCards = dualRequestResult.hasProductCards;
    } else if (acceptAlternateCategory) {
      const altCategory =
        findMentionedCategories(message, knownCategories)[0] ??
        inferSuggestedAlternateCategory(cleanHistory, knownCategories);
      const budget =
        messageFilters.max_price ?? inferMaxPriceFromHistory(cleanHistory) ?? undefined;

      let altDocs = altCategory
        ? await executeSearchProducts(supabase, knownCategories, {
            category: altCategory,
            ...(budget != null ? { max_price: budget } : {}),
            sort_by: 'price_asc',
            limit: 50,
          })
        : [];
      if (budget != null) {
        altDocs = altDocs.filter((doc) => {
          const price = doc.metadata?.price;
          return typeof price === 'number' && price <= budget;
        });
      }
      // Yanlışlıkla önceki panosu sızmasın
      if (altCategory) {
        altDocs = altDocs.filter(
          (doc) =>
            !doc.metadata?.category ||
            doc.metadata.category.toLocaleLowerCase('tr-TR') ===
              altCategory.toLocaleLowerCase('tr-TR')
        );
      }

      documents = altDocs;
      {
        const listing = buildDeterministicListingReply({
          docs: documents,
          message,
          kind: 'alternate',
          category: altCategory,
          alternateBudget: budget,
        });
        rawReply = listing.reply;
        hasProductCards = listing.hasProductCards;
        bypassCardSanitize = listing.bypassCardSanitize;
      }
    } else if (wantsAllCatalogProducts(message)) {
      documents = await executeSearchProducts(supabase, knownCategories, {
        sort_by: 'price_asc',
        limit: 200,
      });
      {
        const listing = buildDeterministicListingReply({
          docs: documents,
          message,
          kind: 'all',
        });
        rawReply = listing.reply;
        hasProductCards = listing.hasProductCards;
        bypassCardSanitize = listing.bypassCardSanitize;
      }
    } else if (looksLikeCatalogCountQuestion(message)) {
      // "27 adet yok mu?" — önceki kategori / mesajdan sayıyı DB'den doğrula
      const countCategory = inferCategoryFromHistory(
        cleanHistory,
        message,
        knownCategories
      );
      documents = await executeSearchProducts(supabase, knownCategories, {
        ...(countCategory ? { category: countCategory } : {}),
        limit: 200,
      });
      {
        const listing = buildDeterministicListingReply({
          docs: documents,
          message,
          kind: 'count',
          category: countCategory,
        });
        rawReply = listing.reply;
        hasProductCards = listing.hasProductCards;
        bypassCardSanitize = listing.bypassCardSanitize;
      }
    } else if (messageFilters.out_of_stock_only) {
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

      {
        const listing = buildDeterministicListingReply({
          docs: documents,
          message,
          kind: 'oos',
          category: oosCategories[0] ?? null,
          wantsSingle,
          sortBy: messageFilters.sort_by,
        });
        rawReply = listing.reply;
        hasProductCards = listing.hasProductCards;
        bypassCardSanitize = listing.bypassCardSanitize;
      }
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

      {
        const listing = buildDeterministicListingReply({
          docs: documents,
          message,
          kind: 'discount',
          category: discCategories[0] ?? null,
          wantsSingle,
          sortBy: messageFilters.sort_by,
          dimension: messageFilters.dimension,
          color: messageFilters.color,
        });
        rawReply = listing.reply;
        hasProductCards = listing.hasProductCards;
        bypassCardSanitize = listing.bypassCardSanitize;
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

      // Kırpmadan önceki havuz: çoklu üstünlük karşılaştırması için
      const rankPool = [...rankDocs];

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

      {
        const listing = buildDeterministicListingReply({
          docs: documents,
          message,
          kind: 'rank',
          category: rankCategories[0] ?? null,
          colors: messageFilters.colors,
          color: messageFilters.color,
          dimension: messageFilters.dimension,
          requestedCount: Number.isFinite(requestedCount) ? requestedCount : undefined,
          wantsSingle,
          sortBy,
          rankPool,
        });
        rawReply = listing.reply;
        hasProductCards = listing.hasProductCards;
        bypassCardSanitize = listing.bypassCardSanitize;
      }
    } else if (
      // "1000 TL altı B2" / "32 mm" / "kırmızı ile siyah A1" — zorunlu filtreli arama
      (messageFilters.dimension ||
        messageFilters.max_price != null ||
        messageFilters.min_price != null ||
        messageFilters.color ||
        (messageFilters.colors && messageFilters.colors.length > 0) ||
        messageFilters.corner_type != null ||
        messageFilters.profile_thickness_mm != null) &&
      !messageFilters.out_of_stock_only
    ) {
      // "5000 TL altı var mı?" → kullanıcı daha önce kategori seçtiyse onu taşı.
      // Asistan menüsündeki "afiş / kaldırım" isimlerini kategori seçimi SAYMA.
      let filterCategories = findMentionedCategories(message, knownCategories);
      const categoryFromHistory =
        filterCategories.length === 0 &&
        cleanHistory.length > 0 &&
        messageFilters.profile_thickness_mm == null
          ? inferUserCommittedCategoryFromHistory(
              cleanHistory,
              message,
              knownCategories
            )
          : null;
      if (categoryFromHistory) {
        filterCategories = [categoryFromHistory];
      }
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
      // Fiyat aralığı / stok sızmasın (DB filtresi kaçsa bile)
      if (messageFilters.max_price != null) {
        const cap = messageFilters.max_price;
        filterDocs = filterDocs.filter((doc) => {
          const price = doc.metadata?.price;
          return typeof price === 'number' && price <= cap;
        });
      }
      if (messageFilters.min_price != null) {
        const floor = messageFilters.min_price;
        const exclusive = messageFilters.min_price_exclusive === true;
        filterDocs = filterDocs.filter((doc) => {
          const price = doc.metadata?.price;
          if (typeof price !== 'number') return false;
          return exclusive ? price > floor : price >= floor;
        });
      }
      if (messageFilters.in_stock_only) {
        filterDocs = filterDocs.filter((doc) => {
          const stock = doc.metadata?.stock;
          return typeof stock === 'number' && stock > 0;
        });
      }

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

      let cornerCounts: { gönye: number; rondo: number } | null = null;
      if (messageFilters.corner_type) {
        const scopeDocs = await executeSearchProducts(supabase, knownCategories, {
          ...(filterCategories[0] ? { category: filterCategories[0] } : {}),
          limit: 200,
        });
        cornerCounts = {
          gönye: scopeDocs.filter((doc) => docMatchesCornerType(doc, 'gönye')).length,
          rondo: scopeDocs.filter((doc) => docMatchesCornerType(doc, 'rondo')).length,
        };
      }

      {
        const listing = buildDeterministicListingReply({
          docs: documents,
          message,
          kind: 'filter',
          category: filterCategories[0] ?? null,
          maxPrice: messageFilters.max_price,
          minPrice: messageFilters.min_price,
          color: messageFilters.color,
          colors: messageFilters.colors,
          dimension: messageFilters.dimension,
          profileMm: messageFilters.profile_thickness_mm,
          cornerType: messageFilters.corner_type,
          cornerCounts,
          wantsSingle: wantsSingleFilter,
          sortBy: messageFilters.sort_by,
        });
        rawReply = listing.reply;
        hasProductCards = listing.hasProductCards;
        bypassCardSanitize = listing.bypassCardSanitize;
      }
    } else if (directCategoryMatches.length > 0) {
      const categoryResultDocs: MatchedDocument[] = [];
      for (const category of directCategoryMatches) {
        categoryResultDocs.push(
          ...(await executeSearchProducts(supabase, knownCategories, {
            category,
            ...messageFilters,
            limit: 200,
          }))
        );
      }
      // Kategori sadece stok=0 ürün içeriyorsa in_stock filtresi boş döndürür →
      // "aşağıda" deyip kartsız kalmayı önlemek için stoksuzları da getir.
      if (categoryResultDocs.length === 0 && messageFilters.in_stock_only) {
        for (const category of directCategoryMatches) {
          categoryResultDocs.push(
            ...(await executeSearchProducts(supabase, knownCategories, {
              category,
              ...messageFilters,
              in_stock_only: false,
              limit: 200,
            }))
          );
        }
      }
      const seen = new Set<string>();
      documents = categoryResultDocs.filter((doc) => {
        const key = `${doc.metadata?.category ?? ''}|${doc.metadata?.title ?? ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      {
        const listing = buildDeterministicListingReply({
          docs: documents,
          message,
          kind: 'category',
          categories: directCategoryMatches,
          category: directCategoryMatches[0] ?? null,
          color: messageFilters.color,
          colors: messageFilters.colors,
          dimension: messageFilters.dimension,
          maxPrice: messageFilters.max_price,
          profileMm: messageFilters.profile_thickness_mm,
          cornerType: messageFilters.corner_type,
        });
        rawReply = listing.reply;
        hasProductCards = listing.hasProductCards;
        bypassCardSanitize = listing.bypassCardSanitize;
      }
    } else {
      // 2. Fallback: politika / belirsiz / tool yolu. Baseline vektör
      // araması yalnızca burada çalışır — pin/filtre yollarında atlanır.
      const {
        documents: baselineDocs,
        error: matchError,
      } = await fetchBaselineDocuments(supabase, message, cleanHistory);

      if (matchError) {
        console.error('Supabase Vektör Arama Hatası:', matchError);
        return NextResponse.json(
          { error: 'Veritabanı araması sırasında hata oluştu.' },
          { status: 500 }
        );
      }

      documents = baselineDocs;
      const baseline = buildDerivedPromptFields(documents, false);

      // İlk model çağrısı: baseline ile doğrudan cevap veya search_products.
      // ÖNEMLİ: baseline (toolActive:false) yanıtında hasProductCards HER
      // ZAMAN false'tur; kartlar sadece gerçek bir tool çağrısı sonucunda
      // (aşağıdaki if bloğunda) gösterilir.
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
            min_price_exclusive:
              args.min_price_exclusive ?? messageFilters.min_price_exclusive,
            out_of_stock_only: outOfStock,
            // Stokta olmayan aramasında in_stock_only asla true kalmasın
            in_stock_only: outOfStock
              ? false
              : Boolean(args.in_stock_only || messageFilters.in_stock_only),
            on_discount_only: Boolean(args.on_discount_only || messageFilters.on_discount_only),
            dimension: args.dimension || messageFilters.dimension,
            profile_thickness_mm:
              args.profile_thickness_mm ?? messageFilters.profile_thickness_mm,
            corner_type: args.corner_type ?? messageFilters.corner_type,
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

        // Tool sonucu DB'den geldi; ikinci LLM çağrısı yok — facts'ten yaz.
        const listing = buildDeterministicListingReply({
          docs: documents,
          message,
          kind: 'tool',
          category: messageFilters.category ?? null,
          maxPrice: messageFilters.max_price,
          color: messageFilters.color,
          colors: messageFilters.colors,
          dimension: messageFilters.dimension,
          profileMm: messageFilters.profile_thickness_mm,
          cornerType: messageFilters.corner_type,
          wantsSingle: looksLikeRankingOrSingleItemQuestion(message),
          sortBy: messageFilters.sort_by,
        });
        rawReply = listing.reply;
        hasProductCards = listing.hasProductCards;
        bypassCardSanitize = listing.bypassCardSanitize;
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
    let reply =
      hasProductCards && !bypassCardSanitize
        ? sanitizeProductCardReply(replyWithPlaceholder, allowPriceStockSummary)
        : replyWithPlaceholder;

    // Sonuçtaki ürünlerin tamamı stok 0 iken model bunu söylemezse kullanıcı
    // durumu ancak kartta fark ediyor; cümleyi deterministik olarak ekliyoruz.
    const productResultDocs = documents.filter((doc) => doc.metadata?.type === 'product');
    if (
      hasProductCards &&
      productResultDocs.length > 0 &&
      productResultDocs.every((doc) => doc.metadata?.stock === 0) &&
      !/(stokta yok|stokta değil|stokta olmayan|stok\s*[:=]?\s*0|tükendi|tükenmiş|stok durumu)/i.test(
        reply
      )
    ) {
      const stockNote =
        productResultDocs.length === 1
          ? 'Not: Bu ürün şu an stokta yok; stok bilgisi veya alternatif için bize yazabilirsiniz.'
          : 'Not: Bu ürünlerin tamamı şu an stokta yok; stok bilgisi veya alternatif için bize yazabilirsiniz.';
      reply = reply.includes(PRODUCT_CARDS_PLACEHOLDER)
        ? reply.replace(PRODUCT_CARDS_PLACEHOLDER, `${stockNote}\n\n${PRODUCT_CARDS_PLACEHOLDER}`)
        : `${reply}\n\n${stockNote}`;
    }

    // "11 gün sonra iade" → model bazen 11'i 14'ten büyük sanıyor; zorla düzelt
    const returnDayAsked = extractReturnDayOffset(message);
    if (
      returnDayAsked != null &&
      !/(indirim|kampanya)/i.test(message) &&
      !looksLikeUrgentOrderChange(message)
    ) {
      const startsEvet = /^evet\b/i.test(reply.trim());
      const startsHayir = /^hayır\b|^hayir\b/i.test(reply.trim());
      const wronglyDenied =
        returnDayAsked <= RETURN_WINDOW_DAYS && (startsHayir || !startsEvet);
      const wronglyAllowed =
        returnDayAsked > RETURN_WINDOW_DAYS && startsEvet;
      if (wronglyDenied || wronglyAllowed) {
        reply = buildReturnDayWindowReply(returnDayAsked);
        hasProductCards = false;
      }
    }

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

    // Kartlar için TÜM ürünler; Kaynaklar paneli için kısa citation listesi.
    // Persist: kartların sohbet yenilenince de gelmesi için productSources saklanır.
    const citationSources = buildCitationSources(documents, hasProductCards, message);
    const productCardSources = buildProductCardSources(documents, hasProductCards);
    const persistedSources =
      productCardSources.length > 0 ? productCardSources : citationSources;

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
          sources: persistedSources.length > 0 ? persistedSources : null,
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
      // Geriye uyumluluk: carousel `sources` içindeki product metadata'yı okur
      sources: persistedSources.length > 0 ? persistedSources : citationSources,
      citations: citationSources,
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
