import WebSocket from 'ws';
(globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = WebSocket;

import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import csv from 'csv-parser';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local', override: true });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
// Bu script sunucu tarafında çalışır ve documents tablosuna insert/delete yapar.
// RLS politikaları anon key ile yazmaya izin vermediği için service_role anahtarı
// tercih edilir (yalnızca .env.local'da tutulmalı, NEXT_PUBLIC_ ile başlamamalı!).
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const openaiKey = process.env.OPENAI_API_KEY!;

if (!supabaseUrl || !supabaseKey || !openaiKey) {
  console.error("❌ Hata: .env.local içerisindeki API anahtarları eksik!");
  process.exit(1);
}

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn(
    '⚠️  SUPABASE_SERVICE_ROLE_KEY tanımlı değil, anon key kullanılıyor. RLS politikaları yazmayı engelleyebilir.'
  );
}

const supabase = createClient(supabaseUrl, supabaseKey);
const openai = new OpenAI({ apiKey: openaiKey });

// Ürün Arayüzü (Interface) — data/urunler.csv başlık satırıyla birebir eşleşir
interface Product {
  sku: string;
  urun_adi: string;
  kategori: string;
  boyut: string;
  olcu: string;
  malzeme: string;
  profil_kalinligi_mm: string;
  kose_tipi: string;
  renk: string;
  agirlik_kg: string;
  fiyat_tl: string;
  indirimli_fiyat_tl: string;
  stok_adedi: string;
  durum: string;
  aciklama: string;
  urun_url: string;
}

// Embedding Oluşturma Fonksiyonu
async function getEmbedding(text: string) {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  });
  return response.data[0].embedding;
}

// 1. Ürünleri İşle
async function processProducts() {
  const products: Product[] = [];
  const filePath = path.join(process.cwd(), 'data', 'urunler.csv');
  // CSV dosyası UTF-8 BOM ile başlıyor; kaldırılmazsa ilk sütun adı
  // ("sku") "\uFEFFsku" olarak okunur ve row.sku undefined döner.
  const rawContent = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');

  return new Promise((resolve, reject) => {
    Readable.from(rawContent)
      .pipe(csv())
      .on('data', (row: Product) => products.push(row))
      .on('end', async () => {
        console.log(`📦 ${products.length} adet ürün işleniyor...`);

        console.log('🧹 Supabase\'deki mevcut ürün kayıtları temizleniyor...');
        const { error: deleteError } = await supabase
          .from('documents')
          .delete()
          .eq('metadata->>source', 'urunler.csv');

        if (deleteError) {
          console.error('❌ Eski ürün verileri silinirken hata oluştu:', deleteError.message);
        } else {
          console.log('✅ Eski ürün verileri temizlendi.');
        }

        for (const row of products) {
          const dimension = row.boyut || row.olcu;
          // liste fiyatı (fiyat_tl) ve indirimli fiyat (indirimli_fiyat_tl)
          // AYRI AYRI saklanır (28 üründen sadece 4'ünde indirimli_fiyat_tl
          // dolu). Önceden bu ikisi tek bir `price` alanında birleştirilip
          // liste fiyatı tamamen atılıyordu; bu yüzden model bir üründe
          // indirim olup olmadığını ASLA bilemiyordu ("indirimli fiyatı
          // nedir" sorusuna yanlışlıkla "indirim yok" diyordu). `price`
          // (satılan/geçerli fiyat) hâlâ filtreleme için kullanılıyor, ama
          // artık `list_price` ve `has_discount` metadata'da da tutuluyor ve
          // `content` metninde ikisi de görünüyor.
          const listPrice = parseFloat(row.fiyat_tl) || null;
          const discountedPrice = parseFloat(row.indirimli_fiyat_tl) || null;
          const effectivePrice = discountedPrice ?? listPrice;
          const hasDiscount = Boolean(
            discountedPrice && listPrice && discountedPrice < listPrice
          );
          const weight = parseFloat(row.agirlik_kg) || null;
          const stock = parseInt(row.stok_adedi, 10) || 0;

          const priceLine = hasDiscount
            ? `Liste Fiyatı: ${listPrice} TL | İndirimli Fiyat: ${discountedPrice} TL (İndirimde)`
            : `Fiyat: ${effectivePrice ?? 'Belirtilmemiş'} TL (İndirim yok)`;

          const content = `Ürün Adı: ${row.urun_adi} | Kategori: ${row.kategori} | Malzeme: ${row.malzeme} | Renk: ${row.renk} | Boyut/Ölçü: ${dimension} | Ağırlık: ${
            weight ?? 'Belirtilmemiş'
          } kg | ${priceLine} | Stok: ${row.stok_adedi} | Açıklama: ${row.aciklama}`;

          const embedding = await getEmbedding(content);

          const { error } = await supabase.from('documents').insert({
            content: content,
            metadata: {
              source: 'urunler.csv',
              type: 'product',
              sku: row.sku,
              title: row.urun_adi,
              category: row.kategori,
              dimension: dimension,
              material: row.malzeme,
              profile_thickness_mm: row.profil_kalinligi_mm,
              color: row.renk,
              weight_kg: weight,
              price: effectivePrice,
              list_price: listPrice,
              has_discount: hasDiscount,
              stock: stock,
              url: row.urun_url,
            },
            embedding: embedding
          });

          if (error) console.error(`❌ Hata (${row.urun_adi}):`, error.message);
          else console.log(`✅ Ürün eklendi: ${row.urun_adi}`);
        }
        resolve(true);
      })
      .on('error', (err) => reject(err));
  });
}

// 2. Politikaları İşle
async function processPolicies() {
  const filePath = path.join(process.cwd(), 'data', 'politikalar.md');
  const fileContent = fs.readFileSync(filePath, 'utf-8');

  console.log('🧹 Supabase\'deki mevcut politika kayıtları temizleniyor...');
  const { error: deleteError } = await supabase
    .from('documents')
    .delete()
    .eq('metadata->>source', 'politikalar.md');

  if (deleteError) {
    console.error('❌ Eski politika verileri silinirken hata oluştu:', deleteError.message);
  } else {
    console.log('✅ Eski politika verileri temizlendi.');
  }

  // Başlıklara göre (##) politikayı parçala (Chunking)
  const sections = fileContent.split(/(?=^##\s)/m);

  console.log(`📄 ${sections.length} adet politika bölümü işleniyor...`);

  for (const section of sections) {
    if (!section.trim()) continue;
    
    const embedding = await getEmbedding(section.trim());

    const { error } = await supabase.from('documents').insert({
      content: section.trim(),
      metadata: {
        source: 'politikalar.md',
        type: 'policy'
      },
      embedding: embedding
    });

    if (error) console.error(`❌ Politika ekleme hatası:`, error.message);
    else console.log(`✅ Politika bölümü eklendi.`);
  }
}

async function main() {
  // `npm run ingest -- --only=products` veya `--only=policies` ile sadece
  // ilgili veri setini yeniden işlemek mümkündür.
  const onlyArg = process.argv.find((arg) => arg.startsWith('--only='));
  const only = onlyArg?.split('=')[1];

  console.log("🚀 Veri yükleme işlemi başladı...");

  if (!only || only === 'products') {
    await processProducts();
  }
  if (!only || only === 'policies') {
    await processPolicies();
  }

  console.log("🎉 Tüm veriler Supabase'e başarıyla yüklendi!");
}

main().catch(console.error);