// H2.1 — persistencia real de auditoría 2.0 en Mongo efímero (replica set).
const assert = require('node:assert/strict');
if (!globalThis.__SOLO_LOOPBACK__) throw new Error('Se requiere preload-solo-loopback');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { ObjectId, MongoServerError } = require('mongodb');
const { crearPersistenciaV2 } = require('../services/propuestas/persistencia-aplicacion-v2');
const { INDICES_APLICACION } = require('../services/propuestas/indices-propuestas');
const { INDICE_TRANSVERSAL } = require('../services/propuestas/aplicar-propuesta-v2');
const A1 = require('../services/propuestas/aplicar-propuesta');
require('../models/propuestas/InicioIntentoAplicacion.model');

const uuid = () => crypto.randomUUID();
const T = new Date('2026-10-27T02:30:00.000Z'), H = 'c'.repeat(64);
const valor = v => ({ presente: true, bson_tipo: 'string', valor: v }), ausente = { presente: false, bson_tipo: 'ausente', valor: null };
const COLECCIONES = ['intentos_aplicacion', 'historial_cambios', 'eventos_propuesta', 'inicios_intento_aplicacion', 'propuestas_cambio'];

function documentos() {
  const propuesta = uuid(), decision = uuid(), intento = uuid(), historial = uuid(), evento = uuid();
  const auditoria = { origen: 'panel', request_id: uuid(), operador: 'aplicador', identidad: { metodo: 'oidc_google', sub: 'sub-apl' }, comando: { nombre: 'panel-propuestas', version: '1' },
    instantanea: { propuesta_id: propuesta, estado_esperado: 'aprobada', payload_hash_esperado: H, version_coordinacion_esperada: 1, decision_aprobacion_id_esperado: decision } };
  const base = { version_contrato: '2.0', propuesta_id: propuesta, operador: { tipo: 'humano', identificador: 'aplicador' }, identidad_operador: { metodo: 'oidc_google', sub: 'sub-apl' }, auditoria,
    aprobacion: { evento_id: decision, actor: { tipo: 'humano', identificador: 'aprobador' }, identidad_operador: { metodo: 'oidc_google', sub: 'sub-apr' }, ocurrido_en: T },
    proceso_aplicador: { nombre: 'aplicar-propuesta-v2', version: '1' }, adaptador: { nombre: 'migracion-colombia', version: '1' },
    hash_contenido_referenciado: H, version_coordinacion_esperada: 1, decision_aprobacion_id: decision, iniciado_en: T, finalizado_en: T };
  const revs = [{ url: 'https://www.migracioncolombia.gov.co/checkmig', fuente_nombre: 'Migración Colombia', hechos_hash: 'd'.repeat(64), revalidada_en: T }];
  return {
    propuesta,
    intento: { intento_id: intento, ...base, resultado: 'exito', revalidaciones: revs, historial_id: historial, fecha_verificacion: '2026-10-26' },
    historial: { historial_id: historial, version_contrato: '2.0', destino_id: String(new ObjectId()), requisito_id: String(new ObjectId()), campo: 'requisito',
      cambios: [{ campo: 'link', anterior: valor('https://www.migracioncolombia.gov.co/checkmig'), nuevo: { ...ausente } }, { campo: 'obligatorio', anterior: valor('si'), nuevo: valor('no') }],
      fecha_verificacion: { anterior: valor('2026-08-18'), nueva: valor('2026-10-26') }, aplicado_en: T, propuesta_id: propuesta, decision_aprobacion_id: decision, intento_aplicacion_id: intento },
    evento: { evento_id: evento, propuesta_id: propuesta, tipo_evento: 'aplicacion', estado_anterior: 'aprobada', estado_nuevo: 'aplicada', hash_contenido_referenciado: H,
      version_coordinacion_nueva: 2, ocurrido_en: T, actor: { tipo: 'sistema', identificador: 'aplicar-propuesta-v2' }, detalle: { resultado: 'exito', version_contrato: '2.0' }, intento_aplicacion_id: intento },
    abortada: { intento_id: uuid(), ...base, resultado: 'escritura_abortada', etapa_fallo: 'escritura_aplicacion', revalidaciones: revs, error_externo: 'red', error_mensaje: 'abortada' }
  };
}
// Forma comparable de lo guardado: sin _id/__v, ObjectId → hex, Date → ISO.
const comparable = v => v instanceof Date ? v.toISOString() : v?._bsontype === 'ObjectId' ? v.toHexString() : Array.isArray(v) ? v.map(comparable)
  : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== '_id' && k !== '__v').map(([k, x]) => [k, comparable(x)])) : v;
