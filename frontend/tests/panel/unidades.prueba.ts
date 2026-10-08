// Configuración, cargador de GIS, comprobación de CSP del build y reglas
// estáticas sobre el código del panel.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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

// Hash del <style> que inyecta el script de Google (el mismo de vercel.json).
const HASH = "'sha256-RU4sU0AaS8IBGZx8XrGt/pa9A5SLA3dQszGeqT5L3Kw='"
const hashDe = (algoritmo: 'sha256' | 'sha384' | 'sha512', texto: string) => `'${algoritmo}-${createHash(algoritmo).update(texto).digest('base64')}'`

// Defectos de vercel.json al transformar la CSP real en ambas rutas (para que sigan idénticas).
function conCsp(cambiar: (csp: string) => string) {
  const v = vercel()
  for (const e of v.headers) e.headers[0].value = cambiar(e.headers[0].value)
  return verificar(API_RENDER, CLIENT_ID, v).vercel
}
// Agrega directivas al final. La política real ya tiene script-src, así que se
// quita antes para que agregarla no cuente como repetición.
const conDirectiva = (...extra: string[]) => conCsp((csp) => [csp.replace(/ script-src [^;]*;/, ''), ...extra].join('; '))
// Reemplaza el hash solo en style-src o solo en style-src-elem.
const enDirectiva = (nombre: 'style-src' | 'style-src-elem', nuevo: string) =>
  conCsp((csp) => csp.replace(new RegExp(`(${nombre} [^;]*?)${HASH}`), (_, antes: string) => antes + nuevo))

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
    nombre: 'verificarCspPanel: hashes válidos en style-src y style-src-elem (mayúsculas, espacios, sha384/sha512, otro orden) → sin defectos',
    fn: () => {
      assert.deepEqual(conCsp((csp) => csp), [])
      assert.deepEqual(conCsp((csp) => csp.replace('style-src ', 'STYLE-SRC \t ').replace('style-src-elem', 'Style-Src-Elem')), [])
      const h384 = hashDe('sha384', 'a')
      const h512 = hashDe('sha512', 'b')
      const varios = conCsp((csp) =>
        csp.replace(`gsi/style ${HASH};`, `gsi/style ${HASH}  ${h384}\t${h512};`).replace(/(style-src-elem [^;]*?)gsi\/style [^;]*/, `$1gsi/style ${h512} ${HASH} ${h384}`),
      )
      assert.deepEqual(varios, [])
    },
  },
  {
    nombre: 'verificarCspPanel: hash ausente o alterado en style-src o en style-src-elem → los hashes ya no coinciden',
    fn: () => {
      const alterado = HASH.replace("'sha256-RU4s", "'sha256-RU4t")
      for (const nombre of ['style-src', 'style-src-elem'] as const) {
        assert.match(enDirectiva(nombre, '').join('\n'), /style-src y style-src-elem tienen que tener los mismos hashes/, `${nombre} sin hash`)
        assert.match(enDirectiva(nombre, alterado).join('\n'), /style-src y style-src-elem tienen que tener los mismos hashes/, `${nombre} alterado`)
        assert.match(enDirectiva(nombre, `${HASH} ${hashDe('sha256', 'otro')}`).join('\n'), /mismos hashes/, `${nombre} con uno de más`)
      }
    },
  },
  {
    nombre: 'verificarCspPanel: hash con forma inválida (longitud, relleno, alfabeto, comillas, algoritmo) → defecto',
    fn: () => {
      const cuerpo = HASH.slice("'sha256-".length, -1)
      const invalidos = [
        `'sha256-${cuerpo.slice(1)}'`, // un carácter menos
        `'sha256-A${cuerpo}'`, // un carácter más
        `'sha256-${cuerpo.slice(0, -1)}'`, // sin relleno
        `'sha256-${cuerpo.slice(0, -2)}x='`, // último carácter no canónico (bits sobrantes)
        `'sha256-${cuerpo.replace('/', '_')}'`, // base64url
        `'sha384-${cuerpo}'`, // longitud de sha256 con prefijo sha384
        `'sha512-${hashDe('sha384', 'a').slice("'sha384-".length)}`, // longitud de sha384 con prefijo sha512
        `'sha256-${hashDe('sha512', 'b').slice("'sha512-".length)}`, // longitud de sha512 con prefijo sha256
        `'SHA256-${cuerpo}'`, // algoritmo en mayúsculas
        `sha256-${cuerpo}`, // sin comillas
        `'sha256-${cuerpo}`, // sin comilla final
        `'sha256-'`, // vacío
      ]
      for (const h of invalidos) {
        // El mismo valor en las dos directivas: el único defecto es la forma.
        const defectos = conCsp((csp) => csp.replaceAll(HASH, h))
        assert.match(defectos.join('\n'), /hash con forma inválida en style-src:[\s\S]*hash con forma inválida en style-src-elem:/, h)
        assert.doesNotMatch(defectos.join('\n'), /mismos hashes/, h)
      }
    },
  },
  {
    nombre: 'verificarCspPanel: hash en script-src, default-src, style-src-attr u otra directiva → defecto',
    fn: () => {
      const fuera = [
        `script-src 'self' ${HASH}`,
        `SCRIPT-SRC\t${HASH}`,
        `script-src-elem ${HASH}`,
        `style-src-attr ${HASH}`,
        `img-src ${hashDe('sha384', 'a')}`,
        `font-src ${HASH.toUpperCase()}`,
        `connect-src-x sha256-${HASH.slice("'sha256-".length, -1)}`,
      ]
      for (const d of fuera) assert.match(conDirectiva(d).join('\n'), /los hashes solo se permiten en style-src y style-src-elem/, d)
      assert.match(conCsp((csp) => csp.replace("default-src 'self'", `default-src 'self' ${HASH}`)).join('\n'), /aparece 'sha256-[^ ]+ en default-src/)
    },
  },
  {
    nombre: "verificarCspPanel: cualquier 'unsafe-*' es defecto en toda directiva, sin excepciones (incluidas style-src-attr y style-src-elem)",
    fn: () => {
      const rechazadas = [
        "style-src-attr 'unsafe-inline'",
        "STYLE-SRC-ATTR 'UNSAFE-INLINE'",
        "  style-src-attr\t 'unsafe-inline'  ",
        "script-src 'self' 'unsafe-inline'",
        "script-src 'UNSAFE-INLINE'",
        "SCRIPT-SRC\t'unsafe-eval'",
        "script-src-attr 'unsafe-inline'",
        "script-src 'wasm-unsafe-eval'",
        "img-src 'unsafe-hashes'",
        "script-src 'self''unsafe-inline'",
        "'unsafe-inline'",
      ]
      for (const d of rechazadas) assert.match(conDirectiva(d).join('\n'), /no puede permitir \S*unsafe-/i, d)
      const enLaPolitica: [string, string][] = [
        ['style-src-elem ', "style-src-elem 'unsafe-inline' "],
        ['style-src ', "style-src 'Unsafe-Inline' "],
        ["default-src 'self'", "default-src 'self' 'unsafe-eval'"],
      ]
      for (const [de, a] of enLaPolitica) assert.match(conCsp((csp) => csp.replace(de, a)).join('\n'), /no puede permitir 'unsafe-(inline|eval)'/i, a)
    },
  },
  {
    nombre: 'verificarCspPanel: directiva repetida → defecto, aunque la repetición sea inocua o el navegador la ignore',
    fn: () => {
      assert.match(conCsp((csp) => `${csp}; style-src-elem 'self' ${HASH}`).join('\n'), /repite la directiva style-src-elem/)
      assert.match(conCsp((csp) => `${csp}; STYLE-SRC 'self'`).join('\n'), /repite la directiva style-src/)
      const scriptRepetido = conDirectiva("script-src 'self'", "script-src 'unsafe-inline'").join('\n')
      assert.match(scriptRepetido, /repite la directiva script-src/)
      assert.match(scriptRepetido, /aparece en script-src/, 'la segunda aparición también se revisa')
      // Para comparar hashes cuenta la primera aparición, como en el navegador.
      const segunda = conCsp((csp) => csp.replace(/style-src-elem [^;]*/, "style-src-elem 'self'; style-src-elem 'self' " + HASH)).join('\n')
      assert.match(segunda, /mismos hashes/)
      // El navegador usa la primera connect-src: si el origen está solo en la segunda, no alcanza.
      const v = vercel()
      for (const e of v.headers) e.headers[0].value = e.headers[0].value.replace('connect-src', "connect-src 'self'; connect-src")
      const r = verificar(API_RENDER, CLIENT_ID, v)
      assert.match(r.vercel.join('\n'), /repite la directiva connect-src/)
      assert.match(r.entorno.join('\n'), /connect-src no incluye el origen de VITE_API_URL/)
    },
  },
  {
    nombre: 'verificarCspPanel: un defecto solo en la CSP de /panel también se detecta; hashes distintos entre las dos entradas → defecto',
    fn: () => {
      const v = vercel()
      v.headers[1].headers[0].value = v.headers[1].headers[0].value.replace('script-src', "script-src 'unsafe-inline'")
      const defectos = verificar(API_RENDER, CLIENT_ID, v).vercel.join('\n')
      assert.match(defectos, /\/panel: la CSP no puede permitir 'unsafe-inline' \(aparece en script-src\)/)
      assert.doesNotMatch(defectos, /\/panel\.html: la CSP no puede permitir/)

      // Válidos y coherentes en cada entrada, pero distintos entre /panel.html y /panel.
      const distintos = vercel()
      distintos.headers[1].headers[0].value = distintos.headers[1].headers[0].value.replaceAll(HASH, hashDe('sha256', 'otro'))
      assert.deepEqual(verificar(API_RENDER, CLIENT_ID, distintos).vercel, ['/panel.html y /panel tienen que tener los mismos headers.'])
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
        // La política completa, en orden: sin style-src-attr ni ningún 'unsafe-*'.
        assert.deepEqual(
          csp.split(';').map((x: string) => x.trim()),
          [
            "default-src 'self'",
            "script-src 'self' https://accounts.google.com/gsi/client",
            `style-src 'self' https://accounts.google.com/gsi/style ${HASH}`,
            `style-src-elem 'self' https://accounts.google.com/gsi/style ${HASH}`,
            'frame-src https://accounts.google.com/gsi/',
            `connect-src 'self' ${API_RENDER} https://accounts.google.com/gsi/`,
            "img-src 'self'",
            "font-src 'self'",
            "object-src 'none'",
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'none'",
          ],
        )
        assert.doesNotMatch(csp, /unsafe-|style-src-attr/i)
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
