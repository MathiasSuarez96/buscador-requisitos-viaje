const assert = require('node:assert/strict');
const {
  validarEntrada, construirFiltroCas, construirEvento, decidirPropuesta, ErrorEntradaInvalida
} = require('../services/propuestas/decidir-propuesta');
const {
  construirEntrada, coincideLoVisto, esReenvioIdentico, ErrorCuerpoInvalido, ErrorPropuestaCambio, crearDecisionesPropuestas
} = require('../services/panel/decisiones-propuestas');
const { ADVERTENCIAS } = require('../services/propuestas/payload-requisito-v2');

const ID = '22222222-2222-4222-8222-222222222222';
const HASH = 'a'.repeat(64);
const base = (tipo_evento = 'aprobacion', extra = {}) => ({ tipo_evento, propuesta_id: ID, estado_esperado: 'pendiente_aprobacion', payload_hash_esperado: HASH, version_coordinacion_esperada: 0, decision_aprobacion_id_esperado: null, ...extra });
const op = { actor: { tipo: 'humano', identificador: 'operador' }, identidad_operador: { metodo: 'google_oidc', sub: '123' } };
const ordenadas = [...ADVERTENCIAS].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
const fallaEntrada = (e) => assert.throws(() => validarEntrada(e), ErrorEntradaInvalida);

for (const a of [[], ['quita_obligatoriedad'], ordenadas]) {
  const entrada = validarEntrada(base('aprobacion', { version_contrato_esperada: '2.0', advertencias_aceptadas: a }));
  assert.deepStrictEqual(entrada.advertencias_aceptadas, a);
  assert.ok(Object.isFrozen(entrada.advertencias_aceptadas));
  const f = construirFiltroCas(entrada);
  assert.equal(f['payload.version_contrato'], '2.0');
  assert.deepStrictEqual(f['payload.advertencias'], { $eq: a });
  const ev = construirEvento(entrada, ID, new Date('2026-01-01T00:00:00Z'), { ...op, comando: { nombre: 'panel-propuestas', version: '1' } });
  assert.deepStrictEqual(ev.detalle.version_contrato, '2.0');
  assert.deepStrictEqual(ev.detalle.advertencias_aceptadas, a);
  assert.equal(ev.hash_contenido_referenciado, HASH);
}

for (const a of [undefined, ['quita_obligatoriedad', 'degrada_estado_verificacion'], ['quita_obligatoriedad', 'quita_obligatoriedad'], ['inventada'], [' quita_obligatoriedad'], new Array(1)]) {
  const e = base('aprobacion', { version_contrato_esperada: '2.0' });
  if (a !== undefined) e.advertencias_aceptadas = a;
  fallaEntrada(e);
}
const conExtra = ['degrada_estado_verificacion']; conExtra.extra = true;
fallaEntrada(base('aprobacion', { version_contrato_esperada: '2.0', advertencias_aceptadas: conExtra }));
let getterLeido = 0;
const conGetter = []; Object.defineProperty(conGetter, '0', { get() { getterLeido++; return 'degrada_estado_verificacion'; } }); conGetter.length = 1;
fallaEntrada(base('aprobacion', { version_contrato_esperada: '2.0', advertencias_aceptadas: conGetter }));
assert.equal(getterLeido, 0);
const coercible = { length: 0, [Symbol.iterator]: function* () {} };
fallaEntrada(base('aprobacion', { version_contrato_esperada: '2.0', advertencias_aceptadas: coercible }));
for (const version_contrato_esperada of [null, 2, {}, '3.0']) fallaEntrada(base('rechazo', { version_contrato_esperada, motivo: 'no aplica' }));
fallaEntrada(base('aprobacion', { advertencias_aceptadas: [] }));
fallaEntrada(base('rechazo', { version_contrato_esperada: '2.0', advertencias_aceptadas: [], motivo: 'no aplica' }));
assert.equal(validarEntrada(base('aprobacion')).version_contrato_esperada, '1.0');
assert.equal(validarEntrada(base('aprobacion', { version_contrato_esperada: '1.0' })).version_contrato_esperada, '1.0');

const rechazo = validarEntrada(base('rechazo', { version_contrato_esperada: '2.0', motivo: 'no aplica' }));
assert.equal(construirFiltroCas(rechazo)['payload.version_contrato'], '2.0');
assert.ok(!Object.hasOwn(construirFiltroCas(rechazo), 'payload.advertencias'));
const ev2r = construirEvento(rechazo, ID, new Date(), { ...op, comando: { nombre: 'panel-propuestas', version: '1' } });
assert.deepStrictEqual(ev2r.detalle, { identidad_operador: op.identidad_operador, comando: { nombre: 'panel-propuestas', version: '1' }, version_contrato: '2.0' });
const cancelacion = validarEntrada(base('cancelacion', { estado_esperado: 'aprobada', decision_aprobacion_id_esperado: ID, version_contrato_esperada: '2.0', motivo: 'se canceló' }));
assert.equal(cancelacion.version_contrato_esperada, '2.0');
fallaEntrada(base('cancelacion', { estado_esperado: 'aprobada', decision_aprobacion_id_esperado: ID, version_contrato_esperada: '2.0', motivo: 'se canceló', advertencias_aceptadas: [] }));
const ev1 = construirEvento(validarEntrada(base()), ID, new Date(), { ...op, comando: { nombre: 'panel-propuestas', version: '1' } });
assert.deepStrictEqual(Object.keys(ev1.detalle).sort(), ['comando', 'identidad_operador']);

