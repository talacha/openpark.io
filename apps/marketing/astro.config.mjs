import { defineConfig } from 'astro/config';

// Static output: serve from any CDN. No database, no tracking cookies.
export default defineConfig({
  site: 'https://openpark.io',
  output: 'static',
  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'es-MX', 'es-ES', 'pt-BR', 'fr', 'de', 'ar'],
    routing: { prefixDefaultLocale: false },
  },
});
