import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Prueba } from './apoyo.tsx'

const RAIZ = resolve(import.meta.dirname, '../..')
// Assets confirmados en aa1558f. Solo guarda local: no modifica el build de Vercel.
const BASE: Record<string, string> = {
  'main-BAWQ6GBH.js': '6576a4bff939d29ea73c31bae1381899a5a842c617f86b02fac04636799c74d2',
  'main-dSpg_NR1.css': '6a64ec463072b65af734bc4985082456e3ecc7bba688d216bcb71877ec061f54',
  'jsx-runtime-BEumusn6.js': '14499e4c8ac46aed13ab8d9533c62fd9dfe18be76f784d379b2cb512d4dba27a',
  'toctoc-logo-CiSSEARy.png': 'cea8421ed137cd045aa01980cf6534655f507a364493d9abb96101741ed3906d',
}
const sha = (v: Uint8Array) => createHash('sha256').update(v).digest('hex')
const entorno = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(VITE_|VERCEL$|PANEL_BUILD_ESTRICTO$|NODE_OPTIONS$|NODE_ENV$)/.test(k))), NODE_ENV: 'production', VITE_API_URL: 'https://buscador-requisitos-viaje.onrender.com', VITE_GOOGLE_CLIENT_ID: '123456789012-abcdefghijklmnop.apps.googleusercontent.com' })

export const pruebas: Prueba[] = [{ nombre: 'huella pública aa1558f: bytes idénticos y cambios de panel/scripts/tests aislados', fn() {
  const temporal = mkdtempSync(join(tmpdir(), 'huella-panel-'))
  try {
    const resultados: string[] = []
    for (const variante of ['base', 'panel', 'excluidos']) {
      const copia = join(temporal, variante)
      mkdirSync(copia)
      for (const p of ['src', 'scripts', 'public', 'index.html', 'panel.html', 'vercel.json', 'vite.config.ts', 'package.json']) cpSync(join(RAIZ, p), join(copia, p), { recursive: true })
      // Reutiliza dependencias locales; se retira el enlace antes de limpiar.
      symlinkSync(join(RAIZ, 'node_modules'), join(copia, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
      if (variante === 'panel') {
        const entrada = join(copia, 'src/panel/PanelApp.tsx')
        writeFileSync(entrada, readFileSync(entrada, 'utf8').replace('Panel de propuestas</h1>', 'Panel cambiado</h1>').replace('max-w-6xl', 'max-w-6xl z-[9876]'))
      }
      if (variante === 'excluidos') {
        mkdirSync(join(copia, 'tests'))
        writeFileSync(join(copia, 'tests/sentinela.tsx'), 'export const clase = "z-[8765]"')
        writeFileSync(join(copia, 'scripts/sentinela.ts'), 'export const clase = "z-[7654]"')
      }
      const r = spawnSync(process.execPath, [...process.execArgv, join(RAIZ, 'tests/panel/construir-huella.ts'), copia], { cwd: RAIZ, env: entorno(), encoding: 'utf8', timeout: 120000 })
      unlinkSync(join(copia, 'node_modules'))
      assert.equal(r.status, 0, `${r.error ?? ''}\n${r.stdout}\n${r.stderr}`)
      const assets = join(copia, 'dist/assets')
      assert.ok(readdirSync(assets).includes('main-BAWQ6GBH.js'), r.stdout)
      for (const [nombre, hash] of Object.entries(BASE)) assert.equal(sha(readFileSync(join(assets, nombre))), hash, `${variante}: ${nombre}`)
      const panelCss = readdirSync(assets).find(n => /^panel-.*\.css$/.test(n))!
      const css = readFileSync(join(assets, panelCss), 'utf8')
      assert.ok(css.includes('grid-template-columns:repeat(2,'), 'utilidades responsive propias del panel')
      assert.equal(css.includes('z-index:9876'), variante === 'panel')
      assert.ok(!css.includes('8765') && !css.includes('7654'), 'tests/scripts fuera del panel')
      const cssPublico = readFileSync(join(assets, 'main-dSpg_NR1.css'), 'utf8')
      assert.ok(!cssPublico.includes('9876') && !cssPublico.includes('8765') && !cssPublico.includes('7654'))
      resultados.push(sha(readFileSync(join(copia, 'dist/index.html'))))
    }
    assert.equal(new Set(resultados).size, 1, 'index.html público idéntico')
  } finally {
    assert.ok(resolve(temporal).startsWith(resolve(tmpdir()) + '\\') || resolve(temporal).startsWith(resolve(tmpdir()) + '/'))
    rmSync(temporal, { recursive: true, force: true })
  }
} }]
