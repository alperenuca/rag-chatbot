'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  Ban,
  CheckCheck,
  ChevronDown,
  Flag,
  Loader2,
  MailCheck,
  MailWarning,
  MessageSquare,
  RefreshCw,
  Search,
  Shield,
  ShieldOff,
  TrendingUp,
  Users,
} from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import {
  isAdminEmail,
  isCurrentlyBanned,
  type AdminActivitySummary,
  type AdminFunnel,
  type AdminUserRow,
} from '@/lib/admin';
import type { AnswerReportRow, AnswerReportStatus } from '@/lib/answer-reports';
import type { PopularQuestion, QuestionTheme } from '@/lib/popular-questions';

type StatusFilter =
  | 'all'
  | 'confirmed'
  | 'unconfirmed'
  | 'active'
  | 'no_chat'
  | 'banned';
type QuestionDays = 7 | 30 | 90;

type UsersResponse = {
  users: AdminUserRow[];
  page: number;
  perPage: number;
  totalFiltered: number;
  totalPages: number;
  counts: { total: number; confirmed: number; unconfirmed: number };
  funnel: AdminFunnel;
  activity: AdminActivitySummary;
  error?: string;
};

type QuestionsResponse = {
  days: number;
  total_user_messages: number;
  unique_questions: number;
  themes: Record<QuestionTheme, number>;
  questions: PopularQuestion[];
  error?: string;
};

type ReportsResponse = {
  reports: AnswerReportRow[];
  openCount: number;
  total: number;
  status: string;
  error?: string;
};

type ReportStatusFilter = AnswerReportStatus | 'all';