const cuerpo = { estado_esperado: 'pendiente_aprobacion', payload_hash_esperado: HASH, version_coordinacion_esperada: 0 };
assert.equal(Object.keys(construirEntrada('aprobacion', ID, cuerpo)).includes('version_contrato_esperada'), false);
const ePanel = construirEntrada('aprobacion', ID, { ...cuerpo, version_contrato_esperada: '2.0', advertencias_aceptadas: ordenadas });
assert.equal(ePanel.version_contrato_esperada, '2.0');
const rechazoPanel = construirEntrada('rechazo', ID, { ...cuerpo, version_contrato_esperada: '2.0', motivo: 'rechazo de prueba' });
assert.equal(rechazoPanel.version_contrato_esperada, '2.0');
assert.ok(!Object.hasOwn(rechazoPanel, 'advertencias_aceptadas'));
assert.throws(() => construirEntrada('aprobacion', ID, { ...cuerpo, version_contrato_esperada: '2.0' }), ErrorCuerpoInvalido);
assert.throws(() => construirEntrada('rechazo', ID, { ...cuerpo, version_contrato_esperada: '2.0', motivo: 'x', advertencias_aceptadas: [] }), ErrorCuerpoInvalido);
const p = { estado: 'pendiente_aprobacion', payload_hash: HASH, version_coordinacion: 0, payload: { version_contrato: '2.0', advertencias: ordenadas } };
assert.equal(coincideLoVisto(ePanel, p), true);
assert.equal(coincideLoVisto(ePanel, { ...p, payload: { ...p.payload, version_contrato: '1.0' } }), false);
assert.equal(coincideLoVisto(ePanel, { ...p, payload: { ...p.payload, advertencias: [...ordenadas].reverse() } }), false);

const evento = { evento_id: ID, propuesta_id: ID, tipo_evento: 'aprobacion', estado_anterior: 'pendiente_aprobacion', estado_nuevo: 'aprobada', hash_contenido_referenciado: HASH, version_coordinacion_nueva: 1, actor: op.actor, detalle: { identidad_operador: op.identidad_operador, comando: { nombre: 'panel-propuestas' }, version_contrato: '2.0', advertencias_aceptadas: ordenadas } };
const posterior = { ultimo_evento_id: ID, estado: 'aprobada', version_coordinacion: 1, payload_hash: HASH, decision_aprobacion_id: ID, payload: p.payload };
assert.equal(esReenvioIdentico(ePanel, op, posterior, evento), true);
assert.equal(esReenvioIdentico({ ...ePanel, advertencias_aceptadas: [] }, op, posterior, evento), false);
assert.equal(esReenvioIdentico({ ...ePanel, advertencias_aceptadas: [...ordenadas].reverse() }, op, posterior, evento), false);

(async () => {
  let dependenciasTocadas = 0;
  const deps = { resolverIdentidad: async () => { dependenciasTocadas++; }, verificarIndices: async () => { dependenciasTocadas++; } };
  await assert.rejects(decidirPropuesta(base('aprobacion', { version_contrato_esperada: '2.0' }), deps), ErrorEntradaInvalida);
  await assert.rejects(decidirPropuesta(base('aprobacion', { version_contrato_esperada: '2.0', advertencias_aceptadas: ['quita_obligatoriedad', 'degrada_estado_verificacion'] }), deps), ErrorEntradaInvalida);
  assert.equal(dependenciasTocadas, 0, 'entradas inválidas no alcanzan identidad, índices ni escrituras');
  let llamadas = 0;
  let proyeccion;
  const db = { collection: () => ({ findOne: async (_f, options) => { proyeccion = options.projection; return { propuesta_id: ID, estado: 'pendiente_aprobacion', payload_hash: HASH, version_coordinacion: 0, decision_aprobacion_id: null, payload: { version_contrato: '2.0', advertencias: ordenadas } }; } }) };
  const servicio = crearDecisionesPropuestas({ obtenerDb: () => db, dependencias: () => ({}), decidir: async (entrada) => { llamadas++; assert.deepStrictEqual(entrada.advertencias_aceptadas, ordenadas); return { resultado: 'decision_registrada', tipo_evento: 'aprobacion', propuesta_id: ID, evento_id: ID, estado_anterior: 'pendiente_aprobacion', estado_nuevo: 'aprobada', version_coordinacion_nueva: 1, ocurrido_en: new Date(), actor: op.actor }; } });
  const cuerpo2 = { ...cuerpo, version_contrato_esperada: '2.0', advertencias_aceptadas: ordenadas };
  await assert.rejects(servicio.decidir('aprobacion', ID, { ...cuerpo2, advertencias_aceptadas: [] }, op), ErrorPropuestaCambio);
  assert.equal(llamadas, 0, 'la instantánea desactualizada no invoca el servicio');
  assert.ok(Object.hasOwn(proyeccion, 'payload.version_contrato') && Object.hasOwn(proyeccion, 'payload.advertencias'));
  const resultado = await servicio.decidir('aprobacion', ID, cuerpo2, op);
  assert.equal(resultado.decision.ya_registrada, false);
  assert.equal(llamadas, 1);
  console.log('Panel 2.0: body exacto, proyección mínima y advertencias desactualizadas bloqueadas antes del servicio: OK');
  console.log('Decisiones 1.0/2.0: validación estricta, CAS de versión/advertencias, detalles de evento y reenvíos exactos: OK');
})().catch((e) => { console.error(e); process.exitCode = 1; });
