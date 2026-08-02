import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * GET: Belirtilen sohbet oturumuna ait mesajları getirir. Sidebar'dan geçmiş
 * bir sohbete tıklandığında kullanılır. RLS sayesinde kullanıcı yalnızca
 * kendi sohbetlerine erişebilir; ayrıca burada da user_id kontrolü yapılır.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: conversationId } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Giriş yapmanız gerekiyor.' }, { status: 401 });
  }

  const { data: conversation, error: conversationError } = await supabase
    .from('conversations')
    .select('id')
    .eq('id', conversationId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (conversationError) {
    console.error('Sohbet doğrulanamadı:', conversationError);
    return NextResponse.json({ error: 'Sohbet doğrulanamadı.' }, { status: 500 });
  }

  if (!conversation) {
    return NextResponse.json({ error: 'Sohbet bulunamadı.' }, { status: 404 });
  }

  const { data: messages, error: messagesError } = await supabase
    .from('messages')
    .select('id, role, content, sources, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });

  if (messagesError) {
    console.error('Mesajlar getirilemedi:', messagesError);
    return NextResponse.json({ error: 'Mesajlar getirilemedi.' }, { status: 500 });
  }

  return NextResponse.json({ conversationId, messages: messages ?? [] });
}

/**
 * DELETE: Sohbeti (ve cascade ile tüm mesajlarını) siler. Sidebar'daki çöp
 * kutusu ikonu için kullanılır.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: conversationId } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Giriş yapmanız gerekiyor.' }, { status: 401 });
  }

  const { error } = await supabase
    .from('conversations')
    .delete()
    .eq('id', conversationId)
    .eq('user_id', user.id);

  if (error) {
    console.error('Sohbet silinemedi:', error);
    return NextResponse.json({ error: 'Sohbet silinemedi.' }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
