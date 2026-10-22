import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'
import { copyOcrAssets } from './scripts/copy-ocr-assets.mjs'

const coreSrc = fileURLToPath(new URL('../../packages/core/src', import.meta.url))

/** Copies tesseract worker/core/traineddata into public/tesseract before dev and build (see README). */
function ocrAssets(): Plugin {
  return {
    name: 'steptrack-ocr-assets',
    async buildStart() {
      await copyOcrAssets({ quiet: true })
    },
  }
}

export default defineConfig({
  plugins: [
    ocrAssets(),
    vue(),
    VitePWA({
      strategies: 'generateSW',
      // an update must never reload the tablet in the middle of a step: the app asks first (src/pwa.ts)
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['icons/*.png', 'icons/*.svg'],
      manifest: {
        name: 'StepTrack',
        short_name: 'StepTrack',
        description: 'Procedure execution and as-run records for manual assembly',
        lang: 'en',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        theme_color: '#1f5fbf',
        background_color: '#f6f7f9',
        categories: ['productivity', 'business'],
        icons: [
          { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // app shell + OCR assets (worker, LSTM cores ~3.9 MB each, eng traineddata ~2.9 MB)
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,ico,webmanifest,woff2}', 'tesseract/**/*.{js,json,gz}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api(\/|$)/],
        // procedures, runs and blobs live in IndexedDB; the API is never cached by the service worker
        runtimeCaching: [],
        cleanupOutdatedCaches: true,
        clientsClaim: false,
        skipWaiting: false,
      },
    }),
  ],
  resolve: {
    alias: [
      { find: '@steptrack/core', replacement: coreSrc },
      // the library's own '@/…' imports resolve in dev too
      { find: '@', replacement: coreSrc },
    ],
    dedupe: ['vue', 'vue-router', 'pinia', 'vue-i18n'],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
})
