import assert from 'node:assert/strict'
import { renderToString } from 'react-dom/server'
import { crearControladorPanel } from '../../src/panel/controlador.ts'
import { ListadoPropuestas } from '../../src/panel/ListadoPropuestas.tsx'
import { consultarPropuestas, validarPagina, cursorValido, filtroValido, leerJsonLimitado, MAXIMO_RESPUESTA, unirPropuestas, type Filtro } from '../../src/panel/propuestas.ts'
import { CONFIG, TOKEN, REQUEST_ID, SESION_AUTORIZADA, crearGisFalso, crearFetchFalso, respuestaJson, hastaQue, esperar, instalarEspias, comprobarSinFugas, renderizar, type Prueba } from './apoyo.tsx'

const filtro: Filtro = { estados: ['pendiente_aprobacion'], limite: 20 }
const cursor = (n: number) => `v1.${n.toString(16).padStart(24, '0')}.01`
const propuesta = (n = 1, extra = {}) => ({ propuesta_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, destino_id: 'a'.repeat(24), destino: { destino_id: 'a'.repeat(24), pais: 'Reino Unido', codigo_iso: 'GB' }, requisito_id: 'b'.repeat(24), estado: 'pendiente_aprobacion', campo: 'costo', creada_en: '2026-10-10T12:00:00.000Z', actualizada_en: null, alertas: [], ...extra })
const pagina = (propuestas: unknown[] = [], siguiente_cursor: string | null = null, f = filtro) => ({ propuestas, siguiente_cursor, filtro: { estados: f.estados }, limite: f.limite })
type Responder = Parameters<typeof crearFetchFalso>[0]
async function contexto(responder: Responder) {
  const gis = crearGisFalso()
  const red = crearFetchFalso((url, init) => url.endsWith('/sesion') ? respuestaJson(200, SESION_AUTORIZADA) : url.includes('/propuestas/') ? respuestaJson(404, {}) : responder(url, init))
  const controlador = crearControladorPanel({ config: CONFIG, cargarGis: gis.cargar, hacerFetch: red.hacerFetch })
  controlador.iniciar()
  await hastaQue(() => controlador.obtenerEstado().fase === 'sin_sesion')
  gis.entregar({ credential: TOKEN })
  await hastaQue(() => controlador.obtenerEstado().fase !== 'verificando')
  return { controlador, gis, red }
}
const terminado = async (c: ReturnType<typeof crearControladorPanel>) => hastaQue(() => !c.obtenerListado().cargando)

