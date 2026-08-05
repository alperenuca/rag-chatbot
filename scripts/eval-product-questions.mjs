/**
 * Ürün/katalog odaklı insan benzeri sorular → otomatik skor.
 * Kullanım: node scripts/eval-product-questions.mjs
 */
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local', override: true, quiet: true });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, '');
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
const base = process.env.EVAL_BASE_URL || 'http://localhost:3000';

if (!url || !anon || !service) {
  console.error('Supabase env eksik.');
  process.exit(1);
}

/** @type {{ name: string, q: string, history?: {role:string,content:string}[], mustInclude?: RegExp[], mustNotInclude?: RegExp[], minProductSources?: number, maxProductSources?: number, productTitlesMustInclude?: RegExp[], productTitlesMustNotInclude?: RegExp[] }[]} */
const CASES = [
  {
    name: 'En ucuz çerçeve',
    q: 'Stokta olan en ucuz afiş çerçevesini göster, fiyatını yaz.',
    mustInclude: [/420|\[\[URUN_KARTLARI\]\]/i],
    mustNotInclude: [/5310|koltuk|yemek masa/i],
  },
  {
    name: 'En pahalı çerçeve (pano değil)',
    q: 'En pahalı afiş çerçevesi hangisi? (kaldırım panosu değil)',
    mustInclude: [/2365|ahşap|B1|\[\[URUN_KARTLARI\]\]/i],
    mustNotInclude: [/5310|Poster Swing/i],
  },
  {
    name: 'En ağır ürün',
    q: 'En ağır ürününüz hangisi? Kilosunu ve fiyatını yaz.',
    mustInclude: [/16|Poster Swing|pano|5310/i],
  },
  {
    name: 'En ağır çerçeve + en ucuz mu?',
    q: 'En ağır afiş çerçevesi hangisi ve aynı zamanda en ucuz mu?',
    mustInclude: [/4[.,]?2|A0|2285/i],
    mustNotInclude: [/en ucuz.*evet|evet.*en ucuz/i],
  },
  {
    name: 'Bütçe 500 TL altı A4',
    q: '500 TL altı stokta A4 çerçeve var mı? Fiyat ve stok yaz.',
    mustInclude: [/420|465|A4/i],
    mustNotInclude: [/1000\s*TL|B1/i],
  },
  {
    name: 'Kategori olumsuzlama pano değil',
    q: '1000 TL altına stokta çerçeve istiyorum (pano değil), en ucuz 3 tanesini göster.',
    mustInclude: [/\[\[URUN_KARTLARI\]\]/i],
    mustNotInclude: [/Poster Swing|5310|kaldırım panosu/i],
  },
  {
    name: 'İndirimli ürünler',
    q: 'İndirimdeki çerçeveleri listele, liste ve indirimli fiyatı yaz.',
    mustInclude: [/460|670|1230|\[\[URUN_KARTLARI\]\]/i],
  },
  {
    name: 'Stokta olmayan en ucuz çerçeve',
    q: 'Stokta olmayan en ucuz afiş çerçevesini göster.',
    mustInclude: [/905|ahşap|A3|stok|\[\[URUN_KARTLARI\]\]/i],
    mustNotInclude: [/stokta olmayan ürün yok|hiç ürün yok/i],
  },
  {
    name: '32 mm profil',
    q: '32 mm profilli çerçeveleri göster.',
    mustInclude: [/32|\[\[URUN_KARTLARI\]\]/i],
  },
  {
    name: 'Kırmızı A1 fiyat stok',
    q: 'Kırmızı A1 çerçeve var mı? Fiyatını ve stoğunu yaz.',
    mustInclude: [/kırmızı|kirmizi|A1/i],
    mustNotInclude: [/ürün bulunamadı.*kırmızı A1|yoktur.*kırmızı A1/i],
  },
  {
    name: 'Siyah A4 yok',
    q: 'Siyah A4 çerçeve istiyorum, fiyatını söyle.',
    mustInclude: [/yok|bulunamadı|bulunmuyor|bulunmamaktadır|mevcut değil/i],
    mustNotInclude: [/uydurma|siyah A4.{0,30}465/i],
  },
  {
    name: 'Kırmızı vs siyah A1',
    q: 'Kırmızı A1 ile siyah A1 çerçeveyi karşılaştır, fiyat ve stok yaz.',
    mustInclude: [/kırmızı|kirmizi|siyah/i],
    mustNotInclude: [/uydurma|sayısal hesapla/i],
  },
  {
    name: '2 adet en ucuz A4 kargo',
    q: 'En ucuz A4 çerçeveden 2 adet alırsam kargo ücretsiz olur mu?',
    // 420*2=840 >= 750 → evet
    mustInclude: [/evet|ücretsiz|840|750/i],
    mustNotInclude: [/^Hayır/i],
  },
  {
    name: 'Ahşap desenli B1',
    q: 'Ahşap desenli B1 çerçeve fiyatı ne kadar, stokta var mı?',
    mustInclude: [/2365|B1|ahşap|stok/i],
  },
  {
    name: 'Olmayan kategori mouse pad',
    q: 'Sizde mouse pad veya iPhone kılıfı var mı? Yoksa en ucuz 3 çerçeveyi göster.',
    mustInclude: [/yok|bulunmuyor|bulunmamaktadır/i, /\[\[URUN_KARTLARI\]\]/i],
    mustNotInclude: [/mouse pad.{0,20}TL|iPhone kılıf.{0,20}TL/i],
  },
  {
    name: 'Kaldırım panosu stok 0 gizleme',
    q: 'Kaldırım panosu kategorisinde ne var?',
    mustInclude: [/Poster Swing|pano|5310|stok/i],
    mustNotInclude: [/bu kategoride ürün yok|hiç ürün bulunmuyor/i],
  },
  {
    name: 'A0 ölçü var mı',
    q: 'A0 ölçüsünde çerçeve var mı? Fiyatını yaz.',
    mustInclude: [/A0|2285|\[\[URUN_KARTLARI\]\]/i],
  },
  {
    name: 'B2 900 TL altı',
    q: 'B2 çerçevelerden 900 TL ve altındakileri stokta olanlarla göster.',
    mustInclude: [/895|B2|\[\[URUN_KARTLARI\]\]/i],
    mustNotInclude: [/1000\s*TL.*Siyah B2|1565/i],
  },
  {
    name: 'Çift istek mouse pad + en ucuz 3 çerçeve (kart zorunlu)',
    q: 'Sizde mouse pad veya iPhone kılıfı var mı? Yoksa en ucuz 3 çerçeveyi göster.',
    mustInclude: [/yok|bulunmamaktadır|bulunmuyor/i, /\[\[URUN_KARTLARI\]\]/i],
    mustNotInclude: [/mouse pad.{0,20}TL|iPhone kılıf.{0,20}TL/i],
  },
  {
    name: '35 mm profil (kaldırım panosu)',
    q: '35 mm profilli ürününüz var mı? Fiyatını ve stoğunu yaz.',
    mustInclude: [/Evet|Poster Swing|pano|5310|stok/i, /\[\[URUN_KARTLARI\]\]/i],
    mustNotInclude: [/bulunmamaktadır|yoktur/i],
  },
  {
    name: '1 adet en ucuz A4 kargo hayır',
    q: 'En ucuz A4 çerçeveden 1 adet alırsam kargo ücretsiz olur mu?',
    mustInclude: [/hay[ıi]r|750|420/i],
    mustNotInclude: [/^Evet/i],
  },
  {
    name: 'Stok yetersiz 50 adet kırmızı A4',
    q: '50 adet kırmızı A4 almak istiyorum, stok yeter mi?',
    mustInclude: [/16|stok/i],
    mustNotInclude: [/evet[,.].{0,30}50\s*adet|50 adet sipariş verebilirsiniz/i],
  },
  {
    name: 'Kategori browse: 27 kart (citation cap tuzağı)',
    q: 'afiş çerçevesi',
    mustInclude: [/\[\[URUN_KARTLARI\]\]/i],
    // API sources içinde en az 20 ürün olmalı (3'e kesilmemeli)
    minProductSources: 20,
  },
  {
    name: 'Tüm ürünler kartlı',
    q: 'tüm ürünlerini görmek isterim',
    mustInclude: [/\[\[URUN_KARTLARI\]\]/i, /28|27|ürün/i],
    minProductSources: 20,
    mustNotInclude: [/aşağıda inceleyebilirsiniz:\s*İlgilendiğiniz/i],
  },
  {
    name: 'Hepsine bakmak istiyorum → 28 ürün (tool limit tuzağı)',
    history: [
      { role: 'user', content: 'merhaba ürünlerinizi merak ediyorum' },
      {
        role: 'assistant',
        content:
          'Mağazamızda Afiş Çerçevesi ve Kaldırım Panosu kategorileri var. Hangisiyle ilgilenirsiniz?',
      },
    ],
    q: 'hepsine bakmak istiyorum',
    mustInclude: [/\[\[URUN_KARTLARI\]\]/i, /28/],
    minProductSources: 20,
    mustNotInclude: [/11 ürün|kriterinize uyan 11/i],
  },
  {
    name: 'Bütçe takip: panosu 5000 altı → Hayır (çerçeve kartı yok)',
    history: [
      { role: 'user', content: '500tl altı kaldırım panosu var mı' },
      {
        role: 'assistant',
        content:
          'Hayır, 500 TL altında kaldırım panosu bulunmamaktadır. Tek kaldırım panosu 5310 TL.',
      },
    ],
    q: '5000 tl altı var mı',
    mustInclude: [/hayır/i, /kaldırım/i],
    mustNotInclude: [/evet[,.].{0,80}5310|5310 TL.{0,40}altında|uygun/i],
    maxProductSources: 0,
  },
  {
    name: 'Sadece bütçe: asistan menüsü panoya kilitlemesin',
    history: [
      { role: 'user', content: 'ürün satın almak istiyorum' },
      {
        role: 'assistant',
        content:
          'Hangi ürünü satın almak istediğinizi belirtirseniz yardımcı olabilirim. Afiş çerçevesi veya kaldırım panosu gibi ürünlerimiz mevcut. Hangisini incelemek istersiniz?',
      },
    ],
    q: '800 lira altında',
    mustInclude: [/\[\[URUN_KARTLARI\]\]/i, /çerçeve|afiş|ürün/i],
    mustNotInclude: [
      /hayır.{0,40}kaldırım\s*panosu/i,
      /"Kaldırım Panosu" kategorisinde 800/i,
    ],
    minProductSources: 3,
  },
  {
    name: 'Başka kategori kabul: 900 altı çerçeve (panosu pin yok)',
    history: [
      { role: 'user', content: 'başka ürün bakıcam 900 tl altında' },
      {
        role: 'assistant',
        content:
          'Hayır, "Kaldırım Panosu" kategorisinde 900 TL ve altında ürün bulunmamaktadır. Daha yüksek bir bütçe veya başka bir kategori (ör. afiş çerçevesi) denemek ister misiniz?',
      },
    ],
    q: 'evet başka kategoride olsun o zaman',
    mustInclude: [/afiş|çerçeve/i, /\[\[URUN_KARTLARI\]\]/i],
    mustNotInclude: [/poster\s*swing|5310|kaldırım\s*reklam/i],
    minProductSources: 3,
  },
  {
    name: 'Çıplak evet: teklife panosu pinleme',
    history: [
      { role: 'user', content: '800 lira altında' },
      {
        role: 'assistant',
        content:
          'Hayır, "Kaldırım Panosu" kategorisinde 800 TL ve altında ürün bulunmamaktadır. Daha yüksek bir bütçe veya başka bir kategori (ör. afiş çerçevesi) denemek ister misiniz?',
      },
    ],
    q: 'evet ,',
    mustInclude: [/\[\[URUN_KARTLARI\]\]/i, /çerçeve|afiş/i],
    mustNotInclude: [
      /bulunmamaktadır/i,
      /poster\s*swing/i,
      /5310/,
      /"Kaldırım Panosu"/i,
    ],
    minProductSources: 3,
  },
  {
    name: '5311 >= 5310 yeterlilik: Evet (sabit fiyat bahanesi yok)',
    history: [
      {
        role: 'user',
        content: 'Ores Poster Swing - Su Depolu Kaldırım Reklam Panosu fiyatı nedir',
      },
      {
        role: 'assistant',
        content:
          'Ores Poster Swing - Su Depolu Kaldırım Reklam Panosu indirimli fiyatı 5310 TL.',
      },
    ],
    q: '5311 tl elimde var ben bu ürünü alabilir miyim',
    mustInclude: [/evet/i, /5310/],
    mustNotInclude: [/hayır/i, /kabul edilmez|alamazsınız|imkânı yoktur/i],
  },
  {
    name: 'Her çerçeve 25 mm mi? → Hayır (32 de var)',
    q: 'o zaman her çerçevenin profili 25 mm mi',
    mustInclude: [/hayır/i, /32/],
    mustNotInclude: [/hepsinin profil kalınlığı 25|hepsinin.*25 mm'dir|hepsi.*25 mm/i],
  },
  {
    name: '35 mm ürün sonrası 25 mm liste: eski panoyu pinleme',
    history: [
      { role: 'user', content: 'hangi ürünün kalınlığı 35 mmdir' },
      {
        role: 'assistant',
        content:
          '35 mm profil kalınlığında Ores Poster Swing - Su Depolu Kaldırım Reklam Panosu vardır.',
      },
    ],
    q: '25 mm kalınlığında ürünlerini incelemek istiyorum',
    mustInclude: [/25 mm/i, /\[\[URUN_KARTLARI\]\]/i],
    mustNotInclude: [/bulunmamaktadır|yalnızca 35|Poster Swing/i],
    minProductSources: 20,
  },
  {
    name: 'Her fiyatta olabilir: önceki 25 mm profilini koru',
    history: [
      { role: 'user', content: '25 mm kalınlığında ürünlerini incelemek istiyorum' },
      {
        role: 'assistant',
        content:
          '25 mm profil ürünlerinde fiyat sınırınıza uyan sonuç bulunamadı.',
      },
    ],
    q: 'her fiyatta olabilir',
    mustInclude: [/25 mm/i, /\[\[URUN_KARTLARI\]\]/i],
    mustNotInclude: [/bulunmamaktadır|yalnızca 35|Poster Swing/i],
    minProductSources: 20,
  },
  {
    name: 'Renk takip: kırmızı var mı (katalogda 3 adet)',
    history: [
      { role: 'user', content: 'afiş çerçevesi' },
      {
        role: 'assistant',
        content:
          'Afiş çerçevesi kategorisinde toplam 27 ürün bulunmaktadır. Listedeki ürünlerden ilgilendiğiniz bir model var mı?',
      },
    ],
    q: 'kırmızı renkte bir ürünün var mı',
    mustInclude: [/kırmızı/i, /\[\[URUN_KARTLARI\]\]/i],
    mustNotInclude: [/bulunmamaktadır|bulunmuyor|kırmızı.{0,30}yok/i],
    minProductSources: 3,
  },
  {
    name: 'Renk takip: pano konuşulduktan sonra kırmızı (pin yok)',
    history: [
      { role: 'user', content: 'kaldırım panosu' },
      {
        role: 'assistant',
        content:
          'Kaldırım Panosu kategorisinde 1 ürün var: Ores Poster Swing - Su Depolu Kaldırım Reklam Panosu, A1, 60x84 cm — 5310 TL.\n\n[[URUN_KARTLARI]]',
      },
      { role: 'user', content: 'afiş çerçevesi' },
      {
        role: 'assistant',
        content:
          'Afiş çerçevesi kategorisinde toplam 27 ürün bulunmaktadır.\n\n[[URUN_KARTLARI]]',
      },
    ],
    q: 'kırmızı renkte bir ürünün var mı',
    mustInclude: [/kırmızı/i, /\[\[URUN_KARTLARI\]\]/i],
    mustNotInclude: [/bulunmamaktadır|bulunmuyor|Poster Swing/i],
    minProductSources: 3,
    maxProductSources: 3,
  },
  {
    name: 'Ölçü takip: çerçeve sohbetinde A2 var mı (pin yok)',
    history: [
      { role: 'user', content: 'afiş çerçevesi' },
      {
        role: 'assistant',
        content:
          'Afiş çerçevesi kategorisinde toplam 27 ürün bulunmaktadır.\n\n[[URUN_KARTLARI]]',
      },
    ],
    q: 'A2 ölçüsünde ürün var mı',
    mustInclude: [/A2/i, /\[\[URUN_KARTLARI\]\]/i],
    mustNotInclude: [/bulunmamaktadır|bulunmuyor|Poster Swing/i],
    minProductSources: 1,
  },
  {
    name: 'Profil takip: pano sohbetinde 32 mm göster (pin yok)',
    history: [
      { role: 'user', content: 'kaldırım panosu' },
      {
        role: 'assistant',
        content:
          'Kaldırım Panosu kategorisinde 1 ürün var: Ores Poster Swing - Su Depolu Kaldırım Reklam Panosu — 5310 TL.\n\n[[URUN_KARTLARI]]',
      },
    ],
    q: '32 mm olanları göster',
    mustInclude: [/32 mm/i, /\[\[URUN_KARTLARI\]\]/i],
    mustNotInclude: [/bulunmamaktadır|Poster Swing/i],
    minProductSources: 2,
  },
  {
    name: 'Takip korunuyor: pano ağırlığı (yeni arama sanmasın)',
    history: [
      { role: 'user', content: 'kaldırım panosu' },
      {
        role: 'assistant',
        content:
          'Kaldırım Panosu kategorisinde 1 ürün var: Ores Poster Swing - Su Depolu Kaldırım Reklam Panosu — 5310 TL.\n\n[[URUN_KARTLARI]]',
      },
    ],
    q: 'bu ürünün ağırlığı ne kadar',
    mustInclude: [/16/, /Poster Swing/i],
    maxProductSources: 1,
  },
  {
    name: 'Gönye köşe filtresi: kartlara rondo karışmasın',
    q: 'gönye köşeli ürüne ihtiyacım var',
    mustInclude: [/gönye/i, /\[\[URUN_KARTLARI\]\]/i],
    minProductSources: 15,
    productTitlesMustInclude: [/gönye/i],
    productTitlesMustNotInclude: [/rondo/i],
  },
  {
    name: 'Köşe kriteri geçmişten taşınır (kategori ikinci turda)',
    history: [
      { role: 'user', content: 'gönye köşeli ürüne ihtiyacım var' },
      {
        role: 'assistant',
        content:
          'Gönye köşeli ürünlerimiz arasında "Afiş Çerçevesi" veya "Kaldırım Panosu" kategorilerinden birini tercih edebilirsiniz. Hangi kategoriyle ilgilendiğinizi belirtir misiniz?',
      },
    ],
    q: 'afiş çerçevesi',
    mustInclude: [/\[\[URUN_KARTLARI\]\]/i],
    minProductSources: 15,
    productTitlesMustNotInclude: [/rondo/i],
  },
  {
    name: 'Rondo köşe filtresi: gönye karışmasın',
    q: 'rondo köşeli çerçeveleri göster',
    mustInclude: [/rondo/i, /\[\[URUN_KARTLARI\]\]/i],
    minProductSources: 5,
    productTitlesMustInclude: [/rondo/i],
    productTitlesMustNotInclude: [/gönye/i],
  },
  {
    name: 'Hangi renkler var: katalog renk dökümü',
    history: [
      { role: 'user', content: 'afiş çerçevesi' },
      {
        role: 'assistant',
        content: 'Afiş çerçevesi kategorisinde toplam 27 ürün bulunmaktadır.',
      },
    ],
    q: 'hangi renkler var',
    mustInclude: [/gümüş/i, /siyah/i, /kırmızı/i, /kahverengi/i],
    mustNotInclude: [/genellikle|çeşitli renk|ürünleri incelemeniz/i],
  },
];

const email = `eval-prod-${Date.now()}@wed1ng.shop`;
const password = `Eval!${Date.now()}Aa1`;

async function adminFetch(path, options = {}) {
  const res = await fetch(`${url}/auth/v1${path}`, {
    ...options,
    headers: {
      apikey: service,
      Authorization: `Bearer ${service}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

function cookieHeader(session) {
  const ref = new URL(url).hostname.split('.')[0];
  const name = `sb-${ref}-auth-token`;
  const payload = {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_in: session.expires_in,
    expires_at: session.expires_at,
    token_type: session.token_type || 'bearer',
    user: session.user,
  };
  return `${name}=${encodeURIComponent(JSON.stringify(payload))}`;
}

function scoreReply(reply, testCase, sources) {
  const text = String(reply);
  const fails = [];
  for (const re of testCase.mustInclude || []) {
    if (!re.test(text)) fails.push(`missing: ${re}`);
  }
  for (const re of testCase.mustNotInclude || []) {
    if (re.test(text)) fails.push(`forbidden: ${re}`);
  }
  const productN = (Array.isArray(sources) ? sources : []).filter(
    (s) => s?.metadata?.type === 'product'
  ).length;
  if (typeof testCase.minProductSources === 'number') {
    if (productN < testCase.minProductSources) {
      fails.push(`productSources ${productN} < ${testCase.minProductSources}`);
    }
  }
  if (typeof testCase.maxProductSources === 'number') {
    if (productN > testCase.maxProductSources) {
      fails.push(`productSources ${productN} > ${testCase.maxProductSources}`);
    }
  }
  // Kart içeriği: metinde görünmeyen ürünler (örn. yanlış köşe tipi) için
  const titles = (Array.isArray(sources) ? sources : [])
    .filter((s) => s?.metadata?.type === 'product')
    .map((s) => String(s?.metadata?.title ?? ''));
  for (const re of testCase.productTitlesMustNotInclude || []) {
    const hit = titles.find((title) => re.test(title));
    if (hit) fails.push(`kartta yasak ürün (${re}): ${hit}`);
  }
  for (const re of testCase.productTitlesMustInclude || []) {
    if (!titles.some((title) => re.test(title))) {
      fails.push(`kartta eksik ürün: ${re}`);
    }
  }
  return fails;
}

// Tek bir vakayı hızlı yeniden çalıştırmak için: node scripts/... "stok 0"
const onlyPattern = process.argv.slice(2).find((arg) => !arg.startsWith('-')) || process.env.EVAL_ONLY || '';
const SELECTED = onlyPattern
  ? CASES.filter((testCase) => new RegExp(onlyPattern, 'i').test(testCase.name))
  : CASES;

async function main() {
  if (SELECTED.length === 0) {
    console.error(`"${onlyPattern}" ile eşleşen vaka yok.`);
    process.exit(1);
  }
  const created = await adminFetch('/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!created.res.ok) {
    console.error('createUser:', created.res.status, created.body);
    process.exit(1);
  }
  const userId = created.body.id;
  let passed = 0;
  const failures = [];

  try {
    const signedRes = await fetch(`${url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: anon, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const session = await signedRes.json();
    if (!signedRes.ok || !session.access_token) {
      console.error('signIn:', signedRes.status, session);
      process.exit(1);
    }
    const cookie = cookieHeader(session);

    for (let i = 0; i < SELECTED.length; i++) {
      const testCase = SELECTED[i];
      console.log(`\n========== ${i + 1}/${SELECTED.length} ${testCase.name} ==========`);
      const res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          message: testCase.q,
          history: Array.isArray(testCase.history) ? testCase.history : [],
        }),
      });
      const text = await res.text();
      let reply = text;
      let sources = [];
      try {
        const json = JSON.parse(text);
        reply = json.reply ?? json.message ?? json.error ?? text;
        sources = json.sources ?? [];
        if (json.error && json.reply == null) reply = `ERROR: ${json.error}`;
      } catch {
        /* raw */
      }
      console.log(
        process.env.EVAL_VERBOSE === '1'
          ? `HTTP ${res.status}\n${reply}`
          : `HTTP ${res.status} | ${String(reply).replace(/\s+/g, ' ').slice(0, 320)}`
      );
      const fails =
        res.status !== 200 ? [`HTTP ${res.status}`] : scoreReply(reply, testCase, sources);
      if (fails.length === 0) {
        console.log('✅ PASS');
        passed += 1;
      } else {
        console.log(`❌ FAIL: ${fails.join('; ')}`);
        failures.push({ name: testCase.name, fails, reply: String(reply) });
      }
      // Rate-limit nefes
      await new Promise((r) => setTimeout(r, 800));
    }

    console.log(`\n===== ÖZET: ${passed}/${SELECTED.length} PASS =====`);
    if (failures.length) {
      console.log('\n===== FAIL DETAY =====');
      for (const f of failures) {
        console.log(`\n## ${f.name}\n${f.fails.join('\n')}\n${f.reply.slice(0, 700)}`);
      }
    }
    if (process.env.EVAL_JSON === '1') {
      console.log('\n__EVAL_JSON__' + JSON.stringify({ passed, total: SELECTED.length, failures }));
    }
    if (passed < SELECTED.length) process.exitCode = 1;
  } finally {
    await adminFetch(`/admin/users/${userId}`, { method: 'DELETE' });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
