// Comprobación de build del panel: la CSP de vercel.json tiene que permitir
// exactamente el origen de VITE_API_URL en connect-src, y VITE_GOOGLE_CLIENT_ID
// tiene que tener la forma que valida el backend. vercel.json es estático (no
// admite variables), así que el origen está escrito a mano en dos lugares.
// También exige que vercel.json tenga solo las dos entradas del panel, cada
// una con exactamente los seis headers aprobados (HEADERS_PANEL), y la CSP
// igual carácter por carácter a CSP_PANEL.
//
// Dos modos:
//  - estricto: con VERCEL (lo define Vercel en el build) o PANEL_BUILD_ESTRICTO
//    activos. Cualquier hallazgo hace fallar el build.
//  - normal (build local por defecto): los hallazgos que dependen del entorno
//    (API, Client ID, connect-src) son advertencias visibles; los defectos del
//    propio vercel.json siguen siendo error.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'
import { CLIENT_ID_GOOGLE } from '../src/panel/config.ts'

export const RUTAS_PANEL = ['/panel.html', '/panel'] as const
// La CSP es obligatoria: cada ruta lleva exactamente una Content-Security-Policy
// y ninguna Content-Security-Policy-Report-Only (con las dos, el navegador
// aplicaría una e informaría la otra, y se confundirían al diagnosticar).
const CSP = 'content-security-policy'
const CSP_REPORT_ONLY = 'content-security-policy-report-only'

export type ModoBuild = 'normal' | 'estricto'

export interface Hallazgos {
  // Defectos de vercel.json: error en los dos modos.
  vercel: string[]
  // Dependen de las variables del build: error en estricto, advertencia en normal.
  entorno: string[]
}

interface Cabecera {
  key: string
  value: string
}

const esObjeto = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const esCabecera = (v: unknown): v is Cabecera => esObjeto(v) && typeof v.key === 'string' && typeof v.value === 'string'

// Activa con cualquier valor no vacío salvo "0" o "false". Vercel define
// VERCEL=1; aceptar otros valores no vacíos hace que un cambio de formato
// (p. ej. "true") no desactive el modo estricto. La variable manual solo
// puede activar el modo estricto, nunca desactivarlo.
const activa = (valor: string | undefined) => valor !== undefined && !['', '0', 'false'].includes(valor.trim().toLowerCase())

export function decidirModo(env: Record<string, string | undefined>): ModoBuild {
  return activa(env.VERCEL) || activa(env.PANEL_BUILD_ESTRICTO) ? 'estricto' : 'normal'
}

function origenDeApi(apiUrl: unknown, entorno: string[]): string | null {
  if (typeof apiUrl !== 'string' || apiUrl === '') {
    entorno.push('VITE_API_URL está ausente.')
    return null
  }
  let url: URL
  try {
    url = new URL(apiUrl)
  } catch {
    entorno.push('VITE_API_URL no es una URL.')
    return null
  }
  if (url.protocol !== 'https:') entorno.push('VITE_API_URL tiene que ser https.')
  if (url.origin !== apiUrl) entorno.push('VITE_API_URL tiene que ser exactamente esquema://host[:puerto], sin ruta ni barra final.')
  return url.origin
}

function revisarClientId(clientId: unknown, entorno: string[]) {
  if (typeof clientId !== 'string' || clientId === '') entorno.push('VITE_GOOGLE_CLIENT_ID está ausente.')
  else if (!CLIENT_ID_GOOGLE.test(clientId)) entorno.push('VITE_GOOGLE_CLIENT_ID no tiene la forma <número>-<id>.apps.googleusercontent.com.')
}

// Directivas en orden, con el nombre en minúsculas (los navegadores no
// distinguen mayúsculas en nombres ni en palabras clave). Se omiten las vacías.
function directivas(csp: string): { nombre: string; valores: string[] }[] {
  return csp
    .split(';')
    .map((parte) => parte.trim())
    .filter((parte) => parte !== '')
    .map((parte) => {
      const [clave, ...valores] = parte.split(/\s+/)
      return { nombre: clave.toLowerCase(), valores }
    })
}

