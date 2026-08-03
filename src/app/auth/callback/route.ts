import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * Supabase e-posta doğrulama / magic link dönüş noktası.
 * Kullanıcı maildeki linke tıklayınca `code` query param ile buraya gelir;
 * kod session cookie'lerine çevrilir ve ana sayfaya yönlendirilir.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const next = searchParams.get('next') ?? '/';

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
