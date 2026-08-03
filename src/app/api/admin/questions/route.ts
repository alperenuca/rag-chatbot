import { NextRequest, NextResponse } from 'next/server';
import { aggregatePopularQuestions, type QuestionTheme } from '@/lib/popular-questions';
import { requireAdmin } from '@/lib/require-admin';
import { createAdminClient } from '@/lib/supabase/admin';

const ALLOWED_DAYS = new Set([7, 30, 90]);

/**
 * Admin: kullanıcı mesajlarından popüler soruları gruplar.
 * Query: days=7|30|90, limit=1..50
 */
export async function GET(request: NextRequest) {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;

  const { searchParams } = request.nextUrl;
  const daysRaw = Number(searchParams.get('days') || '30');
  const days = ALLOWED_DAYS.has(daysRaw) ? daysRaw : 30;
  const limit = Math.min(50, Math.max(1, Number(searchParams.get('limit') || '30') || 30));

  try {
    const admin = createAdminClient();
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await admin
      .from('messages')
      .select('content, created_at')
      .eq('role', 'user')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(5000);

    if (error) {
      console.error('admin questions query:', error);
      return NextResponse.json(
        { error: 'Sorular yüklenemedi.' },
        { status: 500 }
      );
    }

    const rows = (data ?? []).map((row) => ({
      content: String(row.content ?? ''),
      created_at: String(row.created_at),
    }));

    const questions = aggregatePopularQuestions(rows, limit);

    const themeCounts: Record<QuestionTheme, number> = {
      ürün: 0,
      kargo: 0,
      ödeme: 0,
      stok: 0,
      diğer: 0,
    };
    for (const q of questions) {
      themeCounts[q.theme] += q.count;
    }

    return NextResponse.json({
      days,
      limit,
      total_user_messages: rows.length,
      unique_questions: questions.length,
      themes: themeCounts,
      questions,
    });
  } catch (err) {
    console.error('GET /api/admin/questions:', err);
    return NextResponse.json({ error: 'Sunucu hatası.' }, { status: 500 });
  }
}
