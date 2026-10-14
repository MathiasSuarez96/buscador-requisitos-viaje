import assert from 'node:assert/strict'
import { crearControladorPanel } from '../../src/panel/controlador.ts'
import { enviarDecision, esMotivoValido, instantaneaDe, type AccionDecision } from '../../src/panel/decisiones.ts'
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
      valor_anterior: { presente: false, valor: null }, valor_propuesto: { valor: '£20', importe: 20, moneda: 'GBP' },
      fuente: { nombre: 'GOV.UK', url: 'https://www.gov.uk/eta', capturado_en: FECHA }, version_coordinacion: 7, creada_en: FECHA, actualizada_en: FECHA,
      payload_hash: HASH, decision_aprobacion_id: null, ultimo_evento_id: null,
      evidencia: { fuente: 'GOV.UK', url: 'https://www.gov.uk/eta', capturado_en: FECHA, fuente_actualizada_en: FECHA, valor_extraido: '£20', importe: 20, moneda: 'GBP', secciones: [], coincide_entre_secciones: null, avisos: [] },
    },
    integridad: { hash_coincide: true, hash_recalculado: HASH, consistente: true, problemas: [] },
    requisito_actual: { estado: 'coincide', destino: { destino_id: HEX, pais: 'Reino Unido', codigo_iso: 'GB' }, requisito: { requisito_id: HEX, tipo: 'formulario_digital', nombre: 'UK ETA' }, valor_actual: { presente: false, valor: null }, valor: 'coincide' },
    eventos: [], eventos_truncados: false, acciones_permitidas: ['aprobar', 'rechazar'], acciones_bloqueadas: { aprobar: [], rechazar: [] }, ...cambios,
  }
}
const pagina = { propuestas: [{ propuesta_id: ID, estado: 'pendiente_aprobacion', campo: 'costo', destino_id: HEX, destino: { destino_id: HEX, pais: 'Reino Unido', codigo_iso: 'GB' }, requisito_id: HEX, creada_en: FECHA, actualizada_en: null, alertas: [] }], filtro: { estados: ['pendiente_aprobacion'] }, limite: 20, siguiente_cursor: null }
type Responder = Parameters<typeof crearFetchFalso>[0]
async function contexto(responder: Responder, permisos: string[] = ['ver', 'decidir'], tiempoDecisionMs = 20_000) {
  const gis = crearGisFalso()
  let sesion = { ...SESION_AUTORIZADA, permisos }
  const red = crearFetchFalso((url, init) => url.endsWith('/sesion') ? respuestaJson(200, sesion) : url.includes('/propuestas?') ? respuestaJson(200, pagina) : url.endsWith('/' + ID) ? respuestaJson(200, detalle()) : responder(url, init))
  const controlador = crearControladorPanel({ config: CONFIG, cargarGis: gis.cargar, hacerFetch: red.hacerFetch, tiempoDecisionMs })
  controlador.iniciar(); await hastaQue(() => controlador.obtenerEstado().fase === 'sin_sesion')
  gis.entregar({ credential: TOKEN }); await hastaQue(() => controlador.obtenerListado().cargado)
  return { controlador, gis, red, cambiarSesion: (p: string[], sub?: string) => { sesion = { ...sesion, permisos: p, identidad: { ...sesion.identidad, sub: sub ?? sesion.identidad.sub } } } }
}
const decisionBody = (accion: AccionDecision, id = ID) => ({ decision: { tipo_evento: accion === 'aprobar' ? 'aprobacion' : 'rechazo', propuesta_id: id, evento_id: 'd54d03c8-e9ba-4352-8370-e4f88534f612', estado_anterior: 'pendiente_aprobacion', estado_nuevo: accion === 'aprobar' ? 'aprobada' : 'rechazada', version_coordinacion_nueva: 8, ocurrido_en: FECHA, actor: { tipo: 'humano', identificador: 'operador.panel', email: 'privado@example.com' }, ya_registrada: false, identidad_operador: { email: 'privado@example.com' } } })
const errorJson = (status: number, extra: Record<string, unknown> = {}, requestId: string | null = REQUEST_ID) => respuestaJson(status, { error: { codigo: 'codigo_interno', mensaje: 'NO_MOSTRAR', request_id: requestId, ...extra } }, null)
const terminar = (c: ReturnType<typeof crearControladorPanel>) => hastaQue(() => !c.obtenerDecision().enviando)
const seleccionar = async (c: ReturnType<typeof crearControladorPanel>, accion: AccionDecision) => {
  c.seleccionar(ID); await hastaQue(() => c.obtenerDetalle().datos !== null)
  c.prepararDecision(accion)
}
const enviar = async (c: ReturnType<typeof crearControladorPanel>) => { c.confirmarDecision(); await terminar(c) }

