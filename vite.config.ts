import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'
import { aiApiPlugin } from './server/vite-api'

export default defineConfig({
  plugins: [
    aiApiPlugin(),
    react(),
    tailwindcss(),
    VitePWA({
      // New SW takes over automatically — no manual refresh needed.
      registerType: 'autoUpdate',
      // We register the SW ourselves in main.tsx so we can also poll for
      // updates on visibilitychange (critical for installed/home-screen PWAs
      // that are resumed from background rather than cold-started).
      injectRegister: false,
      includeAssets: ['favicon.svg', 'icons/*.png'],
      manifest: {
        name: 'Kura 蔵',
        short_name: 'Kura',
        description: '个人购物决策与消费感知',
        theme_color: '#09090b',
        background_color: '#09090b',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
        // Pull the Web Push handlers (push / notificationclick) into the generated
        // SW. push-sw.js lives in public/ → served at /push-sw.js.
        importScripts: ['/push-sw.js'],
        // Take control of open pages immediately and purge stale precaches,
        // so an updated SW never serves an old index.html / JS bundle.
        clientsClaim: true,
        skipWaiting: true,
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/.*\.supabase\.co\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'supabase-cache',
              expiration: { maxEntries: 50, maxAgeSeconds: 300 },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
