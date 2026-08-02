-- Kullanıcıya özel sohbet geçmişi için gerekli tablolar ve RLS politikaları.
-- Bu dosyayı Supabase Dashboard > SQL Editor içinde çalıştırın.

-- 1. conversations: her kullanıcının sohbet oturumlarını tutar.
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Bu proje için `conversations` tablosu daha önce farklı (daha eksik) bir
-- yapıyla oluşturulmuş olabileceğinden (bkz. "column updated_at does not
-- exist" hatası), eksik sütunları burada açıkça ekliyoruz. `create table
-- if not exists` tablo zaten varsa hiçbir sütun eklemez.
alter table public.conversations add column if not exists title text;
alter table public.conversations add column if not exists created_at timestamptz not null default now();
alter table public.conversations add column if not exists updated_at timestamptz not null default now();

create index if not exists conversations_user_id_created_at_idx
  on public.conversations (user_id, created_at desc);

-- 2. messages: her sohbete ait kullanıcı/asistan mesajlarını tutar.
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  sources jsonb,
  created_at timestamptz not null default now()
);

-- ÖNEMLİ: `create table if not exists` tablo ZATEN VARSA hiçbir şey yapmaz;
-- eksik sütunları eklemez. Bu proje için `messages` tablosu daha önce farklı
-- bir yapıyla (user_id sütunu olmadan) oluşturulmuş olabileceğinden, eksik
-- sütunları burada açıkça ekliyoruz ki insert'ler "Could not find the
-- 'user_id' column" hatasıyla sessizce başarısız olmasın.
alter table public.messages add column if not exists user_id uuid references auth.users (id) on delete cascade;
alter table public.messages add column if not exists sources jsonb;

-- Mevcut satırlarda null user_id yoksa sütunu NOT NULL yap (yeni tablo için no-op).
do $$
begin
  if not exists (select 1 from public.messages where user_id is null) then
    alter table public.messages alter column user_id set not null;
  end if;
end $$;

create index if not exists messages_conversation_id_created_at_idx
  on public.messages (conversation_id, created_at asc);

-- 3. Row Level Security: her kullanıcı yalnızca kendi verisine erişebilir.
alter table public.conversations enable row level security;
alter table public.messages enable row level security;

drop policy if exists "conversations_select_own" on public.conversations;
create policy "conversations_select_own"
  on public.conversations for select
  using (auth.uid() = user_id);

drop policy if exists "conversations_insert_own" on public.conversations;
create policy "conversations_insert_own"
  on public.conversations for insert
  with check (auth.uid() = user_id);

drop policy if exists "conversations_update_own" on public.conversations;
create policy "conversations_update_own"
  on public.conversations for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "conversations_delete_own" on public.conversations;
create policy "conversations_delete_own"
  on public.conversations for delete
  using (auth.uid() = user_id);

drop policy if exists "messages_select_own" on public.messages;
create policy "messages_select_own"
  on public.messages for select
  using (auth.uid() = user_id);

drop policy if exists "messages_insert_own" on public.messages;
create policy "messages_insert_own"
  on public.messages for insert
  with check (auth.uid() = user_id);

drop policy if exists "messages_delete_own" on public.messages;
create policy "messages_delete_own"
  on public.messages for delete
  using (auth.uid() = user_id);

-- 4. conversations.updated_at alanını her yeni mesajda güncelleyen tetikleyici (opsiyonel ama faydalı).
create or replace function public.touch_conversation_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.conversations
  set updated_at = now()
  where id = new.conversation_id;
  return new;
end;
$$;

drop trigger if exists messages_touch_conversation on public.messages;
create trigger messages_touch_conversation
  after insert on public.messages
  for each row
  execute function public.touch_conversation_updated_at();
