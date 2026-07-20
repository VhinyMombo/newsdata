import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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
