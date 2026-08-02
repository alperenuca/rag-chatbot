'use client';

import { useState } from 'react';
import { LogOut } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';

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

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        title={displayName}
        className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-600 text-xs font-semibold text-white transition-all hover:ring-2 hover:ring-indigo-400"
      >
        {getInitials(displayName)}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-2 w-52 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-800">
            <div className="border-b border-slate-100 px-3 py-2 dark:border-slate-700">
              {fullName && (
                <p className="truncate text-xs font-medium text-slate-800 dark:text-slate-200">
                  {fullName}
                </p>
              )}
              <p className="truncate text-xs text-slate-500 dark:text-slate-400">{email}</p>
            </div>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                signOut();
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-xs text-red-600 transition-colors hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
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
