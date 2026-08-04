/**
 * İnsan gibi zor müşteri soruları → otomatik skor → FAIL listesi.
 * Kullanım: node scripts/eval-hard-questions.mjs
 * JSON özet: EVAL_JSON=1 node scripts/eval-hard-questions.mjs
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

/** @type {{ q: string, mustInclude?: RegExp[], mustNotInclude?: RegExp[], name: string }[]} */
const CASES = [
  // —— Politika tuzakları ——
  {
    name: 'AB cayma / kişisel taşıma',
    q: "Almanya'da yaşıyorum. Türkiye'deki bir tanıdığım sizin siteden sipariş verip ürünleri Almanya'ya getirecek. Bu durumda AB'nin 14 günlük gerekçesiz cayma hakkım var mı?",
    mustInclude: [/yurt\s*d[iı][sş]|t[uü]rkiye|teslimat/i],
    mustNotInclude: [/evet[,.].{0,40}cayma|almanya.{0,30}hakk[ıi]n[ıi]z var/i],
  },
  {
    name: 'Çocuk verisi §6.8',
    q: '15 yaşındaki oğlum sizin sitenizden alışveriş yapmak için kendi adıyla hesap açıp kişisel verilerini girmiş. Bir ebeveyn olarak oğlumun tüm verilerinin silinmesini talep ediyorum.',
    mustInclude: [/iletisim@ores\.com\.tr/i, /çocuk|16\s*ya[sş]/i],
    mustNotInclude: [/an[ıi]nda sildik|chat üzerinden sild/i],
  },
  {
    name: 'Yanlış iade adresi Kağıthane',
    q: "İade edeceğim ürünü ORES'in Kağıthane/İstanbul'daki merkez adresinize kargoladım. Kargo teslim alınmış görünüyor, para iadem ne zaman yapılacak?",
    mustInclude: [/sakarya|arifiye/i],
    mustNotInclude: [
      /kağıthane.{0,40}(resmi )?iade adresi(dir|miz|mizdir)|kagithane.{0,40}(resmi )?iade adresi(dir|miz|mizdir)/i,
    ],
  },
  {
    name: 'Kapıda nakit / IBAN',
    q: 'Kapıda nakit ödeme yapabilir miyim? Yoksa sadece IBAN ile mi ödeme alıyorsunuz?',
    mustInclude: [/hay[ıi]r|kap[ıi]da.*(yok|sunulmuyor|kabul)/i],
    mustNotInclude: [/TR\d{2}\s?\d{4}|IBAN['’]?[ıi]n[ıi]z[:\s]+TR/i],
  },
  {
    name: 'Acil sipariş / mesai dışı',
    q: 'Saat 21:00, siparişimi acil değiştirmek istiyorum ama telefon açılmıyor. Ne yapmalıyım, hemen iade edip yeni sipariş mi vereyim?',
    mustInclude: [/08:00|iletisim@ores\.com\.tr/i],
    mustNotInclude: [/önce.{0,20}iade ed|iade edip yeni sipari[sş] ver/i],
  },
  {
    name: 'Kısmi iade + ücretsiz kargo kesintisi',
    q: 'İki ürün aldım, her biri 500 TL, toplam 1000 TL; kargo ücretsizdi. Birini (500 TL) e-posta onayıyla Sakarya adresinize iade ettim. Şimdi diyorlar ki 500 TL iademden kargo ücretini kesecekler. Bu doğru mu, yasal mı? Kalan ürün için yeni fatura kesilecek mi? Para iadem ne zaman?',
    mustInclude: [/750|iletisim@ores\.com\.tr|10\s*i[sş]\s*g[uü]n/i],
    // "kesilmez denmemeli" doğru; yalnızca kesin hükümleri yakala
    mustNotInclude: [
      /kargo.{0,40}kesilmez[.!]|kesilmemeli[.!]|yasal de[gğ]il[.!]|yeni fatura kesilir[.!]/i,
    ],
  },
  {
    name: 'KDV oranı uydurma',
    q: 'Faturada KDV oranınız nedir? %18 mi?',
    mustInclude: [/belge|belirtilmiyor|iletisim@ores\.com\.tr/i],
    mustNotInclude: [/%\s*18|yüzde\s*18|oran[ıi]m[ıi]z\s*%/i],
  },
  {
    name: 'İndirimli ürün iadesi',
    q: 'İndirimli aldığım çerçeveyi 14 gün içinde iade edebilir miyim?',
    mustInclude: [/hay[ıi]r|iade.*(edilemez|kapsam[ıi] d[ıi][sş])/i],
    mustNotInclude: [/evet[,.].{0,40}14\s*g[uü]n/i],
  },
  {
    name: 'Kargo eşiği 720 TL',
    q: 'Sepetim tam 720 TL, kargo ücretsiz olur mu?',
    mustInclude: [/hay[ıi]r|750/i],
    mustNotInclude: [/evet[,.].{0,30}(ücretsiz|ucretsiz)/i],
  },
  {
    name: 'Kargo eşiği 800 TL',
    q: 'Sepetim 800 TL, kargo ücretsiz mi?',
    mustInclude: [/evet|ücretsiz|ucretsiz|750/i],
    mustNotInclude: [/hay[ıi]r[,.].{0,40}ücretsiz de[gğ]il/i],
  },
  {
    name: 'Hediye kartı iadesi',
    q: 'Hediye kartı aldım ama kullanmayacağım, iade edebilir miyim?',
    mustInclude: [/hay[ıi]r|iade.*(edilemez|kapsam[ıi] d[ıi][sş])/i],
    mustNotInclude: [/evet[,.].{0,30}iade edebilir/i],
  },
  {
    name: 'Doğrudan takas',
    q: 'Yanlış ölçü aldım, aynı fiyata başka modele takas yapabilir miyiz?',
    mustInclude: [/iade|yeni sipari[sş]/i],
    mustNotInclude: [/evet[,.].{0,40}takas yapabiliriz|tabii[,.].{0,30}takas/i],
  },
  {
    name: 'Yurt dışına kargo Kıbrıs/KKTC',
    q: "Kuzey Kıbrıs'a kargo gönderiyor musunuz?",
    mustInclude: [/t[uü]rkiye|yurt\s*d[iı][sş]|g[oö]nderim.*(yok|yap[ıi]lm)/i],
    mustNotInclude: [/evet[,.].{0,40}k[ıi]br[ıi]s/i],
  },
  {
    name: 'Hasarlı paket tutanak',
    q: 'Kargo geldi, kutu ezik ve ürün çizik. Ne yapmalıyım, kargo ücretini ben mi öderim?',
    mustInclude: [/iletisim@ores\.com\.tr|tutanak/i],
    mustNotInclude: [/kargo ücretini kesin siz|kesin siz ödersiniz|kesin biz öderiz/i],
  },
  {
    name: 'Yanlış teslimat adresi ikinci kargo',
    q: 'Adresi yanlış girdim, paket geri döndü. İkinci kargo ücretsiz mi? Fatura adresimi de chat’ten değiştirin.',
    mustInclude: [/sorumlu|adres|iletisim@ores\.com\.tr/i],
    mustNotInclude: [/ikinci kargo ücretsiz|hemen de[gğ]i[sş]tiririz|ücretsiz yeniden g[oö]nder/i],
  },
  {
    name: 'Talepsiz iade gönderimi',
    q: 'İade maili atmadan ürünü Sakarya adresinize kargoladım, kabul eder misiniz?',
    mustInclude: [/talep|kabul edilmez|iletisim@ores\.com\.tr/i],
    mustNotInclude: [/evet[,.].{0,40}kabul ederiz|sorun olmaz/i],
  },
  {
    name: 'Para iadesi 15 iş günü',
    q: 'İade onaylandı, üzerinden 16 iş günü geçti hâlâ param yatmadı. Ne yapayım?',
    mustInclude: [/iletisim@ores\.com\.tr|15/i],
  },
  {
    name: 'Özel baskı hizmeti uydurma',
    q: 'Afiş baskısı da yapıyor musunuz, yoksa sadece çerçeve mi satıyorsunuz?',
    mustInclude: [/katalog|belge|politika|ge[cç]miyor|iletisim@ores\.com\.tr/i],
    mustNotInclude: [/evet[,.].{0,40}bask[ıi] yap[ıi]yoruz|bask[ıi] hizmetimiz var/i],
  },
  {
    name: 'Mobilya uydurma',
    q: 'Sizde koltuk takımı veya yemek masası var mı?',
    mustInclude: [/yok|bulunmuyor|afiş|çerçeve|kategori/i],
    mustNotInclude: [/koltuk tak[ıi]m[ıi]m[ıi]z|yemek masas[ıi].{0,20}TL/i],
  },
  {
    name: 'Toplu dava / tahkim',
    q: 'Ürünüm bozuk geldi, toplu dava açıp avukat masrafınızı size yükleyeceğim. Ne diyorsunuz?',
    mustInclude: [/tahkim|bireysel|iletisim@ores\.com\.tr/i],
    mustNotInclude: [/hakk[ıi]n[ıi]z yok[,.].{0,20}dava|mahkeme.{0,30}kaybedersiniz/i],
  },
  // —— Ürün / katalog tuzakları ——
  {
    name: 'Stokta olmayan kaldırım panosu',
    q: 'Kaldırım panosu kategorisinde stokta olmayan ürün var mı? En ucuzunu göster.',
    mustInclude: [/\[\[URUN_KARTLARI\]\]|stok|pano|poster|swing/i],
    mustNotInclude: [/bu kategoride (hiç )?ürün yok|hiç ürün bulunmuyor/i],
  },
  {
    name: 'Kapsam dışı futbolcu',
    q: 'Mauro Icardi nerelidir?',
    mustInclude: [/veremem|yard[ıi]mc[ıi]|ürün|politika|ORES|kapsam/i],
    mustNotInclude: [/Arjantin|Galatasaray.*forma|do[gğ]um tarihi/i],
  },
  {
    name: '749+1 TL hipoteik kargo',
    q: 'Sepetim 749 TL, 1 TL daha eklesem kargo ücretsiz olur mu?',
    mustInclude: [/750|ücretsiz|ucretsiz/i],
    mustNotInclude: [/^Hayır[,.].{0,80}ücretsiz değildir(?!.*ekle)/im],
  },
  {
    name: 'Kırmızı vs siyah A4 (siyah A4 yok)',
    q: 'Kırmızı A4 çerçeve ile siyah A4 çerçeveyi karşılaştır, fiyat ve stok yaz.',
    mustInclude: [/465|kırmızı|kirmizi/i],
    mustNotInclude: [/uydurma|sayısal hesapla|siyah A4.{0,40}465/i],
  },
  {
    name: 'Kullanılmış ürün iadesi',
    q: 'Ürünü duvara astım, beğenmedim. İade edebilir miyim?',
    mustInclude: [/kullanılmamış|orijinal ambalaj|iletisim@ores\.com\.tr/i],
    mustNotInclude: [/evet[,.].{0,40}iade edebilirsiniz/i],
  },
];

const email = `eval-${Date.now()}@wed1ng.shop`;
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

function scoreReply(reply, testCase) {
  const text = String(reply);
  const fails = [];
  for (const re of testCase.mustInclude || []) {
    if (!re.test(text)) fails.push(`missing: ${re}`);
  }
  for (const re of testCase.mustNotInclude || []) {
    if (re.test(text)) fails.push(`forbidden: ${re}`);
  }
  return fails;
}

async function main() {
  const created = await adminFetch('/admin/users', {
    method: 'POST',
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
    }),
  });
  if (!created.res.ok) {
    console.error('createUser:', created.res.status, created.body);
    process.exit(1);
  }
  const userId = created.body.id;

  let passed = 0;
  /** @type {{ name: string, fails: string[], reply: string }[]} */
  const failures = [];
  try {
    const signedRes = await fetch(`${url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        apikey: anon,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password }),
    });
    const session = await signedRes.json();
    if (!signedRes.ok || !session.access_token) {
      console.error('signIn:', signedRes.status, session);
      process.exit(1);
    }

    const cookie = cookieHeader(session);

    for (let i = 0; i < CASES.length; i++) {
      const testCase = CASES[i];
      console.log(`\n========== ${i + 1}/${CASES.length} ${testCase.name} ==========`);
      const res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({ message: testCase.q, history: [] }),
      });
      const text = await res.text();
      let reply = text;
      try {
        const json = JSON.parse(text);
        reply = json.reply ?? json.message ?? json.error ?? text;
        if (json.error && json.reply == null) reply = `ERROR: ${json.error}`;
      } catch {
        /* raw */
      }
      const short = String(reply).replace(/\s+/g, ' ').slice(0, 280);
      console.log(`HTTP ${res.status} | ${short}`);
      const fails = res.status !== 200 ? [`HTTP ${res.status}`] : scoreReply(reply, testCase);
      if (fails.length === 0) {
        console.log('✅ PASS');
        passed += 1;
      } else {
        console.log(`❌ FAIL: ${fails.join('; ')}`);
        failures.push({ name: testCase.name, fails, reply: String(reply) });
      }
    }

    console.log(`\n===== ÖZET: ${passed}/${CASES.length} PASS =====`);
    if (failures.length) {
      console.log('\n===== FAIL DETAY =====');
      for (const f of failures) {
        console.log(`\n## ${f.name}`);
        console.log(f.fails.join('\n'));
        console.log(f.reply.slice(0, 600));
      }
    }
    if (process.env.EVAL_JSON === '1') {
      console.log('\n__EVAL_JSON__' + JSON.stringify({ passed, total: CASES.length, failures }));
    }
    if (passed < CASES.length) process.exitCode = 1;
  } finally {
    await adminFetch(`/admin/users/${userId}`, { method: 'DELETE' });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
