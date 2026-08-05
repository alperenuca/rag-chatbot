 RAG Chatbot

Türkçe e-ticaret asistanı. Ürün kataloğu ve mağaza politikaları hakkında soruları yanıtlar; cevapları mümkün olduğunca belge ve veritabanı gerçeklerine dayandırır.

**Canlı:** [rag-chatbot-seven-beta.vercel.app](wwww.wed1ng.shop)

---

## Ne işe yarar?

Kullanıcı sohbette örneğin şunları sorabilir:

- “500 TL altında gümüş çerçeve var mı?”
- “Bu üründen 3 tane alırsam stok yeter mi?”
- “İade süresi kaç gün?” / “Sepetim 749 TL, kargo ücretsiz mi?”

Asistan ürün listeler, fiyat/stok bilgisi verir, politika sorularını kaynaklara bağlar ve gerektiğinde ürün kartlarıyla gösterir.

---

## Teknoloji

| Katman | Araç |
|--------|------|
| Frontend | Next.js, React, Tailwind |
| Auth & DB | Supabase (Auth, Postgres, pgvector) |
| LLM | OpenAI (embedding, chat, tool calling) |
| Deploy | Vercel |

---

## Nasıl çalışır?

```
Kullanıcı mesajı
      ↓
Intent / filtre anlama (fiyat, renk, kategori, stok…)
      ↓
┌─────────────┬──────────────┬────────────────┐
│ Deterministik│ Tool calling │ Politika / RAG │
│ SQL listing  │ search_products│ lazy vector   │
└─────────────┴──────────────┴────────────────┘
      ↓
SSE stream → sohbet UI (adımlar + cevap + kaynaklar)
      ↓
Supabase’e sohbet kaydı
```

Özetle:

1. **Net ürün soruları** çoğu zaman LLM’e gitmeden SQL / DB facts ile cevaplanır.
2. **Filtre / sıralama** gerektiğinde `search_products` aracı veritabanında çalışır.
3. **Politika ve belirsiz sorular** için embedding + vektör arama (lazy) kullanılır.
4. Cevap **canlı stream** edilir; “Nasıl yanıtladım” adımları UI’da görünür.

---

## Özellikler

### Sohbet
- Markdown cevaplar, ürün carousel / kartlar
- Kaynaklar paneli (politika ve ürün ayrımı)
- Canlı SSE streaming ve süreç adımları
- Çoklu sohbet geçmişi (sidebar)
- Yanlış cevap raporlama (“Raporla”)

### Akıllı ürün cevapları
- Türkçe filtre parse: fiyat aralığı, “üzerinde / altında”, renk, mm ölçü, stok, köşe tipi
- Konuşma takibi: ürün pin, adet, bütçe yeterliliği, kargo eşiği
- Katalog / kategori gezinme ve sıralama (en ucuz, en ağır…)

### Auth
- Supabase ile giriş ve e-posta doğrulama
- Kullanıcıya özel konuşma geçmişi

### Admin paneli (`/admin`)
- Allowlist ile yönetici erişimi (`ADMIN_EMAILS`)
- Kullanıcı listesi, arama, onay durumu
- Ban / unban
- Popüler soru ve tema özeti
- Gelen cevap raporlarını inceleme ve durum takibi

### Veri & kalite
- `data/urunler.csv` + `data/politikalar.md` → ingest → embeddings
- Ürün / edge-case eval script’leri
- SSE smoke testi

---

## Proje yapısı

```
src/
  app/
    page.tsx                 # Chat arayüzü
    admin/                   # Yönetici paneli
    api/
      chat/                  # Asıl sohbet motoru
      conversations/         # Sohbet CRUD
      reports/               # Kullanıcı raporları
      admin/                 # Admin API’leri
  components/                # ChatMessage, kartlar, kaynaklar, adımlar…
  lib/
    chat-stream.ts           # SSE protokolü
    supabase/                # Client / server / admin
scripts/
  ingest.ts                  # Veri yükleme
  eval-*.mjs                 # Kalite testleri
supabase/
  chat_history_schema.sql
  answer_reports_schema.sql
data/
  urunler.csv
  politikalar.md
```

---

## Kurulum

### 1. Bağımlılıklar

```bash
npm install
```

### 2. Ortam değişkenleri

`.env.example` dosyasını `.env.local` olarak kopyalayın:

```bash
cp .env.example .env.local
```

Doldurulması gerekenler:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY`
- `NEXT_PUBLIC_SITE_URL` (production’da auth redirect için)
- `ADMIN_EMAILS` / `NEXT_PUBLIC_ADMIN_EMAILS` (yönetici e-postaları)

### 3. Veritabanı

Supabase SQL Editor’de şemaları uygulayın:

- Sohbet geçmişi → `supabase/chat_history_schema.sql`
- Cevap raporları → `supabase/answer_reports_schema.sql`
- (Vektör arama için `documents` tablosu + `match_documents` RPC — ingest ile birlikte kullanılır)

### 4. Veriyi yükleyin

```bash
npm run ingest
```

### 5. Çalıştırın

```bash
npm run dev
```

Tarayıcı: [http://localhost:3000](http://localhost:3000)

---

## Faydalı komutlar

| Komut | Açıklama |
|-------|----------|
| `npm run dev` | Geliştirme sunucusu |
| `npm run build` | Production build |
| `npm run ingest` | Ürün/politika embedding yükleme |
| `node scripts/eval-product-questions.mjs` | Ürün soru eval |
| `node scripts/eval-hard-questions.mjs` | Zor soru eval |
| `node scripts/smoke-stream.mjs` | SSE smoke test |

---

## Notlar

- Chat mantığının büyük kısmı `src/app/api/chat/route.ts` içindedir (intent, filtre, listing, policy, tools).
- Ürün yollarında vektör arama bilinçli olarak geciktirilir; maliyet ve hız için SQL önceliklidir.
- Admin’e erişim yalnızca allowlist’teki e-postal adreslerine açıktır.
