'use client';

import Link from 'next/link';
import { useState } from 'react';
import { LogOut, Shield } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { isAdminEmail } from '@/lib/admin';

function getInitials(displayName: string) {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return displayName.slice(0, 2).toUpperCase();
}

/**
 * Yalnızca kullanıcı giriş yapmışken render edilir (bkz. page.tsx'teki
 * auth kapısı); bu yüzden burada "giriş yap" için ayrı bir dal tutmuyoruz.
 */
export default function UserMenu() {
  const { user, signOut } = useAuth();
  const [open, setOpen] = useState(false);

  if (!user) return null;

  const email = user.email ?? 'Kullanıcı';
  const fullName = (user.user_metadata?.full_name as string | undefined)?.trim();
  const displayName = fullName || email;
  const showAdminLink = isAdminEmail(user.email);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        title={displayName}
        className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-red-600 to-red-500 text-xs font-semibold text-white shadow-sm transition-all hover:ring-2 hover:ring-red-200"
      >
        {getInitials(displayName)}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-2 w-52 overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-lg shadow-neutral-900/5">
            <div className="border-b border-neutral-100 px-3 py-2.5">
              {fullName && (
                <p className="truncate text-xs font-medium text-neutral-800">{fullName}</p>
              )}
              <p className="truncate text-xs text-neutral-500">{email}</p>
            </div>
            {showAdminLink && (
              <Link
                href="/admin"
                onClick={() => setOpen(false)}
                className="flex w-full items-center gap-2 px-3 py-2.5 text-xs text-neutral-700 transition-colors hover:bg-neutral-50"
              >
                <Shield className="h-3.5 w-3.5 text-red-600" />
                Yönetim Paneli
              </Link>
            )}
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                signOut();
              }}
              className="flex w-full items-center gap-2 px-3 py-2.5 text-xs text-red-600 transition-colors hover:bg-red-50"
            >
              <LogOut className="h-3.5 w-3.5" />
              Çıkış Yap
            </button>
          </div>
        </>
      )}
    </div>
  );
}
