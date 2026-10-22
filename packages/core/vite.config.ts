import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    lib: {
      entry: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
      formats: ['es'],
      fileName: 'steptrack-core',
    },
    rollupOptions: {
      // Host app provides these; also keep heavy/native deps external so the host bundler can split them.
      external: [/^vue($|\/)/, /^vue-router/, /^pinia/, /^vue-i18n/, /^@capacitor/, /^@capacitor-mlkit/, 'tesseract.js'],
    },
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
  },
})
