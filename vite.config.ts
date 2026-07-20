import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/Links-Downloader/',
  build: {
    target: 'es2022',
    cssCodeSplit: true,
    sourcemap: false,
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
})
