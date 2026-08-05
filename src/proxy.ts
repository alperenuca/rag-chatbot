import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Next.js bu sürümde `middleware.ts` dosya kuralını `proxy.ts` olarak yeniden
 * adlandırdı (bkz. node_modules/next/dist/docs .../proxy.md). Supabase'in
 * oturum yenileme (refresh token) mantığı klasik middleware ile aynı şekilde
 * çalışır, sadece dosya/fonksiyon adı `proxy` olarak değişti.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Oturumu her istekte tazele; süresi dolan access token varsa burada yenilenir.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Yasaklı kullanıcıyı oturumdan düşür (admin ban sonrası aktif JWT kalsın diye).
  const bannedUntil = (user as { banned_until?: string | null } | null)?.banned_until;
  if (bannedUntil && new Date(bannedUntil).getTime() > Date.now()) {
    await supabase.auth.signOut();
    const transferCookies = (target: NextResponse) => {
      for (const cookie of response.cookies.getAll()) {
        target.cookies.set(cookie.name, cookie.value);
      }
      return target;
    };

    if (request.nextUrl.pathname.startsWith('/api/')) {
      return transferCookies(
        NextResponse.json(
          { error: 'Hesabınız yasaklandı. Destek için iletişime geçin.' },
          { status: 403 }
        )
      );
    }
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = '/';
    redirectUrl.search = '';
    return transferCookies(NextResponse.redirect(redirectUrl));
  }

  return response;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
