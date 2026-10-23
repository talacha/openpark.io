import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
  build: { rollupOptions: { output: { manualChunks: { supabase: ['@supabase/supabase-js'] } } } },
  server: { port: 5173, proxy: { '/v1': 'http://localhost:3000', '/openapi.json': 'http://localhost:3000' } },
  preview: { port: 4173, proxy: { '/v1': 'http://localhost:3000', '/openapi.json': 'http://localhost:3000' } },
  test: { environment: 'jsdom' },
});
