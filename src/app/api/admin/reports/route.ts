import { NextRequest, NextResponse } from 'next/server';
import type { AnswerReportRow, AnswerReportStatus } from '@/lib/answer-reports';
import { requireAdmin } from '@/lib/require-admin';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Admin: cevap raporlarını listeler.
 * Query: status=open|reviewed|dismissed|all, limit (max 100)
 */
export async function GET(request: NextRequest) {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;

  const { searchParams } = request.nextUrl;
  const statusParam = (searchParams.get('status') || 'open').toLowerCase();
  const limit = Math.min(100, Math.max(1, Number(searchParams.get('limit') || '50') || 50));

  try {
    const admin = createAdminClient();
    let query = admin
      .from('answer_reports')
      .select(
        'id, user_id, conversation_id, message_id, user_question, assistant_reply, reason, status, created_at'
      )
      .order('created_at', { ascending: false })
      .limit(limit);

    if (statusParam !== 'all') {
      query = query.eq('status', statusParam);
    }

    const { data, error } = await query;
    if (error) {
      console.error('admin reports list:', error);
      const missing = /relation .*answer_reports.* does not exist|Could not find the table/i.test(
        error.message
      );
      return NextResponse.json(
        {
          error: missing
            ? 'Rapor tablosu yok. supabase/answer_reports_schema.sql çalıştırın.'
            : 'Raporlar alınamadı.',
        },
        { status: missing ? 503 : 500 }
      );
    }

    const rows = (data ?? []) as AnswerReportRow[];
    const userIds = [...new Set(rows.map((r) => r.user_id))];
    const emailById = new Map<string, { email: string | null; name: string | null }>();

    for (const id of userIds) {
      const { data: userData } = await admin.auth.admin.getUserById(id);
      const u = userData?.user;
      const name =
        typeof u?.user_metadata?.full_name === 'string'
          ? u.user_metadata.full_name.trim() || null
          : null;
      emailById.set(id, { email: u?.email ?? null, name });
    }

    const reports: AnswerReportRow[] = rows.map((row) => {
      const info = emailById.get(row.user_id);
      return {
        ...row,
        reporter_email: info?.email ?? null,
        reporter_name: info?.name ?? null,
      };
    });

    const { count: openCountRaw } = await admin
      .from('answer_reports')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'open');

    return NextResponse.json({
      reports,
      openCount: openCountRaw ?? reports.filter((r) => r.status === 'open').length,
      total: reports.length,
      status: statusParam,
    });
  } catch (err) {
    console.error('GET /api/admin/reports:', err);
    const message = err instanceof Error ? err.message : 'Sunucu hatası.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Admin: rapor durumunu güncelle.
 * Body: { id: string, status: 'open' | 'reviewed' | 'dismissed' }
 */
export async function PATCH(request: NextRequest) {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;

  let body: { id?: unknown; status?: unknown };
  try {
    body = (await request.json()) as { id?: unknown; status?: unknown };
  } catch {
    return NextResponse.json({ error: 'Geçersiz istek gövdesi.' }, { status: 400 });
  }

  const id = typeof body.id === 'string' ? body.id.trim() : '';
  const status = body.status as AnswerReportStatus | undefined;
  if (!id || !status || !['open', 'reviewed', 'dismissed'].includes(status)) {
    return NextResponse.json(
      { error: 'id ve status (open|reviewed|dismissed) gerekli.' },
      { status: 400 }
    );
  }

  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from('answer_reports')
      .update({ status })
      .eq('id', id)
      .select('id, status')
      .single();

    if (error || !data) {
      console.error('admin reports patch:', error);
      return NextResponse.json({ error: 'Durum güncellenemedi.' }, { status: 500 });
    }

    return NextResponse.json({ ok: true, id: data.id, status: data.status });
  } catch (err) {
    console.error('PATCH /api/admin/reports:', err);
    const message = err instanceof Error ? err.message : 'Sunucu hatası.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
