// Contrato del servicio panel de aplicación. Store in-memory, sin Mongo/red.
const assert = require('assert');
const { crearAplicacionesPropuestas, construirEntrada, respuestaAplicada, ErrorCuerpoAplicacion, ErrorAplicacionCambio, ErrorAplicacionNoAplica, ErrorAplicacionIncierta } = require('../services/panel/aplicaciones-propuestas');
const ID = '054d03c8-e9ba-4352-8370-e4f88534f612';
const HASH = 'a'.repeat(64);
const APROB = 'd54d03c8-e9ba-4352-8370-e4f88534f612';
const EVENTO = 'e54d03c8-e9ba-4352-8370-e4f88534f612';
const INTENTO = 'f54d03c8-e9ba-4352-8370-e4f88534f612';
const HIST = 'a54d03c8-e9ba-4352-8370-e4f88534f613';
const REQUEST = 'b54d03c8-e9ba-4352-8370-e4f88534f614';
const body = { estado_esperado: 'aprobada', payload_hash_esperado: HASH, version_coordinacion_esperada: 7, decision_aprobacion_id_esperado: APROB };
const operador = (id = 'op', sub = '5000', permisos = ['ver', 'aplicar']) => ({ identificador: id, permisos, identidad_operador: { metodo: 'oidc_google', sub } });
function storeInicial() {
  const estado = { propuesta: { propuesta_id: ID, estado: 'aprobada', payload_hash: HASH, version_coordinacion: 7, decision_aprobacion_id: APROB, ultimo_evento_id: APROB }, eventos: new Map(), intentos: new Map(), historial: new Map() };
  const db = { collection(nombre) { const llave = nombre === 'propuestas_cambio' ? 'propuesta_id' : nombre === 'eventos_propuesta' ? 'evento_id' : nombre === 'intentos_aplicacion' ? 'intento_id' : 'historial_id'; const mapa = nombre === 'propuestas_cambio' ? null : estado[nombre === 'eventos_propuesta' ? 'eventos' : nombre === 'intentos_aplicacion' ? 'intentos' : 'historial']; return { findOne: async f => nombre === 'propuestas_cambio' ? (f.propuesta_id === ID ? estado.propuesta : null) : mapa.get(f[llave]) ?? null }; } };
  return { estado, db };
}
async function ejecutar() {
  assert.deepStrictEqual(Object.keys(construirEntrada(ID, body)).sort(), ['decision_aprobacion_id_esperado', 'estado_esperado', 'payload_hash_esperado', 'propuesta_id', 'version_coordinacion_esperada'].sort());
  for (const invalido of [{ ...body, actor: 'x' }, { ...body, decision_aprobacion_id_esperado: null }, { ...body, estado_esperado: 'pendiente_aprobacion' }]) assert.throws(() => construirEntrada(ID, invalido), ErrorCuerpoAplicacion);
  const { estado, db } = storeInicial(); let escrituras = 0; let aud;
  const servicio = crearAplicacionesPropuestas({ obtenerDb: () => db, dependencias: () => ({}), aplicar: async (entrada, _deps, audit) => {
    escrituras++; aud = audit;
    estado.propuesta = { ...estado.propuesta, estado: 'aplicada', version_coordinacion: 8, ultimo_evento_id: EVENTO };
    estado.eventos.set(EVENTO, { evento_id: EVENTO, propuesta_id: ID, tipo_evento: 'aplicacion', estado_anterior: 'aprobada', estado_nuevo: 'aplicada', hash_contenido_referenciado: HASH, version_coordinacion_nueva: 8, ocurrido_en: new Date('2026-10-13T12:00:00Z'), intento_aplicacion_id: INTENTO, detalle: { auditoria_panel: audit } });
    estado.intentos.set(INTENTO, { intento_id: INTENTO, historial_id: HIST, resultado: 'exito', decision_aprobacion_id: APROB });
    estado.historial.set(HIST, { historial_id: HIST, decision_aprobacion_id: APROB });
    return { resultado: 'exito', evento_id: EVENTO, intento_id: INTENTO };
  } });
  const primera = await servicio.aplicar(ID, body, operador(), REQUEST);
  assert.equal(primera.aplicacion.destino_modificado, true); assert.equal(primera.aplicacion.ya_aplicada, false);
  assert.equal(aud.origen, 'panel'); assert.equal(aud.request_id, REQUEST); assert.equal(aud.operador, 'op');
  const evExito = estado.eventos.get(EVENTO), intentoExito = estado.intentos.get(INTENTO);
  for (const cambio of [{ estado: 'aprobada' }, { ultimo_evento_id: REQUEST }, { version_coordinacion: 10 }, { payload_hash: 'b'.repeat(64) }, { decision_aprobacion_id: REQUEST }]) {
    assert.throws(() => respuestaAplicada(construirEntrada(ID, body), { ...estado.propuesta, ...cambio }, evExito, intentoExito, false), ErrorAplicacionIncierta);
  }
  for (const cambio of [{ tipo_evento: 'aprobacion' }, { evento_id: 'x' }, { intento_aplicacion_id: REQUEST }, { ocurrido_en: new Date('invalid') }]) {
    assert.throws(() => respuestaAplicada(construirEntrada(ID, body), estado.propuesta, { ...evExito, ...cambio }, intentoExito, false), ErrorAplicacionIncierta);
  }
  const replay = await servicio.aplicar(ID, body, operador(), 'c54d03c8-e9ba-4352-8370-e4f88534f614');
  assert.equal(replay.aplicacion.ya_aplicada, true); assert.equal(escrituras, 1, 'reenvío sin nuevas escrituras');
  await assert.rejects(servicio.aplicar(ID, body, operador('otro', '6000'), REQUEST), ErrorAplicacionCambio);
  await assert.rejects(servicio.aplicar(ID, { ...body, payload_hash_esperado: 'b'.repeat(64) }, operador(), REQUEST), ErrorAplicacionCambio);

  const antesCarrera = { ...estado.propuesta };
  estado.propuesta = { ...estado.propuesta, estado: 'aprobada', version_coordinacion: 7, ultimo_evento_id: APROB };
  const carrera = crearAplicacionesPropuestas({ obtenerDb: () => db, dependencias: () => ({}), aplicar: async () => {
    estado.propuesta = antesCarrera;
    return { resultado: 'propuesta_no_aplicable', intento_id: REQUEST };
  } });
  await assert.rejects(carrera.aplicar(ID, body, operador(), REQUEST), e => e instanceof ErrorAplicacionCambio && e.intentoId === REQUEST, 'CARRERA: tras escribir inicio no se presenta como reenvío');
  const { estado: e422, db: db422 } = storeInicial();
  const semantico = crearAplicacionesPropuestas({ obtenerDb: () => db422, dependencias: () => ({}), aplicar: async () => ({ resultado: 'fuente_cambio', estado_propuesta_nuevo: 'revision_requerida', intento_id: INTENTO }) });
  await assert.rejects(semantico.aplicar(ID, body, operador(), REQUEST), err => err instanceof ErrorAplicacionNoAplica && err.aplicacion.destino_modificado === false && err.aplicacion.estado_propuesta_nuevo === 'aprobada' && err.aplicacion.intento_id === INTENTO);
  assert.equal(e422.propuesta.estado, 'aprobada');

  const { db: dbFalso200 } = storeInicial();
  const falso200 = crearAplicacionesPropuestas({ obtenerDb: () => dbFalso200, dependencias: () => ({}), aplicar: async () => ({ resultado: 'exito', evento_id: EVENTO, intento_id: INTENTO }) });
  await assert.rejects(falso200.aplicar(ID, body, operador(), REQUEST), ErrorAplicacionIncierta);
  const denegado = crearAplicacionesPropuestas({ obtenerDb: () => storeInicial().db, dependencias: () => ({}), aplicar: async () => assert.fail('no ejecutar') });
  await assert.rejects(denegado.aplicar(ID, body, operador('read', '5001', ['ver']), REQUEST), /permiso ausente/);
  const noDisponible = crearAplicacionesPropuestas({ obtenerDb: () => null, aplicar: async () => assert.fail('503 nunca entra al servicio') });
  await assert.rejects(noDisponible.aplicar(ID, body, operador(), REQUEST), e => e.constructor.name === 'ErrorAplicacionNoDisponible');
  const fuenteCaida = crearAplicacionesPropuestas({ obtenerDb: () => storeInicial().db, dependencias: () => ({}), aplicar: async () => ({ resultado: 'fuente_temporalmente_no_disponible', intento_id: INTENTO }) });
  await assert.rejects(fuenteCaida.aplicar(ID, body, operador(), REQUEST), e => e instanceof ErrorAplicacionNoAplica && e.aplicacion.intento_id === INTENTO);
  const redIncierta = crearAplicacionesPropuestas({ obtenerDb: () => storeInicial().db, dependencias: () => ({}), aplicar: async () => { throw Object.assign(new Error('NO_MOSTRAR'), { name: 'MongoNetworkError', intento_id: INTENTO }); } });
  await assert.rejects(redIncierta.aplicar(ID, body, operador(), REQUEST), e => e instanceof ErrorAplicacionIncierta && e.intentoId === INTENTO);
  process.stdout.write('Servicio panel: entrada exacta, CAS snapshot, audit OIDC/request_id, idempotencia, operador distinto, 422 sin destino y ningún 200 falso: OK\n');
}
ejecutar().catch(e => { process.stderr.write(`${e.stack || e}\n`); process.exitCode = 1; });
