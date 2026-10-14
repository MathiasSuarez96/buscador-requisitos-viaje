import type { Detalle } from './detalle.ts'
import { leerJsonLimitado } from './propuestas.ts'
import type { HacerFetch } from './sesion.ts'

export type AccionDecision = 'aprobar' | 'rechazar'
export interface InstantaneaDecision {
  estado_esperado: 'pendiente_aprobacion'
  payload_hash_esperado: string
  version_coordinacion_esperada: number
}
export interface DecisionRegistrada {
  tipo_evento: 'aprobacion' | 'rechazo'
  propuesta_id: string
  evento_id: string
  estado_anterior: string
  estado_nuevo: string
  version_coordinacion_nueva: number
  ocurrido_en: string
  actor: { tipo: 'humano'; identificador: string }
  ya_registrada: boolean
}
export interface ErrorDecision {
  fallo: 'permiso' | 'no_encontrado' | 'cambio' | 'no_decidible' | 'solicitud' | 'no_disponible' | 'incierto'
  requestId: string | null
  actual: { estado: string | null; payload_hash: string | null; version_coordinacion: number | null; ultimo_evento: { tipo_evento: string | null; ocurrido_en: string | null } | null } | null
  motivos: string[]
  autenticacionVencida: boolean
}
export type ResultadoDecision = { tipo: 'ok'; decision: DecisionRegistrada; requestId: string | null } | { tipo: 'error'; error: ErrorDecision }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256 = /^[0-9a-f]{64}$/
const ESTADOS = ['pendiente_aprobacion', 'aprobada', 'rechazada', 'obsoleta', 'revision_requerida', 'conflicto', 'cancelada', 'aplicada']
const TIEMPO_LIMITE = 20_000
const esObjeto = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const uuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v)
const safeInteger = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const requestIdError = (cuerpo: unknown): string | null => {
  if (!esObjeto(cuerpo) || !esObjeto(cuerpo.error) || !uuid(cuerpo.error.request_id)) return null
  return cuerpo.error.request_id
}

