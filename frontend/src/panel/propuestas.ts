import type { HacerFetch } from './sesion.ts'

export const ESTADOS = ['pendiente_aprobacion', 'aprobada', 'rechazada', 'obsoleta', 'revision_requerida', 'conflicto', 'cancelada', 'aplicada'] as const
export type EstadoPropuesta = typeof ESTADOS[number]
export interface Filtro { estados: EstadoPropuesta[]; limite: number }
export interface Propuesta {
  propuesta_id: string
  destino_id: string | null
  destino: { destino_id: string; pais: string | null; codigo_iso: string | null } | null
  requisito_id: string | null
  estado: EstadoPropuesta | null
  campo: string | null
  creada_en: string | null
  actualizada_en: string | null
  alertas: string[]
}
export interface Pagina { propuestas: Propuesta[]; siguiente_cursor: string | null }
export type FalloListado = 'sesion' | 'permiso' | 'servidor' | 'no_disponible' | 'conexion' | 'respuesta'
export type ResultadoListado = { tipo: 'ok'; pagina: Pagina; requestId: string | null } | { tipo: 'error'; fallo: FalloListado; requestId: string | null }
export const MAXIMO_RESPUESTA = 512 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const HEX = /^[0-9a-f]{24}$/
const objeto = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const texto = (v: unknown, max: number): v is string | null => v === null || (typeof v === 'string' && v.length <= max)
const id = (v: unknown): v is string | null => v === null || (typeof v === 'string' && HEX.test(v))
const fecha = (v: unknown): v is string | null => v === null || (typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)))

export function filtroValido(f: Filtro): boolean {
  return Number.isInteger(f.limite) && f.limite >= 1 && f.limite <= 50 && f.estados.length > 0 && new Set(f.estados).size === f.estados.length && f.estados.every(e => ESTADOS.includes(e))
}

export function cursorValido(v: unknown, filtro: Filtro): v is string {
  if (typeof v !== 'string' || !/^v1\.[0-9a-f]{24}\.[0-9a-f]{2}$/.test(v)) return false
  const mascara = ESTADOS.reduce((m, e, i) => filtro.estados.includes(e) ? m | (1 << i) : m, 0).toString(16).padStart(2, '0')
  return v.endsWith(`.${mascara}`)
}

// Lista blanca de los campos que usa esta pantalla. No se conserva el cuerpo crudo.
export function validarPagina(v: unknown, filtro: Filtro): Pagina | null {
  if (!objeto(v) || !Array.isArray(v.propuestas) || v.propuestas.length > filtro.limite || v.limite !== filtro.limite || !objeto(v.filtro) || !Array.isArray(v.filtro.estados)) return null
  const canonicos = ESTADOS.filter(e => filtro.estados.includes(e))
  if (JSON.stringify(v.filtro.estados) !== JSON.stringify(canonicos)) return null
  if (v.siguiente_cursor !== null && !cursorValido(v.siguiente_cursor, filtro)) return null
  if (v.propuestas.length === 0 && v.siguiente_cursor !== null) return null
  const propuestas: Propuesta[] = []
  for (const p of v.propuestas) {
    if (!objeto(p) || typeof p.propuesta_id !== 'string' || !UUID.test(p.propuesta_id) || !id(p.destino_id) || !id(p.requisito_id)) return null
    if (p.estado !== null && !filtro.estados.includes(p.estado as EstadoPropuesta)) return null
    if (!texto(p.campo, 51) || !fecha(p.creada_en) || !fecha(p.actualizada_en)) return null
    if (!Array.isArray(p.alertas) || p.alertas.length > 20 || !p.alertas.every(a => typeof a === 'string' && /^[a-z_]{1,80}$/.test(a))) return null
    let destino: Propuesta['destino'] = null
    if (p.destino !== null) {
      const d = p.destino
      if (!objeto(d) || typeof d.destino_id !== 'string' || !HEX.test(d.destino_id) || d.destino_id !== p.destino_id || !texto(d.pais, 201)) return null
      if (d.codigo_iso !== null && (typeof d.codigo_iso !== 'string' || !/^[A-Z]{2}$/.test(d.codigo_iso))) return null
      destino = { destino_id: d.destino_id, pais: d.pais, codigo_iso: d.codigo_iso as string | null }
    }
    propuestas.push({ propuesta_id: p.propuesta_id, destino_id: p.destino_id, destino, requisito_id: p.requisito_id, estado: p.estado as EstadoPropuesta | null, campo: p.campo, creada_en: p.creada_en, actualizada_en: p.actualizada_en, alertas: [...p.alertas] as string[] })
  }
  return { propuestas, siguiente_cursor: v.siguiente_cursor as string | null }
}

export function unirPropuestas(previas: Propuesta[], nuevas: Propuesta[]): Propuesta[] {
  const vistas = new Set(previas.map(p => p.propuesta_id))
  return [...previas, ...nuevas.filter(p => { if (vistas.has(p.propuesta_id)) return false; vistas.add(p.propuesta_id); return true })]
}

// El tope se aplica sobre bytes recibidos, antes de decodificar o parsear.
export async function leerJsonLimitado(respuesta: Response, token: string): Promise<unknown> {
  const lector = respuesta.body?.getReader()
  if (!lector) return null
  let bytes = 0
  let contenido = ''
  const decodificador = new TextDecoder('utf-8', { fatal: true })
  try {
    while (true) {
      const { done, value } = await lector.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAXIMO_RESPUESTA) { await lector.cancel(); return null }
      contenido += decodificador.decode(value, { stream: true })
    }
    contenido += decodificador.decode()
    if (contenido.includes(token)) return null
    const cuerpo: unknown = JSON.parse(contenido)
    return JSON.stringify(cuerpo).includes(token) ? null : cuerpo
  } catch {
    try { await lector.cancel() } catch { /* La lectura ya falló. */ }
    return null
  } finally {
    lector.releaseLock()
  }
}

export async function consultarPropuestas(origen: string, token: string, filtro: Filtro, cursor: string | null, hacerFetch: HacerFetch, signal?: AbortSignal): Promise<ResultadoListado> {
  if (!filtroValido(filtro) || (cursor !== null && !cursorValido(cursor, filtro))) return { tipo: 'error', fallo: 'respuesta', requestId: null }
  let r: Response
  try {
    const query = `estado=${filtro.estados.join(',')}&limite=${filtro.limite}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`
    r = await hacerFetch(`${origen}/api/panel/propuestas?${query}`, { method: 'GET', headers: { Authorization: `Bearer ${token}` }, credentials: 'omit', cache: 'no-store', redirect: 'error', signal })
  } catch { return { tipo: 'error', fallo: 'conexion', requestId: null } }
  let requestId: string | null = null
  try {
    const header = r.headers.get('X-Request-Id')
    if (header && UUID.test(header)) requestId = header
    const cuerpo = await leerJsonLimitado(r, token)
    if (!requestId && objeto(cuerpo) && objeto(cuerpo.error) && typeof cuerpo.error.request_id === 'string' && UUID.test(cuerpo.error.request_id)) requestId = cuerpo.error.request_id
    const fallos: Record<number, FalloListado> = { 401: 'sesion', 403: 'permiso', 500: 'servidor', 503: 'no_disponible' }
    if (fallos[r.status]) return { tipo: 'error', fallo: fallos[r.status], requestId }
    const pagina = r.status === 200 ? validarPagina(cuerpo, filtro) : null
    return pagina ? { tipo: 'ok', pagina, requestId } : { tipo: 'error', fallo: 'respuesta', requestId }
  } catch { return { tipo: 'error', fallo: 'respuesta', requestId } }
}
