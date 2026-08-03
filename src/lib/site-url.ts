/**
 * Uygulamanın kanonik public URL'i (e-posta doğrulama redirect'i için).
 * Production'da NEXT_PUBLIC_SITE_URL tercih edilir; yoksa Vercel URL veya
 * tarayıcı origin'ine düşülür.
 */
export function getSiteUrl(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/$/, '');
  if (configured) return configured;

  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim().replace(/\/$/, '');
  if (vercel) return `https://${vercel}`;

  const vercelUrl = process.env.VERCEL_URL?.trim().replace(/\/$/, '');
  if (vercelUrl) return `https://${vercelUrl}`;

  return 'http://localhost:3000';
}