export function esMotivoValido(motivo: string): boolean {
  for (let i = 0; i < motivo.length; i++) {
    const code = motivo.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const siguiente = motivo.charCodeAt(i + 1)
      if (!(siguiente >= 0xdc00 && siguiente <= 0xdfff)) return false
      i++
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  const puntos = [...motivo.trim()].length
  return puntos >= 1 && puntos <= 500 && !/(?![\n\t])\p{Cc}/u.test(motivo)
}

export function instantaneaDe(d: Detalle): InstantaneaDecision | null {
  const p = d.propuesta
  if (p.estado !== 'pendiente_aprobacion' || !p.payload_hash || !safeInteger(p.version_coordinacion)) return null
  return Object.freeze({ estado_esperado: p.estado, payload_hash_esperado: p.payload_hash, version_coordinacion_esperada: p.version_coordinacion })
}

function leerActual(v: unknown): ErrorDecision['actual'] | null {
  if (!esObjeto(v) || !(v.estado === null || (typeof v.estado === 'string' && ESTADOS.includes(v.estado))) || !(v.payload_hash === null || (typeof v.payload_hash === 'string' && SHA256.test(v.payload_hash))) || !(v.version_coordinacion === null || Number.isInteger(v.version_coordinacion))) return null
  let ultimoEvento: NonNullable<ErrorDecision['actual']>['ultimo_evento'] = null
  if (v.ultimo_evento !== null) {
    if (!esObjeto(v.ultimo_evento) || !(v.ultimo_evento.tipo_evento === null || (typeof v.ultimo_evento.tipo_evento === 'string' && /^[a-z_]{1,50}$/.test(v.ultimo_evento.tipo_evento))) || !(v.ultimo_evento.ocurrido_en === null || (typeof v.ultimo_evento.ocurrido_en === 'string' && v.ultimo_evento.ocurrido_en.length <= 40 && Number.isFinite(Date.parse(v.ultimo_evento.ocurrido_en))))) return null
    ultimoEvento = { tipo_evento: v.ultimo_evento.tipo_evento, ocurrido_en: v.ultimo_evento.ocurrido_en }
  }
  return { estado: v.estado as string | null, payload_hash: v.payload_hash as string | null, version_coordinacion: v.version_coordinacion as number | null, ultimo_evento: ultimoEvento }
}

function leerDecision(v: unknown, accion: AccionDecision, id: string, snapshot: InstantaneaDecision): DecisionRegistrada | null {
  if (!esObjeto(v) || !esObjeto(v.decision)) return null
  const d = v.decision
  const esperado = accion === 'aprobar' ? 'aprobada' : 'rechazada'
  const tipoEvento = accion === 'aprobar' ? 'aprobacion' : 'rechazo'
  if (d.tipo_evento !== tipoEvento || d.propuesta_id !== id || d.estado_anterior !== snapshot.estado_esperado || d.estado_nuevo !== esperado || !uuid(d.evento_id) || d.version_coordinacion_nueva !== snapshot.version_coordinacion_esperada + 1 || typeof d.ocurrido_en !== 'string' || d.ocurrido_en.length > 40 || !Number.isFinite(Date.parse(d.ocurrido_en)) || typeof d.ya_registrada !== 'boolean' || !esObjeto(d.actor) || d.actor.tipo !== 'humano' || typeof d.actor.identificador !== 'string' || d.actor.identificador.length < 1 || d.actor.identificador.length > 100) return null
  return {
    tipo_evento: d.tipo_evento as 'aprobacion' | 'rechazo', propuesta_id: d.propuesta_id as string, evento_id: d.evento_id as string,
    estado_anterior: d.estado_anterior as string, estado_nuevo: d.estado_nuevo as string,
    version_coordinacion_nueva: d.version_coordinacion_nueva as number, ocurrido_en: d.ocurrido_en as string,
    actor: { tipo: 'humano', identificador: d.actor.identificador }, ya_registrada: d.ya_registrada,
  }
}

export async function enviarDecision(origen: string, token: string, accion: AccionDecision, id: string, snapshot: InstantaneaDecision, motivo: string, hacerFetch: HacerFetch, signal?: AbortSignal, tiempoLimite = TIEMPO_LIMITE): Promise<ResultadoDecision> {
  if (!uuid(id) || snapshot.estado_esperado !== 'pendiente_aprobacion' || !SHA256.test(snapshot.payload_hash_esperado) || !safeInteger(snapshot.version_coordinacion_esperada) || (accion === 'rechazar' && !esMotivoValido(motivo))) {
    return { tipo: 'error', error: { fallo: 'solicitud', requestId: null, actual: null, motivos: [], autenticacionVencida: false } }
  }
  const body: Record<string, unknown> = {
    estado_esperado: snapshot.estado_esperado,
    payload_hash_esperado: snapshot.payload_hash_esperado,
    version_coordinacion_esperada: snapshot.version_coordinacion_esperada,
  }
  if (accion === 'rechazar') body.motivo = motivo
  const controlador = new AbortController()
  if (signal?.aborted) controlador.abort()
  else signal?.addEventListener('abort', () => controlador.abort(), { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  let expirado = false
  let respuesta: Response
  let vencer: (reason: Error) => void = () => {}
  const plazo = new Promise<never>((_, reject) => { vencer = reject })
  timer = setTimeout(() => { expirado = true; controlador.abort(); vencer(new Error('timeout')) }, tiempoLimite)
  try {
    const llamada = hacerFetch(`${origen}/api/panel/propuestas/${id}/${accion === 'aprobar' ? 'aprobacion' : 'rechazo'}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controlador.signal,
    })
    respuesta = await Promise.race([llamada, plazo])
  } catch {
    if (timer) clearTimeout(timer)
    return { tipo: 'error', error: { fallo: 'incierto', requestId: null, actual: null, motivos: [], autenticacionVencida: false } }
  }
  const cabecera = respuesta.headers.get('X-Request-Id')
  const idCabecera = cabecera && uuid(cabecera) ? cabecera : null
  let cuerpo: unknown = null
  let parseable = false
  try {
    if (respuesta.body) {
      const lectura = await Promise.race([leerJsonLimitado(respuesta, token), plazo])
      if (lectura !== null) { cuerpo = lectura; parseable = true }
    }
  } catch { /* Un POST con cuerpo inválido tiene resultado incierto. */ }
  if (timer) clearTimeout(timer)
  const requestId = idCabecera ?? requestIdError(cuerpo)

  if (expirado) return { tipo: 'error', error: { fallo: 'incierto', requestId, actual: null, motivos: [], autenticacionVencida: false } }

  if (respuesta.status === 200) {
    const decision = parseable ? leerDecision(cuerpo, accion, id, snapshot) : null
    return decision ? { tipo: 'ok', decision, requestId } : { tipo: 'error', error: { fallo: 'incierto', requestId, actual: null, motivos: [], autenticacionVencida: false } }
  }
  if ([500].includes(respuesta.status) || !parseable || !esObjeto(cuerpo) || !esObjeto(cuerpo.error)) {
    return { tipo: 'error', error: { fallo: 'incierto', requestId, actual: null, motivos: [], autenticacionVencida: respuesta.status === 401 } }
  }
  const e = cuerpo.error
  if (respuesta.status === 401) return { tipo: 'error', error: { fallo: 'permiso', requestId, actual: null, motivos: [], autenticacionVencida: true } }
  if (respuesta.status === 403) return { tipo: 'error', error: { fallo: 'permiso', requestId, actual: null, motivos: [], autenticacionVencida: false } }
  if (respuesta.status === 404) return { tipo: 'error', error: { fallo: 'no_encontrado', requestId, actual: null, motivos: [], autenticacionVencida: false } }
  if (respuesta.status === 409) return { tipo: 'error', error: { fallo: 'cambio', requestId, actual: leerActual(e.actual), motivos: [], autenticacionVencida: false } }
  if (respuesta.status === 422) return { tipo: 'error', error: { fallo: 'no_decidible', requestId, actual: null, motivos: Array.isArray(e.motivos) ? e.motivos.filter((m): m is string => typeof m === 'string' && /^[a-z_]{1,80}$/.test(m)).slice(0, 30) : [], autenticacionVencida: false } }
  if ([400, 413, 415, 503].includes(respuesta.status)) return { tipo: 'error', error: { fallo: respuesta.status === 503 ? 'no_disponible' : 'solicitud', requestId, actual: null, motivos: [], autenticacionVencida: false } }
  return { tipo: 'error', error: { fallo: 'incierto', requestId, actual: null, motivos: [], autenticacionVencida: false } }
}