function directiva(csp: string, nombre: string): string[] | null {
  return directivas(csp).find((d) => d.nombre === nombre)?.valores ?? null
}

// Cualquier valor con "unsafe-" ('unsafe-inline', 'unsafe-eval',
// 'unsafe-hashes', 'wasm-unsafe-eval', ...) es defecto en cualquier directiva,
// sin excepciones. Una directiva repetida también: el navegador usa la primera
// e ignora el resto en silencio.
//
// Hashes: solo en style-src y style-src-elem, y en cada una exactamente el
// hash aprobado, HASH_ESTILO_GIS, sin ningún otro (style-src es el respaldo
// de los navegadores sin style-src-elem). Corresponde al texto exacto del
// <style> que inyecta el script de Google Identity Services (client:427), que
// Google sirve sin versión. style-src-attr está prohibida con cualquier valor.
//
// Cómo se actualiza la política: la CSP aprobada vive en DIRECTIVAS_APROBADAS
// (de ahí sale CSP_PANEL). Cualquier cambio se hace a propósito en tres
// lugares: esa lista, el valor de Content-Security-Policy en las dos entradas
// de vercel.json y las pruebas que lo cubran. El build falla, en los dos
// modos, mientras vercel.json no coincida carácter por carácter.
//
// Si Google cambia ese bloque de estilo: con la CSP obligatoria, el navegador
// bloquea el <style>. Síntoma a la vista: el contenedor del botón de Google
// aparece sin estilo. En la consola, Chrome informa un error "Refused to apply
// [...] style" por style-src-elem que incluye el hash nuevo ('sha256-...').
// Solución: cambiar HASH_ESTILO_GIS (un solo lugar: CSP_PANEL y las pruebas
// la toman de acá) y el hash de style-src y style-src-elem en las dos
// entradas de vercel.json.
//
// (Este comentario evita a propósito ciertas palabras sueltas: Tailwind
// también recorre scripts/ y las convertiría en clases del CSS del sitio.)
export const HASH_ESTILO_GIS = "'sha256-RU4sU0AaS8IBGZx8XrGt/pa9A5SLA3dQszGeqT5L3Kw='"
const ESTILO_GIS = 'https://accounts.google.com/gsi/style'
const DIRECTIVAS_APROBADAS: readonly (readonly [string, string])[] = [
  ['default-src', "'self'"],
  ['script-src', "'self' https://accounts.google.com/gsi/client"],
  ['style-src', `'self' ${ESTILO_GIS} ${HASH_ESTILO_GIS}`],
  ['style-src-elem', `'self' ${ESTILO_GIS} ${HASH_ESTILO_GIS}`],
  ['frame-src', 'https://accounts.google.com/gsi/'],
  ['connect-src', "'self' https://buscador-requisitos-viaje.onrender.com https://accounts.google.com/gsi/"],
  ['img-src', "'self'"],
  ['font-src', "'self'"],
  ['object-src', "'none'"],
  ['base-uri', "'none'"],
  ['form-action', "'none'"],
  ['frame-ancestors', "'none'"],
]
export const CSP_PANEL = DIRECTIVAS_APROBADAS.map(([nombre, valor]) => `${nombre} ${valor}`).join('; ')
const DIRECTIVAS_CON_HASH = ['style-src', 'style-src-elem']
// Bytes del digest de cada algoritmo: el base64 tiene que decodificar a
// exactamente esa cantidad y volver a codificarse igual (con su relleno).
const BYTES_HASH: Record<string, number> = { sha256: 32, sha384: 48, sha512: 64 }
const PARECE_HASH = /sha(256|384|512)-/i
const FORMA_HASH = /^'(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})'$/

