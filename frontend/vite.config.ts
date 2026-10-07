import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { verificarCspPanelPlugin } from './scripts/verificar-csp-panel.ts'

// https://vite.dev/config/
// Dos páginas independientes: el sitio público (index.html) y el panel
// (panel.html). El panel no se importa desde el sitio público.
export default defineConfig({
  plugins: [react(), tailwindcss(), verificarCspPanelPlugin()],
  build: {
    rolldownOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        panel: resolve(import.meta.dirname, 'panel.html'),
      },
    },
  },
})
