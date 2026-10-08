// Comprobación de build del panel: la CSP de vercel.json tiene que permitir
// exactamente el origen de VITE_API_URL en connect-src, y VITE_GOOGLE_CLIENT_ID
// tiene que tener la forma que valida el backend. vercel.json es estático (no
// admite variables), así que el origen está escrito a mano en dos lugares.
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
const NOMBRES_CSP = ['content-security-policy', 'content-security-policy-report-only']

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
// Hashes: solo en style-src y style-src-elem, y con los mismos valores en las
// dos (style-src es el respaldo de los navegadores sin style-src-elem). El
// hash de vercel.json corresponde al texto exacto del <style> que inyecta el
// script de Google Identity Services (client:427), que Google sirve sin
// versión. Si Google cambia ese texto, el hash deja de coincidir y el botón se
// ve roto hasta actualizarlo; se detecta por una violación nueva de
// style-src-elem en la consola, con el hash nuevo que pide el navegador.
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
}

export function verificarCspPanel({ apiUrl, clientId, vercel }: { apiUrl: unknown; clientId: unknown; vercel: unknown }): Hallazgos {
  const hallazgos: Hallazgos = { vercel: [], entorno: [] }
  const origen = origenDeApi(apiUrl, hallazgos.entorno)
  revisarClientId(clientId, hallazgos.entorno)
  const entradas = esObjeto(vercel) && Array.isArray(vercel.headers) ? vercel.headers.filter(esObjeto) : []

  const cabecerasPorRuta = RUTAS_PANEL.map((ruta) => {
    const coincidentes = entradas.filter((e) => e.source === ruta)
    if (coincidentes.length !== 1) {
      hallazgos.vercel.push(`vercel.json tiene que tener exactamente una entrada de headers para ${ruta}.`)
      return null
    }
    const lista = coincidentes[0].headers
    const cabeceras = Array.isArray(lista) ? lista.filter(esCabecera) : []
    const csps = cabeceras.filter((c) => NOMBRES_CSP.includes(c.key.toLowerCase()))
    if (csps.length === 0) hallazgos.vercel.push(`${ruta}: falta Content-Security-Policy(-Report-Only).`)
    for (const { value } of csps) {
      revisarFuentes(ruta, value, hallazgos.vercel)
      const connect = directiva(value, 'connect-src')
      if (connect === null) hallazgos.vercel.push(`${ruta}: la CSP no tiene connect-src.`)
      else if (origen !== null && !connect.includes(origen)) hallazgos.entorno.push(`${ruta}: connect-src no incluye el origen de VITE_API_URL (${origen}).`)
    }
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