function hashValido(valor: string): boolean {
  const partes = FORMA_HASH.exec(valor)
  if (!partes) return false
  const [, algoritmo, base64] = partes
  const bytes = Buffer.from(base64, 'base64')
  return bytes.length === BYTES_HASH[algoritmo] && bytes.toString('base64') === base64
}

function revisarFuentes(ruta: string, csp: string, vercel: string[]) {
  const vistas = new Set<string>()
  const hashes = new Map<string, string>()
  for (const { nombre, valores } of directivas(csp)) {
    if (nombre === 'style-src-attr') vercel.push(`${ruta}: la CSP no puede tener style-src-attr.`)
    if (vistas.has(nombre)) vercel.push(`${ruta}: la CSP repite la directiva ${nombre}.`)
    else if (DIRECTIVAS_CON_HASH.includes(nombre)) hashes.set(nombre, valores.filter((v) => PARECE_HASH.test(v)).sort().join(' '))
    vistas.add(nombre)
    for (const valor of [nombre, ...valores]) {
      if (/unsafe-/i.test(valor)) vercel.push(`${ruta}: la CSP no puede permitir ${valor} (aparece en ${nombre}).`)
      if (!PARECE_HASH.test(valor)) continue
      if (!DIRECTIVAS_CON_HASH.includes(nombre)) vercel.push(`${ruta}: los hashes solo se permiten en style-src y style-src-elem (aparece ${valor} en ${nombre}).`)
      else if (!hashValido(valor)) vercel.push(`${ruta}: hash con forma inválida en ${nombre}: ${valor}.`)
    }
  }
  if (hashes.size === 2 && hashes.get('style-src') !== hashes.get('style-src-elem')) {
    vercel.push(`${ruta}: style-src y style-src-elem tienen que tener los mismos hashes.`)
  }
  for (const nombre of DIRECTIVAS_CON_HASH) {
    if (hashes.get(nombre) !== HASH_ESTILO_GIS) vercel.push(`${ruta}: ${nombre} tiene que tener el hash aprobado ${HASH_ESTILO_GIS} y ningún otro.`)
  }
}
// Headers aprobados para /panel.html y /panel: exactamente estos seis, sin
// ausentes, duplicados ni adicionales, con el nombre escrito así y estos
// valores. Sin la COOP (o con otro valor) se rompe la ventana emergente del
// inicio de sesión de Google.
export const HEADERS_PANEL: readonly Readonly<Cabecera>[] = [
  { key: 'Content-Security-Policy', value: CSP_PANEL },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
  { key: 'X-Frame-Options', value: 'DENY' },
]

// Compara la CSP con CSP_PANEL. Si difiere, dice qué directivas faltan,
// cuáles sobran, cuáles tienen otro valor y si cambió el orden; si nada de eso
// cambió, la diferencia es de formato (mayúsculas en los nombres, espacios o
// separadores). Las directivas repetidas las informa revisarFuentes.
function compararCsp(ruta: string, valor: string, vercel: string[]) {
  if (valor === CSP_PANEL) return
  const reales = directivas(valor)
  const nombresReales = [...new Set(reales.map((d) => d.nombre))]
  const nombresAprobados = DIRECTIVAS_APROBADAS.map(([nombre]) => nombre)
  const antes = vercel.length
  const faltan = nombresAprobados.filter((n) => !nombresReales.includes(n))
  const sobran = nombresReales.filter((n) => !nombresAprobados.includes(n))
  if (faltan.length > 0) vercel.push(`${ruta}: a la CSP le faltan directivas: ${faltan.join(', ')}.`)
  if (sobran.length > 0) vercel.push(`${ruta}: a la CSP le sobran directivas: ${sobran.join(', ')}.`)
  for (const [nombre, aprobado] of DIRECTIVAS_APROBADAS) {
    const real = reales.find((d) => d.nombre === nombre)?.valores.join(' ')
    if (real !== undefined && real !== aprobado) vercel.push(`${ruta}: la CSP tiene otro valor en ${nombre}: es "${real}", tiene que ser "${aprobado}".`)
  }
  const ordenReal = nombresReales.filter((n) => nombresAprobados.includes(n))
  const ordenAprobado = nombresAprobados.filter((n) => nombresReales.includes(n))
  if (ordenReal.join(' ') !== ordenAprobado.join(' ')) {
    vercel.push(`${ruta}: la CSP tiene las directivas en otro orden: ${ordenReal.join(', ')}; el orden aprobado es ${ordenAprobado.join(', ')}.`)
  }
  if (vercel.length === antes && nombresReales.length === reales.length) {
    vercel.push(`${ruta}: la CSP difiere de la aprobada solo en el formato (mayúsculas de los nombres, espacios o separadores); tiene que ser igual carácter por carácter.`)
  }
}

