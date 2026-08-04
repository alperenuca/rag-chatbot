/**
 * Yerel chat API'ye zor politika soruları atar ve otomatik skorlar.
 * Kullanım: node scripts/eval-hard-questions.mjs
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
  {
    name: 'AB cayma / kişisel taşıma',
    q: "Almanya'da yaşıyorum. Türkiye'deki bir tanıdığım sizin siteden sipariş verip ürünleri Almanya'ya getirecek. Bu durumda AB'nin 14 günlük gerekçesiz cayma hakkım var mı?",
    mustInclude: [/yurt\s*d[iı][sş]|t[uü]rkiye|teslimat/i],
    mustNotInclude: [/evet.*cayma|almanya.*hakk[ıi]n[ıi]z var/i],
  },
  {
    name: 'Çocuk verisi §6.8',
    q: '15 yaşındaki oğlum sizin sitenizden alışveriş yapmak için kendi adıyla hesap açıp kişisel verilerini girmiş. Bir ebeveyn olarak oğlumun tüm verilerinin silinmesini talep ediyorum.',
    mustInclude: [/iletisim@ores\.com\.tr|çocuk|16\s*ya[sş]/i],
    mustNotInclude: [/an[ıi]nda sildik|chat üzerinden sild/i],
  },
  {
    name: 'Yanlış iade adresi Kağıthane',
    q: "İade edeceğim ürünü ORES'in Kağıthane/İstanbul'daki merkez adresinize kargoladım. Kargo teslim alınmış görünüyor, para iadem ne zaman yapılacak?",
    mustInclude: [/sakarya|arifiye/i],
    // "Kağıthane iade adresi değildir" doğru; yalnızca adresi doğruymuş gibi sunmayı yakala
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
    mustNotInclude: [/önce.*iade ed|iade edip yeni sipari[sş]/i],
  },
  {
    name: 'Kısmi iade + ücretsiz kargo kesintisi',
    q: 'İki ürün aldım, her biri 500 TL, toplam 1000 TL; kargo ücretsizdi. Birini (500 TL) e-posta onayıyla Sakarya adresinize iade ettim. Şimdi diyorlar ki 500 TL iademden kargo ücretini kesecekler. Bu doğru mu, yasal mı? Kalan ürün için yeni fatura kesilecek mi? Para iadem ne zaman?',
    mustInclude: [/750|iletisim@ores\.com\.tr|10\s*i[sş]\s*g[uü]n/i],
    mustNotInclude: [
      /kesilmez|kesilmemeli|kesinlikle.*kesil|yasal de[gğ]il|yasal[ıi]r|yeni fatura kesilir/i,
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
    mustNotInclude: [/evet.*14\s*g[uü]n.*iade edebilir/i],
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
      console.log(`\n========== ${i + 1}. ${testCase.name} ==========\n${testCase.q}\n`);
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
      console.log(`HTTP ${res.status}\n${reply}\n`);
      const fails = res.status !== 200 ? [`HTTP ${res.status}`] : scoreReply(reply, testCase);
      if (fails.length === 0) {
        console.log('✅ PASS');
        passed += 1;
      } else {
        console.log(`❌ FAIL: ${fails.join('; ')}`);
      }
    }

    console.log(`\n===== ÖZET: ${passed}/${CASES.length} PASS =====`);
    if (passed < CASES.length) process.exitCode = 1;
  } finally {
    await adminFetch(`/admin/users/${userId}`, { method: 'DELETE' });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
