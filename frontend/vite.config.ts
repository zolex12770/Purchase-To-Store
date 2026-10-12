import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API this app is served in front of. Fixed at the Purchase backend's port
// unless overridden, which lets an isolated test copy run beside production
// (its own port, its own backend) without editing this file.
const apiTarget = process.env.VITE_API_PROXY ?? 'http://localhost:4001';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // 0.0.0.0 — required for LAN access (http://172.16.18.22:8080/)
    port: 8080, // 6000 is blocked by Chrome/Edge/Firefox as an "unsafe port" (legacy X11) — 8080 is not
    strictPort: false,
    proxy: {
      // The SPA talks to a same-origin /api path in development, so no CORS
      // preflight and no hard-coded backend URL in the client bundle.
      // Must match backend/.env PORT (canonically 4000 — see backend/src/config/env.ts).
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: true,
    port: 8080,
    strictPort: false,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          charts: ['recharts'],
          query: ['@tanstack/react-query'],
        },
      },
    },
  },
});
