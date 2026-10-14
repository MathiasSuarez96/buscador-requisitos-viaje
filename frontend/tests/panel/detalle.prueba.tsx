import assert from 'node:assert/strict'
import { renderToString } from 'react-dom/server'
import { crearControladorPanel } from '../../src/panel/controlador.ts'
import { consultarDetalle, validarDetalle, urlHttpsSegura, type Detalle } from '../../src/panel/detalle.ts'
import { ContenidoDetalle } from '../../src/panel/DetallePropuesta.tsx'
import { textoPresencia, textoValor } from '../../src/panel/presentacion.ts'
import { MAXIMO_RESPUESTA } from '../../src/panel/propuestas.ts'
import { CONFIG, TOKEN, REQUEST_ID, SESION_AUTORIZADA, crearGisFalso, crearFetchFalso, respuestaJson, hastaQue, esperar, instalarEspias, comprobarSinFugas, renderizar, type Prueba } from './apoyo.tsx'

const ID = '054d03c8-e9ba-4352-8370-e4f88534f612'
const OTRO = '054d03c8-e9ba-4352-8370-e4f88534f613'
const HEX = 'a'.repeat(24), HASH = 'b'.repeat(64)
const FECHA = '2026-10-13T12:00:00.000Z'
function ejemplo(id = ID) {
  return {
    propuesta: {
      propuesta_id: id, estado: 'pendiente_aprobacion', campo: 'costo', destino_id: HEX, requisito_id: HEX,
      valor_anterior: { presente: true, valor: '£16' }, valor_propuesto: { valor: '£20', importe: 20, moneda: 'GBP' },
      fuente: { nombre: 'GOV.UK', url: 'https://www.gov.uk/eta', capturado_en: FECHA },
      version_coordinacion: 0, creada_en: FECHA, actualizada_en: FECHA, payload_hash: HASH,
      decision_aprobacion_id: null, ultimo_evento_id: ID,
      evidencia: {
        fuente: 'GOV.UK', url: 'https://www.gov.uk/eta', capturado_en: FECHA, fuente_actualizada_en: FECHA,
        valor_extraido: '£20', importe: 20, moneda: 'GBP',
        secciones: [{ seccion: 'overview', costo_extraido: 20, moneda: 'GBP' }],
        coincide_entre_secciones: true, avisos: ['Verificar la fecha de captura.'],
      },
    },
    integridad: { hash_coincide: true, hash_recalculado: HASH, consistente: true, problemas: [] as string[] },
    requisito_actual: {
      estado: 'coincide', destino: { destino_id: HEX, pais: 'Reino Unido', codigo_iso: 'GB' },
      requisito: { requisito_id: HEX, tipo: 'autorizacion', nombre: 'UK ETA' }, valor_actual: { presente: true, valor: '£16' }, valor: 'coincide',
    },
    eventos: [evento(1), evento(2)], eventos_truncados: false,
    acciones_permitidas: ['aprobar', 'rechazar'], acciones_bloqueadas: { aprobar: [] as string[], rechazar: [] as string[], aplicar: ['estado_no_permite_aplicar'] as string[] },
  }
}
function evento(n: number) {
  return { evento_id: n === 1 ? ID : OTRO, tipo_evento: n === 1 ? 'creada' : 'revisada', estado_anterior: null, estado_nuevo: 'pendiente_aprobacion', ocurrido_en: FECHA,
    version_coordinacion_nueva: n, hash_contenido_referenciado: HASH, actor: { tipo: 'humano', identificador: 'privado@example.com', sub: 'SUB_PRIVADO' },
    origen: 'panel-propuestas', metodo_identidad: 'oidc_google', motivo: 'Revisión manual', intento_aplicacion_id: null }
}
const listado = {
  propuestas: [ID, OTRO].map(propuesta_id => ({ propuesta_id, estado: 'pendiente_aprobacion', campo: 'costo', destino_id: HEX, requisito_id: HEX,
    destino: { destino_id: HEX, pais: 'Reino Unido', codigo_iso: 'GB' }, creada_en: FECHA, actualizada_en: null, alertas: [] })),
  filtro: { estados: ['pendiente_aprobacion'] }, limite: 20, siguiente_cursor: `v1.${HEX}.01`,
}
type Responder = Parameters<typeof crearFetchFalso>[0]
function paginaListado(url: string) {
  const parametros = new URL(url).searchParams
  const estados = parametros.get('estado')!.split(',')
  const limite = Number(parametros.get('limite'))
  return { ...listado, filtro: { estados }, limite, siguiente_cursor: null, propuestas: listado.propuestas.slice(0, limite).map(p => ({ ...p, estado: estados[0] })) }
}
async function contexto(responder: Responder) {
  const gis = crearGisFalso()
  let sesion = structuredClone(SESION_AUTORIZADA)
  const red = crearFetchFalso((url, init) => url.endsWith('/sesion') ? respuestaJson(200, sesion) : url.includes('/propuestas?') ? respuestaJson(200, paginaListado(url)) : responder(url, init))
  const controlador = crearControladorPanel({ config: CONFIG, cargarGis: gis.cargar, hacerFetch: red.hacerFetch })
  controlador.iniciar()
  await hastaQue(() => controlador.obtenerEstado().fase === 'sin_sesion')
  gis.entregar({ credential: TOKEN })
  await hastaQue(() => controlador.obtenerListado().cargado)
  return { controlador, gis, red, cambiarSesion: (s: typeof sesion) => { sesion = s } }
}
const terminado = (c: ReturnType<typeof crearControladorPanel>) => hastaQue(() => !c.obtenerDetalle().cargando)
const consultar = (respuesta: Response) => consultarDetalle(CONFIG.apiOrigen, TOKEN, ID, async () => respuesta, new AbortController().signal)
const html = (d: Detalle) => renderToString(<ContenidoDetalle detalle={d} />)
function modificar(cuerpo: unknown, ruta: string, valor: unknown) {
  const partes = ruta.split('.')
  let destino = cuerpo as Record<string, unknown>
  for (const p of partes.slice(0, -1)) destino = destino[p] as Record<string, unknown>
  destino[partes.at(-1)!] = valor
}

