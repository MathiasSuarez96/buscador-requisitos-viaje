// Builds reales (vite build en un proceso aparte) en modo normal y estricto.
// Cada build recibe un entorno controlado: sin VITE_*, VERCEL ni
// PANEL_BUILD_ESTRICTO heredados, y sin los .env del proyecto.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Prueba } from './apoyo.tsx'

const RAIZ = resolve(import.meta.dirname, '../..')
const CONSTRUIR = join(RAIZ, 'tests/panel/construir.ts')
const RENDER = 'https://buscador-requisitos-viaje.onrender.com'
const CLIENT_ID = '123456789012-abcdefghijklmnop.apps.googleusercontent.com'
const CORRECTO = { VITE_API_URL: RENDER, VITE_GOOGLE_CLIENT_ID: CLIENT_ID }
const HEREDADAS = /^(VITE_|VERCEL$|PANEL_BUILD_ESTRICTO$|NODE_OPTIONS$)/

type Env = Record<string, string | undefined>

function construir(env: Env) {
  const salida = join(mkdtempSync(join(tmpdir(), 'panel-dist-')), 'dist')
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !HEREDADAS.test(k)))
  const definidas = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<string, string>
  // process.execArgv conserva el preload sin-red del runner, si lo hay.
  const r = spawnSync(process.execPath, [...process.execArgv, CONSTRUIR, salida], { cwd: RAIZ, env: { ...base, ...definidas }, encoding: 'utf8', timeout: 120000 })
  const resultado = { status: r.status, texto: `${r.stdout}\n${r.stderr}`, existe: existsSync(salida), generado: existsSync(join(salida, 'panel.html')) && existsSync(join(salida, 'index.html')) }
  rmSync(join(salida, '..'), { recursive: true, force: true })
  return resultado
}

function pasa(env: Env, debeIncluir: RegExp[] = []) {
  const r = construir(env)
  assert.equal(r.status, 0, `el build tenía que pasar:\n${r.texto}`)
  assert.ok(r.generado, 'el build no generó dist/index.html y dist/panel.html')
  for (const patron of debeIncluir) assert.match(r.texto, patron)
  return r
}

function falla(env: Env, debeIncluir: RegExp) {
  const r = construir(env)
  assert.notEqual(r.status, 0, `el build tenía que fallar:\n${r.texto}`)
  assert.equal(r.existe, false, 'un build fallido no debe generar salida')
  assert.match(r.texto, /verificar-csp-panel \(modo estricto\)/)
  assert.match(r.texto, debeIncluir)
}

const FALLAS: [string, Env, RegExp][] = [
  ['http', { VITE_API_URL: 'http://buscador-requisitos-viaje.onrender.com' }, /VITE_API_URL tiene que ser https/],
  ['ruta en la URL', { VITE_API_URL: `${RENDER}/api` }, /sin ruta ni barra final/],
  ['barra final', { VITE_API_URL: `${RENDER}/` }, /sin ruta ni barra final/],
  ['otro origen', { VITE_API_URL: 'https://otra-api.onrender.com' }, /connect-src no incluye el origen de VITE_API_URL \(https:\/\/otra-api\.onrender\.com\)/],
  ['VITE_API_URL ausente', { VITE_API_URL: undefined }, /VITE_API_URL está ausente/],
  ['VITE_GOOGLE_CLIENT_ID ausente', { VITE_GOOGLE_CLIENT_ID: undefined }, /VITE_GOOGLE_CLIENT_ID está ausente/],
  ['VITE_GOOGLE_CLIENT_ID inválido', { VITE_GOOGLE_CLIENT_ID: 'abc.apps.googleusercontent.com' }, /VITE_GOOGLE_CLIENT_ID no tiene la forma/],
]
const ACTIVADORES: [string, Env][] = [
  ['VERCEL=1', { VERCEL: '1' }],
  ['PANEL_BUILD_ESTRICTO=1', { PANEL_BUILD_ESTRICTO: '1' }],
]
const TODO_MAL = { VITE_API_URL: 'http://localhost:3000', VITE_GOOGLE_CLIENT_ID: undefined }
const AVISOS_LOCAL = [/ADVERTENCIA verificar-csp-panel \(modo normal, build local\)/, /VITE_API_URL tiene que ser https/, /connect-src no incluye el origen de VITE_API_URL \(http:\/\/localhost:3000\)/, /VITE_GOOGLE_CLIENT_ID está ausente/]

export const pruebas: Prueba[] = [
  {
    nombre: 'build normal con http://localhost:3000 y sin Client ID: pasa y emite advertencias visibles',
    fn: () => {
      pasa(TODO_MAL, AVISOS_LOCAL)
    },
  },
  {
    nombre: 'build normal con todo correcto: pasa sin advertencias',
    fn: () => {
      const r = pasa(CORRECTO, [/verificar-csp-panel: modo normal, sin observaciones/])
      assert.doesNotMatch(r.texto, /ADVERTENCIA/)
    },
  },
  ...ACTIVADORES.flatMap(([activador, envActivador]): Prueba[] => [
    ...FALLAS.map(([nombre, cambio, patron]): Prueba => ({
      nombre: `build estricto (${activador}) con ${nombre}: falla sin generar salida`,
      fn: () => falla({ ...CORRECTO, ...cambio, ...envActivador }, patron),
    })),
    {
      nombre: `build estricto (${activador}) con todo correcto: pasa`,
      fn: () => {
        const r = pasa({ ...CORRECTO, ...envActivador }, [/verificar-csp-panel: modo estricto, sin observaciones/])
        assert.doesNotMatch(r.texto, /ADVERTENCIA/)
      },
    },
  ]),
  {
    nombre: 'VERCEL=1 con todo mal y sin PANEL_BUILD_ESTRICTO: falla igual',
    fn: () => falla({ ...TODO_MAL, VERCEL: '1' }, /VITE_GOOGLE_CLIENT_ID está ausente/),
  },
  {
    nombre: 'VERCEL=1 con PANEL_BUILD_ESTRICTO=0 y todo mal: la variable manual no desactiva el modo estricto',
    fn: () => falla({ ...TODO_MAL, VERCEL: '1', PANEL_BUILD_ESTRICTO: '0' }, /VITE_API_URL tiene que ser https/),
  },
  ...[['0'], [''], ['false']].map(
    ([valor]): Prueba => ({
      nombre: `VERCEL=${JSON.stringify(valor)} con todo mal: no activa el modo estricto (pasa con advertencias)`,
      fn: () => {
        pasa({ ...TODO_MAL, VERCEL: valor }, AVISOS_LOCAL)
      },
    }),
  ),
]
