import {defineConfig} from 'vite';
import {VitePWA} from 'vite-plugin-pwa';

export default defineConfig({
  /* Unterpfad beim Hosting, z. B. BASE=/leistungsdiagnostik/ fuer GitHub Pages */
  base: process.env.BASE || '/',
  build: {target: 'es2022'},
  plugins: [
    VitePWA({
      /* neue Version erst beim naechsten Start aktivieren, damit laufende Eingaben nicht durch einen Reload verloren gehen */
      registerType: 'prompt',
      includeAssets: ['icon.svg', 'favicon.ico', 'apple-touch-icon-180x180.png'],
      manifest: {
        name: 'Leistungsdiagnostik',
        short_name: 'Leistungsdiagnostik',
        description: 'Leistungsdiagnostik für Handball-Mannschaften',
        lang: 'de',
        theme_color: '#111418',
        background_color: '#111418',
        display: 'standalone',
        icons: [
          {src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png'},
          {src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png'},
          {src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png'},
          {src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable'}
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        /* Excel-Modul wird bei Bedarf von cdnjs geladen und danach offline vorgehalten */
        runtimeCaching: [{
          urlPattern: ({url}) => url.origin === 'https://cdnjs.cloudflare.com',
          handler: 'CacheFirst',
          options: {cacheName: 'cdn', expiration: {maxEntries: 10}, cacheableResponse: {statuses: [0, 200]}}
        }]
      }
    })
  ]
});
