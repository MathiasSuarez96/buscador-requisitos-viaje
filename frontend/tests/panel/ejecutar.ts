// Ejecuta las pruebas del panel sin paquetes nuevos: Vite (ya instalado)
// transforma el TSX con ssrLoadModule; React se renderiza con react-dom/server.
// Sin red: no abre puertos ni lee .env (envFile: false).
//
// Uso (desde frontend/): npm run test:panel

import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'

interface Prueba {
  nombre: string
  fn: () => Promise<void> | void
}

const ARCHIVOS = process.argv.includes('--solo-huella') ? ['/tests/panel/huella.prueba.ts'] : process.argv.includes('--solo-listado')
  ? ['/tests/panel/listado.prueba.tsx', '/tests/panel/detalle.prueba.tsx']
  : ['/tests/panel/unidades.prueba.ts', '/tests/panel/controlador.prueba.ts', '/tests/panel/listado.prueba.tsx', '/tests/panel/detalle.prueba.tsx', '/tests/panel/fuentes.prueba.ts', '/tests/panel/build.prueba.ts', '/tests/panel/huella.prueba.ts']

const servidor = await createServer({
  root: process.argv.includes('--raiz') ? resolve(process.argv[process.argv.indexOf('--raiz') + 1]) : resolve(import.meta.dirname, '../..'),
  configFile: false,
  envFile: false,
  plugins: [react()],
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
})

let total = 0
let fallidas = 0
try {
  for (const archivo of ARCHIVOS) {
    const { pruebas } = (await servidor.ssrLoadModule(archivo)) as { pruebas: Prueba[] }
    process.stdout.write(`\n${archivo}\n`)
    for (const { nombre, fn } of pruebas) {
      total += 1
      const inicio = performance.now()
      try {
        await fn()
        process.stdout.write(`  ok   ${nombre} (${Math.round(performance.now() - inicio)} ms)\n`)
      } catch (err) {
        fallidas += 1
        process.stdout.write(`  FALLÓ ${nombre}\n${String((err as Error)?.stack ?? err).replace(/^/gm, '       ')}\n`)
      }
    }
  }
} finally {
  await servidor.close()
}

process.stdout.write(`\n${total - fallidas}/${total} pruebas OK\n`)
process.exitCode = fallidas === 0 ? 0 : 1
