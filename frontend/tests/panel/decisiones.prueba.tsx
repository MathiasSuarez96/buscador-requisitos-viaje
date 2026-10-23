import assert from 'node:assert/strict'
import { crearControladorPanel } from '../../src/panel/controlador.ts'
import { enviarDecision, esMotivoValido, instantaneaDe, type AccionDecision } from '../../src/panel/decisiones.ts'
import { enviarAplicacion, instantaneaAplicacionDe } from '../../src/panel/aplicaciones.ts'
import { MAXIMO_RESPUESTA } from '../../src/panel/propuestas.ts'
import { CONFIG, TOKEN, REQUEST_ID, SESION_AUTORIZADA, crearGisFalso, crearFetchFalso, respuestaJson, hastaQue, esperar, comprobarSinFugas, renderizar, type Prueba } from './apoyo.tsx'

const ID = '054d03c8-e9ba-4352-8370-e4f88534f612'
const HASH = 'b'.repeat(64)
const HEX = 'a'.repeat(24)
const FECHA = '2026-10-13T12:00:00.000Z'
function detalle(id = ID, cambios: Record<string, unknown> = {}) {
  return {
    propuesta: {
      propuesta_id: id, estado: 'pendiente_aprobacion', campo: 'costo', destino_id: HEX, requisito_id: HEX,
      version_contrato: '1.0', requisito_v2: null,
      valor_anterior: { presente: false, valor: null }, valor_propuesto: { valor: '£20', importe: 20, moneda: 'GBP' },
      fuente: { nombre: 'GOV.UK', url: 'https://www.gov.uk/eta', capturado_en: FECHA }, version_coordinacion: 7, creada_en: FECHA, actualizada_en: FECHA,
      payload_hash: HASH, decision_aprobacion_id: null, ultimo_evento_id: null,
      evidencia: { fuente: 'GOV.UK', url: 'https://www.gov.uk/eta', capturado_en: FECHA, fuente_actualizada_en: FECHA, valor_extraido: '£20', importe: 20, moneda: 'GBP', secciones: [], coincide_entre_secciones: null, avisos: [] },
    },
    integridad: { hash_coincide: true, hash_recalculado: HASH, consistente: true, problemas: [] },
    requisito_actual: { estado: 'coincide', destino: { destino_id: HEX, pais: 'Reino Unido', codigo_iso: 'GB' }, requisito: { requisito_id: HEX, tipo: 'formulario_digital', nombre: 'UK ETA' }, valor_actual: { presente: false, valor: null }, valor: 'coincide' },
    eventos: [], eventos_truncados: false, acciones_permitidas: ['aprobar', 'rechazar'], acciones_bloqueadas: { aprobar: [], rechazar: [], aplicar: ['estado_no_permite_aplicar'] }, ...cambios,
  }
}
const pagina = { propuestas: [{ propuesta_id: ID, estado: 'pendiente_aprobacion', campo: 'costo', destino_id: HEX, destino: { destino_id: HEX, pais: 'Reino Unido', codigo_iso: 'GB' }, requisito_id: HEX, creada_en: FECHA, actualizada_en: null, alertas: [] }], filtro: { estados: ['pendiente_aprobacion'] }, limite: 20, siguiente_cursor: null }
type Responder = Parameters<typeof crearFetchFalso>[0]
async function contexto(responder: Responder, permisos: string[] = ['ver', 'decidir'], tiempoDecisionMs = 20_000, responderDetalle?: (lectura: number) => Response) {
  const gis = crearGisFalso()
  let sesion = { ...SESION_AUTORIZADA, permisos }
  let lecturasDetalle = 0
  const red = crearFetchFalso((url, init) => url.endsWith('/sesion') ? respuestaJson(200, sesion) : url.includes('/propuestas?') ? respuestaJson(200, pagina) : url.endsWith('/' + ID) ? responderDetalle?.(++lecturasDetalle) ?? respuestaJson(200, detalle()) : responder(url, init))
  const controlador = crearControladorPanel({ config: CONFIG, cargarGis: gis.cargar, hacerFetch: red.hacerFetch, tiempoDecisionMs })
  controlador.iniciar(); await hastaQue(() => controlador.obtenerEstado().fase === 'sin_sesion')
  gis.entregar({ credential: TOKEN }); await hastaQue(() => controlador.obtenerListado().cargado)
  return { controlador, gis, red, cambiarSesion: (p: string[], sub?: string) => { sesion = { ...sesion, permisos: p, identidad: { ...sesion.identidad, sub: sub ?? sesion.identidad.sub } } } }
}
const decisionBody = (accion: AccionDecision, id = ID) => ({ decision: { tipo_evento: accion === 'aprobar' ? 'aprobacion' : 'rechazo', propuesta_id: id, evento_id: 'd54d03c8-e9ba-4352-8370-e4f88534f612', estado_anterior: 'pendiente_aprobacion', estado_nuevo: accion === 'aprobar' ? 'aprobada' : 'rechazada', version_coordinacion_nueva: 8, ocurrido_en: FECHA, actor: { tipo: 'humano', identificador: 'operador.panel', email: 'privado@example.com' }, ya_registrada: false, identidad_operador: { email: 'privado@example.com' } } })
const errorJson = (status: number, extra: Record<string, unknown> = {}, requestId: string | null = REQUEST_ID) => respuestaJson(status, { error: { codigo: 'codigo_interno', mensaje: 'NO_MOSTRAR', request_id: requestId, ...extra } }, null)
const aprobada = (cambios: Record<string, unknown> = {}) => detalle(ID, { propuesta: { ...detalle().propuesta, estado: 'aprobada', decision_aprobacion_id: 'd54d03c8-e9ba-4352-8370-e4f88534f612' }, acciones_permitidas: ['aplicar'], acciones_bloqueadas: { aprobar: ['estado_no_permite_decision'], rechazar: ['estado_no_permite_decision'], aplicar: [] }, ...cambios })
const detalleV2 = () => detalle(ID, { propuesta: { ...detalle().propuesta, campo: 'requisito', version_contrato: '2.0', requisito_v2: { completo: true, cambios: [{ campo: 'obligatorio', anterior: { presente: true, bson_tipo: 'string', valor: 'si' }, propuesto: { presente: true, bson_tipo: 'string', valor: 'no' } }], advertencias: ['quita_obligatoriedad'] } } })
const aplicacionBody = (ya_aplicada = false) => ({ aplicacion: { propuesta_id: ID, resultado: 'exito', destino_modificado: true, estado_propuesta_nuevo: 'aplicada', version_coordinacion_nueva: 8, decision_aprobacion_id: 'd54d03c8-e9ba-4352-8370-e4f88534f612', evento_id: 'e54d03c8-e9ba-4352-8370-e4f88534f612', intento_id: 'f54d03c8-e9ba-4352-8370-e4f88534f612', aplicado_en: FECHA, ya_aplicada } })
const terminar = (c: ReturnType<typeof crearControladorPanel>) => hastaQue(() => !c.obtenerDecision().enviando)
const seleccionar = async (c: ReturnType<typeof crearControladorPanel>, accion: AccionDecision) => {
  c.seleccionar(ID); await hastaQue(() => c.obtenerDetalle().datos !== null)
  c.prepararDecision(accion)
}
const enviar = async (c: ReturnType<typeof crearControladorPanel>) => { c.confirmarDecision(); await terminar(c) }

