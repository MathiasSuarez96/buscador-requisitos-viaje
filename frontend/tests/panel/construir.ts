// Build real de Vite para las pruebas de build.prueba.ts, en un proceso aparte.
// Usa vite.config.ts (con la comprobación del panel) pero ignora los .env del
// proyecto: envDir apunta a una carpeta vacía, así que las variables salen
// solo del entorno del proceso (VITE_*, VERCEL, PANEL_BUILD_ESTRICTO).
//
// Uso: node tests/panel/construir.ts <outDir>

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'vite'

const salida = process.argv[2]
if (!salida) throw new Error('falta outDir')
const envVacio = mkdtempSync(join(tmpdir(), 'panel-env-'))
try {
  await build({ root: resolve(import.meta.dirname, '../..'), envDir: envVacio, build: { outDir: salida, emptyOutDir: true } })
} finally {
  rmSync(envVacio, { recursive: true, force: true })
}
