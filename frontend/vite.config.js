import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Custom service worker (src/sw.js) instead of the auto-generated one —
      // needed for the push/notificationclick listeners (Web Push
      // notifications on followed-topic spikes). Runtime caching for /api
      // now lives in src/sw.js itself (registerRoute + NetworkFirst) since
      // injectManifest doesn't support the workbox.runtimeCaching shorthand.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.js',
      injectManifest: {
        // data.json is a ~20MB corpus export fetched at startup (see App.jsx) —
        // never precache it, it must always hit the network like today.
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
        globIgnores: ['data.json'],
        // Main bundle is ~5MB (plotly.js is the bulk of it); above Workbox's
        // 2MB default. Raise the ceiling rather than exclude it from
        // precache, so the app still works offline after first load.
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
      manifest: {
        name: 'Le Kiosque',
        short_name: 'Kiosque',
        description: 'La presse gabonaise interrogeable',
        lang: 'fr',
        start_url: '/',
        display: 'standalone',
        background_color: '#F4F6F4',
        theme_color: '#2E554B',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  server: {
    host: true,
    // Cloudflare quick-tunnel hostnames (cloudflared tunnel --url ...)
    allowedHosts: ['.trycloudflare.com'],
    // Single shareable origin: the frontend calls /api/*, Vite forwards to
    // the FastAPI server, so remote visitors never need to reach localhost
    proxy: {
      '/api': {
        target: 'http://localhost:8010',
        changeOrigin: true,
        // Forward the visitor's IP so the API's per-client rate limiting
        // doesn't lump everyone into the proxy's 127.0.0.1
        xfwd: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