export const pruebas: Prueba[] = [
  { nombre: 'detalle completo: contrato real, proyección segura y secciones semánticas', fn() {
    const bruto = { ...ejemplo(), payload: { token: 'PRIVADO' }, identidad_operador: { email: 'PRIVADO' } }
    const d = validarDetalle(bruto, ID)!
    assert.ok(d)
    assert.ok(!JSON.stringify(d).includes('PRIVADO'))
    assert.ok(!JSON.stringify(d).includes('privado@example.com'))
    const vista = html(d)
    for (const texto of ['Reino Unido', 'GB', 'Costo', '£16', '£20', 'GBP', 'UK ETA', 'Valores del cambio', 'Evidencia', 'Integridad', 'Requisito actual', 'Acciones permitidas', 'Aprobar: bloqueos', 'Rechazar: bloqueos', 'Payload hash', 'Versión de coordinación', 'Historial de eventos', 'overview', 'Hash coincide', 'Consistente']) assert.ok(vista.includes(texto), texto)
    assert.ok(vista.replaceAll('<!-- -->', '').indexOf('1. creada') < vista.replaceAll('<!-- -->', '').indexOf('2. revisada'))
    assert.doesNotMatch(vista, /<button|<script|<style|style=|onclick=|privado@example.com/)
  } },
  { nombre: 'detalle: todas las variantes null del contrato y estados de requisito', fn() {
    const rutas = [
      'propuesta.estado', 'propuesta.campo', 'propuesta.destino_id', 'propuesta.requisito_id', 'propuesta.valor_anterior', 'propuesta.valor_anterior.valor',
      'propuesta.valor_propuesto.valor', 'propuesta.valor_propuesto.importe', 'propuesta.valor_propuesto.moneda',
      'propuesta.fuente.nombre', 'propuesta.fuente.url', 'propuesta.fuente.capturado_en', 'propuesta.version_coordinacion', 'propuesta.creada_en', 'propuesta.actualizada_en',
      'propuesta.payload_hash', 'propuesta.decision_aprobacion_id', 'propuesta.ultimo_evento_id',
      ...['fuente', 'url', 'capturado_en', 'fuente_actualizada_en', 'valor_extraido', 'importe', 'moneda', 'coincide_entre_secciones', 'secciones.0.costo_extraido', 'secciones.0.moneda', 'avisos.0'].map(k => `propuesta.evidencia.${k}`),
      'integridad.hash_recalculado', 'requisito_actual.destino', 'requisito_actual.destino.pais', 'requisito_actual.destino.codigo_iso',
      'requisito_actual.requisito', 'requisito_actual.requisito.requisito_id', 'requisito_actual.requisito.tipo', 'requisito_actual.requisito.nombre',
      'requisito_actual.valor_actual', 'requisito_actual.valor_actual.valor', 'requisito_actual.valor',
      ...['evento_id', 'tipo_evento', 'estado_anterior', 'estado_nuevo', 'ocurrido_en', 'version_coordinacion_nueva', 'hash_contenido_referenciado', 'actor.tipo', 'origen', 'metodo_identidad', 'motivo', 'intento_aplicacion_id'].map(k => `eventos.0.${k}`),
    ]
    for (const ruta of rutas) {
      const cuerpo = ejemplo(); modificar(cuerpo, ruta, null)
      const d = validarDetalle(cuerpo, ID); assert.ok(d, ruta); assert.ok(html(d).length > 0)
    }
    for (const estado of ['coincide', 'destino_no_encontrado', 'requisito_id_no_encontrado', 'requisito_id_duplicado', 'identidad_semantica_no_coincide', 'identidad_no_verificable', 'no_evaluable']) {
      const cuerpo = ejemplo(); cuerpo.requisito_actual.estado = estado; assert.ok(validarDetalle(cuerpo, ID), estado)
    }
    assert.equal(textoPresencia(null), 'No evaluable')
    assert.equal(textoPresencia({ presente: false, valor: null }), 'Ausente')
    assert.equal(textoPresencia({ presente: true, valor: null }), 'Null (sin dato)')
    assert.equal(textoPresencia({ presente: true, valor: '' }), 'Cadena vacía ("")')
    assert.equal(textoValor(undefined), 'Ausente')
    assert.equal(textoValor(false), 'No'); assert.equal(textoValor(0), '0')
  } },
  { nombre: 'detalle inválido: campos obligatorios, tipos, IDs, límites y acciones contradictorias', fn() {
    for (const [ruta, valor] of [['propuesta.propuesta_id', OTRO], ['propuesta.campo', undefined], ['integridad.hash_coincide', null], ['propuesta.valor_anterior', {}], ['eventos', Array(201).fill(evento(1))], ['propuesta.evidencia.secciones', Array(6).fill({})], ['acciones_permitidas', ['aprobar', 'aprobar']], ['acciones_bloqueadas.aprobar', ['hash_no_coincide']], ['propuesta.version_coordinacion', 0.5], ['propuesta.payload_hash', 'mal'], ['requisito_actual.estado', 'inventado']]) {
      const cuerpo = ejemplo(); modificar(cuerpo, ruta as string, valor); assert.equal(validarDetalle(cuerpo, ID), null, String(ruta))
    }
    assert.equal(validarDetalle({}, ID), null)
  } },
  { nombre: 'detalle hostil: texto escapado, enlaces solo HTTPS sin credenciales y sin identidad privada', fn() {
    const cuerpo = ejemplo()
    cuerpo.propuesta.campo = '<img src=x onerror=alert(1)>'
    cuerpo.propuesta.evidencia.avisos = ['<script>hostil</script>']
    cuerpo.eventos[0].motivo = '<svg onload=alert(1)>'
    for (const url of ['javascript:alert(1)', 'data:text/html,ataque', 'http://example.com', '//example.com', 'https://usuario:clave@example.com', 'https://example.com/\nfoo', 'https://example.com/"<svg>', 'https://', 'https://example.com\\@evil.test']) {
      assert.equal(urlHttpsSegura(url), null, url)
      cuerpo.propuesta.fuente.url = url; cuerpo.propuesta.evidencia.url = url
      const vista = html(validarDetalle(cuerpo, ID)!)
      assert.doesNotMatch(vista, /<a\b|<script|<img|<svg|style=/i)
      assert.ok(vista.includes('&lt;script&gt;'))
    }
    assert.equal(urlHttpsSegura('https://www.gov.uk/eta?q=1#costo'), 'https://www.gov.uk/eta?q=1#costo')
    const vista = html(validarDetalle(ejemplo(), ID)!)
    assert.match(vista, /href="https:\/\/www.gov.uk\/eta"/)
    assert.match(vista, /rel="noopener noreferrer"/)
    assert.match(vista, /referrerPolicy="no-referrer"/)
  } },
  { nombre: 'historial vacío y truncado; bloqueos separados y sin decisiones ejecutables', fn() {
    const cuerpo = ejemplo(); cuerpo.eventos = []; cuerpo.eventos_truncados = true
    cuerpo.acciones_permitidas = ['rechazar']; cuerpo.acciones_bloqueadas.aprobar = ['hash_no_coincide', 'valor_actual_cambio']
    let vista = html(validarDetalle(cuerpo, ID)!)
    for (const texto of ['Historial truncado', 'No hay eventos', 'hash_no_coincide', 'valor_actual_cambio', 'Sin motivos de bloqueo.']) assert.ok(vista.includes(texto), texto)
    cuerpo.acciones_permitidas = []; cuerpo.acciones_bloqueadas.rechazar = ['sin_permiso_decidir']
    vista = html(validarDetalle(cuerpo, ID)!)
    assert.ok(vista.includes('Ninguna acción permitida.')); assert.ok(vista.includes('sin_permiso_decidir'))
    assert.doesNotMatch(vista, /<button|<form/)
  } },
  { nombre: 'detalle GET únicamente al seleccionar; volver conserva filtros, resultados, cursor y selección', async fn() {
    const ctx = await contexto(() => respuestaJson(200, ejemplo()))
    assert.equal(ctx.red.llamadas.length, 2)
    ctx.controlador.seleccionar(ID)
    const antes = ctx.controlador.obtenerListado()
    await terminado(ctx.controlador)
    assert.equal(ctx.controlador.obtenerDetalle().datos?.propuesta.propuesta_id, ID)
    assert.match(renderizar(ctx.controlador), /<div hidden="">/)
    const llamada = ctx.red.llamadas[2]
    assert.equal(llamada.url, `${CONFIG.apiOrigen}/api/panel/propuestas/${ID}`)
    assert.equal(llamada.init.method, 'GET'); assert.equal(llamada.init.credentials, 'omit'); assert.equal(llamada.init.cache, 'no-store'); assert.equal(llamada.init.redirect, 'error')
    assert.equal(new Headers(llamada.init.headers).get('Authorization'), `Bearer ${TOKEN}`)
    ctx.controlador.volverAlListado()
    assert.strictEqual(ctx.controlador.obtenerListado(), antes)
    assert.equal(ctx.controlador.obtenerListado().seleccion, ID)
    assert.equal(ctx.controlador.obtenerDetalle().propuestaId, null)
    assert.doesNotMatch(renderizar(ctx.controlador), /titulo-detalle|<div hidden="">/)
    assert.equal(ctx.red.llamadas.length, 3)
  } },
  { nombre: 'detalle tardío de otra selección, doble clic, volver y cerrar sesión se ignoran incluso con fetch que no aborta', async fn() {
    const pendientes: ((r: Response) => void)[] = []
    const ctx = await contexto(() => new Promise(resolve => pendientes.push(resolve)))
    ctx.controlador.seleccionar(ID); ctx.controlador.seleccionar(ID)
    assert.equal(pendientes.length, 1)
    ctx.controlador.seleccionar(OTRO)
    assert.ok(ctx.red.llamadas[2].init.signal?.aborted)
    pendientes[1](respuestaJson(200, ejemplo(OTRO))); await terminado(ctx.controlador)
    pendientes[0](respuestaJson(401, {})); await esperar()
    assert.equal(ctx.controlador.obtenerDetalle().datos?.propuesta.propuesta_id, OTRO)
    assert.equal(ctx.controlador.tieneToken(), true)
    ctx.controlador.seleccionar(ID); ctx.controlador.volverAlListado()
    pendientes[2](respuestaJson(200, ejemplo())); await esperar()
    assert.equal(ctx.controlador.obtenerDetalle().propuestaId, null)
    ctx.controlador.seleccionar(ID); ctx.controlador.cerrarSesion()
    pendientes[3](respuestaJson(200, ejemplo())); await esperar()
    assert.equal(ctx.controlador.obtenerDetalle().datos, null)
    assert.equal(ctx.controlador.obtenerListado().propuestas.length, 0)
  } },
  { nombre: 'volver conserva un filtro aplicado distinto del inicial y su página', async fn() {
    const cuerpo = ejemplo(); cuerpo.propuesta.estado = 'aplicada'
    const ctx = await contexto(() => respuestaJson(200, cuerpo))
    ctx.controlador.filtrar({ estados: ['aplicada'], limite: 1 })
    await hastaQue(() => ctx.controlador.obtenerListado().cargado)
    ctx.controlador.seleccionar(ID); await terminado(ctx.controlador)
    const antes = ctx.controlador.obtenerListado()
    ctx.controlador.volverAlListado()
    assert.strictEqual(ctx.controlador.obtenerListado(), antes)
    assert.deepEqual(antes.filtro, { estados: ['aplicada'], limite: 1 })
    assert.equal(antes.propuestas.length, 1)
    assert.equal(antes.propuestas[0].estado, 'aplicada')
    assert.match(renderizar(ctx.controlador), /Filtro aplicado:.*Aplicada/)
  } },
  { nombre: 'detalle inválido o demasiado grande: error anunciable y recuperación manual', async fn() {
    for (const cuerpo of ['{', 'x'.repeat(MAXIMO_RESPUESTA + 1)]) {
      let n = 0
      const ctx = await contexto(() => respuestaJson(200, ++n === 1 ? cuerpo : ejemplo()))
      ctx.controlador.seleccionar(ID)
      const cargando = renderizar(ctx.controlador)
      assert.match(cargando, /Cargando detalle/)
      assert.match(cargando, /id="titulo-detalle" tabindex="-1"/)
      assert.match(cargando, /aria-busy="true"/)
      await terminado(ctx.controlador)
      assert.equal(ctx.controlador.obtenerDetalle().error, 'respuesta')
      const vista = renderizar(ctx.controlador)
      assert.match(vista, /role="alert"/); assert.match(vista, /Reintentar detalle/)
      assert.equal(n, 1)
      ctx.controlador.reintentarDetalle(); ctx.controlador.reintentarDetalle(); await terminado(ctx.controlador)
      assert.equal(n, 2); assert.ok(ctx.controlador.obtenerDetalle().datos)
    }
  } },
  { nombre: 'detalle 401: conserva listado/selección, descarta token, reautenticación sin reintento automático', async fn() {
    let n = 0
    const ctx = await contexto(() => ++n === 1 ? respuestaJson(401, { error: { mensaje: 'NO_MOSTRAR' } }) : respuestaJson(200, ejemplo()))
    ctx.controlador.seleccionar(ID)
    const listadoPrevio = ctx.controlador.obtenerListado()
    await terminado(ctx.controlador)
    assert.equal(ctx.controlador.tieneToken(), false)
    assert.equal(ctx.controlador.obtenerEstado().fase, 'sin_sesion')
    assert.strictEqual(ctx.controlador.obtenerListado(), listadoPrevio)
    assert.equal(ctx.controlador.obtenerDetalle().propuestaId, ID)
    assert.match(renderizar(ctx.controlador), /sesión venció \(401\)/)
    ctx.controlador.reintentarDetalle(); assert.equal(n, 1)
    ctx.gis.entregar({ credential: TOKEN }); await hastaQue(() => ctx.controlador.obtenerEstado().fase === 'autorizado'); await esperar()
    assert.equal(ctx.red.llamadas.length, 4, 'solo sesión, listado, detalle y reautenticación')
    assert.equal(n, 1); assert.strictEqual(ctx.controlador.obtenerListado(), listadoPrevio)
    ctx.controlador.reintentarDetalle(); await terminado(ctx.controlador)
    assert.equal(n, 2); assert.ok(ctx.controlador.obtenerDetalle().datos)
  } },
  { nombre: 'detalle: cambio de identidad o permisos elimina datos y respuestas anteriores', async fn() {
    for (const sesion of [{ ...SESION_AUTORIZADA, identidad: { ...SESION_AUTORIZADA.identidad, sub: '222222222222222222222' } }, { ...SESION_AUTORIZADA, permisos: [] }]) {
      let resolver: (r: Response) => void = () => {}
      const ctx = await contexto(() => new Promise(r => { resolver = r }))
      ctx.controlador.seleccionar(ID); ctx.cambiarSesion(sesion); ctx.gis.entregar({ credential: TOKEN })
      await hastaQue(() => ctx.controlador.obtenerEstado().fase === 'autorizado')
      resolver(respuestaJson(200, ejemplo())); await esperar()
      assert.equal(ctx.controlador.obtenerDetalle().propuestaId, null)
      assert.equal(ctx.controlador.obtenerDetalle().datos, null)
    }
  } },
  ...([403, 404, 500, 503] as const).map(status => ({ nombre: `detalle ${status}: mensaje fijo, request ID y reintento manual`, async fn() {
    let n = 0
    const ctx = await contexto(() => ++n === 1 ? respuestaJson(status, { error: { mensaje: 'NO_MOSTRAR', request_id: REQUEST_ID } }, null) : respuestaJson(200, ejemplo()))
    ctx.controlador.seleccionar(ID); await terminado(ctx.controlador)
    assert.equal(ctx.controlador.obtenerDetalle().requestId, REQUEST_ID)
    const vista = renderizar(ctx.controlador)
    assert.ok(vista.includes(`(${status})`)); assert.ok(vista.includes('Reintentar detalle')); assert.ok(!vista.includes('NO_MOSTRAR'))
    assert.equal(n, 1); ctx.controlador.reintentarDetalle(); await terminado(ctx.controlador); assert.equal(n, 2)
    assert.ok(ctx.controlador.obtenerDetalle().datos)
  } })),
  { nombre: 'detalle: red/CORS, JSON inválido, respuesta grande y request ID hostil', async fn() {
    for (const mensaje of ['Failed to fetch', 'CORS', TOKEN]) {
      const ctx = await contexto(() => { throw new Error(mensaje) }); ctx.controlador.seleccionar(ID); await terminado(ctx.controlador)
      assert.equal(ctx.controlador.obtenerDetalle().error, 'conexion'); assert.match(renderizar(ctx.controlador), /Red|red/)
      assert.ok(!renderizar(ctx.controlador).includes(TOKEN))
    }
    for (const cuerpo of ['<html>', '{', '"' + 'é'.repeat(MAXIMO_RESPUESTA / 2) + '"', {}, { ...ejemplo(), propuesta: { propuesta_id: OTRO } }]) {
      const r = await consultar(respuestaJson(200, cuerpo, '<script>'))
      assert.deepEqual(r, { tipo: 'error', fallo: 'respuesta', requestId: null })
    }
    let cancelada = false, leidas = 0
    const stream = new ReadableStream({ pull(c) { leidas++; c.enqueue(new Uint8Array(65536)) }, cancel() { cancelada = true } }, { highWaterMark: 0 })
    assert.equal((await consultar(new Response(stream))).tipo, 'error')
    assert.equal(cancelada, true); assert.equal(leidas, 9)
    assert.equal((await consultar(respuestaJson(404, { error: { request_id: 'mal' } }, 'mal'))).requestId, null)
    let llamadas = 0
    await consultarDetalle(CONFIG.apiOrigen, TOKEN, '../otro', async () => { llamadas++; return respuestaJson(200, ejemplo()) }, new AbortController().signal)
    assert.equal(llamadas, 0)
  } },
  { nombre: 'detalle: token sin fugas en estados, HTML, URLs, consola ni almacenamiento; eco escapado rechazado', async fn() {
    const espias = instalarEspias()
    try {
      const ctx = await contexto(() => respuestaJson(200, ejemplo()))
      ctx.controlador.seleccionar(ID); await terminado(ctx.controlador)
      comprobarSinFugas({ ...ctx, espias })
      assert.ok(!JSON.stringify(ctx.controlador.obtenerDetalle()).includes(TOKEN))
      assert.ok(!JSON.stringify(ctx.controlador.obtenerListado()).includes(TOKEN))
      for (const escaped of [false, true]) {
        const cuerpo = JSON.stringify({ ...ejemplo(), eco: TOKEN })
        const r = await consultar(respuestaJson(200, escaped ? cuerpo.replace(TOKEN, [...TOKEN].map(c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('')) : cuerpo))
        assert.equal(r.tipo, 'error')
      }
      assert.deepEqual(espias.registro, [])
    } finally { espias.restaurar() }
  } },
]