function revisarHeaders(ruta: string, cabeceras: Cabecera[], vercel: string[]) {
  for (const aprobado of HEADERS_PANEL) {
    const iguales = cabeceras.filter((c) => c.key.toLowerCase() === aprobado.key.toLowerCase())
    const articulo = aprobado.key === 'Content-Security-Policy' ? 'una' : 'un'
    if (iguales.length === 0) vercel.push(`${ruta}: falta ${aprobado.key}.`)
    if (iguales.length > 1) vercel.push(`${ruta}: tiene que haber exactamente ${articulo} ${aprobado.key} (hay ${iguales.length}).`)
    for (const { key, value } of iguales) {
      if (key !== aprobado.key) vercel.push(`${ruta}: el header ${key} tiene que escribirse exactamente ${aprobado.key}.`)
      if (aprobado.value === CSP_PANEL) compararCsp(ruta, value, vercel)
      else if (value !== aprobado.value) vercel.push(`${ruta}: ${aprobado.key} tiene que ser ${aprobado.value} (es ${JSON.stringify(value)}).`)
    }
  }
  // Report-Only tiene su propio mensaje; cualquier otro nombre sobra.
  const conocidos = [...HEADERS_PANEL.map((h) => h.key.toLowerCase()), CSP_REPORT_ONLY]
  for (const { key } of cabeceras) {
    if (!conocidos.includes(key.toLowerCase())) vercel.push(`${ruta}: header no permitido: ${JSON.stringify(key)}.`)
  }
}

// La lista headers de vercel.json tiene exactamente dos entradas, una por
// ruta del panel, y cada una solo source y headers. Una entrada de más podría
// aplicar headers a otras rutas (incluido el sitio público); una clave de más
// (has, missing) podría volver condicionales los headers del panel.
function revisarEntradas(vercel: unknown, errores: string[]) {
  const lista = esObjeto(vercel) ? vercel.headers : undefined
  if (!Array.isArray(lista)) {
    errores.push('vercel.json tiene que tener una lista headers.')
    return
  }
  const fuentes = lista.map((e) => (esObjeto(e) ? e.source : undefined))
  if (lista.length !== RUTAS_PANEL.length || RUTAS_PANEL.some((r) => !fuentes.includes(r))) {
    errores.push(`vercel.json: headers tiene que tener exactamente dos entradas, ${RUTAS_PANEL.join(' y ')} (tiene ${lista.length}: ${fuentes.map((f) => JSON.stringify(f ?? null)).join(', ')}).`)
  }
  for (const entrada of lista) {
    if (!esObjeto(entrada)) continue
    const extra = Object.keys(entrada).filter((c) => c !== 'source' && c !== 'headers')
    if (extra.length > 0) errores.push(`vercel.json: la entrada ${JSON.stringify(entrada.source ?? null)} solo puede tener source y headers (tiene también ${extra.join(', ')}).`)
  }
}

