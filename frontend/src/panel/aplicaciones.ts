import type { Detalle } from './detalle.ts'
import { leerJsonLimitado } from './propuestas.ts'
import type { HacerFetch } from './sesion.ts'

export interface InstantaneaAplicacion {
  estado_esperado: 'aprobada'
  payload_hash_esperado: string
  version_coordinacion_esperada: number
  decision_aprobacion_id_esperado: string
}
export interface AplicacionRegistrada {
  propuesta_id: string
  resultado: 'exito'
  destino_modificado: true
  estado_propuesta_nuevo: 'aplicada'
  version_coordinacion_nueva: number
  decision_aprobacion_id: string
  evento_id: string
  intento_id: string
  aplicado_en: string
  ya_aplicada: boolean
}
export interface ErrorAplicacion {
  fallo: 'permiso' | 'no_encontrado' | 'cambio' | 'no_aplica' | 'solicitud' | 'no_disponible' | 'incierto'
  requestId: string | null
  actual: { estado: string | null; payload_hash: string | null; version_coordinacion: number | null; decision_aprobacion_id: string | null; ultimo_evento_id: string | null } | null
  resultado: string | null
  estadoNuevo: string | null
  intentoId: string | null
  autenticacionVencida: boolean
}
export type ResultadoAplicacion = { tipo: 'ok'; aplicacion: AplicacionRegistrada; requestId: string | null } | { tipo: 'error'; error: ErrorAplicacion }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256 = /^[0-9a-f]{64}$/
const ESTADOS = ['pendiente_aprobacion', 'aprobada', 'rechazada', 'obsoleta', 'revision_requerida', 'conflicto', 'cancelada', 'aplicada']
const RESULTADOS = ['propuesta_no_aplicable', 'fuente_temporalmente_no_disponible', 'extraccion_ambigua', 'fuente_cambio', 'revalidacion_vencida', 'identidad_requisito_cambio', 'valor_actual_cambio', 'resultado_incierto']
const esObjeto = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const uuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v)
const error = (fallo: ErrorAplicacion['fallo'], requestId: string | null = null, extra: Partial<ErrorAplicacion> = {}): ResultadoAplicacion => ({ tipo: 'error', error: { fallo, requestId, actual: null, resultado: null, estadoNuevo: null, intentoId: null, autenticacionVencida: false, ...extra } })
const requestIdError = (cuerpo: unknown): string | null => esObjeto(cuerpo) && esObjeto(cuerpo.error) && uuid(cuerpo.error.request_id) ? cuerpo.error.request_id : null
const tiempoLimite = 30_000

export function instantaneaAplicacionDe(d: Detalle): InstantaneaAplicacion | null {
  const p = d.propuesta
  if (p.estado !== 'aprobada' || !p.payload_hash || !Number.isSafeInteger(p.version_coordinacion) || !p.decision_aprobacion_id) return null
  return Object.freeze({ estado_esperado: 'aprobada', payload_hash_esperado: p.payload_hash, version_coordinacion_esperada: p.version_coordinacion!, decision_aprobacion_id_esperado: p.decision_aprobacion_id })
}

function leerActual(v: unknown): ErrorAplicacion['actual'] | null {
  if (!esObjeto(v) || !(v.estado === null || (typeof v.estado === 'string' && ESTADOS.includes(v.estado))) || !(v.payload_hash === null || (typeof v.payload_hash === 'string' && SHA256.test(v.payload_hash))) || !(v.version_coordinacion === null || (typeof v.version_coordinacion === 'number' && Number.isSafeInteger(v.version_coordinacion))) || !(v.decision_aprobacion_id === null || uuid(v.decision_aprobacion_id)) || !(v.ultimo_evento_id === null || uuid(v.ultimo_evento_id))) return null
  return { estado: v.estado as string | null, payload_hash: v.payload_hash as string | null, version_coordinacion: v.version_coordinacion as number | null, decision_aprobacion_id: v.decision_aprobacion_id as string | null, ultimo_evento_id: v.ultimo_evento_id as string | null }
}
function leerAplicacion(v: unknown, id: string, snapshot: InstantaneaAplicacion): AplicacionRegistrada | null {
  if (!esObjeto(v) || !esObjeto(v.aplicacion)) return null
  const a = v.aplicacion
  const keys = ['propuesta_id', 'resultado', 'destino_modificado', 'estado_propuesta_nuevo', 'version_coordinacion_nueva', 'decision_aprobacion_id', 'evento_id', 'intento_id', 'aplicado_en', 'ya_aplicada']
  if (Object.keys(a).length !== keys.length || keys.some(k => !Object.hasOwn(a, k)) || a.propuesta_id !== id || a.resultado !== 'exito' || a.destino_modificado !== true || a.estado_propuesta_nuevo !== 'aplicada' || a.version_coordinacion_nueva !== snapshot.version_coordinacion_esperada + 1 || a.decision_aprobacion_id !== snapshot.decision_aprobacion_id_esperado || !uuid(a.evento_id) || !uuid(a.intento_id) || typeof a.aplicado_en !== 'string' || !Number.isFinite(Date.parse(a.aplicado_en)) || typeof a.ya_aplicada !== 'boolean') return null
  return { propuesta_id: id, resultado: 'exito', destino_modificado: true, estado_propuesta_nuevo: 'aplicada', version_coordinacion_nueva: a.version_coordinacion_nueva as number, decision_aprobacion_id: a.decision_aprobacion_id as string, evento_id: a.evento_id, intento_id: a.intento_id, aplicado_en: a.aplicado_en, ya_aplicada: a.ya_aplicada }
}

