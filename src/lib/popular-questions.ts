export type QuestionTheme = 'ürün' | 'kargo' | 'ödeme' | 'stok' | 'diğer';

export type PopularQuestion = {
  key: string;
  sample: string;
  count: number;
  last_asked_at: string;
  theme: QuestionTheme;
};

const THEME_RULES: { theme: QuestionTheme; patterns: RegExp[] }[] = [
  {
    theme: 'kargo',
    patterns: [/kargo/, /teslimat/, /gönderim/, /kurye/, /nakliye/],
  },
  {
    theme: 'ödeme',
    patterns: [/ödeme/, /öde/, /fiyat/, /indirim/, /iyzico/, /eft/, /havale/, /kart/, /taksit/],
  },
  {
    theme: 'stok',
    patterns: [/stok/, /mevcut/, /var mı/, /tükendi/, /kalmış/],
  },
  {
    theme: 'ürün',
    patterns: [
      /çerçeve/,
      /pano/,
      /afiş/,
      /kaldırım/,
      /alüminyum/,
      /ürün/,
      /\ba\d\b/,
      /\bb\d\b/,
    ],
  },
];

/** E-posta / telefon benzeri parçaları maskele. */
export function maskPii(text: string): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[e-posta]')
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, '[telefon]');
}

/** Karşılaştırma için metni sadeleştir. */
export function normalizeQuestion(raw: string): string {
  return raw
    .normalize('NFKC')
    .toLocaleLowerCase('tr-TR')
    .replace(/[''`´]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function detectTheme(normalized: string): QuestionTheme {
  for (const rule of THEME_RULES) {
    if (rule.patterns.some((re) => re.test(normalized))) {
      return rule.theme;
    }
  }
  return 'diğer';
}

/**
 * Kullanıcı mesajlarından popüler soru gruplarını üretir.
 * Aynı normalize anahtarı bir grupta toplanır; örnek metin en uzun/en anlamlı olan seçilir.
 */
export function aggregatePopularQuestions(
  rows: { content: string; created_at: string }[],
  limit = 30
): PopularQuestion[] {
  type Bucket = {
    key: string;
    sample: string;
    count: number;
    last_asked_at: string;
    theme: QuestionTheme;
  };

  const buckets = new Map<string, Bucket>();

  for (const row of rows) {
    const masked = maskPii(row.content.trim());
    if (!masked || masked.length < 2) continue;

    const key = normalizeQuestion(masked);
    if (!key || key.length < 2) continue;
    // Çok uzun yapıştırma / spam metinlerini ele
    if (key.length > 280) continue;

    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, {
        key,
        sample: masked.slice(0, 240),
        count: 1,
        last_asked_at: row.created_at,
        theme: detectTheme(key),
      });
      continue;
    }

    existing.count += 1;
    if (new Date(row.created_at).getTime() > new Date(existing.last_asked_at).getTime()) {
      existing.last_asked_at = row.created_at;
    }
    // Daha okunaklı örnek tut (daha uzun, makul uzunlukta)
    if (masked.length > existing.sample.length && masked.length <= 240) {
      existing.sample = masked;
    }
  }

  return Array.from(buckets.values())
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return new Date(b.last_asked_at).getTime() - new Date(a.last_asked_at).getTime();
    })
    .slice(0, limit);
}
