/**
 * answer_reports tablosunu Supabase Management API ile kurar.
 *
 * Kullanım:
 *   SUPABASE_ACCESS_TOKEN=sbp_... node scripts/apply-answer-reports-schema.mjs
 *
 * Token: https://supabase.com/dashboard/account/tokens
 * Alternatif: supabase/answer_reports_schema.sql dosyasını SQL Editor'da çalıştırın.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local', override: true, quiet: true });

const PROJECT_REF = 'cyzalrwbuozrgmnrpcqr';
const token = process.env.SUPABASE_ACCESS_TOKEN?.trim();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sqlPath = path.join(__dirname, '..', 'supabase', 'answer_reports_schema.sql');
const sql = fs.readFileSync(sqlPath, 'utf8');

if (!token) {
  console.error('SUPABASE_ACCESS_TOKEN gerekli.');
  console.error('Veya SQL Editor’da çalıştırın:', sqlPath);
  process.exit(1);
}

const res = await fetch(
  `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  }
);

const text = await res.text();
if (!res.ok) {
  console.error('SQL apply failed:', res.status, text.slice(0, 800));
  process.exit(1);
}
console.log('✅ answer_reports schema applied');
console.log(text.slice(0, 400));
