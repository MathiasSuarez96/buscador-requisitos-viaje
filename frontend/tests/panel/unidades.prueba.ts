// Configuración, cargador de GIS, comprobación de CSP del build y reglas
// estáticas sobre el código del panel.

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { clasificar, decidirModo, verificarCspPanel } from '../../scripts/verificar-csp-panel.ts'
import { crearCargadorGis, URL_GIS } from '../../src/panel/cargar-gis.ts'
import { leerConfigPanel } from '../../src/panel/config.ts'
import { esperar, type Prueba } from './apoyo.tsx'

const RAIZ = resolve(import.meta.dirname, '../..')
const CLIENT_ID = '123456789012-abcdefghijklmnop.apps.googleusercontent.com'
const API_RENDER = 'https://buscador-requisitos-viaje.onrender.com'
const vercel = () => JSON.parse(readFileSync(join(RAIZ, 'vercel.json'), 'utf8'))
// Sin parámetros por defecto: un `undefined` explícito tiene que llegar como ausente.
const verificar = (apiUrl: unknown, ...resto: [clientId?: unknown, v?: unknown]) =>
  verificarCspPanel({ apiUrl, clientId: resto.length > 0 ? resto[0] : CLIENT_ID, vercel: resto.length > 1 ? resto[1] : vercel() })

// Defectos de vercel.json al agregar directivas al final de la CSP real en
// ambas rutas (para que sigan idénticas). La política real ya tiene
// style-src-attr y script-src, así que se quitan antes para no contar repeticiones.
const SIN_ATTR = / style-src-attr 'unsafe-inline';/
function conDirectiva(...extra: string[]) {
  const v = vercel()
  for (const e of v.headers) {
    const csp = e.headers[0].value.replace(SIN_ATTR, '').replace(/ script-src [^;]*;/, '')
    e.headers[0].value = [csp, ...extra].join('; ')
  }
  return verificar(API_RENDER, CLIENT_ID, v).vercel
}

// Documento y ventana falsos para el cargador de GIS.
function entornoGis(alAgregar: (script: ScriptFalso, ventana: { google?: Window['google'] }) => void) {
  const ventana: { google?: Window['google'] } = {}
  const agregados: ScriptFalso[] = []
  const documento = {
    createElement: () => new ScriptFalso(),
    head: {
      appendChild(s: ScriptFalso) {
        agregados.push(s)
        alAgregar(s, ventana)
        return s
      },
    },
  } as unknown as Pick<Document, 'createElement' | 'head'>
  return { ventana, agregados, documento }
}
class ScriptFalso {
  src = ''
  async = false
  quitado = false
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  remove() {
    this.quitado = true
  }
}
const ID_FALSO = { initialize() {}, renderButton() {}, disableAutoSelect() {} }

