import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/v1': 'http://localhost:3000', '/openapi.json': 'http://localhost:3000' } },
  test: { environment: 'jsdom' },
});
