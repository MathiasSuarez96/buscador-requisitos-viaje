// Configuración, cargador de GIS, comprobación de CSP del build y reglas
// estáticas sobre el código del panel.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { clasificar, CSP_PANEL, decidirModo, HASH_ESTILO_GIS, HEADERS_PANEL, RUTAS_PANEL, verificarCspPanel } from '../../scripts/verificar-csp-panel.ts'
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

// Hash aprobado del <style> que inyecta el script de Google: la única fuente es el verificador.
const HASH = HASH_ESTILO_GIS
const hashDe = (algoritmo: 'sha256' | 'sha384' | 'sha512', texto: string) => `'${algoritmo}-${createHash(algoritmo).update(texto).digest('base64')}'`

// Defectos de vercel.json al transformar la CSP real en ambas rutas (para que sigan idénticas).
function conCsp(cambiar: (csp: string) => string) {
  const v = vercel()
  for (const e of v.headers) e.headers[0].value = cambiar(e.headers[0].value)
  return verificar(API_RENDER, CLIENT_ID, v).vercel
}
// Mensajes de la comparación con CSP_PANEL (faltan, sobran, otro valor, otro
// orden, formato). Las pruebas de un control puntual los dejan de lado.
const COMPARACION = /: (a la CSP le (faltan|sobran) directivas|la CSP tiene otro valor en|la CSP tiene las directivas en otro orden|la CSP difiere de la aprobada solo en el formato)/
const sinComparacion = (defectos: string[]) => defectos.filter((d) => !COMPARACION.test(d))
// Defectos de vercel.json al cambiar los headers de las dos rutas por igual.
type Cabeceras = { key: string; value: string }[]
function conHeaders(cambiar: (headers: Cabeceras) => void) {
  const v = vercel()
  for (const e of v.headers) cambiar(e.headers)
  return verificar(API_RENDER, CLIENT_ID, v).vercel
}
const enAmbas = (texto: string) => [`/panel.html: ${texto}`, `/panel: ${texto}`]
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
    nombre: 'verificarCspPanel: exactamente una Content-Security-Policy por ruta; Report-Only, las dos cabeceras o la obligatoria ausente → defecto',
    fn: () => {
      const defectos = (cambiar: (v: { headers: { headers: { key: string; value: string }[] }[] }) => void) => {
        const v = vercel()
        cambiar(v)
        return verificar(API_RENDER, CLIENT_ID, v).vercel
      }

      // Vuelta a Report-Only en las dos rutas (con cualquier capitalización).
      for (const nombre of ['Content-Security-Policy-Report-Only', 'content-security-policy-report-only']) {
        const r = defectos((v) => v.headers.forEach((e) => (e.headers[0].key = nombre)))
        assert.deepEqual(
          r,
          [
            '/panel.html: no puede tener Content-Security-Policy-Report-Only; la CSP tiene que ser obligatoria.',
            '/panel.html: falta Content-Security-Policy.',
            '/panel: no puede tener Content-Security-Policy-Report-Only; la CSP tiene que ser obligatoria.',
            '/panel: falta Content-Security-Policy.',
          ],
          nombre,
        )
      }

      // Las dos cabeceras a la vez, con la misma política, en las dos rutas.
      const ambas = defectos((v) => v.headers.forEach((e) => e.headers.splice(1, 0, { ...e.headers[0], key: 'Content-Security-Policy-Report-Only' })))
      assert.deepEqual(ambas, [
        '/panel.html: no puede tener Content-Security-Policy-Report-Only; la CSP tiene que ser obligatoria.',
        '/panel: no puede tener Content-Security-Policy-Report-Only; la CSP tiene que ser obligatoria.',
      ])

      // La obligatoria ausente solo en /panel (quitada o vuelta a Report-Only).
      const sinObligatoria = defectos((v) => v.headers[1].headers.shift()).join('\n')
      assert.match(sinObligatoria, /^\/panel: falta Content-Security-Policy\.$/m)
      assert.doesNotMatch(sinObligatoria, /\/panel\.html: falta/)
      assert.match(sinObligatoria, /mismos headers/)
      const unaReportOnly = defectos((v) => (v.headers[1].headers[0].key = 'Content-Security-Policy-Report-Only')).join('\n')
      assert.match(unaReportOnly, /^\/panel: no puede tener Content-Security-Policy-Report-Only/m)
      assert.match(unaReportOnly, /^\/panel: falta Content-Security-Policy\.$/m)
      assert.doesNotMatch(unaReportOnly, /\/panel\.html: (falta|no puede tener)/)

      // Dos obligatorias en la misma ruta (aunque sean iguales).
      const dobles = defectos((v) => v.headers.forEach((e) => e.headers.splice(1, 0, { ...e.headers[0] })))
      assert.deepEqual(dobles, [
        '/panel.html: tiene que haber exactamente una Content-Security-Policy (hay 2).',
        '/panel: tiene que haber exactamente una Content-Security-Policy (hay 2).',
      ])

      // Las dos rutas difieren en un header que no es la CSP.
      const distintas = defectos((v) => (v.headers[1].headers[4].value = 'noindex'))
      assert.deepEqual(distintas, ['/panel: X-Robots-Tag tiene que ser noindex, nofollow (es "noindex").', '/panel.html y /panel tienen que tener los mismos headers.'])
    },
  },
  {
    nombre: 'verificarCspPanel: hash aprobado en style-src y style-src-elem; con mayúsculas y espacios en los nombres solo falla la comparación exacta',
    fn: () => {
      assert.deepEqual(conCsp((csp) => csp), [])
      const formato = conCsp((csp) => csp.replace('style-src ', 'STYLE-SRC \t ').replace('style-src-elem', 'Style-Src-Elem'))
      assert.deepEqual(sinComparacion(formato), [])
      assert.deepEqual(
        formato,
        ['/panel.html', '/panel'].map((r) => `${r}: la CSP difiere de la aprobada solo en el formato (mayúsculas de los nombres, espacios o separadores); tiene que ser igual carácter por carácter.`),
      )
    },
  },
  {
    nombre: 'verificarCspPanel: el hash tiene que ser exactamente el aprobado y el único (no alcanza con que coincidan)',
    fn: () => {
      const aprobado = (nombre: string) => `${nombre} tiene que tener el hash aprobado ${HASH} y ningún otro.`
      const ambas = (ruta: string) => [`${ruta}: ${aprobado('style-src')}`, `${ruta}: ${aprobado('style-src-elem')}`]
      const otro = hashDe('sha256', 'otro')
      // Cambiado de forma coherente en las dos directivas, o quitado de las dos: coinciden entre sí, pero no es el aprobado.
      assert.deepEqual(sinComparacion(conCsp((csp) => csp.replaceAll(HASH, otro))), [...ambas('/panel.html'), ...ambas('/panel')])
      assert.deepEqual(sinComparacion(conCsp((csp) => csp.replaceAll(` ${HASH}`, ''))), [...ambas('/panel.html'), ...ambas('/panel')])
      for (const nombre of ['style-src', 'style-src-elem'] as const) {
        const enUna = (nuevo: string) => sinComparacion(enDirectiva(nombre, nuevo)).filter((d) => !/mismos hashes/.test(d))
        const solo = ['/panel.html', '/panel'].map((ruta) => `${ruta}: ${aprobado(nombre)}`)
        assert.deepEqual(enUna(otro), solo, `${nombre} distinto`)
        assert.deepEqual(enUna(''), solo, `${nombre} sin hash`)
        // Un segundo hash, válido, antes o después del aprobado.
        for (const extra of [`${HASH} ${otro}`, `${hashDe('sha384', 'a')} ${HASH}`, `${HASH}\t${hashDe('sha512', 'b')}`]) {
          assert.deepEqual(enUna(extra), solo, `${nombre}: ${extra}`)
        }
      }
      // Sin style-src-elem (o sin style-src) tampoco está el hash aprobado.
      assert.match(conCsp((csp) => csp.replace(/ style-src-elem [^;]*;/, '')).join('\n'), /\/panel\.html: style-src-elem tiene que tener el hash aprobado/)
    },
  },
  {
    nombre: 'verificarCspPanel: style-src-attr prohibida en cualquier posición y con cualquier valor',
    fn: () => {
      const valores = ["'self'", "'none'", "'unsafe-inline'", HASH, 'https://accounts.google.com/gsi/style', '']
      for (const valor of valores) {
        for (const nombre of ['style-src-attr', 'STYLE-SRC-ATTR', 'Style-Src-Attr']) {
          const directiva = `${nombre} ${valor}`.trim()
          for (const [donde, csp] of [
            ['al principio', (c: string) => `${directiva}; ${c}`],
            ['en el medio', (c: string) => c.replace('frame-src', `${directiva}; frame-src`)],
            ['al final', (c: string) => `${c}; ${directiva}`],
          ] as const) {
            const defectos = conCsp(csp).join('\n')
            assert.match(defectos, /\/panel\.html: la CSP no puede tener style-src-attr\./, `${directiva} ${donde}`)
            assert.match(defectos, /\/panel: la CSP no puede tener style-src-attr\./, `${directiva} ${donde}`)
          }
        }
      }
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

      // Válidos y coherentes en cada entrada, pero distintos entre /panel.html y /panel:
      // /panel ya no tiene el hash aprobado y las entradas difieren.
      const distintos = vercel()
      distintos.headers[1].headers[0].value = distintos.headers[1].headers[0].value.replaceAll(HASH, hashDe('sha256', 'otro'))
      assert.deepEqual(sinComparacion(verificar(API_RENDER, CLIENT_ID, distintos).vercel), [
        `/panel: style-src tiene que tener el hash aprobado ${HASH} y ningún otro.`,
        `/panel: style-src-elem tiene que tener el hash aprobado ${HASH} y ningún otro.`,
        '/panel.html y /panel tienen que tener los mismos headers.',
      ])
    },
  },
  {
    nombre: 'verificarCspPanel: exactamente un Cross-Origin-Opener-Policy, con ese nombre y same-origin-allow-popups; ausente, duplicado, otro valor u otras mayúsculas → defecto',
    fn: () => {
      type Entrada = { headers: { key: string; value: string }[] }
      const conCoop = (cambiar: (headers: Entrada['headers']) => void) => {
        const v = vercel()
        for (const e of v.headers as Entrada[]) cambiar(e.headers)
        return verificar(API_RENDER, CLIENT_ID, v).vercel
      }
      const indice = (h: Entrada['headers']) => h.findIndex((x) => x.key === 'Cross-Origin-Opener-Policy')
      const enAmbas = (texto: string) => [`/panel.html: ${texto}`, `/panel: ${texto}`]

      assert.deepEqual(conCoop((h) => h.splice(indice(h), 1)), enAmbas('falta Cross-Origin-Opener-Policy.'))
      assert.deepEqual(
        conCoop((h) => h.push({ key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' })),
        enAmbas('tiene que haber exactamente un Cross-Origin-Opener-Policy (hay 2).'),
      )
      for (const valor of ['same-origin', 'unsafe-none', 'Same-Origin-Allow-Popups', ' same-origin-allow-popups', 'same-origin-allow-popups;', '']) {
        assert.deepEqual(
          conCoop((h) => (h[indice(h)].value = valor)),
          enAmbas(`Cross-Origin-Opener-Policy tiene que ser same-origin-allow-popups (es ${JSON.stringify(valor)}).`),
          valor,
        )
      }
      // Otras mayúsculas en el nombre: con el valor correcto, con otro valor, o como duplicado del header bien escrito.
      for (const nombre of ['cross-origin-opener-policy', 'CROSS-ORIGIN-OPENER-POLICY', 'Cross-origin-opener-policy']) {
        const escritura = `el header ${nombre} tiene que escribirse exactamente Cross-Origin-Opener-Policy.`
        assert.deepEqual(conCoop((h) => (h[indice(h)].key = nombre)), enAmbas(escritura), nombre)
        assert.deepEqual(
          conCoop((h) => (h[indice(h)] = { key: nombre, value: 'unsafe-none' })),
          ['/panel.html', '/panel'].flatMap((r) => [`${r}: ${escritura}`, `${r}: Cross-Origin-Opener-Policy tiene que ser same-origin-allow-popups (es "unsafe-none").`]),
          `${nombre} con otro valor`,
        )
        assert.deepEqual(
          conCoop((h) => h.push({ key: nombre, value: 'same-origin-allow-popups' })),
          ['/panel.html', '/panel'].flatMap((r) => [`${r}: tiene que haber exactamente un Cross-Origin-Opener-Policy (hay 2).`, `${r}: ${escritura}`]),
          `${nombre} duplicado`,
        )
      }
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
    nombre: 'vercel.json: solo headers, con las dos entradas del panel y exactamente HEADERS_PANEL (CSP_PANEL obligatoria, sin Report-Only)',
    fn: () => {
      const texto = readFileSync(join(RAIZ, 'vercel.json'), 'utf8')
      assert.doesNotMatch(texto, /report-only/i)
      assert.deepEqual(JSON.parse(texto), { headers: RUTAS_PANEL.map((source) => ({ source, headers: HEADERS_PANEL })) })
      assert.deepEqual(verificar(API_RENDER).vercel, [])
      // Los seis headers aprobados, en este orden, con la CSP como primero.
      assert.deepEqual(
        HEADERS_PANEL.map((h) => h.key),
        ['Content-Security-Policy', 'Cross-Origin-Opener-Policy', 'Referrer-Policy', 'X-Content-Type-Options', 'X-Robots-Tag', 'X-Frame-Options'],
      )
      const valores = Object.fromEntries(HEADERS_PANEL.map((h) => [h.key, h.value]))
      assert.equal(valores['Content-Security-Policy'], CSP_PANEL)
      assert.equal(valores['Cross-Origin-Opener-Policy'], 'same-origin-allow-popups')
      assert.equal(valores['Referrer-Policy'], 'strict-origin-when-cross-origin')
      assert.equal(valores['X-Content-Type-Options'], 'nosniff')
      assert.equal(valores['X-Robots-Tag'], 'noindex, nofollow')
      assert.equal(valores['X-Frame-Options'], 'DENY')
      // Propiedades de la política aprobada, sin repetir su texto: 12 directivas,
      // el hash aprobado dos veces, sin 'unsafe-*', comodines ni style-src-attr.
      const directivasCsp = CSP_PANEL.split('; ')
      assert.equal(directivasCsp.length, 12)
      assert.equal(CSP_PANEL.split(HASH).length - 1, 2)
      assert.doesNotMatch(CSP_PANEL, /unsafe-|style-src-attr|\*/i)
      for (const d of ["default-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"]) assert.ok(directivasCsp.includes(d), d)
      assert.ok(directivasCsp.some((d) => d.startsWith('connect-src ') && d.split(' ').includes(API_RENDER)))
    },
  },
  {
    nombre: 'verificarCspPanel: cada uno de los seis headers ausente, duplicado, con otro valor, con otras mayúsculas o espacios de más; un header adicional → defecto',
    fn: () => {
      for (const { key, value } of HEADERS_PANEL) {
        const i = (h: Cabeceras) => h.findIndex((x) => x.key === key)
        const articulo = key === 'Content-Security-Policy' ? 'una' : 'un'
        assert.deepEqual(conHeaders((h) => h.splice(i(h), 1)), enAmbas(`falta ${key}.`), `${key} ausente`)
        assert.deepEqual(conHeaders((h) => h.push({ key, value })), enAmbas(`tiene que haber exactamente ${articulo} ${key} (hay 2).`), `${key} duplicado`)
        for (const nombre of [key.toLowerCase(), key.toUpperCase()]) {
          assert.deepEqual(conHeaders((h) => (h[i(h)].key = nombre)), enAmbas(`el header ${nombre} tiene que escribirse exactamente ${key}.`), nombre)
        }
        for (const nombre of [`${key} `, ` ${key}`]) {
          assert.deepEqual(
            conHeaders((h) => (h[i(h)].key = nombre)),
            ['/panel.html', '/panel'].flatMap((r) => [`${r}: falta ${key}.`, `${r}: header no permitido: ${JSON.stringify(nombre)}.`]),
            JSON.stringify(nombre),
          )
        }
        if (key === 'Content-Security-Policy') {
          const formato = enAmbas('la CSP difiere de la aprobada solo en el formato (mayúsculas de los nombres, espacios o separadores); tiene que ser igual carácter por carácter.')
          for (const otro of [` ${value}`, `${value} `, `${value};`, value.replace('; ', ';  '), value.replace('; ', ' ; '), value.replace('default-src', 'DEFAULT-SRC')]) {
            assert.deepEqual(conHeaders((h) => (h[i(h)].value = otro)), formato, JSON.stringify(otro))
          }
          assert.deepEqual(conHeaders((h) => (h[i(h)].value = `${value}; worker-src 'none'`)), enAmbas('a la CSP le sobran directivas: worker-src.'))
        } else {
          for (const otro of [` ${value}`, `${value} `, value === value.toUpperCase() ? value.toLowerCase() : value.toUpperCase(), 'otro', '']) {
            assert.deepEqual(conHeaders((h) => (h[i(h)].value = otro)), enAmbas(`${key} tiene que ser ${value} (es ${JSON.stringify(otro)}).`), `${key}: ${JSON.stringify(otro)}`)
          }
        }
      }
      assert.deepEqual(
        conHeaders((h) => (h[h.findIndex((x) => x.key === 'X-Robots-Tag')].value = 'noindex,  nofollow')),
        enAmbas('X-Robots-Tag tiene que ser noindex, nofollow (es "noindex,  nofollow").'),
      )
      for (const extra of [
        { key: 'X-Extra', value: '1' },
        { key: 'Strict-Transport-Security', value: 'max-age=63072000' },
        { key: 'Cache-Control', value: 'no-store' },
        { key: 'Access-Control-Allow-Origin', value: '*' },
      ]) {
        assert.deepEqual(conHeaders((h) => h.push(extra)), enAmbas(`header no permitido: ${JSON.stringify(extra.key)}.`), extra.key)
      }
    },
  },
  {
    nombre: 'verificarCspPanel: cada directiva de la CSP quitada, con un valor de más, con otro valor o en otro orden → el error dice qué cambió',
    fn: () => {
      const aprobadas = CSP_PANEL.split('; ').map((d) => {
        const [nombre, ...valores] = d.split(' ')
        return [nombre, valores.join(' ')] as const
      })
      const nombres = aprobadas.map(([n]) => n)
      const armar = (lista: (readonly [string, string])[]) => lista.map(([n, v]) => `${n} ${v}`).join('; ')
      const comparacion = (lista: (readonly [string, string])[]) => conCsp(() => armar(lista)).filter((d) => COMPARACION.test(d))
      const otroValor = (nombre: string, es: string, aprobado: string) => enAmbas(`la CSP tiene otro valor en ${nombre}: es "${es}", tiene que ser "${aprobado}".`)
      const otroOrden = (orden: string[]) => enAmbas(`la CSP tiene las directivas en otro orden: ${orden.join(', ')}; el orden aprobado es ${nombres.join(', ')}.`)

      for (const [k, [nombre, valor]] of aprobadas.entries()) {
        const resto = aprobadas.filter((_, j) => j !== k)
        assert.deepEqual(comparacion(resto), enAmbas(`a la CSP le faltan directivas: ${nombre}.`), `${nombre} quitada`)
        for (const agregado of ['https://ajeno.example', "'self'", 'data:']) {
          if (valor.split(' ').includes(agregado)) continue
          const lista = aprobadas.map((d, j) => (j === k ? ([nombre, `${valor} ${agregado}`] as const) : d))
          assert.deepEqual(comparacion(lista), otroValor(nombre, `${valor} ${agregado}`, valor), `${nombre} + ${agregado}`)
        }
        const cambiado = valor === "'none'" ? "'self'" : "'none'"
        assert.deepEqual(comparacion(aprobadas.map((d, j) => (j === k ? ([nombre, cambiado] as const) : d))), otroValor(nombre, cambiado, valor), `${nombre} cambiada`)
        // Movida al final (o al principio, si ya es la última): solo cambia el orden.
        const movida = k < aprobadas.length - 1 ? [...resto, aprobadas[k]] : [aprobadas[k], ...resto]
        assert.deepEqual(conCsp(() => armar(movida)), otroOrden(movida.map(([n]) => n)), `${nombre} movida`)
      }

      // Casos concretos: orígenes ajenos, directivas de protección ausentes y hash cambiado.
      const con = (nombre: string, nuevo: string) => aprobadas.map((d) => (d[0] === nombre ? ([nombre, nuevo] as const) : d))
      const valorDe = (nombre: string) => aprobadas.find(([n]) => n === nombre)![1]
      for (const nombre of ['script-src', 'connect-src']) {
        const ajeno = `${valorDe(nombre)} https://evil.example`
        assert.deepEqual(comparacion(con(nombre, ajeno)), otroValor(nombre, ajeno, valorDe(nombre)), `origen ajeno en ${nombre}`)
      }
      for (const nombre of ['frame-ancestors', 'object-src', 'base-uri']) {
        assert.deepEqual(comparacion(aprobadas.filter(([n]) => n !== nombre)), enAmbas(`a la CSP le faltan directivas: ${nombre}.`), `sin ${nombre}`)
      }
      const otroHash = hashDe('sha256', 'otro')
      const conOtroHash = conCsp((csp) => csp.replaceAll(HASH, otroHash))
      assert.deepEqual(
        conOtroHash.filter((d) => COMPARACION.test(d)),
        ['/panel.html', '/panel'].flatMap((r) =>
          ['style-src', 'style-src-elem'].map((n) => `${r}: la CSP tiene otro valor en ${n}: es "${valorDe(n).replace(HASH, otroHash)}", tiene que ser "${valorDe(n)}".`),
        ),
      )
      // Varias diferencias a la vez: faltan, sobran, otro valor y orden, cada una con su mensaje.
      const varias = [aprobadas[1], aprobadas[0], ...aprobadas.slice(2, -1).map((d) => (d[0] === 'img-src' ? (['img-src', "'self' data:"] as const) : d)), ['worker-src', "'none'"] as const]
      assert.deepEqual(comparacion(varias), [
        ...['/panel.html', '/panel'].flatMap((r) => [
          `${r}: a la CSP le faltan directivas: frame-ancestors.`,
          `${r}: a la CSP le sobran directivas: worker-src.`,
          `${r}: la CSP tiene otro valor en img-src: es "'self' data:", tiene que ser "'self'".`,
          `${r}: la CSP tiene las directivas en otro orden: ${[nombres[1], nombres[0], ...nombres.slice(2, -1)].join(', ')}; el orden aprobado es ${nombres.slice(0, -1).join(', ')}.`,
        ]),
      ])
      // Un valor con otras mayúsculas es otro valor (los valores se comparan tal cual).
      assert.deepEqual(comparacion(con('object-src', "'NONE'")), otroValor('object-src', "'NONE'", "'none'"))
      // Una directiva renombrada: falta la aprobada y sobra la nueva.
      assert.deepEqual(
        comparacion(aprobadas.map((d) => (d[0] === 'script-src' ? (['script-src-elem', d[1]] as const) : d))),
        ['/panel.html', '/panel'].flatMap((r) => [`${r}: a la CSP le faltan directivas: script-src.`, `${r}: a la CSP le sobran directivas: script-src-elem.`]),
      )
    },
  },
  {
    nombre: 'verificarCspPanel: vercel.json con exactamente dos entradas (/panel.html y /panel), solo source y headers, e iguales entre sí',
    fn: () => {
      const con = (cambiar: (v: { headers: Record<string, unknown>[] }) => void) => {
        const v = vercel()
        cambiar(v)
        return verificar(API_RENDER, CLIENT_ID, v).vercel
      }
      for (const source of ['/(.*)', '/', '/index.html', '/panel/']) {
        assert.deepEqual(
          con((v) => v.headers.push({ source, headers: [{ key: 'X-Frame-Options', value: 'DENY' }] })),
          [`vercel.json: headers tiene que tener exactamente dos entradas, /panel.html y /panel (tiene 3: "/panel.html", "/panel", ${JSON.stringify(source)}).`],
          source,
        )
      }
      assert.deepEqual(con((v) => v.headers.push({ ...v.headers[1] })), [
        'vercel.json: headers tiene que tener exactamente dos entradas, /panel.html y /panel (tiene 3: "/panel.html", "/panel", "/panel").',
        'vercel.json tiene que tener exactamente una entrada de headers para /panel.',
      ])
      assert.deepEqual(con((v) => (v.headers[1].source = '/panel/')), [
        'vercel.json: headers tiene que tener exactamente dos entradas, /panel.html y /panel (tiene 2: "/panel.html", "/panel/").',
        'vercel.json tiene que tener exactamente una entrada de headers para /panel.',
      ])
      for (const clave of ['has', 'missing']) {
        assert.deepEqual(
          con((v) => (v.headers[0][clave] = [{ type: 'header', key: 'x-no-aplicar' }])),
          [`vercel.json: la entrada "/panel.html" solo puede tener source y headers (tiene también ${clave}).`],
          clave,
        )
      }
      // Entradas en otro orden: se aceptan (cada una se busca por su source).
      assert.deepEqual(con((v) => v.headers.reverse()), [])
      // /panel con los mismos seis headers en otro orden: las rutas difieren.
      assert.deepEqual(con((v) => (v.headers[1].headers as unknown[]).reverse()), ['/panel.html y /panel tienen que tener los mismos headers.'])
      // Headers que no son una lista de { key, value } de texto.
      assert.match(con((v) => (v.headers[0].headers = {})).join('\n'), /^\/panel\.html: headers tiene que ser una lista de \{ key, value \} de texto\.$/m)
      assert.match(con((v) => (v.headers[1].headers as unknown[]).push({ key: 'X-Extra', value: 1 })).join('\n'), /^\/panel: headers tiene que ser una lista de \{ key, value \} de texto\.$/m)
      assert.match(verificar(API_RENDER, CLIENT_ID, {}).vercel.join('\n'), /^vercel\.json tiene que tener una lista headers\.$/m)
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
