/**
 * Yerel chat API'ye 5 zor soru atar (geçici test kullanıcısı + oturum çerezi).
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

const QUESTIONS = [
  // AB cayma / kişisel taşıma tuzağı
  "Almanya'da yaşıyorum. Türkiye'deki bir tanıdığım sizin siteden sipariş verip ürünleri Almanya'ya getirecek. Bu durumda AB'nin 14 günlük gerekçesiz cayma hakkım var mı?",
  // Çocuk verisi / ebeveyn silme
  "15 yaşındaki oğlum sizin sitenizden alışveriş yapmak için kendi adıyla hesap açıp kişisel verilerini girmiş. Bir ebeveyn olarak oğlumun tüm verilerinin silinmesini talep ediyorum.",
  // Yanlış iade adresi (Kağıthane ≠ Sakarya) + para iadesi
  "İade edeceğim ürünü ORES'in Kağıthane/İstanbul'daki merkez adresinize kargoladım. Kargo teslim alınmış görünüyor, para iadem ne zaman yapılacak?",
  // Kapıda nakit / IBAN tuzağı
  'Kapıda nakit ödeme yapabilir miyim? Yoksa sadece IBAN ile mi ödeme alıyorsunuz?',
  // Acil sipariş / mesai dışı telefon
  'Saat 21:00, siparişimi acil değiştirmek istiyorum ama telefon açılmıyor. Ne yapmalıyım, hemen iade edip yeni sipariş mi vereyim?',
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
    const results = [];

    for (let i = 0; i < QUESTIONS.length; i++) {
      const message = QUESTIONS[i];
      console.log(`\n========== Q${i + 1} ==========\n${message}\n`);
      const res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({ message, history: [] }),
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
      results.push({ q: message, status: res.status, reply });
    }

    console.log('\n===== ÖZET =====');
    results.forEach((r, i) => {
      const short = String(r.reply).replace(/\s+/g, ' ').slice(0, 200);
      console.log(`${i + 1}. [${r.status}] ${short}`);
    });
  } finally {
    await adminFetch(`/admin/users/${userId}`, { method: 'DELETE' });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
