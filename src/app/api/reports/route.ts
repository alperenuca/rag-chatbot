import { NextRequest, NextResponse } from 'next/server';
import {
  clampReportText,
  REPORT_QUESTION_SNAPSHOT_MAX,
  REPORT_REASON_MAX,
  REPORT_REPLY_SNAPSHOT_MAX,
} from '@/lib/answer-reports';
import { createClient } from '@/lib/supabase/server';

/**
 * Kullanıcı: asistan cevabını yanlış diye raporlar.
 * Body: { reason, assistantReply, userQuestion?, conversationId?, messageId? }
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Oturum gerekli.' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Geçersiz istek gövdesi.' }, { status: 400 });
  }

  const reasonRaw = typeof body.reason === 'string' ? body.reason : '';
  const reason = clampReportText(reasonRaw, REPORT_REASON_MAX);
  if (reason.length < 3) {
    return NextResponse.json(
      { error: 'Lütfen kısa bir açıklama yazın (en az 3 karakter).' },
      { status: 400 }
    );
  }

  const assistantReply = clampReportText(
    typeof body.assistantReply === 'string' ? body.assistantReply : '',
    REPORT_REPLY_SNAPSHOT_MAX
  );
  if (!assistantReply) {
    return NextResponse.json({ error: 'Raporlanacak cevap bulunamadı.' }, { status: 400 });
  }

  const userQuestion = clampReportText(
    typeof body.userQuestion === 'string' ? body.userQuestion : '',
    REPORT_QUESTION_SNAPSHOT_MAX
  );

  let conversationId =
    typeof body.conversationId === 'string' && body.conversationId.trim()
      ? body.conversationId.trim()
      : null;
  let messageId =
    typeof body.messageId === 'string' && body.messageId.trim()
      ? body.messageId.trim()
      : null;

  // conversation kullanıcıya ait mi? (yanlış id ile FK/RLS gürültüsünü azalt)
  if (conversationId) {
    const { data: conv } = await supabase
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('user_id', user.id)
      .maybeSingle();
    if (!conv?.id) {
      conversationId = null;
    }
  }

  if (messageId) {
    const { data: msg } = await supabase
      .from('messages')
      .select('id')
      .eq('id', messageId)
      .eq('user_id', user.id)
      .maybeSingle();
    if (!msg?.id) {
      messageId = null;
    }
  }

  const { data, error } = await supabase
    .from('answer_reports')
    .insert({
      user_id: user.id,
      conversation_id: conversationId,
      message_id: messageId,
      user_question: userQuestion,
      assistant_reply: assistantReply,
      reason,
      status: 'open',
    })
    .select('id, created_at')
    .single();

  if (error) {
    console.error('answer_reports insert:', error);
    const missing =
      /relation .*answer_reports.* does not exist|Could not find the table/i.test(
        error.message
      );
    return NextResponse.json(
      {
        error: missing
          ? 'Rapor tablosu henüz kurulmadı. Yönetici: supabase/answer_reports_schema.sql çalıştırın.'
          : 'Rapor kaydedilemedi.',
      },
      { status: missing ? 503 : 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    id: data.id,
    created_at: data.created_at,
  });
}
