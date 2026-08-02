import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Ev dizininde de bir package-lock.json bulunduğundan Turbopack proje kökünü
  // yanlış tespit edip tüm home dizinini izlemeye çalışıyordu (EMFILE hatası).
  // Kökü açıkça bu projeye sabitliyoruz.
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
