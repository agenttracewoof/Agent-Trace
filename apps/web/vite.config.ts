import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * `base` приходить складанням. На Vercel (T060) сторінка живе в корені домену,
 * а проєктні GitHub Pages віддають її з підшляху `/Agent-Trace/` — і шлях до
 * ассетів мусить це знати ще на етапі збірки. Роутер бере той самий префікс із
 * `import.meta.env.BASE_URL`, тож джерело правди одне.
 */
export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? '/',
  plugins: [react(), tailwindcss()],
  server: { port: 5173 },
})
