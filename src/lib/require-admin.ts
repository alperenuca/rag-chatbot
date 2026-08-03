import { NextResponse } from 'next/server';
import type { User } from '@supabase/supabase-js';
import { isAdminEmail } from '@/lib/admin';
import { createClient } from '@/lib/supabase/server';

type RequireAdminResult =
  | { user: User; error: null }
  | { user: null; error: NextResponse };

/**
 * Oturum + ADMIN_EMAILS kontrolü. Başarısızsa 401/403 JSON response döner.
 * Yalnızca Route Handler / Server Component'te kullanın.
 */
export async function requireAdmin(): Promise<RequireAdminResult> {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    return {
      user: null,
      error: NextResponse.json({ error: 'Oturum gerekli.' }, { status: 401 }),
    };
  }

  if (!isAdminEmail(user.email)) {
    return {
      user: null,
      error: NextResponse.json({ error: 'Bu işlem için yetkiniz yok.' }, { status: 403 }),
    };
  }

  return { user, error: null };
}
