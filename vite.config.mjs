import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const renderer = fileURLToPath(new URL('./src/renderer', import.meta.url))

export default defineConfig({
  root: renderer,
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': renderer } },
  build: {
    outDir: '../../renderer-dist',
    emptyOutDir: true,
  },
})