export const pruebas: Prueba[] = [
  { nombre: 'instantánea exacta y motivo: puntos de código, trim Unicode, LF/TAB y controles del backend', fn() {
    assert.deepEqual(instantaneaDe(detalleTipado()), { estado_esperado: 'pendiente_aprobacion', payload_hash_esperado: HASH, version_coordinacion_esperada: 7 })
    for (const motivo of [' x ', '😀'.repeat(500), 'ñ'.repeat(500), 'a\nb', 'a\tb', '　x　']) assert.equal(esMotivoValido(motivo), true, JSON.stringify(motivo))
    for (const motivo of ['', ' \t\n ', '😀'.repeat(501), 'a\rb', 'a\u0000b', 'a\u0085b', '\ud800', '\udc00']) assert.equal(esMotivoValido(motivo), false, JSON.stringify(motivo))
    const c = detalleTipado()
    c.propuesta.estado = 'aplicada'; assert.equal(instantaneaDe(c), null)
    c.propuesta.estado = 'pendiente_aprobacion'; c.propuesta.payload_hash = null; assert.equal(instantaneaDe(c), null)
  } },
  { nombre: 'aprobación POST: endpoint, JSON y campos exactos desde la instantánea, sin identidades', async fn() {
    const d = detalleTipado(), snap = instantaneaDe(d)!
    const r = await enviarDecision(CONFIG.apiOrigen, TOKEN, 'aprobar', ID, snap, '', async (url, init) => {
      assert.equal(url, `${CONFIG.apiOrigen}/api/panel/propuestas/${ID}/aprobacion`)
      assert.equal(init.method, 'POST'); assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store'); assert.equal(init.redirect, 'error')
      const headers = new Headers(init.headers); assert.equal(headers.get('Content-Type'), 'application/json'); assert.equal(headers.get('Authorization'), `Bearer ${TOKEN}`)
      const body = JSON.parse(String(init.body)); assert.deepEqual(Object.keys(body).sort(), ['estado_esperado', 'payload_hash_esperado', 'version_coordinacion_esperada'])
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
      const body = JSON.parse(String(init.body)); assert.deepEqual(Object.keys(body).sort(), ['estado_esperado', 'motivo', 'payload_hash_esperado', 'version_coordinacion_esperada'])
      assert.equal(body.motivo, motivo); assert.deepEqual({ estado_esperado: body.estado_esperado, payload_hash_esperado: body.payload_hash_esperado, version_coordinacion_esperada: body.version_coordinacion_esperada }, snap)
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
    if (status === 422) { assert.equal(estado.accionesBloqueadas.includes('aprobar'), true); assert.match(vista, /hash_no_coincide/) }
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
  { nombre: '422 aprobación: recarga explícita vuelve a habilitar un rechazo permitido', async fn() {
    let reads = 0, posts = 0
    const ctx = await contexto(url => {
      if (url.includes('/aprobacion')) { posts++; return errorJson(422, { motivos: ['hash_no_coincide'] }) }
      if (url.includes('/rechazo')) { posts++; return respuestaJson(200, decisionBody('rechazar')) }
      if (url.endsWith('/' + ID)) { reads++; const d = detalle() as import('../../src/panel/detalle.ts').Detalle; if (reads > 1) { d.acciones_permitidas = ['rechazar']; d.acciones_bloqueadas = { aprobar: ['hash_no_coincide'], rechazar: [] } } return respuestaJson(200, d) }
      return respuestaJson(200, pagina)
    })
    await seleccionar(ctx.controlador, 'aprobar'); await enviar(ctx.controlador)
    assert.equal(ctx.controlador.obtenerDecision().accionesBloqueadas.includes('aprobar'), true)
    ctx.controlador.reintentarDetalle(); await hastaQue(() => !ctx.controlador.obtenerDetalle().cargando)
    assert.equal(ctx.controlador.obtenerDetalle().datos?.acciones_permitidas.includes('rechazar'), true)
    await seleccionar(ctx.controlador, 'rechazar'); ctx.controlador.fijarMotivoDecision('Inconsistencia')
    assert.match(renderizar(ctx.controlador), /Rechazar/); await enviar(ctx.controlador); assert.equal(posts, 2)
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
