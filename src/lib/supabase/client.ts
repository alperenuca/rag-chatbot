import { createBrowserClient } from '@supabase/ssr';

/**
 * Client Component'lerde kullanılacak Supabase istemcisi.
 * Oturum bilgisini otomatik olarak çerezlerde (cookie) tutar,
 * böylece sunucu tarafı (Route Handler, proxy) aynı oturumu okuyabilir.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
