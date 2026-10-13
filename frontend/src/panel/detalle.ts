import { ESTADOS, leerJsonLimitado, type FalloListado } from './propuestas.ts'
import type { HacerFetch } from './sesion.ts'

// Proyección explícita del contrato de services/panel/lectura-propuestas.js.
// Los campos desconocidos (incluida cualquier identidad privada) se descartan.
type Lector<T> = (valor: unknown) => T
const invalido = (): never => { throw new Error('respuesta_invalida') }
const objeto = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : invalido()
const cadena = (max: number): Lector<string> => v => typeof v === 'string' && v.length <= max ? v : invalido()
const booleano: Lector<boolean> = v => typeof v === 'boolean' ? v : invalido()
const entero: Lector<number> = v => typeof v === 'number' && Number.isInteger(v) ? v : invalido()
const nullable = <T,>(leer: Lector<T>): Lector<T | null> => v => v === null ? null : leer(v)
const enumerado = <T extends string,>(valores: readonly T[]): Lector<T> => v => typeof v === 'string' && valores.includes(v as T) ? v as T : invalido()
const patron = (re: RegExp): Lector<string> => v => typeof v === 'string' && re.test(v) ? v : invalido()
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const uuid = patron(UUID)
const hex = nullable(patron(/^[0-9a-f]{24}$/))
const hash = nullable(patron(/^[0-9a-f]{64}$/))
const fecha = nullable((v: unknown) => { const s = cadena(40)(v); return Number.isFinite(Date.parse(s)) ? s : invalido() })
const texto = (max: number) => nullable(cadena(max))
const estado = nullable(enumerado(ESTADOS))
const moneda = nullable(patron(/^[A-Z]{3}$/))
const lista = <T,>(leer: Lector<T>, max: number): Lector<T[]> => v => Array.isArray(v) && v.length <= max ? v.map(leer) : invalido()
function forma<S extends Record<string, Lector<unknown>>>(campos: S): Lector<{ [K in keyof S]: ReturnType<S[K]> }> {
  return v => {
    const original = objeto(v)
    const limpio: Record<string, unknown> = {}
    for (const [clave, leer] of Object.entries(campos)) {
      if (!Object.hasOwn(original, clave)) invalido()
      limpio[clave] = leer(original[clave])
    }
    return limpio as { [K in keyof S]: ReturnType<S[K]> }
  }
}
const presencia = nullable(forma({ presente: booleano, valor: texto(512 * 1024) }))
const acciones = ['aprobar', 'rechazar'] as const
const codigos = lista(patron(/^[a-z_]{1,80}$/), 30)
const fuente = forma({ nombre: texto(101), url: texto(500), capturado_en: fecha })
const leerDetalle = forma({
  propuesta: forma({
    propuesta_id: uuid, estado, campo: texto(51), destino_id: hex, requisito_id: hex,
    valor_anterior: presencia,
    valor_propuesto: forma({ valor: texto(101), importe: nullable(entero), moneda }),
    fuente, version_coordinacion: nullable(entero), creada_en: fecha, actualizada_en: fecha,
    payload_hash: hash, decision_aprobacion_id: nullable(uuid), ultimo_evento_id: nullable(uuid),
    evidencia: forma({
      fuente: texto(101), url: texto(500), capturado_en: fecha, fuente_actualizada_en: fecha,
      valor_extraido: texto(101), importe: nullable(entero), moneda,
      secciones: lista(forma({ seccion: patron(/^[a-z_]{1,32}$/), costo_extraido: nullable(entero), moneda }), 5),
      coincide_entre_secciones: nullable(booleano), avisos: lista(texto(201), 10),
    }),
  }),
  integridad: forma({ hash_coincide: booleano, hash_recalculado: hash, consistente: booleano, problemas: codigos }),
  requisito_actual: forma({
    estado: enumerado(['coincide', 'destino_no_encontrado', 'requisito_id_no_encontrado', 'requisito_id_duplicado', 'identidad_semantica_no_coincide', 'identidad_no_verificable', 'no_evaluable']),
    destino: nullable(forma({ destino_id: patron(/^[0-9a-f]{24}$/), pais: texto(201), codigo_iso: nullable(patron(/^[A-Z]{2}$/)) })),
    requisito: nullable(forma({ requisito_id: hex, tipo: texto(51), nombre: texto(101) })),
    valor_actual: presencia, valor: nullable(enumerado(['coincide', 'cambio'])),
  }),
  eventos: lista(forma({
    evento_id: texto(37), tipo_evento: texto(51), estado_anterior: estado, estado_nuevo: estado,
    ocurrido_en: fecha, version_coordinacion_nueva: nullable(entero), hash_contenido_referenciado: hash,
    // Solo el tipo del actor; no se conserva su identificador ni su identidad.
    actor: forma({ tipo: nullable(enumerado(['humano', 'sistema'])) }),
    origen: nullable(enumerado(['decidir-propuesta', 'panel-propuestas', 'aplicar-propuesta'])),
    metodo_identidad: nullable(enumerado(['connection_status', 'oidc_google'])),
    motivo: texto(501), intento_aplicacion_id: nullable(uuid),
  }), 200),
  eventos_truncados: booleano,
  acciones_permitidas: lista(enumerado(acciones), 2),
  acciones_bloqueadas: forma({ aprobar: codigos, rechazar: codigos }),
})
export type Detalle = ReturnType<typeof leerDetalle>
export type ValorPresente = Detalle['propuesta']['valor_anterior']
export type FalloDetalle = FalloListado | 'no_encontrado'
export type ResultadoDetalle = { tipo: 'ok'; detalle: Detalle; requestId: string | null } | { tipo: 'error'; fallo: FalloDetalle; requestId: string | null }