export const pruebas: Prueba[] = [
  ...(['409', '422', '500', 'red', 'timeout', 'respuesta inválida'] as const).map(caso => ({
    nombre: `aplicación ${caso}: bloquea sin reintentos; recarga fallida conserva bloqueo y exitosa lo libera`,
    async fn() {
      let posts = 0, recargas = 0
      const ctx = await contexto(() => {
        posts++
        if (posts > 1) return respuestaJson(200, aplicacionBody())
        if (caso === 'red') throw new TypeError('red caída')
        if (caso === 'timeout') return new Promise<Response>(() => {})
        if (caso === 'respuesta inválida') return respuestaJson(200, { aplicacion: { ...aplicacionBody().aplicacion, destino_modificado: false } })
        return errorJson(Number(caso))
      }, ['ver', 'aplicar'], 20_000, () => {
        recargas++
        return recargas === 2 ? errorJson(503) : respuestaJson(200, aprobada())
      })
      ctx.controlador.seleccionar(ID); await hastaQue(() => ctx.controlador.obtenerDetalle().datos !== null)
      ctx.controlador.prepararAplicacion()
      const original = globalThis.setTimeout
      let vencer: (() => void) | undefined
      let plazo: number | undefined
      if (caso === 'timeout') globalThis.setTimeout = ((fn: () => void, ms: number) => { plazo = ms; vencer = fn; return 123 }) as unknown as typeof setTimeout
      try { ctx.controlador.confirmarAplicacion() } finally { globalThis.setTimeout = original }
      if (caso === 'timeout') {
        assert.equal(plazo, 30_000, 'el timeout real del controlador debe ser 30 segundos')
        assert.equal(ctx.controlador.obtenerAplicacion().enviando, true)
        vencer!()
      }
      await hastaQue(() => !ctx.controlador.obtenerAplicacion().enviando)
      assert.equal(ctx.controlador.obtenerAplicacion().error?.fallo, caso === '409' ? 'cambio' : caso === '422' ? 'no_aplica' : 'incierto')
      assert.equal(ctx.controlador.obtenerAplicacion().requiereRecarga, true)
      await esperar(); assert.equal(posts, 1, 'sin reintento automático después del fallo')
      ctx.controlador.prepararAplicacion(); ctx.controlador.confirmarAplicacion(); await esperar()
      assert.equal(posts, 1, 'bloqueo efectivo del POST')
      ctx.controlador.reintentarDetalle(); await hastaQue(() => !ctx.controlador.obtenerDetalle().cargando)
      assert.equal(ctx.controlador.obtenerAplicacion().requiereRecarga, true, 'recarga fallida conserva bloqueo')
      ctx.controlador.confirmarAplicacion(); await esperar(); assert.equal(posts, 1)
      ctx.controlador.reintentarDetalle(); await hastaQue(() => !ctx.controlador.obtenerDetalle().cargando)
      assert.equal(ctx.controlador.obtenerAplicacion().requiereRecarga, false, 'solo recarga exitosa libera bloqueo')
      assert.equal(posts, 1, 'recargar no reenvía')
      ctx.controlador.prepararAplicacion(); ctx.controlador.confirmarAplicacion()
      await hastaQue(() => !ctx.controlador.obtenerAplicacion().enviando)
      assert.equal(posts, 2, 'nuevo envío explícito permitido')
    },
  })),
  { nombre: 'aplicación 503 sin escritura: conserva confirmación, permite intento explícito y no reintenta automáticamente', async fn() {
    let posts = 0
    const ctx = await contexto(() => { posts++; return errorJson(503) }, ['ver', 'aplicar'], 20_000, () => respuestaJson(200, aprobada()))
    ctx.controlador.seleccionar(ID); await hastaQue(() => ctx.controlador.obtenerDetalle().datos !== null)
    ctx.controlador.prepararAplicacion(); ctx.controlador.confirmarAplicacion()
    await hastaQue(() => !ctx.controlador.obtenerAplicacion().enviando)
    assert.equal(ctx.controlador.obtenerAplicacion().error?.fallo, 'no_disponible')
    assert.equal(ctx.controlador.obtenerAplicacion().requiereRecarga, false)
    assert.equal(ctx.controlador.obtenerAplicacion().confirmar, true)
    await esperar(); assert.equal(posts, 1)
    ctx.controlador.confirmarAplicacion(); await hastaQue(() => !ctx.controlador.obtenerAplicacion().enviando)
    assert.equal(posts, 2)
  } },
  { nombre: 'aplicación 200 valida todos los campos; destino_modificado exige true literal', async fn() {
    const snap = instantaneaAplicacionDe(aprobada() as ReturnType<typeof castDetalle>)!
    const invalidados: [string, unknown][] = [
      ['propuesta_id', REQUEST_ID], ['resultado', 'fuente_cambio'], ['estado_propuesta_nuevo', 'aprobada'],
      ['version_coordinacion_nueva', 7], ['decision_aprobacion_id', REQUEST_ID], ['evento_id', 'x'], ['intento_id', 'x'],
      ['aplicado_en', 'ayer'], ['ya_aplicada', 'true'], ['extra', 'no admitido'],
      ...[false, null, undefined, 0, 1, 'true', {}, []].map(v => ['destino_modificado', v] as [string, unknown]),
    ]
    for (const [campo, valor] of invalidados) {
      const body = { aplicacion: { ...aplicacionBody().aplicacion, [campo]: valor } }
      const r = await enviarAplicacion(CONFIG.apiOrigen, TOKEN, ID, snap, async () => respuestaJson(200, body))
      assert.equal(r.tipo, 'error', campo)
      if (r.tipo === 'error') assert.equal(r.error.fallo, 'incierto', campo)
    }
  } },
  { nombre: 'aplicación: CAS visible, body exacto, confirmación accesible, doble clic y reenvío idéntico', async fn() {
    const d = aprobada() as ReturnType<typeof castDetalle>
    const snap = instantaneaAplicacionDe(d)!
    assert.deepEqual(snap, { estado_esperado: 'aprobada', payload_hash_esperado: HASH, version_coordinacion_esperada: 7, decision_aprobacion_id_esperado: 'd54d03c8-e9ba-4352-8370-e4f88534f612' })
    const r = await enviarAplicacion(CONFIG.apiOrigen, TOKEN, ID, snap, async (url, init) => {
      assert.equal(url, `${CONFIG.apiOrigen}/api/panel/propuestas/${ID}/aplicacion`); assert.equal(init.method, 'POST'); assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store')
      const body = JSON.parse(String(init.body)); assert.deepEqual(Object.keys(body).sort(), ['decision_aprobacion_id_esperado', 'estado_esperado', 'payload_hash_esperado', 'version_coordinacion_esperada']); assert.deepEqual(body, snap)
      return respuestaJson(200, aplicacionBody(true))
    })
    assert.equal(r.tipo, 'ok'); if (r.tipo === 'ok') assert.equal(r.aplicacion.ya_aplicada, true)
    let llamadas = 0
    const pendientes: ((r: Response) => void)[] = []
    const ctx = await contexto(() => { llamadas++; return new Promise(r => { pendientes.push(r) }) }, ['ver', 'aplicar'], 20_000, () => respuestaJson(200, aprobada()))
    ctx.controlador.seleccionar(ID); await hastaQue(() => ctx.controlador.obtenerDetalle().datos !== null)
    ctx.controlador.prepararAplicacion(); assert.match(renderizar(ctx.controlador), /Esto modificará el buscador público/); assert.match(renderizar(ctx.controlador), /Reino Unido/); assert.match(renderizar(ctx.controlador), /Valor nuevo/)
    ctx.controlador.confirmarAplicacion(); ctx.controlador.confirmarAplicacion(); ctx.controlador.filtrar({ estados: ['aplicada'], limite: 5 }); ctx.controlador.volverAlListado()
    try { assert.equal(llamadas, 1); assert.equal(ctx.controlador.obtenerAplicacion().enviando, true) }
    finally { for (const resolver of pendientes) resolver(respuestaJson(200, aplicacionBody())) }
    await hastaQue(() => !ctx.controlador.obtenerAplicacion().enviando)
    assert.equal(ctx.controlador.obtenerAplicacion().registrada?.destino_modificado, true); assert.equal(ctx.controlador.obtenerAplicacion().requiereRecarga, true)
    assert.equal(ctx.red.llamadas.filter(p => p.url.endsWith('/aplicacion')).length, 1)
  } },
  { nombre: 'aplicación sin permiso o sin acción no permite un POST', async fn() {
    const ctx = await contexto(async () => { assert.fail('sin permiso no debe enviar') }, ['ver'], 20_000, () => respuestaJson(200, aprobada()))
    ctx.controlador.seleccionar(ID); await hastaQue(() => ctx.controlador.obtenerDetalle().datos !== null); ctx.controlador.prepararAplicacion(); ctx.controlador.confirmarAplicacion()
    assert.equal(ctx.controlador.obtenerAplicacion().confirmar, false); assert.equal(ctx.red.llamadas.filter(p => p.url.endsWith('/aplicacion')).length, 0)
    const detalleSinAccion = aprobada({ acciones_permitidas: [], acciones_bloqueadas: { aprobar: ['estado_no_permite_decision'], rechazar: ['estado_no_permite_decision'], aplicar: ['sin_permiso_aplicar'] } })
    const snap = instantaneaAplicacionDe(detalleSinAccion as ReturnType<typeof castDetalle>)
    assert.ok(snap)
    const sinAccion = await contexto(async () => { assert.fail('sin acción no debe enviar') }, ['ver', 'aplicar'], 20_000, () => respuestaJson(200, detalleSinAccion))
    sinAccion.controlador.seleccionar(ID); await hastaQue(() => sinAccion.controlador.obtenerDetalle().datos !== null)
    sinAccion.controlador.prepararAplicacion(); sinAccion.controlador.confirmarAplicacion()
    assert.equal(sinAccion.controlador.obtenerAplicacion().confirmar, false)
    assert.equal(sinAccion.red.llamadas.filter(p => p.init.method === 'POST').length, 0)
  } },
  { nombre: '409 bloquea; recarga completa sin acción aplicar impide otro POST', async fn() {
    let lecturas = 0, posts = 0
    const ctx = await contexto(() => { posts++; return errorJson(posts === 1 ? 409 : 422, posts === 1 ? { actual: { estado: 'aprobada', payload_hash: HASH, version_coordinacion: 7, decision_aprobacion_id: 'd54d03c8-e9ba-4352-8370-e4f88534f612', ultimo_evento_id: 'd54d03c8-e9ba-4352-8370-e4f88534f612' } } : { aplicacion: { destino_modificado: false, resultado: 'fuente_cambio', estado_propuesta_nuevo: 'revision_requerida', intento_id: 'f54d03c8-e9ba-4352-8370-e4f88534f612' } }) }, ['ver', 'aplicar'], 20_000, () => { lecturas++; return respuestaJson(200, aprobada({ acciones_permitidas: lecturas > 1 ? [] : ['aplicar'], acciones_bloqueadas: { aprobar: ['estado_no_permite_decision'], rechazar: ['estado_no_permite_decision'], aplicar: lecturas > 1 ? ['fuente_cambio'] : [] } })) })
    ctx.controlador.seleccionar(ID); await hastaQue(() => ctx.controlador.obtenerDetalle().datos !== null)
    ctx.controlador.prepararAplicacion(); ctx.controlador.confirmarAplicacion(); await hastaQue(() => !ctx.controlador.obtenerAplicacion().enviando)
    assert.equal(ctx.controlador.obtenerAplicacion().requiereRecarga, true); ctx.controlador.prepararAplicacion(); assert.equal(ctx.controlador.obtenerAplicacion().confirmar, true)
    ctx.controlador.confirmarAplicacion(); await hastaQue(() => !ctx.controlador.obtenerAplicacion().enviando); assert.equal(posts, 1)
    await ctx.controlador.reintentarDetalle(); await hastaQue(() => !ctx.controlador.obtenerDetalle().cargando)
    assert.equal(ctx.controlador.obtenerAplicacion().requiereRecarga, false); assert.equal(ctx.controlador.obtenerDetalle().datos?.acciones_permitidas.includes('aplicar'), false)
    ctx.controlador.prepararAplicacion(); assert.equal(ctx.controlador.obtenerAplicacion().confirmar, false); assert.equal(posts, 1)
  } },
  { nombre: '401 conserva confirmación y reautenticación no reenvía aplicación', async fn() {
    let posts = 0
    const ctx = await contexto(() => { posts++; return errorJson(401) }, ['ver', 'aplicar'], 20_000, () => respuestaJson(200, aprobada()))
    ctx.controlador.seleccionar(ID); await hastaQue(() => ctx.controlador.obtenerDetalle().datos !== null); ctx.controlador.prepararAplicacion(); ctx.controlador.confirmarAplicacion(); await hastaQue(() => !ctx.controlador.obtenerAplicacion().enviando)
    assert.equal(ctx.controlador.tieneToken(), false); assert.equal(ctx.controlador.obtenerAplicacion().confirmar, true); assert.equal(posts, 1)
    ctx.gis.entregar({ credential: TOKEN }); await hastaQue(() => ctx.controlador.obtenerEstado().fase === 'autorizado'); await esperar(); assert.equal(posts, 1)
  } },
  { nombre: 'errores HTTP, red/CORS, timeout, JSON inválido y respuesta grande al aplicar son seguros e inciertos cuando corresponde', async fn() {
    const snap = instantaneaAplicacionDe(aprobada() as ReturnType<typeof castDetalle>)!
    for (const [status, fallo] of [[403, 'permiso'], [404, 'no_encontrado'], [409, 'cambio'], [422, 'no_aplica'], [400, 'solicitud'], [413, 'solicitud'], [415, 'solicitud'], [503, 'no_disponible'], [500, 'incierto']] as const) {
      const r = await enviarAplicacion(CONFIG.apiOrigen, TOKEN, ID, snap, async () => errorJson(status))
      assert.equal(r.tipo, 'error'); if (r.tipo === 'error') { assert.equal(r.error.fallo, fallo); assert.equal(r.error.requestId, REQUEST_ID); assert.ok(!JSON.stringify(r).includes('NO_MOSTRAR')) }
    }
    const red = await enviarAplicacion(CONFIG.apiOrigen, TOKEN, ID, snap, async () => { throw new TypeError(`CORS ${TOKEN}`) })
    assert.equal(red.tipo, 'error'); if (red.tipo === 'error') assert.equal(red.error.fallo, 'incierto')
    const timeout = await enviarAplicacion(CONFIG.apiOrigen, TOKEN, ID, snap, async () => new Promise<Response>(() => {}), undefined, 2)
    assert.equal(timeout.tipo, 'error'); if (timeout.tipo === 'error') assert.equal(timeout.error.fallo, 'incierto')
    const invalido = await enviarAplicacion(CONFIG.apiOrigen, TOKEN, ID, snap, async () => new Response('{no-json', { status: 200 }))
    assert.equal(invalido.tipo, 'error'); if (invalido.tipo === 'error') assert.equal(invalido.error.fallo, 'incierto')
    const grande = await enviarAplicacion(CONFIG.apiOrigen, TOKEN, ID, snap, async () => new Response(' '.repeat(512 * 1024 + 1), { status: 200 }))
    assert.equal(grande.tipo, 'error'); if (grande.tipo === 'error') assert.equal(grande.error.fallo, 'incierto')
  } },
  { nombre: 'instantánea exacta y motivo: puntos de código, trim Unicode, LF/TAB y controles del backend', fn() {
    assert.deepEqual(instantaneaDe(detalleTipado()), { estado_esperado: 'pendiente_aprobacion', payload_hash_esperado: HASH, version_coordinacion_esperada: 7, version_contrato_esperada: '1.0' })
    for (const motivo of [' x ', '😀'.repeat(500), 'ñ'.repeat(500), 'a\nb', 'a\tb', '　x　']) assert.equal(esMotivoValido(motivo), true, JSON.stringify(motivo))
    for (const motivo of ['', ' \t\n ', '😀'.repeat(501), 'a\rb', 'a\u0000b', 'a\u0085b', '\ud800', '\udc00']) assert.equal(esMotivoValido(motivo), false, JSON.stringify(motivo))
    const c = detalleTipado()
    c.propuesta.estado = 'aplicada'; assert.equal(instantaneaDe(c), null)
    c.propuesta.estado = 'pendiente_aprobacion'; c.propuesta.payload_hash = null; assert.equal(instantaneaDe(c), null)
  } },
  { nombre: 'contrato 2.0: muestra cambios, exige advertencias exactas y envía el body versionado', async fn() {
    const d = detalleV2() as ReturnType<typeof castDetalle>
    assert.equal(instantaneaDe(d), null, 'sin aceptación no hay instantánea de aprobación')
    const snap = instantaneaDe(d, ['quita_obligatoriedad'])!
    assert.deepEqual(snap, { estado_esperado: 'pendiente_aprobacion', payload_hash_esperado: HASH, version_coordinacion_esperada: 7, version_contrato_esperada: '2.0', advertencias_aceptadas: ['quita_obligatoriedad'] })
    assert.deepEqual(instantaneaDe(d, undefined, 'rechazar'), { estado_esperado: 'pendiente_aprobacion', payload_hash_esperado: HASH, version_coordinacion_esperada: 7, version_contrato_esperada: '2.0' })
    let body: Record<string, unknown> | null = null
    const r = await enviarDecision(CONFIG.apiOrigen, TOKEN, 'aprobar', ID, snap, '', async (_url, init) => {
      body = JSON.parse(String(init.body))
      return respuestaJson(200, decisionBody('aprobar'))
    })
    assert.equal(r.tipo, 'ok')
    assert.deepEqual(body, { estado_esperado: 'pendiente_aprobacion', payload_hash_esperado: HASH, version_coordinacion_esperada: 7, version_contrato_esperada: '2.0', advertencias_aceptadas: ['quita_obligatoriedad'] })

    let posts = 0
    const ctx = await contexto((_url, init) => { posts++; body = JSON.parse(String(init.body)); return respuestaJson(200, decisionBody('aprobar')) }, ['ver', 'decidir'], 20_000, () => respuestaJson(200, detalleV2()))
    ctx.controlador.seleccionar(ID); await hastaQue(() => ctx.controlador.obtenerDetalle().datos !== null)
    const vista = renderizar(ctx.controlador)
    assert.match(vista, /Cambios del requisito/); assert.match(vista, /quita_obligatoriedad/); assert.match(vista, /Valor anterior/); assert.match(vista, /Valor propuesto/)
    assert.match(vista, /<button[^>]*disabled=""[^>]*>Aprobar<\/button>/)
    ctx.controlador.prepararDecision('aprobar'); assert.equal(ctx.controlador.obtenerDecision().accion, null); assert.equal(posts, 0)
    ctx.controlador.fijarAdvertenciaDecision('quita_obligatoriedad', true)
    ctx.controlador.prepararDecision('aprobar'); assert.equal(ctx.controlador.obtenerDecision().accion, 'aprobar')
    ctx.controlador.fijarAdvertenciaDecision('quita_obligatoriedad', false)
    assert.deepEqual(ctx.controlador.obtenerDecision().advertenciasAceptadas, ['quita_obligatoriedad'], 'una confirmación abierta congela las casillas')
    ctx.controlador.confirmarDecision(); await terminar(ctx.controlador)
    assert.equal(posts, 1); const enviado = body as unknown as Record<string, unknown>; assert.deepEqual(enviado.advertencias_aceptadas, ['quita_obligatoriedad']); assert.equal(enviado.version_contrato_esperada, '2.0')
  } },
  { nombre: 'la decisión usa 30 segundos por defecto', async fn() {
    const original = globalThis.setTimeout
    let demora: number | undefined
    globalThis.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
      demora = ms
      return original(fn, ms, ...args)
    }) as typeof setTimeout
    try {
      const r = await enviarDecision(CONFIG.apiOrigen, TOKEN, 'aprobar', ID, instantaneaDe(detalleTipado())!, '', async () => respuestaJson(200, decisionBody('aprobar')))
      assert.equal(r.tipo, 'ok'); assert.equal(demora, 30_000)
    } finally { globalThis.setTimeout = original }
  } },
  { nombre: 'el emisor rechaza instantáneas fabricadas con advertencias fuera del contrato', async fn() {
    const base = { estado_esperado: 'pendiente_aprobacion' as const, payload_hash_esperado: HASH, version_coordinacion_esperada: 7 }
    const invalidas = [
      { ...base, version_contrato_esperada: '1.0' as const, advertencias_aceptadas: ['extra'] },
      { ...base, version_contrato_esperada: '2.0' as const },
      { ...base, version_contrato_esperada: '2.0' as const, advertencias_aceptadas: ['b', 'a'] },
      { ...base, version_contrato_esperada: '2.0' as const, advertencias_aceptadas: ['a', 'a'] },
      { ...base, version_contrato_esperada: '2.0' as const, advertencias_aceptadas: [1, 2] as unknown as string[] },
      { ...base, version_contrato_esperada: '2.0' as const, advertencias_aceptadas: [{ toString: () => 'a' }] as unknown as string[] },
    ]
    for (const snapshot of invalidas) {
      const r = await enviarDecision(CONFIG.apiOrigen, TOKEN, 'aprobar', ID, snapshot, '', async () => { assert.fail('una instantánea inválida no hace POST') })
      assert.equal(r.tipo, 'error'); if (r.tipo === 'error') assert.equal(r.error.fallo, 'solicitud')
    }
    const rechazoConAdvertencias = { ...base, version_contrato_esperada: '2.0' as const, advertencias_aceptadas: ['a'] }
    const r = await enviarDecision(CONFIG.apiOrigen, TOKEN, 'rechazar', ID, rechazoConAdvertencias, 'Motivo', async () => { assert.fail('un rechazo no acepta advertencias') })
    assert.equal(r.tipo, 'error'); if (r.tipo === 'error') assert.equal(r.error.fallo, 'solicitud')
  } },
  { nombre: 'aprobación POST: endpoint, JSON y campos exactos desde la instantánea, sin identidades', async fn() {
    const d = detalleTipado(), snap = instantaneaDe(d)!
    const r = await enviarDecision(CONFIG.apiOrigen, TOKEN, 'aprobar', ID, snap, '', async (url, init) => {
      assert.equal(url, `${CONFIG.apiOrigen}/api/panel/propuestas/${ID}/aprobacion`)
      assert.equal(init.method, 'POST'); assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store'); assert.equal(init.redirect, 'error')
      const headers = new Headers(init.headers); assert.equal(headers.get('Content-Type'), 'application/json'); assert.equal(headers.get('Authorization'), `Bearer ${TOKEN}`)
      const body = JSON.parse(String(init.body)); assert.deepEqual(Object.keys(body).sort(), ['estado_esperado', 'payload_hash_esperado', 'version_contrato_esperada', 'version_coordinacion_esperada'])
      assert.deepEqual(body, snap)
      d.propuesta.payload_hash = 'c'.repeat(64); d.propuesta.version_coordinacion = 12
      return respuestaJson(200, decisionBody('aprobar'))
    }, new AbortController().signal)
    assert.equal(r.tipo, 'ok'); if (r.tipo === 'ok') { assert.equal(r.decision.tipo_evento, 'aprobacion'); assert.equal(r.decision.estado_nuevo, 'aprobada'); assert.equal(r.decision.actor.identificador, 'operador.panel'); assert.equal(r.decision.ya_registrada, false); assert.ok(!JSON.stringify(r).includes('privado@example.com')) }
  } },
  { nombre: 'rechazo POST: body por lista blanca y motivo original validado por puntos de código', async fn() {
    const motivo = `  ${'😀'.repeat(500)}  `, snap = instantaneaDe(detalleTipado())!
    const r = await enviarDecision(CONFIG.apiOrigen, TOKEN, 'rechazar', ID, snap, motivo, async (url, init) => {
      assert.ok(url.endsWith('/rechazo'))
      const body = JSON.parse(String(init.body)); assert.deepEqual(Object.keys(body).sort(), ['estado_esperado', 'motivo', 'payload_hash_esperado', 'version_contrato_esperada', 'version_coordinacion_esperada'])
      assert.equal(body.motivo, motivo); assert.deepEqual({ estado_esperado: body.estado_esperado, payload_hash_esperado: body.payload_hash_esperado, version_coordinacion_esperada: body.version_coordinacion_esperada, version_contrato_esperada: body.version_contrato_esperada }, snap)
      return respuestaJson(200, decisionBody('rechazar'))
    })
    assert.equal(r.tipo, 'ok'); if (r.tipo === 'ok') { assert.equal(r.decision.tipo_evento, 'rechazo'); assert.equal(r.decision.estado_nuevo, 'rechazada') }
    const inválido = await enviarDecision(CONFIG.apiOrigen, TOKEN, 'rechazar', ID, snap, '😀'.repeat(501), async () => { assert.fail('no envía motivo inválido') })
    assert.equal(inválido.tipo, 'error'); if (inválido.tipo === 'error') assert.equal(inválido.error.fallo, 'solicitud')
  } },
  { nombre: 'aprobación exitosa, ya_registrada, instantánea retenida, doble clic y acciones simultáneas', async fn() {
    let resolver: (r: Response) => void = () => {}, llamadas = 0
    const ctx = await contexto(() => { llamadas++; return new Promise(r => { resolver = r }) })
    await seleccionar(ctx.controlador, 'aprobar')
    const snap = ctx.controlador.obtenerDecision().instantanea!
    assert.match(renderizar(ctx.controlador), /Se registrará la aprobación, pero este panel todavía no aplica el cambio al destino/)
    ctx.controlador.confirmarDecision(); ctx.controlador.confirmarDecision(); ctx.controlador.prepararDecision('rechazar'); ctx.controlador.filtrar({ estados: ['aprobada'], limite: 5 }); ctx.controlador.volverAlListado()
    assert.equal(llamadas, 1); assert.equal(ctx.controlador.obtenerDecision().enviando, true); assert.equal(ctx.controlador.obtenerDecision().instantanea, snap)
    resolver(respuestaJson(200, decisionBody('aprobar'))); await terminar(ctx.controlador)
    assert.equal(ctx.controlador.obtenerDecision().registrada?.ya_registrada, false)
    assert.match(renderizar(ctx.controlador), /Decisión registrada/); assert.match(renderizar(ctx.controlador), /Evento ID/)
    ctx.controlador.prepararDecision('aprobar'); assert.equal(ctx.controlador.obtenerDecision().accion, null)
    assert.equal(llamadas, 1)

    const replay = await enviarDecision(CONFIG.apiOrigen, TOKEN, 'aprobar', ID, snap, '', async () => respuestaJson(200, { decision: { ...decisionBody('aprobar').decision, ya_registrada: true } }))
    assert.equal(replay.tipo, 'ok'); if (replay.tipo === 'ok') assert.equal(replay.decision.ya_registrada, true)
  } },
  { nombre: 'dos acciones simultáneas y respuesta atrasada no cambian vista ni repiten el POST', async fn() {
    let resolver: (r: Response) => void = () => {}, llamadas = 0
    const ctx = await contexto(() => { llamadas++; return new Promise(r => { resolver = r }) })
    await seleccionar(ctx.controlador, 'rechazar'); ctx.controlador.fijarMotivoDecision('Motivo')
    ctx.controlador.confirmarDecision(); ctx.controlador.prepararDecision('aprobar'); ctx.controlador.confirmarDecision()
    ctx.controlador.cerrarSesion(); assert.equal(ctx.controlador.obtenerDecision().motivo, '')
    resolver(respuestaJson(200, decisionBody('rechazar'))); await esperar()
    assert.equal(llamadas, 1); assert.equal(ctx.controlador.obtenerDecision().registrada, null); assert.equal(ctx.controlador.tieneToken(), false)
    assert.ok(ctx.controlador.obtenerDetalle().propuestaId === null)
  } },
  { nombre: '401: conserva confirmación y borrador; reautenticación no reenvía la decisión', async fn() {
    let posts = 0
    const ctx = await contexto(() => { posts++; return errorJson(401) })
    await seleccionar(ctx.controlador, 'rechazar'); ctx.controlador.fijarMotivoDecision('Borrador 😀')
    const snap = ctx.controlador.obtenerDecision().instantanea
    await enviar(ctx.controlador)
    assert.equal(ctx.controlador.tieneToken(), false); assert.equal(ctx.controlador.obtenerEstado().fase, 'sin_sesion')
    assert.equal(ctx.controlador.obtenerDecision().motivo, 'Borrador 😀'); assert.deepEqual(ctx.controlador.obtenerDecision().instantanea, snap)
    ctx.gis.entregar({ credential: TOKEN }); await hastaQue(() => ctx.controlador.obtenerEstado().fase === 'autorizado'); await esperar()
    assert.equal(posts, 1); assert.equal(ctx.controlador.obtenerDecision().motivo, 'Borrador 😀')
  } },
  ...([403, 404, 409, 422, 400, 413, 415, 503] as const).map(status => ({ nombre: `POST ${status}: error fijo, código seguro, IDs válidos y tratamiento específico`, async fn() {
    let posts = 0
    const actual = { estado: 'aprobada', payload_hash: 'c'.repeat(64), version_coordinacion: 8, ultimo_evento: { tipo_evento: 'aprobacion', ocurrido_en: FECHA }, actor: { email: 'privado' } }
    const ctx = await contexto(() => { posts++; return errorJson(status, status === 409 ? { actual } : status === 422 ? { motivos: ['hash_no_coincide', 'valor_actual_cambio', { email: 'privado' }] } : {}) })
    await seleccionar(ctx.controlador, 'aprobar'); await enviar(ctx.controlador)
    const vista = renderizar(ctx.controlador)
    assert.equal(posts, 1); assert.ok(!vista.includes('NO_MOSTRAR')); assert.ok(!vista.includes('codigo_interno')); assert.ok(!vista.includes('privado'))
    const estado = ctx.controlador.obtenerDecision()
    if (status === 409) { assert.equal(estado.error?.fallo, 'cambio'); assert.match(vista, /Estado actual devuelto por el servidor/) ; assert.match(vista, /Lo que vio el operador/) }
    if (status === 422) {
      assert.equal(estado.accionesBloqueadas.includes('aprobar'), true)
      assert.equal(estado.accionesBloqueadas.includes('rechazar'), true)
      assert.equal(estado.requiereRecarga, true)
      assert.equal(estado.requestId, REQUEST_ID)
      assert.match(vista, /hash_no_coincide/)
    }
    if (status === 403) { assert.equal(estado.accionesBloqueadas.includes('aprobar'), true); assert.match(vista, /falta de autorización/) }
    if (status === 404 || status === 409) assert.equal(estado.requiereRecarga, true)
    if (status === 503) assert.equal(estado.error?.fallo, 'no_disponible')
    if (status === 400 || status === 413 || status === 415) assert.equal(estado.error?.fallo, 'solicitud')
    assert.ok(estado.requestId === REQUEST_ID || estado.requestId === null)
  } })),
  { nombre: 'resultado incierto por 500, red, timeout, CORS, JSON inválido y respuesta grande bloquea hasta recarga', async fn() {
    const respuestas: Responder[] = [
      async () => errorJson(500, {}),
      async () => { throw new Error('network') },
      async () => new Response(new ReadableStream({ pull() {} }, { highWaterMark: 0 }), { status: 200 }),
      async () => { throw new Error('CORS') },
      async () => respuestaJson(200, '{'),
      async () => respuestaJson(200, 'x'.repeat(MAXIMO_RESPUESTA + 1)),
    ]
    for (const responder of respuestas) {
      const ctx = await contexto(responder, ['ver', 'decidir'], 25); await seleccionar(ctx.controlador, 'aprobar'); await enviar(ctx.controlador)
      assert.equal(ctx.controlador.obtenerDecision().requiereRecarga, true)
      assert.match(renderizar(ctx.controlador), /No la repitas|instantánea está bloqueada|No se pudo confirmar/)
      ctx.controlador.prepararDecision('aprobar'); assert.equal(ctx.controlador.obtenerDecision().accion, 'aprobar', 'confirmation keeps visible but submit button must stay blocked')
      assert.match(renderizar(ctx.controlador), /Recargar propuesta/)
      ctx.controlador.reintentarDetalle(); await hastaQue(() => !ctx.controlador.obtenerDetalle().cargando)
      assert.equal(ctx.controlador.obtenerDecision().requiereRecarga, false)
      assert.equal(ctx.controlador.obtenerDecision().error, null)
    }
  } },
  { nombre: '422 de aprobación bloquea ambas acciones hasta recarga explícita válida', async fn() {
    let posts = 0
    const ctx = await contexto(url => {
      if (url.includes('/aprobacion')) { posts++; return errorJson(422, { motivos: ['hash_no_coincide'] }) }
      if (url.includes('/rechazo')) { posts++; return respuestaJson(200, decisionBody('rechazar')) }
      return respuestaJson(200, pagina)
    }, ['ver', 'decidir'], 20_000, lectura => {
      const d = detalle() as import('../../src/panel/detalle.ts').Detalle
      if (lectura > 1) { d.acciones_permitidas = ['rechazar']; d.acciones_bloqueadas = { aprobar: ['hash_no_coincide'], rechazar: [], aplicar: ['estado_no_permite_aplicar'] } }
      return respuestaJson(200, d)
    })
    await seleccionar(ctx.controlador, 'aprobar'); await enviar(ctx.controlador)
    assert.equal(ctx.controlador.obtenerDecision().accionesBloqueadas.includes('aprobar'), true)
    assert.equal(ctx.controlador.obtenerDecision().accionesBloqueadas.includes('rechazar'), true)
    assert.equal(ctx.controlador.obtenerDecision().requiereRecarga, true)
    const req = ctx.controlador.obtenerDecision().requestId
    const aprobacionVista = ctx.controlador.obtenerDecision().instantanea
    ctx.controlador.prepararDecision('rechazar')
    assert.equal(ctx.controlador.obtenerDecision().accion, 'aprobar')
    ctx.controlador.confirmarDecision(); await esperar()
    assert.equal(posts, 1)
    ctx.controlador.reintentarDetalle(); await hastaQue(() => !ctx.controlador.obtenerDetalle().cargando)
    assert.equal(ctx.controlador.obtenerDetalle().datos?.acciones_permitidas.includes('rechazar'), true)
    assert.equal(ctx.controlador.obtenerDecision().requiereRecarga, false)
    assert.equal(ctx.controlador.obtenerDecision().accion, null)
    assert.equal(ctx.controlador.obtenerDecision().instantanea, null)
    assert.equal(ctx.controlador.obtenerDecision().requestId, null)
    assert.deepEqual(aprobacionVista, { estado_esperado: 'pendiente_aprobacion', payload_hash_esperado: HASH, version_coordinacion_esperada: 7, version_contrato_esperada: '1.0' })
    assert.equal(req, REQUEST_ID)
    await seleccionar(ctx.controlador, 'rechazar'); ctx.controlador.fijarMotivoDecision('Inconsistencia')
    assert.match(renderizar(ctx.controlador), /Rechazar/); await enviar(ctx.controlador); assert.equal(posts, 2)
  } },
  { nombre: '422 de rechazo conserva motivo y request_id; recarga sin acciones sigue bloqueada', async fn() {
    let posts = 0
    const ctx = await contexto(url => {
      if (url.includes('/rechazo')) { posts++; return errorJson(422, { motivos: ['decision_previa_existente'] }) }
      if (url.includes('/aprobacion')) { posts++; return respuestaJson(200, decisionBody('aprobar')) }
      return respuestaJson(200, pagina)
    }, ['ver', 'decidir'], 20_000, lectura => {
      const d = detalle() as import('../../src/panel/detalle.ts').Detalle
      if (lectura > 1) { d.acciones_permitidas = []; d.acciones_bloqueadas = { aprobar: ['decision_previa_existente'], rechazar: ['decision_previa_existente'], aplicar: ['estado_no_permite_aplicar'] } }
      return respuestaJson(200, d)
    })
    await seleccionar(ctx.controlador, 'rechazar'); ctx.controlador.fijarMotivoDecision('Borrador conservado')
    const snap = ctx.controlador.obtenerDecision().instantanea
    await enviar(ctx.controlador)
    assert.equal(ctx.controlador.obtenerDecision().requiereRecarga, true)
    assert.equal(ctx.controlador.obtenerDecision().motivo, 'Borrador conservado')
    assert.equal(ctx.controlador.obtenerDecision().requestId, REQUEST_ID)
    assert.deepEqual(ctx.controlador.obtenerDecision().instantanea, snap)
    assert.match(renderizar(ctx.controlador), /decision_previa_existente/)
    ctx.controlador.prepararDecision('aprobar'); ctx.controlador.confirmarDecision(); await esperar()
    assert.equal(posts, 1)
    ctx.controlador.reintentarDetalle(); await hastaQue(() => !ctx.controlador.obtenerDetalle().cargando)
    assert.equal(ctx.controlador.obtenerDecision().requiereRecarga, false)
    assert.equal(ctx.controlador.obtenerDecision().motivo, 'Borrador conservado')
    assert.equal(ctx.controlador.obtenerDecision().accion, null)
    assert.deepEqual(ctx.controlador.obtenerDetalle().datos?.acciones_permitidas, [])
    ctx.controlador.prepararDecision('aprobar'); ctx.controlador.prepararDecision('rechazar'); ctx.controlador.confirmarDecision(); await esperar()
    assert.equal(ctx.controlador.obtenerDecision().accion, null)
    assert.equal(posts, 1)
  } },
  { nombre: 'recarga fallida por red o 503 conserva requiereRecarga, motivo y request_id', async fn() {
    for (const fallo of ['red', '503'] as const) {
      let posts = 0
      const ctx = await contexto(url => {
        if (url.includes('/aprobacion')) { posts++; return errorJson(422, { motivos: ['hash_no_coincide'] }) }
        return respuestaJson(200, pagina)
      }, ['ver', 'decidir'], 20_000, lectura => {
        if (lectura === 1) return respuestaJson(200, detalle())
        return fallo === 'red' ? (() => { throw new Error('network') })() : errorJson(503)
      })
      await seleccionar(ctx.controlador, 'aprobar'); ctx.controlador.fijarMotivoDecision('Borrador')
      await enviar(ctx.controlador)
      assert.equal(ctx.controlador.obtenerDecision().requiereRecarga, true)
      ctx.controlador.reintentarDetalle(); await hastaQue(() => !ctx.controlador.obtenerDetalle().cargando)
      assert.equal(ctx.controlador.obtenerDecision().requiereRecarga, true)
      assert.equal(ctx.controlador.obtenerDecision().motivo, 'Borrador')
      assert.equal(ctx.controlador.obtenerDecision().requestId, REQUEST_ID)
      ctx.controlador.prepararDecision('aprobar'); ctx.controlador.prepararDecision('rechazar'); ctx.controlador.confirmarDecision(); await esperar()
      assert.equal(posts, 1)
    }
  } },
  { nombre: 'permisos de solo ver, detalle sin acciones, cambio de identidad y cierre de sesión', async fn() {
    const sinPermiso = await contexto(() => { assert.fail('no debe enviar') }, ['ver'])
    await seleccionar(sinPermiso.controlador, 'aprobar')
    sinPermiso.controlador.prepararDecision('aprobar')
    assert.equal(sinPermiso.controlador.obtenerDecision().accion, null)
    assert.doesNotMatch(renderizar(sinPermiso.controlador), /Confirmar aprobación/)
    const vacia = await contexto(() => { assert.fail('no debe enviar') })
    vacia.controlador.seleccionar(ID); await hastaQue(() => vacia.controlador.obtenerDetalle().datos !== null)
    vacia.controlador.obtenerDetalle().datos!.acciones_permitidas = []
    assert.doesNotMatch(renderizar(vacia.controlador), /<button[^>]*>Aprobar|<button[^>]*>Rechazar/)
    vacia.controlador.prepararDecision('rechazar'); assert.equal(vacia.controlador.obtenerDecision().accion, null)
    const distinto = await contexto(() => { assert.fail('no debe enviar') })
    await seleccionar(distinto.controlador, 'rechazar'); distinto.controlador.fijarMotivoDecision('Borrador')
    // GIS puede autenticar una identidad distinta; no conserva ni puede continuar la confirmación anterior.
    distinto.cambiarSesion(['ver', 'decidir'], '333333333333333333333')
    distinto.gis.entregar({ credential: TOKEN }); await hastaQue(() => { const e = distinto.controlador.obtenerEstado(); return e.fase === 'autorizado' && e.sesion.identidad.sub === '333333333333333333333' })
    assert.equal(distinto.controlador.obtenerDecision().motivo, '')
    assert.equal(distinto.controlador.obtenerDecision().accion, null)
    distinto.controlador.confirmarDecision()
    assert.equal(distinto.red.llamadas.filter(x => x.init.method === 'POST').length, 0)
    const cierre = await contexto(() => { assert.fail('no debe enviar') })
    await seleccionar(cierre.controlador, 'rechazar'); cierre.controlador.fijarMotivoDecision('Borrador')
    cierre.controlador.cerrarSesion()
    assert.equal(cierre.controlador.obtenerDecision().motivo, '')
  } },
  { nombre: 'tokens sin fugas en el POST, respuesta, sesión y árbol renderizado', async fn() {
    const { instalarEspias } = await import('./apoyo.tsx')
    const espias = instalarEspias()
    try {
    const ctx = await contexto(() => respuestaJson(200, decisionBody('aprobar')))
    await seleccionar(ctx.controlador, 'aprobar'); await enviar(ctx.controlador)
    comprobarSinFugas({ ...ctx, espias })
    for (const { url, init } of ctx.red.llamadas) {
      assert.ok(!url.includes(TOKEN)); assert.equal(init.credentials, 'omit')
      const body = typeof init.body === 'string' ? init.body : ''
      assert.ok(!body.includes(TOKEN))
      assert.ok(!JSON.stringify(ctx.controlador.obtenerDecision()).includes(TOKEN))
    }
    assert.ok(!renderizar(ctx.controlador).includes(TOKEN))
    } finally { espias.restaurar() }
  } },
]

function detalleTipado() { return detalle() as ReturnType<typeof castDetalle> }
function castDetalle() { return null as unknown as import('../../src/panel/detalle.ts').Detalle }
