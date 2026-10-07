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

function directiva(csp: string, nombre: string): string[] | null {
  for (const parte of csp.split(';')) {
    const [clave, ...valores] = parte.trim().split(/\s+/)
    if (clave?.toLowerCase() === nombre) return valores
  }
  return null
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
      if (/'unsafe-(inline|eval)'/i.test(value)) hallazgos.vercel.push(`${ruta}: la CSP no puede permitir 'unsafe-inline' ni 'unsafe-eval'.`)
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