export const pruebas: Prueba[] = [
  { nombre: 'contrato: filtro, cursor ligado a estados, destino válido/null y lista blanca', fn() {
    assert.equal(filtroValido(filtro), true)
    for (const f of [{ ...filtro, limite: 0 }, { ...filtro, limite: 51 }, { ...filtro, limite: 1.5 }, { ...filtro, estados: [] }, { ...filtro, estados: ['aprobada', 'aprobada'] }]) assert.equal(filtroValido(f as Filtro), false)
    assert.equal(cursorValido(cursor(5), filtro), true)
    for (const c of ['', 'xyz', 'https://otro.example', cursor(5).replace('.01', '.02')]) assert.equal(cursorValido(c, filtro), false)
    const p = validarPagina(pagina([propuesta(1, { extra: 'no sale' }), propuesta(2, { destino: null })]), filtro)!
    assert.equal(p.propuestas[0].destino?.pais, 'Reino Unido')
    assert.equal(p.propuestas[1].destino, null)
    assert.ok(!JSON.stringify(p).includes('no sale'))
    for (const cuerpo of [{}, pagina([], cursor(1)), pagina([propuesta()], 'mal'), { ...pagina(), limite: 50 }, pagina([propuesta(1, { destino: { destino_id: 'c'.repeat(24), pais: 'X', codigo_iso: 'GB' } })]), pagina([propuesta(1, { destino: undefined })]), pagina([propuesta(1, { estado: 'aprobada' })]), pagina([propuesta(1, { propuesta_id: '../x' })]), pagina([propuesta(1, { alertas: ['<script>'] })])]) assert.equal(validarPagina(cuerpo, filtro), null)
    assert.equal(unirPropuestas(p.propuestas, [p.propuestas[0], p.propuestas[0]]).length, 2)
  } },
  { nombre: 'lectura: 512 KiB durante streaming, bytes UTF-8 y cancelación temprana', async fn() {
    let cancelada = false, lecturas = 0
    const r = new Response(new ReadableStream({ pull(c) { lecturas++; c.enqueue(new Uint8Array(64 * 1024).fill(32)) }, cancel() { cancelada = true } }, { highWaterMark: 0 }))
    assert.equal(await leerJsonLimitado(r, TOKEN), null)
    assert.equal(cancelada, true)
    assert.equal(lecturas, 9)
    assert.equal(await leerJsonLimitado(new Response('"' + 'é'.repeat(MAXIMO_RESPUESTA / 2) + '"'), TOKEN), null)
    assert.equal((await leerJsonLimitado(new Response('"' + 'a'.repeat(MAXIMO_RESPUESTA - 2) + '"'), TOKEN) as string).length, MAXIMO_RESPUESTA - 2)
    assert.equal(await leerJsonLimitado(new Response(new Uint8Array([0xff])), TOKEN), null)
    assert.equal(await leerJsonLimitado(new Response(JSON.stringify({ eco: TOKEN })), TOKEN), null)
    assert.equal(await leerJsonLimitado(new Response('{"eco":"' + [...TOKEN].map(c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('') + '"}'), TOKEN), null)
  } },
  { nombre: 'API: 401/403/500/503, red/CORS, JSON inválido y request ID validado', async fn() {
    for (const [status, fallo] of [[401, 'sesion'], [403, 'permiso'], [500, 'servidor'], [503, 'no_disponible']] as const) {
      assert.deepEqual(await consultarPropuestas(CONFIG.apiOrigen, TOKEN, filtro, null, async () => respuestaJson(status, { error: { mensaje: TOKEN } })), { tipo: 'error', fallo, requestId: REQUEST_ID })
    }
    for (const mensaje of ['Failed to fetch', 'CORS', TOKEN]) assert.deepEqual(await consultarPropuestas(CONFIG.apiOrigen, TOKEN, filtro, null, async () => { throw new Error(mensaje) }), { tipo: 'error', fallo: 'conexion', requestId: null })
    for (const cuerpo of ['<html>', '{', 'x'.repeat(MAXIMO_RESPUESTA + 1), JSON.stringify({ eco: TOKEN })]) assert.deepEqual(await consultarPropuestas(CONFIG.apiOrigen, TOKEN, filtro, null, async () => respuestaJson(200, cuerpo)), { tipo: 'error', fallo: 'respuesta', requestId: REQUEST_ID })
    const r = await consultarPropuestas(CONFIG.apiOrigen, TOKEN, filtro, null, async () => respuestaJson(500, { error: { request_id: REQUEST_ID } }, 'mal'))
    assert.equal(r.requestId, REQUEST_ID)
    assert.equal((await consultarPropuestas(CONFIG.apiOrigen, TOKEN, filtro, null, async () => respuestaJson(500, {}, TOKEN))).requestId, null)
    let llamadas = 0
    await consultarPropuestas(CONFIG.apiOrigen, TOKEN, filtro, 'invalido', async () => { llamadas++; return respuestaJson(200, pagina()) })
    assert.equal(llamadas, 0)
  } },
  { nombre: 'listado vacío y múltiples páginas: deduplica, protege doble clic y detecta cursor repetido', async fn() {
    const vacio = await contexto(() => respuestaJson(200, pagina()))
    await terminado(vacio.controlador)
    assert.match(renderizar(vacio.controlador), /No hay propuestas/)
    let n = 0
    const ctx = await contexto(() => respuestaJson(200, ++n === 1 ? pagina([propuesta()], cursor(3)) : n === 2 ? pagina([propuesta(), propuesta(2)], cursor(2)) : pagina([propuesta(3)], cursor(3))))
    await terminado(ctx.controlador)
    ctx.controlador.cargarMas(); ctx.controlador.cargarMas()
    await terminado(ctx.controlador)
    assert.equal(n, 2)
    assert.equal(ctx.controlador.obtenerListado().propuestas.length, 2)
    assert.ok(ctx.red.llamadas[2].url.endsWith(`cursor=${cursor(3)}`))
    ctx.controlador.cargarMas()
    await terminado(ctx.controlador)
    assert.equal(ctx.controlador.obtenerListado().error, 'respuesta')
    assert.equal(ctx.controlador.obtenerListado().cursor, null)
    assert.equal(ctx.controlador.obtenerListado().propuestas.length, 2)
    ctx.controlador.cargarMas(); assert.equal(n, 3)
  } },
  { nombre: 'cambio de filtro ignora respuestas tardías y reinicia cursor y selección', async fn() {
    let resolver: (r: Response) => void = () => {}
    const ctx = await contexto(() => new Promise(r => { resolver = r }))
    const primera = resolver
    const f: Filtro = { estados: ['aprobada'], limite: 1 }
    ctx.controlador.filtrar(f)
    const segunda = resolver
    // La solicitud anterior queda abortada; su respuesta no reemplaza la nueva.
    segunda(respuestaJson(200, pagina([propuesta(2, { estado: 'aprobada' })], null, f)))
    await terminado(ctx.controlador)
    primera(respuestaJson(200, pagina([propuesta()])))
    await esperar()
    ctx.controlador.seleccionar(propuesta(2).propuesta_id)
    assert.equal(ctx.controlador.obtenerListado().seleccion, propuesta(2).propuesta_id)
    assert.equal(ctx.controlador.obtenerListado().propuestas[0].estado, 'aprobada')
    assert.ok(ctx.red.llamadas[1].init.signal?.aborted)
    ctx.controlador.filtrar(filtro)
    assert.equal(ctx.controlador.obtenerListado().seleccion, null)
    assert.equal(ctx.controlador.obtenerListado().cursor, null)
    ctx.controlador.cerrarSesion()
    resolver(respuestaJson(200, pagina([propuesta()])))
    await esperar()
    assert.equal(ctx.controlador.obtenerListado().propuestas.length, 0)
  } },
  { nombre: '401 conserva resultados y selección, borra token y permite reautenticar sin fugas', async fn() {
    const espias = instalarEspias()
    try {
      let n = 0
      const ctx = await contexto(() => respuestaJson(++n === 2 ? 401 : 200, n === 2 ? {} : pagina([propuesta()], cursor(3))))
      await terminado(ctx.controlador)
      ctx.controlador.seleccionar(propuesta().propuesta_id)
      ctx.controlador.cargarMas()
      await terminado(ctx.controlador)
      assert.equal(ctx.controlador.tieneToken(), false)
      assert.equal(ctx.controlador.obtenerEstado().fase, 'sin_sesion')
      assert.equal(ctx.controlador.obtenerListado().propuestas.length, 1)
      assert.equal(ctx.controlador.obtenerListado().seleccion, propuesta().propuesta_id)
      assert.match(renderizar(ctx.controlador), /Conservamos la vista/)
      ctx.gis.entregar({ credential: TOKEN })
      await hastaQue(() => ctx.controlador.obtenerEstado().fase === 'autorizado')
      await terminado(ctx.controlador)
      comprobarSinFugas({ ...ctx, espias })
      for (const { url, init } of ctx.red.llamadas) { assert.ok(url.startsWith(CONFIG.apiOrigen)); assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store'); assert.equal(init.redirect, 'error'); assert.equal(init.method, 'GET') }
    } finally { espias.restaurar() }
  } },
  { nombre: 'vista: destino null, alertas, texto hostil escapado, etiquetas y carga anunciable', async fn() {
    const ctx = await contexto(() => respuestaJson(200, pagina([propuesta(1, { destino: null, campo: '<img src=x onerror=alert(1)>', alertas: ['hash_no_coincide', 'datos_inconsistentes'] }), propuesta(2, { destino: { destino_id: 'a'.repeat(24), pais: '<script>hostil</script>', codigo_iso: 'GB' } })])))
    await terminado(ctx.controlador)
    const html = renderToString(<ListadoPropuestas controlador={ctx.controlador} habilitado copiar={async () => {}} />)
    for (const texto of ['Destino no disponible', 'huella registrada', 'datos inconsistentes', '&lt;script&gt;', '&lt;img', 'Filtrar por estado', 'aria-busy="false"', 'role="status"', 'Copiar request ID']) assert.ok(html.includes(texto), texto)
    assert.doesNotMatch(html, /<script|<img|style=|onclick=/i)
  } },
  { nombre: 'controlador: errores visibles conservan página y nunca exponen mensajes del servidor', async fn() {
    for (const status of [403, 500, 503]) {
      let n = 0
      const ctx = await contexto(() => respuestaJson(++n === 1 ? 200 : status, n === 1 ? pagina([propuesta()], cursor(3)) : { error: { mensaje: '<script>secreto</script>' } }))
      await terminado(ctx.controlador)
      ctx.controlador.cargarMas()
      await terminado(ctx.controlador)
      assert.equal(ctx.controlador.obtenerListado().propuestas.length, 1)
      const html = renderizar(ctx.controlador)
      assert.ok(html.includes(`(${status})`))
      assert.ok(html.includes(REQUEST_ID))
      assert.ok(!html.includes('secreto'))
    }
  } },
  { nombre: 'cursor inmediato repetido e inválido no agregan páginas; recarga permite recuperarse', async fn() {
    for (const siguiente of [cursor(3), 'cursor-invalido']) {
      let n = 0
      const ctx = await contexto(() => respuestaJson(200, ++n === 1 ? pagina([propuesta()], cursor(3)) : n === 2 ? pagina([propuesta(2)], siguiente) : pagina([propuesta(3)])))
      await terminado(ctx.controlador)
      ctx.controlador.cargarMas()
      await terminado(ctx.controlador)
      assert.equal(ctx.controlador.obtenerListado().error, 'respuesta')
      assert.equal(ctx.controlador.obtenerListado().propuestas.length, 1)
      ctx.controlador.recargar()
      await terminado(ctx.controlador)
      assert.equal(ctx.controlador.obtenerListado().error, null)
      assert.equal(ctx.controlador.obtenerListado().propuestas[0].propuesta_id, propuesta(3).propuesta_id)
    }
  } },
]
