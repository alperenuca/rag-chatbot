'use client';

import { useState, type FormEvent } from 'react';
import { Bot, Lock, Loader2, Mail, User } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';

type Mode = 'login' | 'signup';

/**
 * Giriş yapmadan RAG asistanına erişim engellenir; kullanıcı giriş/kayıt
 * olana kadar tüm ekranı kaplayan bu bileşen gösterilir.
 */
export default function AuthScreen() {
  const [mode, setMode] = useState<Mode>('login');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
    setInfoMessage(null);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfoMessage(null);
    setLoading(true);

    const supabase = createClient();

    try {
      if (mode === 'login') {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        // Başarılı girişte AuthContext session'ı güncelleyip chat ekranını açacak.
      } else {
        const trimmedName = fullName.trim();
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: {
              full_name: trimmedName,
            },
          },
        });
        if (error) throw error;

        if (!data.session) {
          setInfoMessage(
            'Kayıt başarılı! Lütfen e-postanıza gelen bağlantıyla hesabınızı onaylayıp giriş yapın.'
          );
          setMode('login');
        }
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Beklenmeyen bir hata oluştu.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-4 dark:bg-slate-900">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-700 dark:bg-slate-800">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-indigo-600 text-white">
            <Bot className="h-6 w-6" />
          </div>
          <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">RAG Asistanı</h1>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Devam etmek için giriş yapın veya kayıt olun.
          </p>
        </div>

        <div className="mb-5 flex rounded-lg bg-slate-100 p-1 dark:bg-slate-900/60">
          <button
            type="button"
            onClick={() => switchMode('login')}
            className={`flex-1 rounded-md py-1.5 text-sm font-medium transition-colors ${
              mode === 'login'
                ? 'bg-indigo-600 text-white'
                : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
            }`}
          >
            Giriş Yap
          </button>
          <button
            type="button"
            onClick={() => switchMode('signup')}
            className={`flex-1 rounded-md py-1.5 text-sm font-medium transition-colors ${
              mode === 'signup'
                ? 'bg-indigo-600 text-white'
                : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
            }`}
          >
            Kayıt Ol
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          {mode === 'signup' && (
            <div className="relative">
              <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400 dark:text-slate-500" />
              <input
                type="text"
                required
                autoComplete="name"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Ad Soyad"
                className="w-full rounded-lg border border-slate-300 bg-slate-50 py-2.5 pl-9 pr-3 text-sm placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-slate-700 dark:bg-slate-900/60 dark:text-white dark:placeholder-slate-500"
              />
            </div>
          )}
          <div className="relative">
            <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400 dark:text-slate-500" />
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="E-posta"
              className="w-full rounded-lg border border-slate-300 bg-slate-50 py-2.5 pl-9 pr-3 text-sm placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-slate-700 dark:bg-slate-900/60 dark:text-white dark:placeholder-slate-500"
            />
          </div>
          <div className="relative">
            <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400 dark:text-slate-500" />
            <input
              type="password"
              required
              minLength={6}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Şifre (en az 6 karakter)"
              className="w-full rounded-lg border border-slate-300 bg-slate-50 py-2.5 pl-9 pr-3 text-sm placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-slate-700 dark:bg-slate-900/60 dark:text-white dark:placeholder-slate-500"
            />
          </div>

          {error && <p className="text-xs text-red-500 dark:text-red-400">{error}</p>}
          {infoMessage && (
            <p className="text-xs text-emerald-600 dark:text-emerald-400">{infoMessage}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 py-2.5 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50"
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            {mode === 'login' ? 'Giriş Yap' : 'Kayıt Ol'}
          </button>
        </form>
      </div>
    </main>
  );
}