function formatDate(value: string | null) {
  if (!value) return '—';
  try {
    return new Intl.DateTimeFormat('tr-TR', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

export default function AdminPage() {
  const { user, loading: authLoading } = useAuth();
  const [status, setStatus] = useState<StatusFilter>('all');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<UsersResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [questionsOpen, setQuestionsOpen] = useState(false);
  const [questionDays, setQuestionDays] = useState<QuestionDays>(30);
  const [questionTheme, setQuestionTheme] = useState<QuestionTheme | 'all'>('all');
  const [questionsData, setQuestionsData] = useState<QuestionsResponse | null>(null);
  const [questionsLoading, setQuestionsLoading] = useState(false);
  const [questionsError, setQuestionsError] = useState<string | null>(null);
  const [banBusyId, setBanBusyId] = useState<string | null>(null);
  const [reportsOpen, setReportsOpen] = useState(true);
  const [reportStatus, setReportStatus] = useState<ReportStatusFilter>('open');
  const [reportsData, setReportsData] = useState<ReportsResponse | null>(null);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [reportsError, setReportsError] = useState<string | null>(null);
  const [reportBusyId, setReportBusyId] = useState<string | null>(null);
  const [expandedReportId, setExpandedReportId] = useState<string | null>(null);

  const filteredQuestions = useMemo(() => {
    const list = questionsData?.questions ?? [];
    if (questionTheme === 'all') return list;
    return list.filter((q) => q.theme === questionTheme);
  }, [questionsData, questionTheme]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    setPage(1);
  }, [status, debouncedQuery]);

  const loadUsers = useCallback(async () => {
    if (!user || !isAdminEmail(user.email)) return;

    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        page: String(page),
        perPage: '50',
        status,
      });
      if (debouncedQuery) params.set('q', debouncedQuery);

      const res = await fetch(`/api/admin/users?${params.toString()}`);
      const json = (await res.json()) as UsersResponse;

      if (!res.ok) {
        throw new Error(json.error || 'Kullanıcılar yüklenemedi.');
      }

      setData(json);
    } catch (err) {
      setData(null);
      setError(err instanceof Error ? err.message : 'Beklenmeyen bir hata oluştu.');
    } finally {
      setLoading(false);
    }
  }, [user, page, status, debouncedQuery]);

  const loadQuestions = useCallback(async () => {
    if (!user || !isAdminEmail(user.email)) return;

    setQuestionsLoading(true);
    setQuestionsError(null);
    try {
      const res = await fetch(`/api/admin/questions?days=${questionDays}&limit=30`);
      const json = (await res.json()) as QuestionsResponse;
      if (!res.ok) {
        throw new Error(json.error || 'Popüler sorular yüklenemedi.');
      }
      setQuestionsData(json);
    } catch (err) {
      setQuestionsData(null);
      setQuestionsError(err instanceof Error ? err.message : 'Beklenmeyen bir hata oluştu.');
    } finally {
      setQuestionsLoading(false);
    }
  }, [user, questionDays]);

  const loadReports = useCallback(async () => {
    if (!user || !isAdminEmail(user.email)) return;

    setReportsLoading(true);
    setReportsError(null);
    try {
      const res = await fetch(
        `/api/admin/reports?status=${reportStatus}&limit=50`
      );
      const json = (await res.json()) as ReportsResponse;
      if (!res.ok) {
        throw new Error(json.error || 'Raporlar yüklenemedi.');
      }
      setReportsData(json);
    } catch (err) {
      setReportsData(null);
      setReportsError(err instanceof Error ? err.message : 'Beklenmeyen bir hata oluştu.');
    } finally {
      setReportsLoading(false);
    }
  }, [user, reportStatus]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  useEffect(() => {
    if (!questionsOpen) return;
    void loadQuestions();
  }, [questionsOpen, loadQuestions]);

  useEffect(() => {
    if (!reportsOpen) return;
    void loadReports();
  }, [reportsOpen, loadReports]);

  const updateReportStatus = useCallback(
    async (id: string, status: AnswerReportStatus) => {
      setReportBusyId(id);
      setReportsError(null);
      try {
        const res = await fetch('/api/admin/reports', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, status }),
        });
        const json = (await res.json()) as { error?: string };
        if (!res.ok) {
          throw new Error(json.error || 'Durum güncellenemedi.');
        }
        await loadReports();
      } catch (err) {
        setReportsError(
          err instanceof Error ? err.message : 'Beklenmeyen bir hata oluştu.'
        );
      } finally {
        setReportBusyId(null);
      }
    },
    [loadReports]
  );

  const toggleBan = useCallback(
    async (row: AdminUserRow) => {
      if (!user || !isAdminEmail(user.email)) return;
      if (row.id === user.id) {
        setError('Kendi hesabınızı yasaklayamazsınız.');
        return;
      }
      if (isAdminEmail(row.email)) {
        setError('Yönetici hesapları yasaklanamaz.');
        return;
      }

      const banned = isCurrentlyBanned(row.banned_until);
      const label = row.email || row.full_name || row.id;
      const ok = window.confirm(
        banned
          ? `"${label}" yasağını kaldırmak istiyor musunuz?`
          : `"${label}" hesabını yasaklamak istiyor musunuz? Bu kullanıcı giriş yapamaz ve sohbet kullanamaz.`
      );
      if (!ok) return;

      setBanBusyId(row.id);
      setError(null);
      try {
        const res = await fetch('/api/admin/users', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: row.id,
            action: banned ? 'unban' : 'ban',
          }),
        });
        const json = (await res.json()) as {
          error?: string;
          banned_until?: string | null;
          banned?: boolean;
        };
        if (!res.ok) {
          throw new Error(json.error || 'İşlem başarısız.');
        }
        setData((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            users: prev.users.map((u) =>
              u.id === row.id
                ? { ...u, banned_until: json.banned_until ?? null }
                : u
            ),
          };
        });
        // Yasaklı filtresindeyse veya durum değiştiyse listeyi yenile
        if (status === 'banned') {
          void loadUsers();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Beklenmeyen bir hata oluştu.');
      } finally {
        setBanBusyId(null);
      }
    },
    [user, status, loadUsers]
  );

  if (authLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#fefbfa]">
        <Loader2 className="h-6 w-6 animate-spin text-red-500" />
      </main>
    );
  }

  if (!user) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[#fefbfa] p-6">
        <Shield className="h-10 w-10 text-red-500" />
        <h1 className="text-lg font-semibold text-neutral-900">Yönetim Paneli</h1>
        <p className="text-sm text-neutral-500">Devam etmek için giriş yapın.</p>
        <Link
          href="/"
          className="rounded-xl bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500"
        >
          Giriş sayfasına dön
        </Link>
      </main>
    );
  }

  if (!isAdminEmail(user.email)) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[#fefbfa] p-6">
        <Shield className="h-10 w-10 text-neutral-400" />
        <h1 className="text-lg font-semibold text-neutral-900">Yetkisiz</h1>
        <p className="max-w-sm text-center text-sm text-neutral-500">
          Bu panele erişim yetkiniz yok.
        </p>
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm text-red-600 hover:underline"
        >
          <ArrowLeft className="h-4 w-4" />
          Sohbete dön
        </Link>
      </main>
    );
  }

  const counts = data?.counts ?? { total: 0, confirmed: 0, unconfirmed: 0 };
  const funnel = data?.funnel ?? {
    signed_up: 0,
    confirmed: 0,
    chatted: 0,
    confirm_rate: 0,
    chat_rate: 0,
  };
  const activity = data?.activity ?? {
    active_7d: 0,
    active_30d: 0,
    total_conversations: 0,
    total_messages: 0,
  };

  return (
    <main className="min-h-screen bg-[#fefbfa]">
      <header className="border-b border-neutral-200/80 bg-white/90 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-800"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Sohbet
            </Link>
            <div className="h-4 w-px bg-neutral-200" />
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-red-600 text-white">
                <Shield className="h-4 w-4" />
              </div>
              <div>
                <h1 className="text-sm font-semibold text-neutral-900">Yönetim Paneli</h1>
                <p className="text-[11px] text-neutral-500">
                  Kullanıcılar · raporlar · aktivite
                </p>
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              void loadUsers();
              if (questionsOpen) void loadQuestions();
              if (reportsOpen) void loadReports();
            }}
            disabled={loading || questionsLoading || reportsLoading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs text-neutral-600 transition hover:bg-neutral-50 disabled:opacity-50"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${
                loading || questionsLoading || reportsLoading ? 'animate-spin' : ''
              }`}
            />
            Yenile
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-6xl space-y-5 px-4 py-6">
        <section className="grid gap-3 sm:grid-cols-3">
          <StatCard
            icon={<Users className="h-4 w-4 text-red-600" />}
            label="Toplam"
            value={counts.total}
          />
          <StatCard
            icon={<MailCheck className="h-4 w-4 text-emerald-600" />}
            label="Doğrulanmış"
            value={counts.confirmed}
          />
          <StatCard
            icon={<MailWarning className="h-4 w-4 text-amber-600" />}
            label="Bekleyen"
            value={counts.unconfirmed}
          />
        </section>

        <section className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm shadow-neutral-900/5">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-neutral-900">Doğrulama hunisi</h2>
            <p className="text-[11px] text-neutral-400">Kayıt → onay → ilk sohbet</p>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <FunnelStep
              label="Kayıt"
              value={funnel.signed_up}
              hint="Tüm hesaplar"
              active
            />
            <FunnelStep
              label="Doğrulandı"
              value={funnel.confirmed}
              hint={`%${funnel.confirm_rate} dönüşüm`}
              active={funnel.confirmed > 0}
            />
            <FunnelStep
              label="Sohbet etti"
              value={funnel.chatted}
              hint={`Doğrulananların %${funnel.chat_rate}`}
              active={funnel.chatted > 0}
            />
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-4">
            <MiniStat label="Aktif 7 gün" value={activity.active_7d} />
            <MiniStat label="Aktif 30 gün" value={activity.active_30d} />
            <MiniStat label="Toplam sohbet" value={activity.total_conversations} />
            <MiniStat label="Toplam mesaj" value={activity.total_messages} />
          </div>
        </section>

        <section className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm shadow-neutral-900/5">
          <button
            type="button"
            onClick={() => setReportsOpen((open) => !open)}
            aria-expanded={reportsOpen}
            className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-neutral-50/80"
          >
            <div className="flex items-center gap-2">
              <Flag className="h-4 w-4 text-red-600" />
              <div>
                <h2 className="text-sm font-semibold text-neutral-900">Cevap raporları</h2>
                <p className="text-[11px] text-neutral-400">
                  {reportsOpen && reportsData
                    ? `${reportsData.total} kayıt · ${reportsData.openCount} açık (bu listede)`
                    : 'Yanlış cevap geri bildirimleri'}
                </p>
              </div>
            </div>
            <ChevronDown
              className={`h-4 w-4 shrink-0 text-neutral-400 transition-transform duration-200 ${
                reportsOpen ? 'rotate-180' : ''
              }`}
            />
          </button>

          {reportsOpen && (
            <div className="border-t border-neutral-100">
              <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-[11px] text-neutral-400">Durum filtresi</p>
                <div className="flex rounded-xl bg-neutral-100 p-1">
                  {(
                    [
                      ['open', 'Açık'],
                      ['reviewed', 'İncelendi'],
                      ['dismissed', 'Kapatıldı'],
                      ['all', 'Tümü'],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setReportStatus(value)}
                      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                        reportStatus === value
                          ? 'bg-white text-red-600 shadow-sm'
                          : 'text-neutral-500 hover:text-neutral-800'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {reportsError && (
                <p className="border-t border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">
                  {reportsError}
                </p>
              )}

              <div className="overflow-x-auto border-t border-neutral-100">
                <table className="min-w-full text-left text-sm">
                  <thead className="bg-neutral-50 text-[11px] uppercase tracking-wide text-neutral-500">
                    <tr>
                      <th className="px-4 py-3 font-medium">Tarih / saat</th>
                      <th className="px-4 py-3 font-medium">Hesap</th>
                      <th className="px-4 py-3 font-medium">Açıklama</th>
                      <th className="px-4 py-3 font-medium">Durum</th>
                      <th className="px-4 py-3 font-medium">İşlem</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100">
                    {reportsLoading && !reportsData ? (
                      <tr>
                        <td colSpan={5} className="px-4 py-10 text-center text-neutral-400">
                          <Loader2 className="mx-auto h-5 w-5 animate-spin text-red-500" />
                        </td>
                      </tr>
                    ) : !reportsLoading && (reportsData?.reports.length ?? 0) === 0 ? (
                      <tr>
                        <td
                          colSpan={5}
                          className="px-4 py-10 text-center text-sm text-neutral-400"
                        >
                          Bu filtrede rapor yok.
                        </td>
                      </tr>
                    ) : (
                      reportsData?.reports.map((report) => {
                        const expanded = expandedReportId === report.id;
                        const busy = reportBusyId === report.id;
                        return (
                          <tr key={report.id} className="align-top hover:bg-neutral-50/80">
                            <td className="whitespace-nowrap px-4 py-3 text-neutral-500">
                              {formatDate(report.created_at)}
                            </td>
                            <td className="px-4 py-3">
                              <div className="font-medium text-neutral-800">
                                {report.reporter_name || '—'}
                              </div>
                              <div className="text-[11px] text-neutral-500">
                                {report.reporter_email || report.user_id}
                              </div>
                            </td>
                            <td className="max-w-md px-4 py-3">
                              <p className="text-neutral-800">{report.reason}</p>
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedReportId((prev) =>
                                    prev === report.id ? null : report.id
                                  )
                                }
                                className="mt-1 text-[11px] text-red-600 hover:underline"
                              >
                                {expanded ? 'Detayı gizle' : 'Soru / cevap detayı'}
                              </button>
                              {expanded && (
                                <div className="mt-2 space-y-2 rounded-lg border border-neutral-200 bg-neutral-50 p-2 text-[11px] text-neutral-600">
                                  <div>
                                    <span className="font-medium text-neutral-700">Soru: </span>
                                    {report.user_question || '—'}
                                  </div>
                                  <div>
                                    <span className="font-medium text-neutral-700">Cevap: </span>
                                    <span className="whitespace-pre-wrap">
                                      {report.assistant_reply.slice(0, 800)}
                                      {report.assistant_reply.length > 800 ? '…' : ''}
                                    </span>
                                  </div>
                                </div>
                              )}
                            </td>
                            <td className="px-4 py-3">
                              <ReportStatusBadge status={report.status} />
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex flex-col gap-1">
                                {report.status !== 'reviewed' && (
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() =>
                                      void updateReportStatus(report.id, 'reviewed')
                                    }
                                    className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                                  >
                                    {busy ? (
                                      <Loader2 className="h-3 w-3 animate-spin" />
                                    ) : (
                                      <CheckCheck className="h-3 w-3" />
                                    )}
                                    İncelendi
                                  </button>
                                )}
                                {report.status !== 'dismissed' && (
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() =>
                                      void updateReportStatus(report.id, 'dismissed')
                                    }
                                    className="inline-flex items-center gap-1 rounded-lg border border-neutral-200 bg-white px-2 py-1 text-[11px] font-medium text-neutral-600 hover:bg-neutral-50 disabled:opacity-50"
                                  >
                                    Kapat
                                  </button>
                                )}
                                {report.status !== 'open' && (
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() =>
                                      void updateReportStatus(report.id, 'open')
                                    }
                                    className="text-left text-[11px] text-neutral-400 hover:text-red-600 disabled:opacity-50"
                                  >
                                    Yeniden aç
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>

        <section className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm shadow-neutral-900/5">
          <button
            type="button"
            onClick={() => setQuestionsOpen((open) => !open)}
            aria-expanded={questionsOpen}
            className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-neutral-50/80"
          >
            <div className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-red-600" />
              <div>
                <h2 className="text-sm font-semibold text-neutral-900">Popüler sorular</h2>
                <p className="text-[11px] text-neutral-400">
                  {questionsOpen && questionsData
                    ? `${questionsData.total_user_messages} kullanıcı mesajı · ${questionsData.unique_questions} benzersiz`
                    : 'Görmek için tıklayın'}
                </p>
              </div>
            </div>
            <ChevronDown
              className={`h-4 w-4 shrink-0 text-neutral-400 transition-transform duration-200 ${
                questionsOpen ? 'rotate-180' : ''
              }`}
            />
          </button>

          {questionsOpen && (
            <div className="border-t border-neutral-100">
              <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-[11px] text-neutral-400">Dönem filtresi</p>
                <div className="flex rounded-xl bg-neutral-100 p-1">
                  {([7, 30, 90] as const).map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => {
                        setQuestionDays(d);
                        setQuestionTheme('all');
                      }}
                      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                        questionDays === d
                          ? 'bg-white text-red-600 shadow-sm'
                          : 'text-neutral-500 hover:text-neutral-800'
                      }`}
                    >
                      {d} gün
                    </button>
                  ))}
                </div>
              </div>

              {questionsData?.themes && (
                <div className="flex flex-wrap gap-2 border-t border-neutral-100 px-4 py-3">
                  <button
                    type="button"
                    onClick={() => setQuestionTheme('all')}
                    className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] transition ${
                      questionTheme === 'all'
                        ? 'bg-red-600 text-white'
                        : 'bg-neutral-50 text-neutral-600 hover:bg-neutral-100'
                    }`}
                  >
                    <span className="font-medium">Tümü</span>
                    <span
                      className={`tabular-nums ${
                        questionTheme === 'all' ? 'text-red-100' : 'text-neutral-400'
                      }`}
                    >
                      {questionsData.unique_questions}
                    </span>
                  </button>
                  {(Object.entries(questionsData.themes) as [QuestionTheme, number][]).map(
                    ([theme, count]) => {
                      const active = questionTheme === theme;
                      return (
                        <button
                          key={theme}
                          type="button"
                          onClick={() =>
                            setQuestionTheme((prev) => (prev === theme ? 'all' : theme))
                          }
                          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] transition ${
                            active
                              ? 'bg-red-600 text-white'
                              : 'bg-neutral-50 text-neutral-600 hover:bg-neutral-100'
                          }`}
                        >
                          <span className="font-medium capitalize">{theme}</span>
                          <span
                            className={`tabular-nums ${
                              active ? 'text-red-100' : 'text-neutral-400'
                            }`}
                          >
                            {count}
                          </span>
                        </button>
                      );
                    }
                  )}
                </div>
              )}

              {questionsError && (
                <p className="border-t border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">
                  {questionsError}
                </p>
              )}

              <div className="overflow-x-auto border-t border-neutral-100">
                <table className="min-w-full text-left text-sm">
                  <thead className="bg-neutral-50 text-[11px] uppercase tracking-wide text-neutral-500">
                    <tr>
                      <th className="px-4 py-3 font-medium">#</th>
                      <th className="px-4 py-3 font-medium">Soru</th>
                      <th className="px-4 py-3 font-medium">Tema</th>
                      <th className="px-4 py-3 font-medium">Adet</th>
                      <th className="px-4 py-3 font-medium">Son</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100">
                    {questionsLoading && !questionsData ? (
                      <tr>
                        <td colSpan={5} className="px-4 py-10 text-center text-neutral-400">
                          <Loader2 className="mx-auto h-5 w-5 animate-spin text-red-500" />
                        </td>
                      </tr>
                    ) : !questionsLoading && filteredQuestions.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-4 py-10 text-center text-sm text-neutral-400">
                          {questionTheme === 'all'
                            ? 'Bu dönemde kullanıcı sorusu yok.'
                            : `“${questionTheme}” temasında soru yok.`}
                        </td>
                      </tr>
                    ) : (
                      filteredQuestions.map((q, index) => (
                        <tr key={q.key} className="hover:bg-neutral-50/80">
                          <td className="px-4 py-3 tabular-nums text-neutral-400">{index + 1}</td>
                          <td className="max-w-xl px-4 py-3 text-neutral-800">{q.sample}</td>
                          <td className="px-4 py-3">
                            <ThemeBadge theme={q.theme} />
                          </td>
                          <td className="px-4 py-3 tabular-nums font-medium text-neutral-700">
                            {q.count}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-neutral-500">
                            {formatDate(q.last_asked_at)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>

        <section className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap rounded-xl bg-neutral-100 p-1">
            {(
              [
                ['all', 'Tümü'],
                ['confirmed', 'Doğrulanmış'],
                ['unconfirmed', 'Bekleyen'],
                ['active', 'Aktif 7g'],
                ['no_chat', 'Sohbetsiz'],
                ['banned', 'Yasaklı'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setStatus(value)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                  status === value
                    ? 'bg-white text-red-600 shadow-sm'
                    : 'text-neutral-500 hover:text-neutral-800'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="relative w-full lg:max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-400" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="E-posta veya ad ara…"
              className="w-full rounded-xl border border-neutral-200 bg-white py-2 pl-9 pr-3 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-red-400 focus:outline-none focus:ring-2 focus:ring-red-100"
            />
          </div>
        </section>

        <section className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm shadow-neutral-900/5">
          {error && (
            <p className="border-b border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">
              {error}
            </p>
          )}

          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-neutral-50 text-[11px] uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-4 py-3 font-medium">Ad</th>
                  <th className="px-4 py-3 font-medium">E-posta</th>
                  <th className="px-4 py-3 font-medium">Durum</th>
                  <th className="px-4 py-3 font-medium">Sohbet</th>
                  <th className="px-4 py-3 font-medium">Mesaj</th>
                  <th className="px-4 py-3 font-medium">Son aktivite</th>
                  <th className="px-4 py-3 font-medium">Kayıt</th>
                  <th className="px-4 py-3 font-medium">İşlem</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {loading && !data ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-10 text-center text-neutral-400">
                      <Loader2 className="mx-auto h-5 w-5 animate-spin text-red-500" />
                    </td>
                  </tr>
                ) : data && data.users.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-10 text-center text-sm text-neutral-400">
                      Eşleşen kullanıcı yok.
                    </td>
                  </tr>
                ) : (
                  data?.users.map((row) => {
                    const confirmed = Boolean(row.email_confirmed_at);
                    const banned = isCurrentlyBanned(row.banned_until);
                    const isSelf = row.id === user.id;
                    const rowIsAdmin = isAdminEmail(row.email);
                    const busy = banBusyId === row.id;
                    return (
                      <tr
                        key={row.id}
                        className={`hover:bg-neutral-50/80 ${banned ? 'bg-red-50/40' : ''}`}
                      >
                        <td className="px-4 py-3 font-medium text-neutral-800">
                          {row.full_name || '—'}
                        </td>
                        <td className="px-4 py-3 text-neutral-600">{row.email || '—'}</td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-1">
                            {banned ? (
                              <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-medium text-red-700">
                                Yasaklı
                              </span>
                            ) : (
                              <span
                                className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${
                                  confirmed
                                    ? 'bg-emerald-50 text-emerald-700'
                                    : 'bg-amber-50 text-amber-700'
                                }`}
                              >
                                {confirmed ? 'Doğrulandı' : 'Bekliyor'}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 tabular-nums text-neutral-700">
                          {row.conversation_count}
                        </td>
                        <td className="px-4 py-3 tabular-nums text-neutral-700">
                          {row.message_count}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-neutral-500">
                          {formatDate(row.last_activity_at)}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-neutral-500">
                          {formatDate(row.created_at)}
                        </td>
                        <td className="px-4 py-3">
                          {isSelf || rowIsAdmin ? (
                            <span className="text-[11px] text-neutral-400">
                              {isSelf ? 'Siz' : 'Yönetici'}
                            </span>
                          ) : (
                            <button
                              type="button"
                              disabled={busy || loading}
                              onClick={() => void toggleBan(row)}
                              className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-medium transition disabled:opacity-50 ${
                                banned
                                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                                  : 'border-red-200 bg-red-50 text-red-700 hover:bg-red-100'
                              }`}
                            >
                              {busy ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : banned ? (
                                <ShieldOff className="h-3 w-3" />
                              ) : (
                                <Ban className="h-3 w-3" />
                              )}
                              {banned ? 'Yasağı kaldır' : 'Yasakla'}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {data && data.totalPages > 1 && (
            <div className="flex items-center justify-between border-t border-neutral-100 px-4 py-3 text-xs text-neutral-500">
              <span>
                {data.totalFiltered} sonuç · Sayfa {data.page}/{data.totalPages}
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={page <= 1 || loading}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="rounded-lg border border-neutral-200 px-2.5 py-1 disabled:opacity-40"
                >
                  Önceki
                </button>
                <button
                  type="button"
                  disabled={page >= data.totalPages || loading}
                  onClick={() => setPage((p) => p + 1)}
                  className="rounded-lg border border-neutral-200 px-2.5 py-1 disabled:opacity-40"
                >
                  Sonraki
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function StatCard({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: number;
}) {
  return (
    <div className="rounded-2xl border border-neutral-200 bg-white px-4 py-3 shadow-sm shadow-neutral-900/5">
      <div className="flex items-center gap-2 text-xs text-neutral-500">
        {icon}
        {label}
      </div>
      <p className="mt-1 text-2xl font-semibold tracking-tight text-neutral-900">{value}</p>
    </div>
  );
}

function FunnelStep({
  label,
  value,
  hint,
  active,
}: {
  label: string;
  value: number;
  hint: string;
  active: boolean;
}) {
  return (
    <div
      className={`rounded-xl border px-4 py-3 ${
        active ? 'border-red-100 bg-red-50/40' : 'border-neutral-100 bg-neutral-50'
      }`}
    >
      <div className="flex items-center gap-2 text-xs text-neutral-500">
        <MessageSquare className="h-3.5 w-3.5 text-red-500" />
        {label}
      </div>
      <p className="mt-1 text-xl font-semibold text-neutral-900">{value}</p>
      <p className="text-[11px] text-neutral-400">{hint}</p>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-neutral-50 px-3 py-2">
      <p className="text-[11px] text-neutral-500">{label}</p>
      <p className="text-sm font-semibold tabular-nums text-neutral-800">{value}</p>
    </div>
  );
}

function ThemeBadge({ theme }: { theme: QuestionTheme }) {
  const styles: Record<QuestionTheme, string> = {
    ürün: 'bg-sky-50 text-sky-700',
    kargo: 'bg-violet-50 text-violet-700',
    ödeme: 'bg-emerald-50 text-emerald-700',
    stok: 'bg-amber-50 text-amber-700',
    diğer: 'bg-neutral-100 text-neutral-600',
  };

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${styles[theme]}`}
    >
      {theme}
    </span>
  );
}

function ReportStatusBadge({ status }: { status: AnswerReportStatus }) {
  const styles: Record<AnswerReportStatus, string> = {
    open: 'bg-red-50 text-red-700',
    reviewed: 'bg-emerald-50 text-emerald-700',
    dismissed: 'bg-neutral-100 text-neutral-600',
  };
  const labels: Record<AnswerReportStatus, string> = {
    open: 'Açık',
    reviewed: 'İncelendi',
    dismissed: 'Kapatıldı',
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${styles[status]}`}
    >
      {labels[status]}
    </span>
  );
}
