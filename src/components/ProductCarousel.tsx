'use client';

import { ArrowUpRight } from 'lucide-react';
import type { DocumentSource } from './SourcesAccordion';

export interface ProductCardData {
  title: string;
  dimension?: string;
  price?: number | null;
  stock?: number;
  url?: string;
  category?: string;
}

/**
 * Backend, ürün yanıtlarında ham `sources` (documents) dizisini zaten
 * döndürüyor; Markdown tablosu yerine kart göstermek için ayrı bir API alanı
 * eklemeye gerek yok - kartlar doğrudan bu dizideki `metadata`den türetilir.
 */
export function extractProductCards(sources?: DocumentSource[]): ProductCardData[] {
  if (!sources) return [];
  return sources
    .filter((source) => source.metadata?.type === 'product')
    .map((source) => ({
      title: source.metadata?.title ?? source.metadata?.name ?? 'Ürün',
      dimension: source.metadata?.dimension,
      price: source.metadata?.price,
      stock: source.metadata?.stock,
      url: source.metadata?.url,
      category: source.metadata?.category,
    }));
}

function formatPrice(price?: number | null): string {
  if (typeof price !== 'number') return 'Belirtilmemiş';
  return `${price.toLocaleString('tr-TR')} TL`;
}

// 10'dan fazla ürün geldiğinde tek satırlık bir yatay şerit çok uzayıp
// keşfedilebilirliği düşürüyor; bu eşikten sonra kartları dikeyde
// büyütmeden 2 satırlı bir şeride (grid-flow-col) dağıtıp yine yatayda
// kaydırılabilir hâlde sunuyoruz. Chat'in dikey boyutu her koşulda sabit
// kalır (2 satırlık kart yüksekliğiyle sınırlıdır).
const MULTI_ROW_THRESHOLD = 10;

export default function ProductCarousel({ products }: { products: ProductCardData[] }) {
  if (products.length === 0) return null;

  const hasMultipleCategories =
    new Set(products.map((product) => product.category).filter(Boolean)).size > 1;
  const useMultiRow = products.length >= MULTI_ROW_THRESHOLD;

  return (
    <div
      className={`w-full gap-3 overflow-x-auto pb-2 pt-0.5 pr-1 snap-x snap-mandatory [-webkit-overflow-scrolling:touch] ${
        useMultiRow ? 'grid grid-rows-2 grid-flow-col auto-cols-max' : 'flex'
      }`}
      role="list"
      aria-label="Ürün listesi"
    >
      {products.map((product, index) => {
        const inStock = typeof product.stock !== 'number' || product.stock > 0;

        return (
          <div
            key={`${product.title}-${index}`}
            role="listitem"
            className="flex w-48 flex-shrink-0 snap-start flex-col rounded-xl border border-neutral-200 bg-white p-3 shadow-sm shadow-neutral-900/5"
          >
            {hasMultipleCategories && product.category && (
              <span className="mb-1.5 inline-block w-fit rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-medium text-red-700">
                {product.category}
              </span>
            )}
            <p className="min-h-[2.4em] text-xs font-semibold leading-snug text-neutral-800 line-clamp-2">
              {product.title}
            </p>
            {product.dimension && (
              <p className="mt-0.5 text-[11px] text-neutral-500">{product.dimension}</p>
            )}
            <span className="mt-2 text-sm font-bold text-red-600">{formatPrice(product.price)}</span>
            <span
              className={`mt-1 text-[11px] font-medium ${
                inStock ? 'text-emerald-600' : 'text-neutral-400'
              }`}
            >
              {typeof product.stock === 'number'
                ? inStock
                  ? `Stokta: ${product.stock} adet`
                  : 'Stokta yok'
                : 'Stok bilgisi yok'}
            </span>
            {product.url ? (
              <a
                href={product.url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2.5 inline-flex items-center justify-center gap-1 rounded-lg bg-gradient-to-r from-red-600 to-red-500 px-3 py-1.5 text-[11px] font-medium text-white shadow-sm shadow-red-600/20 transition-shadow hover:shadow-md hover:shadow-red-600/30"
              >
                İncele
                <ArrowUpRight className="h-3 w-3" />
              </a>
            ) : (
              <span className="mt-2.5 inline-flex items-center justify-center rounded-lg border border-neutral-200 px-3 py-1.5 text-[11px] font-medium text-neutral-400">
                Detay yok
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
