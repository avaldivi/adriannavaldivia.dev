import { defineConfig } from 'astro/config';

export default defineConfig({
  site: "https://adriannavaldivia.dev",
  output: "static",
  prefetch: true,
  compressHTML: true,
});