export function verificarCspPanel({ apiUrl, clientId, vercel }: { apiUrl: unknown; clientId: unknown; vercel: unknown }): Hallazgos {
  const hallazgos: Hallazgos = { vercel: [], entorno: [] }
  const origen = origenDeApi(apiUrl, hallazgos.entorno)
  revisarClientId(clientId, hallazgos.entorno)
  revisarEntradas(vercel, hallazgos.vercel)
  const entradas = esObjeto(vercel) && Array.isArray(vercel.headers) ? vercel.headers.filter(esObjeto) : []

  const cabecerasPorRuta = RUTAS_PANEL.map((ruta) => {
    const coincidentes = entradas.filter((e) => e.source === ruta)
    if (coincidentes.length !== 1) {
      hallazgos.vercel.push(`vercel.json tiene que tener exactamente una entrada de headers para ${ruta}.`)
      return null
    }
    const lista = coincidentes[0].headers
    const cabeceras = Array.isArray(lista) ? lista.filter(esCabecera) : []
    if (!Array.isArray(lista) || cabeceras.length !== lista.length) hallazgos.vercel.push(`${ruta}: headers tiene que ser una lista de { key, value } de texto.`)
    if (cabeceras.some((c) => c.key.toLowerCase() === CSP_REPORT_ONLY)) {
      hallazgos.vercel.push(`${ruta}: no puede tener Content-Security-Policy-Report-Only; la CSP tiene que ser obligatoria.`)
    }
    for (const { value } of cabeceras.filter((c) => c.key.toLowerCase() === CSP)) {
      revisarFuentes(ruta, value, hallazgos.vercel)
      const connect = directiva(value, 'connect-src')
      if (connect === null) hallazgos.vercel.push(`${ruta}: la CSP no tiene connect-src.`)
      else if (origen !== null && !connect.includes(origen)) hallazgos.entorno.push(`${ruta}: connect-src no incluye el origen de VITE_API_URL (${origen}).`)
    }
    revisarHeaders(ruta, cabeceras, hallazgos.vercel)
    return cabeceras
  })

  const [a, b] = cabecerasPorRuta
  if (a && b && JSON.stringify(a) !== JSON.stringify(b)) hallazgos.vercel.push(`${RUTAS_PANEL.join(' y ')} tienen que tener los mismos headers.`)
  return hallazgos
}

// errores: hacen fallar el build. avisos: se muestran como advertencia.
export function clasificar(hallazgos: Hallazgos, modo: ModoBuild): { errores: string[]; avisos: string[] } {
  return modo === 'estricto' ? { errores: [...hallazgos.vercel, ...hallazgos.entorno], avisos: [] } : { errores: hallazgos.vercel, avisos: hallazgos.entorno }
}

export function verificarCspPanelPlugin(env: Record<string, string | undefined> = process.env): Plugin {
  return {
    name: 'verificar-csp-panel',
    apply: 'build',
    configResolved(config) {
      const modo = decidirModo(env)
      let vercel: unknown
      try {
        vercel = JSON.parse(readFileSync(resolve(config.root, 'vercel.json'), 'utf8'))
      } catch {
        throw new Error(`verificar-csp-panel (modo ${modo}): no se pudo leer vercel.json como JSON.`)
      }
      const hallazgos = verificarCspPanel({ apiUrl: config.env.VITE_API_URL, clientId: config.env.VITE_GOOGLE_CLIENT_ID, vercel })
      const { errores, avisos } = clasificar(hallazgos, modo)
      if (errores.length > 0) throw new Error(`verificar-csp-panel (modo ${modo}):\n- ${errores.join('\n- ')}`)
      if (avisos.length > 0) {
        config.logger.warn(
          `\nADVERTENCIA verificar-csp-panel (modo normal, build local):\n- ${avisos.join('\n- ')}\n` +
            'En Vercel (VERCEL=1) o con PANEL_BUILD_ESTRICTO=1 esto haría fallar el build.\n',
        )
      } else {
        config.logger.info(`verificar-csp-panel: modo ${modo}, sin observaciones.`)
      }
    },
  }
}
