import { NextRequest, NextResponse } from 'next/server';
import {
  isAdminEmail,
  isCurrentlyBanned,
  PERMANENT_BAN_DURATION,
  type AdminActivitySummary,
  type AdminFunnel,
  type AdminUserRow,
} from '@/lib/admin';
import { requireAdmin } from '@/lib/require-admin';
import { createAdminClient } from '@/lib/supabase/admin';

type ActivityAgg = {
  conversation_count: number;
  message_count: number;
  last_activity_at: string | null;
};

function maxIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

function rate(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

async function loadActivityByUser(
  admin: ReturnType<typeof createAdminClient>
): Promise<{
  byUser: Map<string, ActivityAgg>;
  totalConversations: number;
  totalMessages: number;
}> {
  const byUser = new Map<string, ActivityAgg>();

  const ensure = (userId: string): ActivityAgg => {
    let row = byUser.get(userId);
    if (!row) {
      row = { conversation_count: 0, message_count: 0, last_activity_at: null };
      byUser.set(userId, row);
    }
    return row;
  };

  // Service role RLS'i bypass eder; tüm kullanıcı aktivitesini okuyabiliriz.
  const { data: conversations, error: convError } = await admin
    .from('conversations')
    .select('user_id, updated_at, created_at');

  if (convError) {
    console.error('admin conversations aggregate:', convError);
    throw new Error('Sohbet istatistikleri alınamadı.');
  }

  for (const row of conversations ?? []) {
    const userId = row.user_id as string;
    const agg = ensure(userId);
    agg.conversation_count += 1;
    const ts = (row.updated_at as string | null) || (row.created_at as string | null);
    agg.last_activity_at = maxIso(agg.last_activity_at, ts);
  }

  const { data: messages, error: msgError } = await admin
    .from('messages')
    .select('user_id, created_at, role');

  if (msgError) {
    console.error('admin messages aggregate:', msgError);
    throw new Error('Mesaj istatistikleri alınamadı.');
  }

  let totalMessages = 0;
  for (const row of messages ?? []) {
    totalMessages += 1;
    const userId = row.user_id as string;
    const agg = ensure(userId);
    // Kullanıcı mesajlarını "etkileşim" olarak say; asistan yanıtlarını da aktivite zamanına dahil et.
    if (row.role === 'user') {
      agg.message_count += 1;
    }
    agg.last_activity_at = maxIso(agg.last_activity_at, row.created_at as string | null);
  }

  return {
    byUser,
    totalConversations: conversations?.length ?? 0,
    totalMessages,
  };
}

/**
 * Admin: kayıtlı Auth kullanıcılarını listeler (service role).
 * Query: page (1-based), perPage (max 100), q (e-posta/ad arama), status (all|confirmed|unconfirmed)
 */
export async function GET(request: NextRequest) {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;

  const { searchParams } = request.nextUrl;
  const page = Math.max(1, Number(searchParams.get('page') || '1') || 1);
  const perPage = Math.min(100, Math.max(1, Number(searchParams.get('perPage') || '50') || 50));
  const q = (searchParams.get('q') || '').trim().toLowerCase();
  const status = (searchParams.get('status') || 'all').toLowerCase();

  try {
    const admin = createAdminClient();
    const activity = await loadActivityByUser(admin);

    const allUsers: AdminUserRow[] = [];
    let listPage = 1;
    const listPerPage = 100;
    const maxPages = 20;

    while (listPage <= maxPages) {
      const { data, error } = await admin.auth.admin.listUsers({
        page: listPage,
        perPage: listPerPage,
      });

      if (error) {
        console.error('admin.listUsers error:', error);
        return NextResponse.json(
          { error: 'Kullanıcı listesi alınamadı.' },
          { status: 500 }
        );
      }

      const batch = data.users ?? [];
      for (const u of batch) {
        const fullName =
          typeof u.user_metadata?.full_name === 'string'
            ? u.user_metadata.full_name.trim() || null
            : null;
        const agg = activity.byUser.get(u.id) ?? {
          conversation_count: 0,
          message_count: 0,
          last_activity_at: null,
        };

        allUsers.push({
          id: u.id,
          email: u.email ?? null,
          full_name: fullName,
          email_confirmed_at: u.email_confirmed_at ?? null,
          created_at: u.created_at,
          last_sign_in_at: u.last_sign_in_at ?? null,
          banned_until: (u as { banned_until?: string | null }).banned_until ?? null,
          conversation_count: agg.conversation_count,
          message_count: agg.message_count,
          last_activity_at: agg.last_activity_at,
        });
      }

      if (batch.length < listPerPage) break;
      listPage += 1;
    }

    const confirmed = allUsers.filter((u) => Boolean(u.email_confirmed_at)).length;
    const unconfirmed = allUsers.length - confirmed;
    const chatted = allUsers.filter((u) => u.message_count > 0 || u.conversation_count > 0).length;

    const now = Date.now();
    const ms7 = 7 * 24 * 60 * 60 * 1000;
    const ms30 = 30 * 24 * 60 * 60 * 1000;
    const active_7d = allUsers.filter((u) => {
      if (!u.last_activity_at) return false;
      return now - new Date(u.last_activity_at).getTime() <= ms7;
    }).length;
    const active_30d = allUsers.filter((u) => {
      if (!u.last_activity_at) return false;
      return now - new Date(u.last_activity_at).getTime() <= ms30;
    }).length;

    const funnel: AdminFunnel = {
      signed_up: allUsers.length,
      confirmed,
      chatted,
      confirm_rate: rate(confirmed, allUsers.length),
      // Doğrulanmışlar içinde en az bir sohbet/mesajı olanlar
      chat_rate: rate(chatted, confirmed > 0 ? confirmed : allUsers.length),
    };

    const activitySummary: AdminActivitySummary = {
      active_7d,
      active_30d,
      total_conversations: activity.totalConversations,
      total_messages: activity.totalMessages,
    };

    let filtered = allUsers;

    if (status === 'confirmed') {
      filtered = filtered.filter((u) => Boolean(u.email_confirmed_at));
    } else if (status === 'unconfirmed') {
      filtered = filtered.filter((u) => !u.email_confirmed_at);
    } else if (status === 'active') {
      filtered = filtered.filter((u) => {
        if (!u.last_activity_at) return false;
        return now - new Date(u.last_activity_at).getTime() <= ms7;
      });
    } else if (status === 'no_chat') {
      filtered = filtered.filter(
        (u) => Boolean(u.email_confirmed_at) && u.message_count === 0 && u.conversation_count === 0
      );
    } else if (status === 'banned') {
      filtered = filtered.filter((u) => isCurrentlyBanned(u.banned_until));
    }

    if (q) {
      filtered = filtered.filter((u) => {
        const email = (u.email || '').toLowerCase();
        const name = (u.full_name || '').toLowerCase();
        return email.includes(q) || name.includes(q);
      });
    }

    filtered.sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );

    const totalFiltered = filtered.length;
    const start = (page - 1) * perPage;
    const users = filtered.slice(start, start + perPage);

    return NextResponse.json({
      users,
      page,
      perPage,
      totalFiltered,
      totalPages: Math.max(1, Math.ceil(totalFiltered / perPage)),
      counts: {
        total: allUsers.length,
        confirmed,
        unconfirmed,
      },
      funnel,
      activity: activitySummary,
    });
  } catch (err) {
    console.error('GET /api/admin/users:', err);
    const message = err instanceof Error ? err.message : 'Sunucu hatası.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Admin: kullanıcıyı yasakla / yasağı kaldır.
 * Body: { userId: string, action: 'ban' | 'unban' }
 */
export async function PATCH(request: NextRequest) {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;

  let body: { userId?: unknown; action?: unknown };
  try {
    body = (await request.json()) as { userId?: unknown; action?: unknown };
  } catch {
    return NextResponse.json({ error: 'Geçersiz istek gövdesi.' }, { status: 400 });
  }

  const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
  const action = body.action === 'ban' || body.action === 'unban' ? body.action : null;

  if (!userId || !action) {
    return NextResponse.json(
      { error: 'userId ve action (ban|unban) gerekli.' },
      { status: 400 }
    );
  }

  if (userId === gate.user.id) {
    return NextResponse.json(
      { error: 'Kendi hesabınızı yasaklayamazsınız.' },
      { status: 400 }
    );
  }

  try {
    const admin = createAdminClient();
    const { data: targetData, error: getError } = await admin.auth.admin.getUserById(
      userId
    );

    if (getError || !targetData.user) {
      return NextResponse.json({ error: 'Kullanıcı bulunamadı.' }, { status: 404 });
    }

    if (isAdminEmail(targetData.user.email)) {
      return NextResponse.json(
        { error: 'Yönetici hesapları yasaklanamaz.' },
        { status: 400 }
      );
    }

    const { data, error } = await admin.auth.admin.updateUserById(userId, {
      ban_duration: action === 'ban' ? PERMANENT_BAN_DURATION : 'none',
    });

    if (error || !data.user) {
      console.error('admin ban/unban:', error);
      return NextResponse.json(
        { error: action === 'ban' ? 'Yasaklama başarısız.' : 'Yasak kaldırılamadı.' },
        { status: 500 }
      );
    }

    const bannedUntil =
      (data.user as { banned_until?: string | null }).banned_until ?? null;

    return NextResponse.json({
      ok: true,
      userId: data.user.id,
      action,
      banned_until: bannedUntil,
      banned: isCurrentlyBanned(bannedUntil),
    });
  } catch (err) {
    console.error('PATCH /api/admin/users:', err);
    const message = err instanceof Error ? err.message : 'Sunucu hatası.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
