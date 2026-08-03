/**
 * Domain + Supabase Auth URL + Resend SMTP kurulum yardımcısı.
 *
 * Kullanım:
 *   CUSTOM_DOMAIN=chat.ornek.com SUPABASE_ACCESS_TOKEN=sbp_... node scripts/setup-auth-config.mjs
 *
 * SUPABASE_ACCESS_TOKEN: https://supabase.com/dashboard/account/tokens
 * CUSTOM_DOMAIN yoksa mevcut Vercel production URL kullanılır.
 */
import { execSync } from 'child_process';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local', override: true });

const PROJECT_REF = 'cyzalrwbuozrgmnrpcqr';
const customDomain = (process.env.CUSTOM_DOMAIN || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '') ||
  (customDomain ? `https://${customDomain}` : 'https://rag-chatbot-seven-beta.vercel.app');

const accessToken = process.env.SUPABASE_ACCESS_TOKEN?.trim();
const resendKey = process.env.RESEND_API_KEY?.trim();
const senderEmail =
  process.env.RESEND_FROM_EMAIL?.trim() ||
  (customDomain ? `noreply@${customDomain}` : 'onboarding@resend.dev');

console.log('=== Auth / Domain Setup ===');
console.log('Site URL:', siteUrl);

// 1) Vercel domain
if (customDomain) {
  try {
    console.log(`\n[Vercel] Adding domain ${customDomain}...`);
    const out = execSync(`vercel domains add ${customDomain}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log(out || 'Domain add requested.');
  } catch (e) {
    const msg = e.stderr?.toString() || e.message;
    console.log('[Vercel] Domain add result:', msg.slice(0, 500));
    console.log('DNS: Subdomain için CNAME → cname.vercel-dns.com');
  }
} else {
  console.log('\n[Vercel] CUSTOM_DOMAIN yok — production alias kullanılacak:');
  console.log('  https://rag-chatbot-seven-beta.vercel.app');
  console.log('  Özel domain için: CUSTOM_DOMAIN=chat.ornek.com node scripts/setup-auth-config.mjs');
}

// 2) Supabase Auth URLs
const redirectUrls = [
  `${siteUrl}/**`,
  `${siteUrl}/auth/callback`,
  'http://localhost:3000/**',
  'http://localhost:3000/auth/callback',
  'https://rag-chatbot-seven-beta.vercel.app/**',
  'https://rag-chatbot-seven-beta.vercel.app/auth/callback',
];

const confirmSubject = 'Ores RAG Asistanı — hesabınızı doğrulayın';
const confirmHtml = `<h2>Merhaba,</h2>
<p>Ores RAG Asistanı hesabınızı oluşturduğunuz için teşekkürler.</p>
<p>Hesabınızı etkinleştirmek için aşağıdaki bağlantıya tıklayın:</p>
<p><a href="{{ .ConfirmationURL }}">E-posta adresimi doğrula</a></p>
<p>Bu işlemi siz başlatmadıysanız bu e-postayı yok sayabilirsiniz.</p>`;

if (accessToken) {
  console.log('\n[Supabase] Updating Auth URL + Confirm email + template...');
  const payload = {
    site_url: siteUrl,
    uri_allow_list: redirectUrls.join(','),
    external_email_enabled: true,
    mailer_autoconfirm: false,
    mailer_subjects_confirmation: confirmSubject,
    mailer_templates_confirmation_content: confirmHtml,
  };

  if (resendKey) {
    Object.assign(payload, {
      smtp_admin_email: senderEmail,
      smtp_sender_name: 'Ores RAG Asistanı',
      smtp_host: 'smtp.resend.com',
      smtp_port: '465',
      smtp_user: 'resend',
      smtp_pass: resendKey,
      smtp_max_frequency: 60,
    });
    console.log('[Supabase] Resend SMTP alanları da gönderilecek.');
  } else {
    console.log('[Resend] RESEND_API_KEY yok — SMTP atlandı (Confirm email yine ON).');
  }

  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/config/auth`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  console.log('[Supabase] status', res.status, body.slice(0, 400));
  if (!res.ok) process.exitCode = 1;
} else {
  console.log('\n[Supabase] SUPABASE_ACCESS_TOKEN yok — Dashboard adımları:');
  console.log('  Authentication → URL Configuration');
  console.log('  Site URL =', siteUrl);
  console.log('  Redirect URLs =');
  redirectUrls.forEach((u) => console.log('   -', u));
  console.log('\n  Project Settings → Auth → SMTP:');
  console.log('   Host: smtp.resend.com');
  console.log('   Port: 465');
  console.log('   User: resend');
  console.log('   Pass: <RESEND_API_KEY>');
  console.log('   Sender:', senderEmail);
  console.log('  Authentication → Providers → Email → Confirm email: ON');
}

console.log('\n=== Confirm signup e-posta şablonu (Supabase → Email Templates) ===');
console.log(`Konu: Ores RAG Asistanı — hesabınızı doğrulayın

<body>
  <h2>Merhaba,</h2>
  <p>Ores RAG Asistanı hesabınızı oluşturduğunuz için teşekkürler.</p>
  <p>Hesabınızı etkinleştirmek için aşağıdaki bağlantıya tıklayın:</p>
  <p><a href="{{ .ConfirmationURL }}">E-posta adresimi doğrula</a></p>
  <p>Bu işlemi siz başlatmadıysanız bu e-postayı yok sayabilirsiniz.</p>
</body>
`);

console.log('Done.');
