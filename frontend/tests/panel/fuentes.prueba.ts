import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { Scanner } from '@tailwindcss/oxide'
import type { Prueba } from './apoyo.tsx'

const raiz = resolve(import.meta.dirname, '../..')
const leer = (p: string) => readFileSync(join(raiz, p), 'utf8')
const archivos = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? archivos(join(dir, e.name)) : [join(dir, e.name)])
export const pruebas: Prueba[] = [
  { nombre: 'fuentes Tailwind: inclusión explícita; scripts/tests fuera; panel autónomo', fn() {
    const publico = leer('src/index.css'), panel = leer('src/panel/panel.css')
    for (const css of [publico, panel]) {
      assert.match(css, /@import "tailwindcss" source\(none\);/)
      assert.doesNotMatch(css, /@source\s+"[^"\n]*(?:scripts|tests)/)
    }
    assert.deepEqual([...publico.matchAll(/@source "([^"]+)"/g)].map(m => m[1]), ['./App.tsx', './main.tsx', './BadgesRequisito.tsx', '../index.html'])
    assert.deepEqual([...panel.matchAll(/@source "([^"]+)"/g)].map(m => m[1]), ['./**/*.tsx'])
    assert.ok(!leer('src/panel/main.tsx').includes('index.css'))
    const scan = new Scanner({ sources: [{ base: join(raiz, 'src/panel').replaceAll('\\', '/'), pattern: '**/*.tsx', negated: false }] })
    const clases = scan.scan()
    assert.ok(clases.includes('md:grid-cols-2'))
    assert.ok(clases.includes('max-w-6xl'))
    assert.ok(clases.includes('lg:grid-cols-3'), 'columnas de valores del detalle')
    assert.ok(clases.includes('[overflow-wrap:anywhere]'), 'textos largos del detalle')
    assert.ok(scan.files.every(f => f.replaceAll('\\', '/').includes('/src/panel/') && f.endsWith('.tsx')))
  } },
  { nombre: 'seguridad recursiva: APIs prohibidas, HTML y scripts/estilos inline ausentes', fn() {
    const prohibidos = [/\b(?:localStorage|sessionStorage|indexedDB)\b/, /document\.cookie/, /innerHTML|dangerouslySetInnerHTML/, /\beval\s*\(|new Function\s*\(/, /\bconsole\./, /\bstyle\s*=/, /<style\b/i, /<script\b/i, /location\.(href|hash|search|assign|replace)/, /history\.(pushState|replaceState)/]
    for (const f of archivos(join(raiz, 'src/panel')).filter(f => /\.(ts|tsx)$/.test(f))) {
      const codigo = readFileSync(f, 'utf8')
      for (const patron of prohibidos) assert.doesNotMatch(codigo, patron, f)
    }
    const html = leer('panel.html')
    assert.doesNotMatch(html, /\bstyle\s*=|<style\b|\son\w+\s*=/i)
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) { assert.match(m[1], /src="\/src\/panel\/main.tsx"/); assert.equal(m[2].trim(), '') }
  } },
]
