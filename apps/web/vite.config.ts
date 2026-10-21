import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  build: { rollupOptions: { output: { manualChunks: { supabase: ['@supabase/supabase-js'] } } } },
  server: { port: 5173, proxy: { '/v1': 'http://localhost:3000', '/openapi.json': 'http://localhost:3000' } },
  preview: { port: 4173, proxy: { '/v1': 'http://localhost:3000', '/openapi.json': 'http://localhost:3000' } },
  test: { environment: 'jsdom' },
});
