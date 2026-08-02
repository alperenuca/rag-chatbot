'use client';

import { useState, type FormEvent } from 'react';
import { Bot, Lock, Loader2, Mail, Sparkles, User } from 'lucide-react';
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
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#fefbfa] p-4">
      {/* Dekoratif arka plan aksanları */}
      <div className="pointer-events-none absolute -top-32 -right-32 h-96 w-96 rounded-full bg-red-100 opacity-60 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-32 -left-32 h-96 w-96 rounded-full bg-red-50 opacity-80 blur-3xl" />

      <div className="relative w-full max-w-sm rounded-3xl border border-neutral-200/80 bg-white/90 p-7 shadow-xl shadow-red-900/5 backdrop-blur-sm">
        <div className="mb-7 flex flex-col items-center text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-red-600 to-red-500 text-white shadow-lg shadow-red-600/30">
            <Bot className="h-7 w-7" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-neutral-900">
            Ores RAG Asistanı
          </h1>
          <p className="mt-1.5 flex items-center gap-1 text-xs text-neutral-500">
            <Sparkles className="h-3 w-3 text-red-500" />
            Devam etmek için giriş yapın veya kayıt olun
          </p>
        </div>

        <div className="mb-6 flex rounded-xl bg-neutral-100 p-1">
          <button
            type="button"
            onClick={() => switchMode('login')}
            className={`flex-1 rounded-lg py-2 text-sm font-medium transition-all duration-200 ${
              mode === 'login'
                ? 'bg-white text-red-600 shadow-sm'
                : 'text-neutral-500 hover:text-neutral-800'
            }`}
          >
            Giriş Yap
          </button>
          <button
            type="button"
            onClick={() => switchMode('signup')}
            className={`flex-1 rounded-lg py-2 text-sm font-medium transition-all duration-200 ${
              mode === 'signup'
                ? 'bg-white text-red-600 shadow-sm'
                : 'text-neutral-500 hover:text-neutral-800'
            }`}
          >
            Kayıt Ol
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          {mode === 'signup' && (
            <div className="relative">
              <User className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
              <input
                type="text"
                required
                autoComplete="name"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Ad Soyad"
                className="w-full rounded-xl border border-neutral-200 bg-neutral-50 py-2.5 pl-10 pr-3 text-sm text-neutral-900 placeholder-neutral-400 transition-colors focus:border-red-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-100"
              />
            </div>
          )}
          <div className="relative">
            <Mail className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="E-posta"
              className="w-full rounded-xl border border-neutral-200 bg-neutral-50 py-2.5 pl-10 pr-3 text-sm text-neutral-900 placeholder-neutral-400 transition-colors focus:border-red-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-100"
            />
          </div>
          <div className="relative">
            <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
            <input
              type="password"
              required
              minLength={6}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Şifre (en az 6 karakter)"
              className="w-full rounded-xl border border-neutral-200 bg-neutral-50 py-2.5 pl-10 pr-3 text-sm text-neutral-900 placeholder-neutral-400 transition-colors focus:border-red-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-100"
            />
          </div>

          {error && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>
          )}
          {infoMessage && (
            <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-600">
              {infoMessage}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-red-600 to-red-500 py-2.5 text-sm font-medium text-white shadow-md shadow-red-600/25 transition-all hover:shadow-lg hover:shadow-red-600/35 disabled:opacity-50"
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            {mode === 'login' ? 'Giriş Yap' : 'Kayıt Ol'}
          </button>
        </form>
      </div>
    </main>
  );
}
