const assert = require('node:assert/strict');
const {
  validarEntrada, construirFiltroCas, construirEvento, decidirPropuesta, ErrorEntradaInvalida
} = require('../services/propuestas/decidir-propuesta');
const {
  construirEntrada, coincideLoVisto, esReenvioIdentico, motivosIntegridadV2, ErrorCuerpoInvalido, ErrorPropuestaCambio, ErrorPropuestaNoDecidible, crearDecisionesPropuestas
} = require('../services/panel/decisiones-propuestas');
const { ADVERTENCIAS, ALGORITMO_HECHOS_HASH, hashHechos, crearSobreRequisitoV2 } = require('../services/propuestas/payload-requisito-v2');
const lectorPropuestas = require('../services/panel/lectura-propuestas');

const ID = '22222222-2222-4222-8222-222222222222';
const HASH = 'a'.repeat(64);
const base = (tipo_evento = 'aprobacion', extra = {}) => ({ tipo_evento, propuesta_id: ID, estado_esperado: 'pendiente_aprobacion', payload_hash_esperado: HASH, version_coordinacion_esperada: 0, decision_aprobacion_id_esperado: null, ...extra });
const op = { actor: { tipo: 'humano', identificador: 'operador' }, identidad_operador: { metodo: 'google_oidc', sub: '123' } };
const ordenadas = [...ADVERTENCIAS].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
const fallaEntrada = (e) => assert.throws(() => validarEntrada(e), ErrorEntradaInvalida);
const valor = (valor) => ({ presente: true, bson_tipo: 'string', valor });
const ausente = { presente: false, bson_tipo: 'ausente', valor: null };
const foto = { obligatorio: valor('si'), recomendado: ausente, descripcion: valor('Descripción'), fuente: valor('Migración Colombia'), link: valor('https://www.migracioncolombia.gov.co/checkmig'), plazo_antes_del_vuelo: ausente, costo: ausente, fecha_verificacion: valor('2026-10-16'), estado: valor('confirmado') };
const hechos = { obligatorio: 'opcional' };
const sobre2 = crearSobreRequisitoV2({
  fecha_propuesta: '2026-10-16T18:00:00.000Z', destino_id: '111111111111111111111111', requisito_id: '222222222222222222222222',
  identidad_requisito: { tipo: 'formulario_digital', nombre: valor('Check-Mig') }, run_id_origen: ID, propuesta_id: ID,
  instantanea_anterior: foto, cambios: [{ campo: 'obligatorio', propuesto: valor('no') }],
  fuentes: [{ nombre: 'Migración Colombia', url: 'https://www.migracioncolombia.gov.co/checkmig', capturado_en: '2026-10-16T17:00:00.000Z', hechos, algoritmo_hechos_hash: ALGORITMO_HECHOS_HASH, hechos_hash: hashHechos(hechos) }],
  advertencias: ['quita_obligatoriedad']
});

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
assert.equal(Object.keys(construirEntrada('aprobacion', ID, { ...cuerpo, version_contrato_esperada: '1.0' })).includes('version_contrato_esperada'), false);
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
assert.deepStrictEqual(motivosIntegridadV2(sobre2), []);
assert.strictEqual(motivosIntegridadV2, lectorPropuestas.motivosIntegridadV2, 'GET y POST comparten la misma función 2.0');
assert.deepStrictEqual(motivosIntegridadV2({ ...sobre2, payload_hash: '0'.repeat(64) }), ['payload_2_invalido']);
const payloadIncompleto = structuredClone(sobre2.payload); delete payloadIncompleto.fuentes;
const payloadConExtra = structuredClone(sobre2.payload); payloadConExtra.extra = true;
for (const invalido of [
  { ...sobre2, payload: payloadIncompleto },
  { ...sobre2, payload: payloadConExtra },
  { ...sobre2, algoritmo_hash: 'sha512' },
  { ...sobre2, payload_hash: 'f'.repeat(64) }
]) assert.deepStrictEqual(motivosIntegridadV2(invalido), ['payload_2_invalido']);
assert.throws(() => motivosIntegridadV2({ get algoritmo_canonicalizacion() { throw new Error('bug inesperado simulado'); } }), /bug inesperado simulado/);