export const pruebas: Prueba[] = [
  {
    nombre: 'leerConfigPanel: acepta solo https sin ruta y un client ID con la forma de Google',
    fn: () => {
      assert.deepEqual(leerConfigPanel({ VITE_API_URL: API_RENDER, VITE_GOOGLE_CLIENT_ID: CLIENT_ID }), { apiOrigen: API_RENDER, clientId: CLIENT_ID })
      for (const api of ['http://localhost:3000', `${API_RENDER}/`, `${API_RENDER}/api`, 'no-es-url', '', undefined]) {
        assert.equal(leerConfigPanel({ VITE_API_URL: api, VITE_GOOGLE_CLIENT_ID: CLIENT_ID }), null, String(api))
      }
      for (const id of [undefined, '', 'abc.apps.googleusercontent.com', `${CLIENT_ID} `]) {
        assert.equal(leerConfigPanel({ VITE_API_URL: API_RENDER, VITE_GOOGLE_CLIENT_ID: id }), null, String(id))
      }
    },
  },
  {
    nombre: 'cargador de GIS: un solo <script async> con la URL exacta; resuelve google.accounts.id',
    fn: async () => {
      const { ventana, agregados, documento } = entornoGis((s, v) => {
        queueMicrotask(() => {
          v.google = { accounts: { id: ID_FALSO } }
          s.onload?.()
        })
      })
      const cargar = crearCargadorGis({ documento, ventana: ventana as Pick<Window, 'google'>, limiteMs: 1000 })
      const [a, b] = await Promise.all([cargar(), cargar()])
      assert.equal(a, ID_FALSO)
      assert.equal(b, ID_FALSO)
      assert.equal(agregados.length, 1)
      assert.equal(agregados[0].src, URL_GIS)
      assert.equal(URL_GIS, 'https://accounts.google.com/gsi/client')
      assert.equal(agregados[0].async, true)
    },
  },
  {
    nombre: 'cargador de GIS: si ya está cargado no agrega otro script',
    fn: async () => {
      const { ventana, agregados, documento } = entornoGis(() => assert.fail('no debe agregar el script'))
      ventana.google = { accounts: { id: ID_FALSO } }
      assert.equal(await crearCargadorGis({ documento, ventana: ventana as Pick<Window, 'google'> })(), ID_FALSO)
      assert.equal(agregados.length, 0)
    },
  },
  {
    nombre: 'cargador de GIS: onerror, carga sin google.accounts.id o tiempo agotado → rechaza y quita el script',
    fn: async () => {
      const casos: ((s: ScriptFalso) => void)[] = [(s) => queueMicrotask(() => s.onerror?.()), (s) => queueMicrotask(() => s.onload?.()), () => {}]
      for (const alAgregar of casos) {
        const { ventana, agregados, documento } = entornoGis(alAgregar)
        await assert.rejects(crearCargadorGis({ documento, ventana: ventana as Pick<Window, 'google'>, limiteMs: 20 })(), /gis_no_disponible/)
        assert.equal(agregados[0].quitado, true)
      }
      await esperar()
    },
  },
  {
    nombre: 'verificarCspPanel: vercel.json real + origen de Render + Client ID válido → sin hallazgos',
    fn: () => assert.deepEqual(verificar(API_RENDER), { vercel: [], entorno: [] }),
  },
  {
    nombre: 'verificarCspPanel: VITE_API_URL ausente, http, con ruta o con barra final → hallazgo de entorno',
    fn: () => {
      assert.match(verificar(undefined).entorno.join('\n'), /VITE_API_URL está ausente/)
      assert.match(verificar('').entorno.join('\n'), /VITE_API_URL está ausente/)
      assert.match(verificar('http://buscador-requisitos-viaje.onrender.com').entorno.join('\n'), /https/)
      assert.match(verificar('http://localhost:3000').entorno.join('\n'), /https/)
      assert.match(verificar(`${API_RENDER}/api`).entorno.join('\n'), /sin ruta/)
      assert.match(verificar(`${API_RENDER}/`).entorno.join('\n'), /sin ruta/)
      for (const api of [undefined, 'http://localhost:3000', `${API_RENDER}/`]) assert.deepEqual(verificar(api).vercel, [], 'no es un defecto de vercel.json')
    },
  },
  {
    nombre: 'verificarCspPanel: VITE_GOOGLE_CLIENT_ID ausente o con forma inválida → hallazgo de entorno',
    fn: () => {
      for (const id of [undefined, '']) assert.deepEqual(verificar(API_RENDER, id).entorno, ['VITE_GOOGLE_CLIENT_ID está ausente.'])
      for (const id of ['abc.apps.googleusercontent.com', `${CLIENT_ID} `, '123-ABC.apps.googleusercontent.com', '123-abc.apps.googleusercontent.com.evil.example']) {
        assert.deepEqual(verificar(API_RENDER, id).entorno, ['VITE_GOOGLE_CLIENT_ID no tiene la forma <número>-<id>.apps.googleusercontent.com.'], id)
      }
      assert.ok(!verificar(API_RENDER, 'abc.apps.googleusercontent.com').entorno.join('').includes('abc.'), 'el mensaje no repite el valor')
    },
  },
  {
    nombre: 'verificarCspPanel: otro origen o un origen parecido no alcanza',
    fn: () => {
      assert.match(verificar('https://otra-api.onrender.com').entorno.join('\n'), /\/panel\.html: connect-src no incluye[\s\S]*\/panel: connect-src no incluye/)
      const conParecido = vercel()
      for (const e of conParecido.headers) e.headers[0].value = e.headers[0].value.replace(API_RENDER, `${API_RENDER}.evil.example`)
      assert.match(verificar(API_RENDER, CLIENT_ID, conParecido).entorno.join('\n'), /connect-src no incluye/)
    },
  },
  {
    nombre: 'verificarCspPanel: falta la entrada de /panel, falta la CSP, unsafe-inline o headers distintos → defecto de vercel.json',
    fn: () => {
      const sinPanel = vercel()
      sinPanel.headers = sinPanel.headers.filter((e: { source: string }) => e.source !== '/panel')
      assert.match(verificar(API_RENDER, CLIENT_ID, sinPanel).vercel.join('\n'), /exactamente una entrada de headers para \/panel\./)

      const sinCsp = vercel()
      sinCsp.headers[1].headers = sinCsp.headers[1].headers.slice(1)
      assert.match(verificar(API_RENDER, CLIENT_ID, sinCsp).vercel.join('\n'), /\/panel: falta Content-Security-Policy/)

      const inseguro = vercel()
      inseguro.headers[0].headers[0].value += "; style-src 'self' 'unsafe-inline'"
      assert.match(verificar(API_RENDER, CLIENT_ID, inseguro).vercel.join('\n'), /unsafe-inline/)

      const distintos = vercel()
      distintos.headers[1].headers.pop()
      assert.match(verificar(API_RENDER, CLIENT_ID, distintos).vercel.join('\n'), /mismos headers/)

      assert.match(verificar(API_RENDER, CLIENT_ID, null).vercel.join('\n'), /\/panel\.html/)
    },
  },
  {
    nombre: "verificarCspPanel: 'unsafe-inline' solo en style-src-attr (mayúsculas, espacios y otros valores incluidos)",
    fn: () => {
      const aceptadas = [
        "style-src-attr 'unsafe-inline'",
        "STYLE-SRC-ATTR 'UNSAFE-INLINE'",
        "Style-Src-Attr 'Unsafe-Inline'",
        "  style-src-attr\t 'unsafe-inline'  ",
        "style-src-attr 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
        "style-src-attr 'unsafe-inline' 'self'",
      ]
      for (const d of aceptadas) assert.deepEqual(conDirectiva(d), [], d)
    },
  },
  {
    nombre: "verificarCspPanel: 'unsafe-inline' fuera de style-src-attr → defecto de vercel.json",
    fn: () => {
      const rechazadas = [
        "script-src 'self' 'unsafe-inline'",
        "script-src 'UNSAFE-INLINE'",
        "SCRIPT-SRC\t'unsafe-inline'",
        "script-src-elem 'unsafe-inline'",
        "script-src-attr 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "style-src 'Unsafe-Inline' 'self'",
        "style-src-elem 'unsafe-inline'",
        "style-src-elem 'self'   'unsafe-inline'",
        "default-src 'unsafe-inline'",
        "img-src 'unsafe-inline'",
        "style-src-attrs 'unsafe-inline'",
        "style-src-attr-x 'unsafe-inline'",
        "'unsafe-inline'",
      ]
      for (const d of rechazadas) assert.match(conDirectiva(d).join('\n'), /'unsafe-inline' solo se permite en style-src-attr/i, d)
      // Pegado a otro valor ya no es la palabra clave exacta: también es defecto, incluso en style-src-attr.
      assert.match(conDirectiva("style-src-attr 'self''unsafe-inline'").join('\n'), /no puede permitir 'self''unsafe-inline'/)
    },
  },
  {
    nombre: "verificarCspPanel: 'unsafe-eval' y cualquier otro 'unsafe-*' son defecto en toda directiva, incluida style-src-attr",
    fn: () => {
      const rechazadas = [
        "script-src 'self' 'unsafe-eval'",
        "script-src 'UNSAFE-EVAL'",
        "default-src 'unsafe-eval'",
        "style-src-attr 'unsafe-eval'",
        "style-src-attr 'unsafe-inline' 'unsafe-eval'",
        "STYLE-SRC-ATTR 'UNSAFE-INLINE' 'UNSAFE-EVAL'",
        "script-src 'wasm-unsafe-eval'",
        "style-src-attr 'unsafe-inline' 'unsafe-hashes'",
      ]
      for (const d of rechazadas) assert.match(conDirectiva(d).join('\n'), /no puede permitir '[a-z-]*unsafe-(eval|hashes)'/i, d)
    },
  },
  {
    nombre: 'verificarCspPanel: directiva repetida → defecto, aunque la repetición sea inocua o el navegador la ignore',
    fn: () => {
      assert.match(conDirectiva("style-src-attr 'unsafe-inline'", "style-src-attr 'unsafe-inline'").join('\n'), /repite la directiva style-src-attr/)
      assert.match(conDirectiva("style-src-attr 'none'", "STYLE-SRC-ATTR 'unsafe-inline'").join('\n'), /repite la directiva style-src-attr/)
      const scriptRepetido = conDirectiva("script-src 'self'", "script-src 'unsafe-inline'").join('\n')
      assert.match(scriptRepetido, /repite la directiva script-src/)
      assert.match(scriptRepetido, /aparece en script-src/, 'la segunda aparición también se revisa')
      // El navegador usa la primera connect-src: si el origen está solo en la segunda, no alcanza.
      const v = vercel()
      for (const e of v.headers) e.headers[0].value = e.headers[0].value.replace('connect-src', "connect-src 'self'; connect-src")
      const r = verificar(API_RENDER, CLIENT_ID, v)
      assert.match(r.vercel.join('\n'), /repite la directiva connect-src/)
      assert.match(r.entorno.join('\n'), /connect-src no incluye el origen de VITE_API_URL/)
    },
  },
  {
    nombre: "verificarCspPanel: 'unsafe-inline' solo en la CSP de /panel también se detecta",
    fn: () => {
      const v = vercel()
      v.headers[1].headers[0].value = v.headers[1].headers[0].value.replace('script-src', "script-src 'unsafe-inline'")
      const defectos = verificar(API_RENDER, CLIENT_ID, v).vercel.join('\n')
      assert.match(defectos, /\/panel: 'unsafe-inline' solo se permite en style-src-attr \(aparece en script-src\)/)
      assert.doesNotMatch(defectos, /\/panel\.html: 'unsafe-inline'/)
    },
  },
  {
    nombre: 'decidirModo: estricto con VERCEL o PANEL_BUILD_ESTRICTO activos; nunca por defecto; la variable manual no lo desactiva',
    fn: () => {
      const casos: [Record<string, string | undefined>, string][] = [
        [{}, 'normal'],
        [{ VERCEL: undefined, PANEL_BUILD_ESTRICTO: undefined }, 'normal'],
        [{ VERCEL: '' }, 'normal'],
        [{ VERCEL: '0' }, 'normal'],
        [{ VERCEL: ' 0 ' }, 'normal'],
        [{ VERCEL: 'false' }, 'normal'],
        [{ VERCEL: 'FALSE' }, 'normal'],
        [{ PANEL_BUILD_ESTRICTO: '' }, 'normal'],
        [{ PANEL_BUILD_ESTRICTO: '0' }, 'normal'],
        [{ VERCEL: '1' }, 'estricto'],
        [{ VERCEL: 'true' }, 'estricto'],
        [{ PANEL_BUILD_ESTRICTO: '1' }, 'estricto'],
        [{ VERCEL: '1', PANEL_BUILD_ESTRICTO: '0' }, 'estricto'],
        [{ VERCEL: '1', PANEL_BUILD_ESTRICTO: '' }, 'estricto'],
        [{ VERCEL: '0', PANEL_BUILD_ESTRICTO: '1' }, 'estricto'],
      ]
      for (const [env, esperado] of casos) assert.equal(decidirModo(env), esperado, JSON.stringify(env))
    },
  },
  {
    nombre: 'clasificar: en normal, el entorno es advertencia y vercel.json error; en estricto, todo es error',
    fn: () => {
      const h = { vercel: ['v'], entorno: ['e'] }
      assert.deepEqual(clasificar(h, 'normal'), { errores: ['v'], avisos: ['e'] })
      assert.deepEqual(clasificar(h, 'estricto'), { errores: ['v', 'e'], avisos: [] })
      assert.deepEqual(clasificar(verificar('http://localhost:3000', undefined), 'normal').errores, [], 'la configuración local normal no rompe el build')
    },
  },
  {
    nombre: 'vercel.json: CSP Report-Only con la política diseñada y los cinco headers en ambas rutas',
    fn: () => {
      const v = vercel()
      assert.deepEqual(
        v.headers.map((e: { source: string }) => e.source),
        ['/panel.html', '/panel'],
      )
      for (const e of v.headers) {
        const h = Object.fromEntries(e.headers.map((x: { key: string; value: string }) => [x.key, x.value]))
        assert.deepEqual(Object.keys(h), ['Content-Security-Policy-Report-Only', 'Cross-Origin-Opener-Policy', 'Referrer-Policy', 'X-Content-Type-Options', 'X-Robots-Tag', 'X-Frame-Options'])
        const csp = h['Content-Security-Policy-Report-Only']
        for (const d of [
          "default-src 'self'",
          "script-src 'self' https://accounts.google.com/gsi/client",
          "style-src 'self' https://accounts.google.com/gsi/style",
          "style-src-elem 'self' https://accounts.google.com/gsi/style",
          "style-src-attr 'unsafe-inline'",
          'frame-src https://accounts.google.com/gsi/',
          `connect-src 'self' ${API_RENDER} https://accounts.google.com/gsi/`,
          "object-src 'none'",
          "base-uri 'none'",
          "form-action 'none'",
          "frame-ancestors 'none'",
        ]) {
          assert.ok(csp.split(';').map((x: string) => x.trim()).includes(d), `falta "${d}"`)
        }
        const conUnsafe = csp
          .split(';')
          .map((x: string) => x.trim())
          .filter((x: string) => /unsafe-/i.test(x))
        assert.deepEqual(conUnsafe, ["style-src-attr 'unsafe-inline'"], "'unsafe-*' solo en style-src-attr")
        assert.equal(h['Cross-Origin-Opener-Policy'], 'same-origin-allow-popups')
        assert.equal(h['Referrer-Policy'], 'strict-origin-when-cross-origin')
        assert.equal(h['X-Content-Type-Options'], 'nosniff')
        assert.equal(h['X-Robots-Tag'], 'noindex, nofollow')
        assert.equal(h['X-Frame-Options'], 'DENY')
      }
    },
  },
  {
    nombre: 'código del panel: sin console, sin catch con variable, sin almacenamiento, URL, One Tap, revoke, redirect ni eval',
    fn: () => {
      const dir = join(RAIZ, 'src/panel')
      const archivos = readdirSync(dir).filter((f) => /\.(ts|tsx)$/.test(f))
      assert.ok(archivos.length >= 8, `archivos: ${archivos.join(', ')}`)
      const prohibidos: [string, RegExp][] = [
        ['console', /\bconsole\./],
        ['catch con variable', /catch\s*\(/],
        ['localStorage', /localStorage/],
        ['sessionStorage', /sessionStorage/],
        ['cookie', /document\.cookie/],
        ['indexedDB', /indexedDB/],
        ['history', /history\.(push|replace)State/],
        ['location', /location\.(href|hash|search|assign|replace)/],
        ['prompt', /\.prompt\s*\(/],
        ['revoke', /\.revoke\s*\(/],
        ['redirect', /ux_mode:\s*'redirect'/],
        ['credentials include', /credentials:\s*'include'/],
        ['eval', /\beval\s*\(|new Function\s*\(/],
        ['innerHTML', /innerHTML|dangerouslySetInnerHTML/],
      ]
      for (const archivo of archivos) {
        const codigo = readFileSync(join(dir, archivo), 'utf8')
        for (const [nombre, patron] of prohibidos) assert.doesNotMatch(codigo, patron, `${archivo}: ${nombre}`)
      }
    },
  },
]
