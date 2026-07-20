import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Relative assets let the same static build run at a Vercel root domain or
  // inside a GitHub Pages project path.
  base: './',
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
