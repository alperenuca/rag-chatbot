import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * Open redirect engeli: yalnız aynı-origin relative path'lere izin ver.
 * `https://evil.com`, `//evil.com`, `/\evil.com` vb. reddedilir.
 */
function safeNextPath(raw: string | null): string {
  if (!raw) return '/';
  // Absolute / protocol-relative URL'leri engelle
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) {
    return '/';
  }
  // Query/hash içeren relative path'ler OK (örn. /?tab=1), ama şema kaçışı olmasın
  try {
    const parsed = new URL(raw, 'http://local.invalid');
    if (parsed.origin !== 'http://local.invalid') return '/';
    return `${parsed.pathname}${parsed.search}${parsed.hash}` || '/';
  } catch {
    return '/';
  }
}

/**
 * Supabase e-posta doğrulama / magic link dönüş noktası.
 * Kullanıcı maildeki linke tıklayınca `code` query param ile buraya gelir;
 * kod session cookie'lerine çevrilir ve ana sayfaya yönlendirilir.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const next = safeNextPath(searchParams.get('next'));

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      return NextResponse.redirect(new URL(next, origin));
    }

    const loginUrl = new URL('/', origin);
    loginUrl.searchParams.set('authError', 'email_confirm_failed');
    return NextResponse.redirect(loginUrl);
  }

  const loginUrl = new URL('/', origin);
  loginUrl.searchParams.set('authError', 'missing_code');
  return NextResponse.redirect(loginUrl);
}
