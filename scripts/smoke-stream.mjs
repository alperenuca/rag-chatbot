/**
 * Streaming SSE duman testi: node scripts/smoke-stream.mjs
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

const email = `stream-smoke-${Date.now()}@wed1ng.shop`;
const password = `Stream!${Date.now()}Aa1`;

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

const created = await adminFetch('/admin/users', {
  method: 'POST',
  body: JSON.stringify({ email, password, email_confirm: true }),
});
if (!created.res.ok) {
  console.error('createUser', created.res.status, created.body);
  process.exit(1);
}

const signedRes = await fetch(`${url}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: anon, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
const session = await signedRes.json();
if (!signedRes.ok || !session.access_token) {
  console.error('signIn', session);
  process.exit(1);
}

const res = await fetch(`${base}/api/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(session) },
  body: JSON.stringify({
    message: 'sepetimde 800 tl var kargo ücreti öder miyim',
    history: [],
    stream: true,
  }),
});

const ct = res.headers.get('content-type') || '';
console.log('HTTP', res.status, ct);
if (!res.ok || !ct.includes('text/event-stream')) {
  console.error(await res.text());
  process.exit(1);
}

const text = await res.text();
const hasMeta = /event:\s*meta/.test(text);
const hasDelta = /event:\s*delta/.test(text);
const hasDone = /event:\s*done/.test(text);
const deltaCount = (text.match(/event:\s*delta/g) || []).length;
console.log({ hasMeta, hasDelta, hasDone, deltaCount });
console.log('--- sample ---\n', text.slice(0, 500));
if (!hasMeta || !hasDelta || !hasDone) process.exit(1);
console.log('✅ stream smoke PASS');

if (session.user?.id) {
  await adminFetch(`/admin/users/${session.user.id}`, { method: 'DELETE' });
}
