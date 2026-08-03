/**
 * Admin e-posta allowlist.
 * Sunucu: ADMIN_EMAILS; istemci menü ipucu: NEXT_PUBLIC_ADMIN_EMAILS.
 * Bu dosya client component'lerden import edilebilir (server-only bağımlılık yok).
 */

export type AdminUserRow = {
  id: string;
  email: string | null;
  full_name: string | null;
  email_confirmed_at: string | null;
  created_at: string;
  last_sign_in_at: string | null;
  banned_until: string | null;
  conversation_count: number;
  message_count: number;
  last_activity_at: string | null;
};

export type AdminFunnel = {
  signed_up: number;
  confirmed: number;
  chatted: number;
  confirm_rate: number;
  chat_rate: number;
};

export type AdminActivitySummary = {
  active_7d: number;
  active_30d: number;
  total_conversations: number;
  total_messages: number;
};

export function getAdminEmails(): string[] {
  const raw =
    process.env.ADMIN_EMAILS?.trim() ||
    process.env.NEXT_PUBLIC_ADMIN_EMAILS?.trim() ||
    '';

  return raw
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return getAdminEmails().includes(email.trim().toLowerCase());
}
