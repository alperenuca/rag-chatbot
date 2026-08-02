import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * GET: Giriş yapmış kullanıcının tüm sohbet oturumlarını (en güncel önce)
 * listeler. Sidebar'daki sohbet geçmişi listesini doldurmak için kullanılır.
 * Artık otomatik sohbet oluşturmuyor; boş liste dönebilir (kullanıcı henüz
 * hiç sohbet başlatmamışsa).
 */
export async function GET() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Giriş yapmanız gerekiyor.' }, { status: 401 });
  }

  const { data: conversations, error } = await supabase
    .from('conversations')
    .select('id, title, created_at, updated_at')
    .eq('user_id', user.id)
    .order('updated_at', { ascending: false });

  if (error) {
    console.error('Sohbet listesi getirilemedi:', error);
    return NextResponse.json({ error: 'Sohbet listesi getirilemedi.' }, { status: 500 });
  }

  return NextResponse.json({ conversations: conversations ?? [] });
}

/**
 * POST: Kullanıcı için boş, yeni bir sohbet oturumu oluşturur ("Yeni Sohbet"
 * butonu). İlk mesaj gönderildiğinde başlık otomatik olarak atanır.
 */
export async function POST() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Giriş yapmanız gerekiyor.' }, { status: 401 });
  }

  const { data: newConversation, error } = await supabase
    .from('conversations')
    .insert({ user_id: user.id })
    .select('id, title, created_at, updated_at')
    .single();

  if (error || !newConversation) {
    console.error('Sohbet oturumu oluşturulamadı:', error);
    return NextResponse.json({ error: 'Sohbet oturumu oluşturulamadı.' }, { status: 500 });
  }

  return NextResponse.json({ conversation: newConversation });
}
