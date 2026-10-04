import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Printout',
        short_name: 'Printout',
        description: 'Upload, configure and track print orders.',
        start_url: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#1d4ed8',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
        ]
      },
      // Never cache API traffic or documents: orders need connectivity and documents are private.
      workbox: { navigateFallbackDenylist: [/^\/api\//], runtimeCaching: [] }
    })
  ],
  server: { port: 5173, proxy: { '/api': { target: process.env.VITE_API_TARGET ?? 'http://localhost:3000', changeOrigin: false } } },
  test: { environment: 'jsdom', globals: true, setupFiles: ['./src/test-setup.ts'], css: false }
});