export function validarDetalle(v: unknown, propuestaId: string): Detalle | null {
  try {
    const d = leerDetalle(v)
    if (d.propuesta.propuesta_id !== propuestaId) return null
    if (new Set(d.acciones_permitidas).size !== d.acciones_permitidas.length) return null
    for (const a of acciones) if (d.acciones_permitidas.includes(a) !== (d.acciones_bloqueadas[a].length === 0)) return null
    return d
  } catch { return null }
}

export function urlHttpsSegura(v: string | null): string | null {
  if (!v || !/^https:\/\//i.test(v) || /[\s<>"'\\]/.test(v) || [...v].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return null
  try {
    const url = new URL(v)
    return url.protocol === 'https:' && url.hostname !== '' && !url.username && !url.password ? url.href : null
  } catch { return null }
}

export async function consultarDetalle(origen: string, token: string, propuestaId: string, hacerFetch: HacerFetch, signal: AbortSignal): Promise<ResultadoDetalle> {
  if (!UUID.test(propuestaId)) return { tipo: 'error', fallo: 'respuesta', requestId: null }
  let respuesta: Response
  try {
    respuesta = await hacerFetch(`${origen}/api/panel/propuestas/${propuestaId}`, {
      method: 'GET', headers: { Authorization: `Bearer ${token}` }, credentials: 'omit', cache: 'no-store', redirect: 'error', signal,
    })
  } catch { return { tipo: 'error', fallo: 'conexion', requestId: null } }
  let requestId: string | null = null
  try {
    const cabecera = respuesta.headers.get('X-Request-Id')
    if (cabecera && UUID.test(cabecera)) requestId = cabecera
    const cuerpo = await leerJsonLimitado(respuesta, token)
    if (!requestId && cuerpo !== null && typeof cuerpo === 'object') {
      const error = (cuerpo as Record<string, unknown>).error
      if (error !== null && typeof error === 'object') {
        const id = (error as Record<string, unknown>).request_id
        if (typeof id === 'string' && UUID.test(id)) requestId = id
      }
    }
    const fallos: Record<number, FalloDetalle> = { 401: 'sesion', 403: 'permiso', 404: 'no_encontrado', 500: 'servidor', 503: 'no_disponible' }
    if (fallos[respuesta.status]) return { tipo: 'error', fallo: fallos[respuesta.status], requestId }
    const detalle = respuesta.status === 200 ? validarDetalle(cuerpo, propuestaId) : null
    return detalle ? { tipo: 'ok', detalle, requestId } : { tipo: 'error', fallo: 'respuesta', requestId }
  } catch { return { tipo: 'error', fallo: 'respuesta', requestId } }
}