export async function enviarAplicacion(origen: string, token: string, id: string, snapshot: InstantaneaAplicacion, hacerFetch: HacerFetch, signal?: AbortSignal, limiteMs = tiempoLimite): Promise<ResultadoAplicacion> {
  if (!uuid(id) || snapshot.estado_esperado !== 'aprobada' || !SHA256.test(snapshot.payload_hash_esperado) || !Number.isSafeInteger(snapshot.version_coordinacion_esperada) || snapshot.version_coordinacion_esperada < 0 || !uuid(snapshot.decision_aprobacion_id_esperado)) return error('solicitud')
  const body = { estado_esperado: snapshot.estado_esperado, payload_hash_esperado: snapshot.payload_hash_esperado, version_coordinacion_esperada: snapshot.version_coordinacion_esperada, decision_aprobacion_id_esperado: snapshot.decision_aprobacion_id_esperado }
  const controlador = new AbortController()
  if (signal?.aborted) controlador.abort()
  else signal?.addEventListener('abort', () => controlador.abort(), { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  let expirado = false
  let vencer: (reason: Error) => void = () => {}
  const plazo = new Promise<never>((_, reject) => { vencer = reject })
  timer = setTimeout(() => { expirado = true; controlador.abort(); vencer(new Error('timeout')) }, limiteMs)
  let respuesta: Response
  try {
    const llamada = hacerFetch(`${origen}/api/panel/propuestas/${id}/aplicacion`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controlador.signal })
    respuesta = await Promise.race([llamada, plazo])
  } catch { if (timer) clearTimeout(timer); return error('incierto') }
  const header = respuesta.headers.get('X-Request-Id')
  let cuerpo: unknown = null
  let parseable = false
  try {
    if (respuesta.body) {
      const lectura = await Promise.race([leerJsonLimitado(respuesta, token), plazo])
      if (lectura !== null) { cuerpo = lectura; parseable = true }
    }
  } catch { /* En una escritura no se puede inferir el resultado de un cuerpo ilegible. */ }
  if (timer) clearTimeout(timer)
  const requestId = header && uuid(header) ? header : requestIdError(cuerpo)
  if (expirado) return error('incierto', requestId)
  if (respuesta.status === 200) {
    const aplicacion = parseable ? leerAplicacion(cuerpo, id, snapshot) : null
    return aplicacion ? { tipo: 'ok', aplicacion, requestId } : error('incierto', requestId)
  }
  if ([500].includes(respuesta.status) || !parseable || !esObjeto(cuerpo) || !esObjeto(cuerpo.error)) return error('incierto', requestId)
  const e = cuerpo.error
  if (respuesta.status === 401) return error('permiso', requestId, { autenticacionVencida: true })
  if (respuesta.status === 403) return error('permiso', requestId)
  if (respuesta.status === 404) return error('no_encontrado', requestId)
  if (respuesta.status === 409) return error('cambio', requestId, { actual: leerActual(e.actual) })
  if (respuesta.status === 422) {
    const a = esObjeto(e.aplicacion) ? e.aplicacion : null
    return error('no_aplica', requestId, { resultado: a && typeof a.resultado === 'string' && RESULTADOS.includes(a.resultado) ? a.resultado : null, estadoNuevo: a && (a.estado_propuesta_nuevo === null || (typeof a.estado_propuesta_nuevo === 'string' && ESTADOS.includes(a.estado_propuesta_nuevo))) ? a.estado_propuesta_nuevo as string | null : null, intentoId: a && uuid(a.intento_id) ? a.intento_id : null })
  }
  if ([400, 413, 415].includes(respuesta.status)) return error('solicitud', requestId)
  if (respuesta.status === 503) return error('no_disponible', requestId)
  return error('incierto', requestId)
}
