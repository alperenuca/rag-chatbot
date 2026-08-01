import WebSocket from 'ws';
(globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = WebSocket;

import fs from 'fs';
import path from 'path';
import csv from 'csv-parser';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local', override: true });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const openaiKey = process.env.OPENAI_API_KEY!;

if (!supabaseUrl || !supabaseKey || !openaiKey) {
  console.error("❌ Hata: .env.local içerisindeki API anahtarları eksik!");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
const openai = new OpenAI({ apiKey: openaiKey });

// Ürün Arayüzü (Interface)
interface Product {
  isim: string;
  aciklama: string;
  kategori: string;
  fiyat: string;
  stok: string;
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

  return new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (row: Product) => products.push(row))
      .on('end', async () => {
        console.log(`📦 ${products.length} adet ürün işleniyor...`);
        
        for (const product of products) {
          const content = `Ürün Adı: ${product.isim}\nAçıklama: ${product.aciklama}\nKategori: ${product.kategori}\nFiyat: ${product.fiyat} TL\nStok: ${product.stok}`;
          
          const embedding = await getEmbedding(content);

          const { error } = await supabase.from('documents').insert({
            content: content,
            metadata: {
              source: 'urunler.csv',
              type: 'product',
              name: product.isim,
              category: product.kategori,
              price: parseFloat(product.fiyat),
              stock: parseInt(product.stok, 10)
            },
            embedding: embedding
          });

          if (error) console.error(`❌ Hata (${product.isim}):`, error.message);
          else console.log(`✅ Ürün eklendi: ${product.isim}`);
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
  console.log("🚀 Veri yükleme işlemi başladı...");
  await processProducts();
  await processPolicies();
  console.log("🎉 Tüm veriler Supabase'e başarıyla yüklendi!");
}

main().catch(console.error);