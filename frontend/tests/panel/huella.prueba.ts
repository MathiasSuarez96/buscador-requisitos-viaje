import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Prueba } from './apoyo.tsx'

const RAIZ = resolve(import.meta.dirname, '../..')
// Huella pública local aprobada para el build reproducible; no modifica Vercel.
const BASE: Record<string, string> = {
  'main-DQWu3QQB.js': 'de46237ee1d493ec8ad647ddf2a830f6f761a526754edf70cc5738179575cd06',
  'main-CrgIgJwf.css': '9d194a6a2c1ccebf073b913e13d0d8ba8d89e42ebc7767c0d1613444983ebac4',
  'jsx-runtime-BEumusn6.js': '14499e4c8ac46aed13ab8d9533c62fd9dfe18be76f784d379b2cb512d4dba27a',
  'toctoc-logo-CiSSEARy.png': 'cea8421ed137cd045aa01980cf6534655f507a364493d9abb96101741ed3906d',
}
const SHA_INDEX_PUBLICO = '0944c215ba0e487590424f86e8df25bd5b860dfc9718278b60dc543fafc8709e'
const SHA_PANEL_HTML = '122cc820a69412805fbaa71d54d9b1e2ededf99794ad4e4ebbd89fde6528a015'
const SHA_PANEL_JS = '05b406ca4ba6b35eada491bae79dbceb3cb99f856ef9734aafd0cd098bd50e59'
const SHA_PANEL_CSS = 'ea68f5e6ab12f242e6610de42744c3b7fcc2a4c4d872297a780683445b15c3db'
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
      assert.equal(sha(readFileSync(join(copia, 'dist/index.html'))), SHA_INDEX_PUBLICO, 'HTML público referencia los assets aprobados')
      if (variante === 'base') assert.equal(sha(readFileSync(join(copia, 'dist/panel.html'))), SHA_PANEL_HTML, 'HTML del panel conserva sus bytes')
      const jsPublico = readdirSync(assets).find(n => /^main-.*\.js$/.test(n))!
      assert.ok(jsPublico && readFileSync(join(assets, jsPublico), 'utf8').includes('Recomendación a verificar'), 'bundle público incluye el nuevo badge')
      for (const [nombre, hash] of Object.entries(BASE)) assert.equal(sha(readFileSync(join(assets, nombre))), hash, `${variante}: ${nombre}`)
      const panelCss = readdirSync(assets).find(n => /^panel-.*\.css$/.test(n))!
      const css = readFileSync(join(assets, panelCss), 'utf8')
      if (variante === 'base') assert.equal(sha(readFileSync(join(assets, panelCss))), SHA_PANEL_CSS, 'el CSS aislado del panel conserva sus bytes')
      const panelJs = readdirSync(assets).find(n => /^panel-.*\.js$/.test(n))!
      if (variante === 'base') assert.equal(sha(readFileSync(join(assets, panelJs))), SHA_PANEL_JS, 'el JS del panel conserva sus bytes')
      assert.ok(css.includes('grid-template-columns:repeat(2,'), 'utilidades responsive propias del panel')
      assert.ok(css.includes('grid-template-columns:repeat(3,'), 'valores responsive del detalle')
      assert.ok(css.includes('overflow-wrap:anywhere'), 'datos largos del detalle no desbordan')
      assert.equal(css.includes('z-index:9876'), variante === 'panel')
      assert.ok(!css.includes('8765') && !css.includes('7654'), 'tests/scripts fuera del panel')
      const cssPublicoNombre = readdirSync(assets).find(n => /^main-.*\.css$/.test(n))!
      const cssPublico = readFileSync(join(assets, cssPublicoNombre), 'utf8')
      assert.ok(!cssPublico.includes('9876') && !cssPublico.includes('8765') && !cssPublico.includes('7654'))
      assert.ok(cssPublico.includes('.bg-slate-100'), 'las clases del badge se generan en el CSS público')
      resultados.push(sha(readFileSync(join(copia, 'dist/index.html'))))
    }
    assert.equal(new Set(resultados).size, 1, 'index.html público idéntico')
  } finally {
    assert.ok(resolve(temporal).startsWith(resolve(tmpdir()) + '\\') || resolve(temporal).startsWith(resolve(tmpdir()) + '/'))
    rmSync(temporal, { recursive: true, force: true })
  }
} }]
