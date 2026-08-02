import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

/**
 * Server Component, Route Handler ve Server Action'larda kullanılacak
 * Supabase istemcisi. İstek çerezlerinden oturumu okur; oturum yenilenirse
 * güncel çerezleri geri yazmaya çalışır (Server Component içinden çağrıldığında
 * çerez yazımı mümkün olmadığından proxy.ts bu işi devralır).
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Server Component içinden çağrıldıysa cookie set edilemez;
            // oturum yenilemesi proxy.ts tarafından ele alınır.
          }
        },
      },
    }
  );
}