const transitorio = () => new MongoServerError({ message: 'transitorio', errmsg: 'transitorio', code: 112, codeName: 'WriteConflict', errorLabels: ['TransientTransactionError'] });

(async () => {
  let rs;
  try {
    rs = await MongoMemoryReplSet.create({ binary: { version: '8.0.32' }, replSet: { count: 1 } });
    // autoIndex por defecto de la conexión: los esquemas de auditoría (autoIndex: false) no deben crear índices.
    await mongoose.connect(rs.getUri('buscador_requisitos'));
    const db = mongoose.connection.db, col = n => db.collection(n);
    for (const s of [...INDICES_APLICACION, INDICE_TRANSVERSAL]) {
      await col(s.coleccion).createIndex(s.clave, { name: s.nombre, unique: true, ...(s.partialFilterExpression ? { partialFilterExpression: s.partialFilterExpression } : {}) });
    }
    await col('inicios_intento_aplicacion').createIndex({ propuesta_id: 1, iniciado_en: -1 });
    const indices = async () => JSON.stringify(await Promise.all(COLECCIONES.map(async c => [c, (await col(c).indexes()).map(i => ({ name: i.name, key: i.key, unique: !!i.unique, pfe: i.partialFilterExpression ?? null })).sort((a, b) => a.name.localeCompare(b.name))])));
    const indicesAntes = await indices();
    const P = crearPersistenciaV2();
    const tx = fn => mongoose.connection.transaction(fn, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    const contar = async d => [await col('historial_cambios').countDocuments({ propuesta_id: d.propuesta }), await col('intentos_aplicacion').countDocuments({ propuesta_id: d.propuesta }),
      await col('eventos_propuesta').countDocuments({ propuesta_id: d.propuesta })];

    // 1. Commit: documentos completos tal como entraron (sin descartes ni [] implícitos).
    const d1 = documentos();
    await tx(async s => { await P.insertarHistorial(d1.historial, s); await P.insertarIntento(d1.intento, s); await P.insertarEvento(d1.evento, s); });
    assert.deepEqual(comparable(await col('intentos_aplicacion').findOne({ intento_id: d1.intento.intento_id })), comparable(d1.intento), 'intento guardado completo');
    assert.deepEqual(comparable(await col('historial_cambios').findOne({ historial_id: d1.historial.historial_id })), comparable(d1.historial), 'historial guardado completo');
    assert.deepEqual(comparable(await col('eventos_propuesta').findOne({ evento_id: d1.evento.evento_id })), comparable(d1.evento), 'evento guardado completo');
    assert.equal(typeof (await col('intentos_aplicacion').findOne({ intento_id: d1.intento.intento_id })).fecha_verificacion, 'string', 'fecha BSON string');
    assert.ok((await col('historial_cambios').findOne({ historial_id: d1.historial.historial_id })).destino_id instanceof ObjectId, 'destino_id como en el 1.0');

    // 2. Rollback completo ante un fallo entre escrituras.
    const d2 = documentos();
    // Las tres escrituras ocurren antes del fallo: ninguna puede quedar fuera de la sesión.
    await assert.rejects(tx(async s => { await P.insertarHistorial(d2.historial, s); await P.insertarIntento(d2.intento, s); await P.insertarEvento(d2.evento, s); throw new Error('fallo entre escrituras'); }), /fallo entre escrituras/);
    assert.deepEqual(await contar(d2), [0, 0, 0], 'nada sobrevive al rollback');

    // 3. Reintento del callback: instancias nuevas, sin duplicados (y sin chocar con __v al restaurar).
    const d3 = documentos(); let vueltas = 0;
    await tx(async s => { vueltas++; await P.insertarHistorial(d3.historial, s); await P.insertarIntento(d3.intento, s); if (vueltas === 1) throw transitorio(); await P.insertarEvento(d3.evento, s); });
    assert.equal(vueltas, 2);
    assert.deepEqual(await contar(d3), [1, 1, 1], 'una sola auditoría tras el reintento');
    // ejecutarTransaccion es inyectable: con withTransaction del driver Mongoose no restaura el estado de
    // los documentos, así que solo una instancia nueva por llamada sirve en el reintento.
    const d3b = documentos(); let vueltasB = 0;
    const sesion = await mongoose.startSession();
    try {
      await assert.doesNotReject(sesion.withTransaction(async s => { vueltasB++; await P.insertarHistorial(d3b.historial, s); await P.insertarIntento(d3b.intento, s); if (vueltasB === 1) throw transitorio(); await P.insertarEvento(d3b.evento, s); },
        { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } }), 'reintento con withTransaction del driver');
    } finally { await sesion.endSession(); }
    assert.equal(vueltasB, 2);
    assert.deepEqual(await contar(d3b), [1, 1, 1], 'una sola auditoría tras el reintento del driver');

    // 4. Toda escritura transaccional exige la sesión de una transacción activa.
    const d4 = documentos();
    await assert.rejects(P.insertarHistorial(d4.historial), TypeError);
    await assert.rejects(P.insertarIntento(d4.intento, undefined), TypeError);
    const suelta = await mongoose.startSession();
    try { await assert.rejects(P.insertarEvento(d4.evento, suelta), TypeError, 'sesión sin transacción'); } finally { await suelta.endSession(); }
    assert.deepEqual(await contar(d4), [0, 0, 0]);

    // 5. El registro independiente queda fuera de la transacción (sobrevive a su rollback).
    const d5 = documentos();
    await assert.rejects(tx(async s => { await P.insertarHistorial(d5.historial, s); await P.insertarIntentoIndependiente(d5.abortada); throw new Error('rollback'); }), /rollback/);
    assert.equal(await col('historial_cambios').countDocuments({ propuesta_id: d5.propuesta }), 0);
    assert.equal(await col('intentos_aplicacion').countDocuments({ intento_id: d5.abortada.intento_id }), 1, 'independiente persistido');

    // 6. strict: claves desconocidas (también anidadas) y conversiones silenciosas se rechazan sin escribir.
    const d6 = documentos();
    for (const [n, f] of [
      ['clave raíz', () => P.insertarIntentoIndependiente({ ...d6.abortada, intruso: 1 })],
      ['clave anidada', () => P.insertarIntentoIndependiente({ ...d6.abortada, revalidaciones: [{ ...d6.abortada.revalidaciones[0], intruso: 1 }] })],
      ['Date en path String', () => P.insertarIntentoIndependiente({ ...d6.abortada, error_mensaje: new Date() })]
    ]) await assert.rejects(f(), e => e?.name === 'StrictModeError', n);
    await assert.rejects(P.insertarIntentoIndependiente({ ...d6.abortada, revalidaciones: undefined, etapa_fallo: 'escritura_aplicacion' }), undefined, 'abortada sin revalidaciones');
    assert.equal(await col('intentos_aplicacion').countDocuments({ propuesta_id: d6.propuesta }), 0, 'ningún documento inválido persistido');

    // 6b. Mixed: una función anidada (Mongoose la conserva, Mongo la descartaría) o un undefined desconocido
    // se rechazan antes de escribir, en la transacción y fuera de ella; los tipos legítimos se guardan con su tipo.
    const d6b = documentos();
    const conflictoDe = detalle => ({ ...d6b.abortada, intento_id: uuid(), etapa_fallo: 'transicion_por_fallo', resultado_no_registrado: 'valor_actual_cambio',
      conflicto: { categoria: 'claves_desconocidas', detalle } });
    const conFuncion = conflictoDe({ dato: 'conservar', evidencia: () => 'dato perdido' });
    await assert.rejects(P.insertarIntentoIndependiente(conFuncion), e => e?.name === 'StrictModeError' && /tipos no persistibles/.test(e.message), 'función anidada: independiente');
    await assert.rejects(tx(s => P.insertarIntento(conflictoDe({ dato: 'conservar', evidencia: () => 'x' }), s)), e => e?.name === 'StrictModeError', 'función anidada: en transacción');
    await assert.rejects(P.insertarIntentoIndependiente(conflictoDe({ dato: 'conservar', extra: undefined })), e => e?.name === 'StrictModeError', 'undefined en Mixed');
    await assert.rejects(P.insertarIntentoIndependiente({ ...d6b.abortada, intento_id: uuid(), revalidaciones: [{ ...d6b.abortada.revalidaciones[0], intruso: undefined }] }), e => e?.name === 'StrictModeError', 'undefined desconocido anidado');
    assert.equal(await col('intentos_aplicacion').countDocuments({ propuesta_id: d6b.propuesta }), 0, 'ninguna escritura de los rechazados');
    const legitimo = conflictoDe({ visto_en: T, destino: new ObjectId(), 'a.b': 1, vacio: {}, lista: [1, 'x', null], decimal: 1.5, bandera: false, nulo: null });
    await P.insertarIntentoIndependiente(legitimo);
    const guardado = (await col('intentos_aplicacion').findOne({ intento_id: legitimo.intento_id })).conflicto.detalle;
    assert.ok(guardado.visto_en instanceof Date && guardado.destino instanceof ObjectId, 'Date y ObjectId conservan su tipo BSON');
    assert.deepEqual(comparable(guardado), comparable(legitimo.conflicto.detalle), 'Mixed legítimo guardado completo');

    // 7. Un 1.0 guardado por el modelo no gana campos 2.0 ni [] implícitos.
    const IntentoAplicacion = mongoose.model('IntentoAplicacion');
    const ctx1 = { intento_id: uuid(), propuesta_id: uuid(), operador: { tipo: 'humano', identificador: 'op' }, adaptador: { nombre: 'govuk-uk-eta', version: '1' }, hash_leido: H, version_esperada: 0,
      decision_aprobacion_id_esperado: null, iniciado_en: T,
      auditoria: { origen: 'comando_administrativo', operador: 'op', identidad: { metodo: 'connection_status', usuario_atlas: 'u', db_autenticacion: 'admin' }, comando: { nombre: 'aplicar-propuesta', version: '1' } } };
    const doc1 = A1.construirIntento(ctx1, { resultado: 'propuesta_no_aplicable', etapa_fallo: 'precondiciones_propuesta', finalizado_en: T, evidencia_fresca: { precondiciones: [] }, error_mensaje: 'x' });
    await new IntentoAplicacion(doc1).save();
    const crudo1 = await col('intentos_aplicacion').findOne({ intento_id: ctx1.intento_id });
    for (const c of ['version_contrato', 'revalidaciones', 'precondiciones', 'aprobacion', 'conflicto', 'fecha_verificacion', 'error_externo', 'identidad_operador']) assert.equal(Object.hasOwn(crudo1, c), false, `1.0 sin ${c}`);

    // 8. Índices intactos: los modelos (autoIndex: false) no crearon ni cambiaron ninguno. Se espera init()
    // (donde Mongoose crearía los índices) y se compara con el inventario exacto creado por esta prueba,
    // porque la foto «antes» se toma ya conectados.
    await Promise.all(['IntentoAplicacion', 'HistorialCambio', 'EventoPropuesta', 'InicioIntentoAplicacion'].map(n => mongoose.model(n).init()));
    assert.equal(await indices(), indicesAntes, 'listIndexes igual antes y después');
    const creados = [...INDICES_APLICACION, INDICE_TRANSVERSAL, { coleccion: 'inicios_intento_aplicacion', nombre: 'propuesta_id_1_iniciado_en_-1' }];
    for (const c of COLECCIONES) {
      assert.deepEqual((await col(c).indexes()).map(i => i.name).sort(), ['_id_', ...creados.filter(s => s.coleccion === c).map(s => s.nombre)].sort(), `índices exactos en ${c}`);
    }
    console.log('Persistencia 2.0: commit completo, rollback, reintento, sesión obligatoria, registro independiente, strict anidado, 1.0 intacto e índices sin cambios: OK');
  } finally { await mongoose.disconnect(); await rs?.stop({ doCleanup: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
