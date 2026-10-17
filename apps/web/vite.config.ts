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
        name: 'PrintoutBuddy',
        short_name: 'PrintoutBuddy',
        description: 'Send your files to a nearby print shop, print them there, and track your order.',
        start_url: '/',
        display: 'standalone',
        background_color: '#FBFBF8',
        theme_color: '#14213D',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      // Never cache API traffic or documents: orders need connectivity and documents are private.
      workbox: { navigateFallbackDenylist: [/^\/api\//], runtimeCaching: [] }
    })
  ],
  server: { port: 5173, proxy: { '/api': { target: process.env.VITE_API_TARGET ?? 'http://localhost:3000', changeOrigin: false } } },
  // Page-level tests render whole screens in jsdom. With one jsdom worker per core (11+) and other processes running (browser tests,
  // a second suite, CI runners) they miss the 5 s default test timeout and Testing Library's 1 s async wait; reproduced by running three
  // suites at once. Cap the workers and give async waits and tests realistic headroom. Assertions are unchanged.
  test: { environment: 'jsdom', globals: true, setupFiles: ['./src/test-setup.ts'], css: false, maxWorkers: 4, testTimeout: 30_000, hookTimeout: 30_000 }
});
