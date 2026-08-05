-- Yanlış cevap raporları. Supabase SQL Editor'da çalıştırın.
-- Kullanıcı kendi raporunu ekler; admin service role ile tümünü okur.

create table if not exists public.answer_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete set null,
  message_id uuid references public.messages (id) on delete set null,
  user_question text not null default '',
  assistant_reply text not null default '',
  reason text not null,
  status text not null default 'open'
    check (status in ('open', 'reviewed', 'dismissed')),
  created_at timestamptz not null default now()
);

create index if not exists answer_reports_created_at_idx
  on public.answer_reports (created_at desc);

create index if not exists answer_reports_status_created_at_idx
  on public.answer_reports (status, created_at desc);

create index if not exists answer_reports_user_id_idx
  on public.answer_reports (user_id);

alter table public.answer_reports enable row level security;

drop policy if exists "answer_reports_insert_own" on public.answer_reports;
create policy "answer_reports_insert_own"
  on public.answer_reports for insert
  with check (auth.uid() = user_id);

drop policy if exists "answer_reports_select_own" on public.answer_reports;
create policy "answer_reports_select_own"
  on public.answer_reports for select
  using (auth.uid() = user_id);

-- Kullanıcı kendi raporunu silemez/güncelleyemez (admin service role ile yönetir).