(async () => {
  const invalidaCompartida = { ...sobre2, payload: { ...sobre2.payload, campo: 'costo' } };
  const integridadGet = await lectorPropuestas.evaluarIntegridad({ collection: () => ({ findOne: async () => null }) }, invalidaCompartida);
  assert.ok(integridadGet.motivos.includes('payload_2_invalido'), 'el lector GET informa el mismo motivo 2.0');
  const accionesGet = lectorPropuestas.calcularAcciones({ ...integridadGet, estado: 'pendiente_aprobacion', operador: { permisos: ['decidir'] }, motivosAprobacion: integridadGet.motivos });
  assert.ok(accionesGet.acciones_bloqueadas.aprobar.includes('payload_2_invalido'));
  let dependenciasTocadas = 0;
  const deps = { resolverIdentidad: async () => { dependenciasTocadas++; }, verificarIndices: async () => { dependenciasTocadas++; } };
  await assert.rejects(decidirPropuesta(base('aprobacion', { version_contrato_esperada: '2.0' }), deps), ErrorEntradaInvalida);
  await assert.rejects(decidirPropuesta(base('aprobacion', { version_contrato_esperada: '2.0', advertencias_aceptadas: ['quita_obligatoriedad', 'degrada_estado_verificacion'] }), deps), ErrorEntradaInvalida);
  assert.equal(dependenciasTocadas, 0, 'entradas inválidas no alcanzan identidad, índices ni escrituras');
  let llamadas = 0;
  let proyeccion;
  const completa2 = {
    propuesta_id: ID,
    destino_id: sobre2.payload.destino_id,
    requisito_id: sobre2.payload.requisito_id,
    run_id_origen: sobre2.payload.run_id_origen,
    campo: 'requisito',
    estado: 'pendiente_aprobacion',
    payload_hash: sobre2.payload_hash,
    version_coordinacion: 0,
    decision_aprobacion_id: null,
    ultimo_evento_id: null,
    algoritmo_canonicalizacion: sobre2.algoritmo_canonicalizacion,
    algoritmo_hash: sobre2.algoritmo_hash,
    payload: sobre2.payload
  };
  const requisito2 = { _id: sobre2.payload.requisito_id, tipo: 'formulario_digital', nombre: 'Check-Mig', obligatorio: 'si', descripcion: 'Descripción', fuente: 'Migración Colombia', link: 'https://www.migracioncolombia.gov.co/checkmig', fecha_verificacion: '2026-10-16', estado: 'confirmado' };
  const destino2 = { _id: sobre2.payload.destino_id, pais: 'Colombia', codigo_iso: 'CO', requisitos: [requisito2] };
  const parcial2 = { propuesta_id: ID, estado: 'pendiente_aprobacion', payload_hash: sobre2.payload_hash, version_coordinacion: 0, decision_aprobacion_id: null, ultimo_evento_id: null, payload: { version_contrato: '2.0', advertencias: ['quita_obligatoriedad'] } };
  const db = { collection: (nombre) => ({ findOne: async (_f, options) => { if (nombre === 'destinos') return destino2; if (options?.projection) { proyeccion = options.projection; return parcial2; } return completa2; } }) };
  const integridadValida = await lectorPropuestas.evaluarIntegridad(db, completa2);
  assert.deepStrictEqual(integridadValida.motivos, [], 'GET y POST consideran íntegra la misma propuesta 2.0');
  assert.deepStrictEqual(lectorPropuestas.resumenRequisitoV2(completa2.payload), {
    completo: true,
    cambios: [{ campo: 'obligatorio', anterior: { presente: true, bson_tipo: 'string', valor: 'si' }, propuesto: { presente: true, bson_tipo: 'string', valor: 'no' } }],
    advertencias: ['quita_obligatoriedad']
  }, 'el detalle 2.0 expone solo cambios y advertencias por lista blanca');
  assert.equal(JSON.stringify(lectorPropuestas.resumenRequisitoV2(completa2.payload)).includes('identidad_requisito'), false);
  assert.equal(JSON.stringify(lectorPropuestas.resumenRequisitoV2(completa2.payload)).includes('run_id_origen'), false);
  const resumenLargo = lectorPropuestas.resumenRequisitoV2({ ...completa2.payload, cambios: [{ campo: 'descripcion', propuesto: { presente: true, bson_tipo: 'string', valor: 'x'.repeat(10_001) } }] });
  assert.deepStrictEqual(resumenLargo, { completo: false, cambios: [], advertencias: ['quita_obligatoriedad'] }, 'un cambio que no puede mostrarse queda marcado como incompleto');
  const proyeccionListado = lectorPropuestas.consultaListado({ estados: ['pendiente_aprobacion'], limite: 20, despuesDe: null }).opciones.projection;
  const proyectada2 = Object.fromEntries(Object.keys(proyeccionListado).filter((k) => Object.hasOwn(completa2, k)).map((k) => [k, completa2[k]]));
  assert.deepStrictEqual(lectorPropuestas.problemasConsistenciaV2(proyectada2), [], 'el documento 2.0 proyectado por el listado conserva la consistencia');
  assert.deepStrictEqual(lectorPropuestas.resumenListado(proyectada2).alertas, [], 'el listado no marca una 2.0 válida como inconsistente');
  const accionesValidas = lectorPropuestas.calcularAcciones({ ...integridadValida, estado: 'pendiente_aprobacion', operador: { permisos: ['decidir'] }, motivosAprobacion: integridadValida.motivos });
  assert.ok(accionesValidas.acciones_permitidas.includes('aprobar'));
  const accionesAplicar2 = lectorPropuestas.calcularAcciones({ ...integridadValida, estado: 'aprobada', operador: { permisos: ['decidir', 'aplicar'] }, version: 1, versionContrato: '2.0', decisionAprobacionId: ID, decisionAprobacionValida: true, motivosAprobacion: [] });
  assert.ok(!accionesAplicar2.acciones_permitidas.includes('aplicar'));
  assert.ok(accionesAplicar2.acciones_bloqueadas.aplicar.includes('contrato_2_no_aplicable'));
  for (const [campo, valor] of [
    ['propuesta_id', '33333333-3333-4333-8333-333333333333'],
    ['destino_id', '333333333333333333333333'],
    ['requisito_id', '333333333333333333333333'],
    ['run_id_origen', '33333333-3333-4333-8333-333333333333'],
    ['campo', 'costo']
  ]) {
    const divergente = { ...completa2, [campo]: valor };
    const evaluada = await lectorPropuestas.evaluarIntegridad(db, divergente);
    assert.ok(evaluada.motivos.includes('datos_inconsistentes'), `${campo} externo distinto bloquea 2.0`);
  }
  for (const clave of ['identidad_requisito', 'instantanea_anterior']) {
    const payload = structuredClone(completa2.payload);
    delete payload[clave];
    let lecturasDestino = 0;
    const sinComparar = { collection: (nombre) => ({ findOne: async () => { if (nombre === 'destinos') lecturasDestino++; return destino2; } }) };
    let evaluada;
    await assert.doesNotReject(async () => { evaluada = await lectorPropuestas.evaluarIntegridad(sinComparar, { ...completa2, payload }); });
    assert.ok(evaluada.motivos.includes('payload_2_invalido'), `${clave} ausente se bloquea como payload inválido`);
    assert.equal(lecturasDestino, 0, `${clave} ausente no compara el requisito vivo`);
  }
  const escenariosVivos = [
    ['identidad modificada', { ...requisito2, tipo: 'visa' }, 'requisito_no_coincide'],
    ['campo de instantánea modificado', { ...requisito2, descripcion: 'Otra descripción' }, 'valor_actual_cambio'],
    ['costo modificado', { ...requisito2, costo: 'COP 1' }, 'valor_actual_cambio'],
    ['presencia y tipo BSON modificados', { ...requisito2, recomendado: null }, 'valor_actual_cambio'],
    ['requisito no capturable', { ...requisito2, descripcion: new Date('2026-10-16T00:00:00Z') }, 'requisito_no_coincide']
  ];
  for (const [nombre, requisito, motivo] of escenariosVivos) {
    const dbEscenario = { collection: () => ({ findOne: async () => ({ ...destino2, requisitos: [requisito] }) }) };
    const evaluada = await lectorPropuestas.evaluarIntegridad(dbEscenario, completa2);
    assert.ok(evaluada.motivos.includes(motivo), nombre);
  }
  const sinDestino = await lectorPropuestas.evaluarIntegridad({ collection: () => ({ findOne: async () => null }) }, completa2);
  assert.ok(sinDestino.motivos.includes('requisito_no_coincide'), 'destino ausente no se considera coincidente');
  const duplicado = await lectorPropuestas.evaluarIntegridad({ collection: () => ({ findOne: async () => ({ ...destino2, requisitos: [requisito2, { ...requisito2 }] }) }) }, completa2);
  assert.ok(duplicado.motivos.includes('requisito_no_coincide'), 'requisito duplicado no se considera coincidente');
  const servicio = crearDecisionesPropuestas({ obtenerDb: () => db, dependencias: () => ({}), decidir: async (entrada) => { llamadas++; assert.deepStrictEqual(entrada.advertencias_aceptadas, ['quita_obligatoriedad']); return { resultado: 'decision_registrada', tipo_evento: 'aprobacion', propuesta_id: ID, evento_id: ID, estado_anterior: 'pendiente_aprobacion', estado_nuevo: 'aprobada', version_coordinacion_nueva: 1, ocurrido_en: new Date(), actor: op.actor }; } });
  const cuerpo2 = { ...cuerpo, payload_hash_esperado: sobre2.payload_hash, version_contrato_esperada: '2.0', advertencias_aceptadas: ['quita_obligatoriedad'] };
  await assert.rejects(servicio.decidir('aprobacion', ID, { ...cuerpo2, advertencias_aceptadas: [] }, op), ErrorPropuestaCambio);
  assert.equal(llamadas, 0, 'la instantánea desactualizada no invoca el servicio');
  assert.ok(Object.hasOwn(proyeccion, 'payload.version_contrato') && Object.hasOwn(proyeccion, 'payload.advertencias'));
  const resultado = await servicio.decidir('aprobacion', ID, cuerpo2, op);
  assert.equal(resultado.decision.ya_registrada, false);
  assert.equal(llamadas, 1);
  const dbInvalida = { collection: (nombre) => ({ findOne: async (_f, options) => nombre === 'destinos' ? destino2 : options?.projection ? parcial2 : { ...completa2, payload: { ...completa2.payload, campo: 'costo' } } }) };
  const servicioInvalido = crearDecisionesPropuestas({ obtenerDb: () => dbInvalida, dependencias: () => ({}), decidir: async () => { throw new Error('no debe decidir'); } });
  await assert.rejects(servicioInvalido.decidir('aprobacion', ID, cuerpo2, op), (err) => err instanceof ErrorPropuestaNoDecidible && err.motivos.includes('payload_2_invalido'));
  let decisionesTrasCambio = 0;
  const dbCambioSegundaLectura = { collection: (nombre) => ({ findOne: async (_f, options) => nombre === 'destinos' ? destino2 : options?.projection ? parcial2 : { ...completa2, version_coordinacion: 1 } }) };
  const servicioCambio = crearDecisionesPropuestas({ obtenerDb: () => dbCambioSegundaLectura, dependencias: () => ({}), decidir: async () => { decisionesTrasCambio++; } });
  await assert.rejects(servicioCambio.decidir('aprobacion', ID, cuerpo2, op), ErrorPropuestaCambio);
  assert.equal(decisionesTrasCambio, 0, 'un cambio entre ambas lecturas no llega al servicio de escritura');
  let rechazos = 0;
  const servicioRechazo = crearDecisionesPropuestas({ obtenerDb: () => dbInvalida, dependencias: () => ({}), decidir: async () => { rechazos++; return { resultado: 'decision_registrada', tipo_evento: 'rechazo', propuesta_id: ID, evento_id: ID, estado_anterior: 'pendiente_aprobacion', estado_nuevo: 'rechazada', version_coordinacion_nueva: 1, ocurrido_en: new Date(), actor: op.actor }; } });
  const rechazo2 = { ...cuerpo, payload_hash_esperado: sobre2.payload_hash, version_contrato_esperada: '2.0', motivo: 'La propuesta no corresponde.' };
  let resultadoRechazo;
  await assert.doesNotReject(async () => { resultadoRechazo = await servicioRechazo.decidir('rechazo', ID, rechazo2, op); });
  assert.equal(resultadoRechazo.decision.estado_nuevo, 'rechazada');
  assert.equal(rechazos, 1, 'el rechazo 2.0 no valida la integridad del payload');
  console.log('Panel 2.0: body exacto, proyección mínima y advertencias desactualizadas bloqueadas antes del servicio: OK');
  console.log('Decisiones 1.0/2.0: validación estricta, CAS de versión/advertencias, detalles de evento y reenvíos exactos: OK');
})().catch((e) => { console.error(e); process.exitCode = 1; });
