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
const { crearLectorPropuestas } = require('../services/panel/lectura-propuestas');
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
      version_coordinacion_nueva: 2, ocurrido_en: T, actor: { tipo: 'sistema', identificador: 'aplicar-propuesta-v2' },
      detalle: { version_contrato: '2.0', resultado: 'exito', auditoria: structuredClone(auditoria), proceso_aplicador: { nombre: 'aplicar-propuesta-v2', version: '1' },
        adaptador: { nombre: 'migracion-colombia', version: '1' }, decision_aprobacion_id: decision }, intento_aplicacion_id: intento },
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
    // monitorCommands: la prueba del inicio inspecciona el readConcern que llega al driver.
    await mongoose.connect(rs.getUri('buscador_requisitos'), { monitorCommands: true });
    const comandos = [];
    mongoose.connection.getClient().on('commandStarted', ev => { if (ev.commandName === 'find' && ev.command.find === 'inicios_intento_aplicacion') comandos.push(ev.command); });
    const findsInicio = id => comandos.filter(c => c.filter?.intento_id === id);
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

    // 7b. H2.2: eventos 1.0 reales (constructor del 1.0) siguen guardándose con el modelo y el panel los lee
    // como antes (origen solo de detalle.comando, que la aplicación no tiene); nada privado en la respuesta.
    {
      const EventoPropuesta = mongoose.model('EventoPropuesta');
      const pid = uuid(), dec = uuid();
      await col('propuestas_cambio').insertOne({ propuesta_id: pid, estado: 'aplicada', version_coordinacion: 4, payload: {} });
      const idAtlas = { metodo: 'connection_status', usuario_atlas: 'atlas-privado', db_autenticacion: 'admin' };
      const ctxE = (version, extra = {}) => ({ ...ctx1, propuesta_id: pid, evento_id: uuid(), intento_id: uuid(), hash_esperado: H, version_esperada: version, decision_aprobacion_id_esperado: dec,
        identidad_operador: idAtlas, auditoria: { origen: 'comando_administrativo', operador: 'op', identidad: idAtlas, comando: { nombre: 'aplicar-propuesta', version: '1' } }, ...extra });
      const audPanel = { origen: 'panel', request_id: uuid(), operador: 'operador.panel', identidad: { metodo: 'oidc_google', sub: 'sub-privado-panel' }, comando: { nombre: 'panel-propuestas', version: '1' },
        instantanea: { propuesta_id: pid, estado_esperado: 'aprobada', payload_hash_esperado: H, version_coordinacion_esperada: 1, decision_aprobacion_id_esperado: dec } };
      const historico = A1.construirEvento(ctxE(2), 'conflicto', T, 'valor_actual_cambio', 'cambió'); delete historico.detalle.auditoria;
      const porPanel = A1.construirEvento(ctxE(1, { auditoria: audPanel, auditoria_panel: audPanel, identidad_operador: { metodo: 'oidc_google', sub: 'sub-privado-panel' } }), 'aplicacion', T, 'exito', null);
      const porComando = A1.construirEvento(ctxE(3), 'conflicto', T, 'identidad_requisito_cambio', 'identidad');
      // Estados ficticios para tres transiciones lineales de la misma propuesta (el panel solo lee).
      const docs = [porPanel, { ...historico, version_coordinacion_nueva: 3 }, { ...porComando, version_coordinacion_nueva: 4 }];
      for (const e of docs) await new EventoPropuesta(e).save();
      const vista = await crearLectorPropuestas({ obtenerDb: () => db }).detalle(pid, { identificador: 'lector', permisos: [] });
      assert.deepEqual(vista.eventos.map(e => [e.tipo_evento, e.origen, e.metodo_identidad, e.actor.identificador]), [
        ['aplicacion', null, 'oidc_google', 'aplicar-propuesta'],
        ['conflicto', null, 'connection_status', 'aplicar-propuesta'],
        ['conflicto', null, 'connection_status', 'aplicar-propuesta']
      ], '1.0: panel, histórico sin auditoría y comando');
      assert.deepEqual(Object.keys(vista.eventos[0]), ['evento_id', 'tipo_evento', 'estado_anterior', 'estado_nuevo', 'ocurrido_en', 'version_coordinacion_nueva', 'hash_contenido_referenciado',
        'actor', 'origen', 'metodo_identidad', 'motivo', 'intento_aplicacion_id'], 'forma del evento del panel sin cambios');
      const texto = JSON.stringify(vista);
      for (const p of ['sub-privado-panel', audPanel.request_id, 'usuario_atlas', 'atlas-privado', 'instantanea', 'auditoria', 'identidad_operador']) assert.ok(!texto.includes(p), `panel sin ${p}`);
    }

    // 7c. H2.2: eventos de aplicación y conflicto 2.0 (guardados con el modelo) exponen origen y método
    // desde las hojas seguras de detalle.auditoria; misma forma JSON, allowlists y nada privado.
    {
      const EventoPropuesta = mongoose.model('EventoPropuesta');
      const pid = uuid(), dec = uuid(), reqId = uuid();
      await col('propuestas_cambio').insertOne({ propuesta_id: pid, estado: 'conflicto', version_coordinacion: 6, payload: {} });
      const audPanel = v => ({ origen: 'panel', request_id: reqId, operador: 'aplicador.panel', identidad: { metodo: 'oidc_google', sub: 'sub-privado-v2' }, comando: { nombre: 'panel-propuestas', version: '1' },
        instantanea: { propuesta_id: pid, estado_esperado: 'aprobada', payload_hash_esperado: H, version_coordinacion_esperada: v - 1, decision_aprobacion_id_esperado: dec } });
      const audComando = { origen: 'comando_administrativo', operador: 'aplicador.cli', identidad: { metodo: 'connection_status', usuario_atlas: 'atlas-privado-v2', db_autenticacion: 'admin' }, comando: { nombre: 'aplicar-propuesta', version: '1' } };
      const ev2 = (tipo, v, auditoria) => ({ evento_id: uuid(), propuesta_id: pid, tipo_evento: tipo, estado_anterior: 'aprobada', estado_nuevo: tipo === 'aplicacion' ? 'aplicada' : 'conflicto',
        hash_contenido_referenciado: H, version_coordinacion_nueva: v, ocurrido_en: T, actor: { tipo: 'sistema', identificador: 'aplicar-propuesta-v2' }, ...(tipo === 'conflicto' ? { motivo: 'conflicto' } : {}),
        detalle: { version_contrato: '2.0', resultado: tipo === 'aplicacion' ? 'exito' : 'valor_actual_cambio', auditoria, proceso_aplicador: { nombre: 'aplicar-propuesta-v2', version: '1' },
          adaptador: { nombre: 'migracion-colombia', version: '1' }, decision_aprobacion_id: dec }, intento_aplicacion_id: uuid() });
      const decision2 = { evento_id: uuid(), propuesta_id: pid, tipo_evento: 'aprobacion', estado_anterior: 'pendiente_aprobacion', estado_nuevo: 'aprobada', hash_contenido_referenciado: H,
        version_coordinacion_nueva: 1, ocurrido_en: T, actor: { tipo: 'humano', identificador: 'aprobador' },
        detalle: { identidad_operador: { metodo: 'oidc_google', sub: 'sub-privado-aprobador' }, comando: { nombre: 'panel-propuestas', version: '1' }, version_contrato: '2.0', advertencias_aceptadas: [] } };
      for (const e of [decision2, ev2('aplicacion', 2, audPanel(2)), ev2('conflicto', 3, audPanel(3)), ev2('aplicacion', 4, audComando), ev2('conflicto', 5, audComando)]) await new EventoPropuesta(e).save();
      // No confiable (escrito sin el modelo): valores fuera de las allowlists siguen saliendo null.
      const raro = ev2('conflicto', 6, { ...audComando, comando: { nombre: '<script>', version: '1' }, identidad: { metodo: 'token', usuario_atlas: 'atlas-privado-v2' } });
      await col('eventos_propuesta').insertOne(raro);
      const vista = await crearLectorPropuestas({ obtenerDb: () => db }).detalle(pid, { identificador: 'lector', permisos: [] });
      assert.deepEqual(vista.eventos.map(e => [e.version_coordinacion_nueva, e.tipo_evento, e.origen, e.metodo_identidad, e.actor.tipo, e.actor.identificador]), [
        [1, 'aprobacion', 'panel-propuestas', 'oidc_google', 'humano', 'aprobador'],
        [2, 'aplicacion', 'panel-propuestas', 'oidc_google', 'sistema', 'aplicar-propuesta-v2'],
        [3, 'conflicto', 'panel-propuestas', 'oidc_google', 'sistema', 'aplicar-propuesta-v2'],
        [4, 'aplicacion', 'aplicar-propuesta', 'connection_status', 'sistema', 'aplicar-propuesta-v2'],
        [5, 'conflicto', 'aplicar-propuesta', 'connection_status', 'sistema', 'aplicar-propuesta-v2'],
        [6, 'conflicto', null, null, 'sistema', 'aplicar-propuesta-v2']
      ], '2.0: origen y método desde la auditoría; decisión 2.0 por su camino; allowlists conservadas');
      const CLAVES = ['evento_id', 'tipo_evento', 'estado_anterior', 'estado_nuevo', 'ocurrido_en', 'version_coordinacion_nueva', 'hash_contenido_referenciado', 'actor', 'origen', 'metodo_identidad', 'motivo', 'intento_aplicacion_id'];
      for (const e of vista.eventos) assert.deepEqual(Object.keys(e), CLAVES, 'forma JSON del evento intacta');
      const texto = JSON.stringify(vista);
      for (const p of ['sub-privado', reqId, 'usuario_atlas', 'atlas-privado', 'instantanea', 'auditoria', 'identidad_operador', 'aplicador.panel', 'aplicador.cli', 'migracion-colombia', '<script>', 'token']) {
        assert.ok(!texto.includes(p), `panel 2.0 sin ${p}`);
      }
    }

    // 7d. H3.1: registrarInicioV2. Insert independiente; una colisión de id solo confirma con el registro
    // completo; sin poder confirmarlo, incertidumbre. Nunca sobrescribe, cambia el id ni reintenta.
    {
      const V2 = require('../services/propuestas/aplicar-propuesta-v2');
      const d = documentos(), decision = d.intento.decision_aprobacion_id;
      const entrada = { propuesta_id: d.propuesta, estado_esperado: 'aprobada', payload_hash_esperado: H, version_coordinacion_esperada: 1, decision_aprobacion_id_esperado: decision };
      const ctxDe = (extra = {}) => ({ adaptador: { nombre: 'migracion-colombia', version: '1' }, auditoria: structuredClone(d.intento.auditoria),
        intento: { intento_id: uuid(), evento_id: uuid(), historial_id: uuid(), iniciado_en: T }, revalidaciones: [], ...extra });
      const leerIni = id => col('inicios_intento_aplicacion').find({ intento_id: id }).toArray();
      const SECRETO = 'mongodb://u:clave-secreta@h';
      const sinSecreto = (e, n) => assert.ok(!`${e?.message}\n${String(e)}`.includes('clave-secreta'), `${n}: mensaje sin secretos`);
      // Primero: se inserta tal cual (tipos BSON del modelo, sin conversiones).
      const ctx = ctxDe(), inicio = V2.construirInicioV2(entrada, ctx);
      assert.deepEqual(await V2.registrarInicioV2(inicio, P), { confirmado: true, causa_relectura: null });
      const [guardado] = await leerIni(inicio.intento_id);
      assert.deepEqual(comparable(guardado), comparable(inicio), 'inicio guardado completo');
      assert.ok(guardado.iniciado_en instanceof Date && typeof guardado.version_coordinacion_esperada === 'number', 'tipos conservados');
      // Repetido idéntico: E11000 + relectura exacta → confirmado, sin segundo documento.
      assert.deepEqual(await V2.registrarInicioV2(structuredClone(inicio), P), { confirmado: true, causa_relectura: 'duplicado' });
      assert.equal((await leerIni(inicio.intento_id)).length, 1);
      // Mismo id, otro inicio: inconsistencia; el original queda intacto.
      const otro = V2.construirInicioV2(entrada, ctxDe({ adaptador: { nombre: 'migracion-colombia', version: '2' }, intento: { ...ctx.intento } }));
      await assert.rejects(V2.registrarInicioV2(otro, P), e => e instanceof A1.ErrorInconsistencia, 'colisión con otro inicio');
      assert.deepEqual(comparable((await leerIni(inicio.intento_id))[0]), comparable(inicio), 'original sin sobrescribir');
      // El insert falla después de escribir (respuesta perdida): la relectura exacta lo confirma.
      const i2 = V2.construirInicioV2(entrada, ctxDe()); let llamadas = 0;
      const perdida = { ...P, insertarInicio: async x => { llamadas++; await P.insertarInicio(x); throw new MongoServerError({ message: SECRETO, errmsg: SECRETO, code: 91 }); } };
      assert.deepEqual(await V2.registrarInicioV2(i2, perdida), { confirmado: true, causa_relectura: 'error_insercion' });
      assert.equal(llamadas, 1, 'sin reintento');
      // El insert falla sin escribir: no se puede afirmar ausencia → incierto, sin reintentar ni escribir.
      for (const [n, leerInicio] of [['relectura vacía', P.leerInicio], ['relectura fallida', async () => { throw new MongoServerError({ message: SECRETO, errmsg: SECRETO, code: 6 }); }]]) {
        const i3 = V2.construirInicioV2(entrada, ctxDe()); let veces = 0;
        const deps = { ...P, leerInicio, insertarInicio: async () => { veces++; throw new MongoServerError({ message: SECRETO, errmsg: SECRETO, code: 91 }); } };
        let e = null;
        try { await V2.registrarInicioV2(i3, deps); } catch (x) { e = x; }
        assert.ok(e instanceof V2.ErrorInicioInciertoV2 && e.intento_id === i3.intento_id, `${n}: ${e}`);
        assert.equal(e instanceof A1.ErrorResultadoIncierto, false, `${n}: incertidumbre del inicio, distinta de la del intento terminado`);
        sinSecreto(e, n);
        assert.deepEqual([veces, (await leerIni(i3.intento_id)).length], [1, 0], `${n}: un solo intento de insert y nada escrito`);
        // La relectura real que no confirma se pidió por mayoría.
        // (el primer find es la relectura del servicio; el segundo, el de leerIni de esta prueba).
        if (leerInicio === P.leerInicio) assert.deepEqual(findsInicio(i3.intento_id).map(c => c.readConcern?.level), ['majority', undefined], `${n}: relectura con readConcern majority`);
      }
      // Opción enviada al driver: fuera de transacción, majority y sin transacción; dentro, la
      // sesión y el nivel de la transacción (snapshot), sin un readConcern propio de la operación.
      {
        const [g] = await leerIni(inicio.intento_id), antes = comandos.length;
        assert.deepEqual(await P.leerInicio(inicio.intento_id, null), g, 'lectura sin sesión');
        const fuera = comandos.slice(antes);
        assert.equal(fuera.length, 1);
        assert.deepEqual({ ...fuera[0].readConcern }, { level: 'majority' }, 'fuera de transacción: readConcern majority');
        assert.equal(fuera[0].txnNumber, undefined, 'fuera de transacción: sin txnNumber');
        let idSesion = null; const k = comandos.length;
        await mongoose.connection.transaction(async s => {
          idSesion = s.id.id.toString('hex');
          assert.deepEqual(await P.leerInicio(inicio.intento_id, s), g, 'lectura en la transacción');
        }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
        const dentro = comandos.slice(k);
        assert.equal(dentro.length, 1);
        assert.ok(dentro[0].txnNumber !== undefined && dentro[0].lsid.id.toString('hex') === idSesion, 'dentro: misma sesión y transacción');
        assert.deepEqual([dentro[0].readConcern?.level, dentro[0].readConcern && Object.keys(dentro[0].readConcern).filter(c => c !== 'level' && c !== 'afterClusterTime')], ['snapshot', []], 'dentro: nivel de la transacción, no majority');
        // Una sesión sin transacción activa no lee: ni por mayoría ni dentro del snapshot.
        const suelta = mongoose.connection.getClient().startSession();
        try { await assert.rejects(P.leerInicio(inicio.intento_id, suelta), TypeError, 'sesión sin transacción'); } finally { await suelta.endSession(); }
      }
      // Duplicado con la fecha guardada como TEXTO (dato ajeno, sin el modelo): mismo instante,
      // otro tipo BSON. No confirma: inconsistencia, el documento ajeno queda tal cual.
      {
        const i4 = V2.construirInicioV2(entrada, ctxDe());
        await col('inicios_intento_aplicacion').insertOne({ ...structuredClone(i4), iniciado_en: i4.iniciado_en.toISOString() });
        await assert.rejects(V2.registrarInicioV2(structuredClone(i4), P), e => e instanceof A1.ErrorInconsistencia, 'fecha guardada como texto no confirma');
        const guardados = await leerIni(i4.intento_id);
        assert.deepEqual([guardados.length, typeof guardados[0].iniciado_en], [1, 'string'], 'documento con texto intacto, sin segundo inicio');
        // Mismo caso con un número guardado como texto.
        const i5 = V2.construirInicioV2(entrada, ctxDe());
        await col('inicios_intento_aplicacion').insertOne({ ...structuredClone(i5), version_coordinacion_esperada: String(i5.version_coordinacion_esperada) });
        await assert.rejects(V2.registrarInicioV2(structuredClone(i5), P), e => e instanceof A1.ErrorInconsistencia, 'número guardado como texto no confirma');
      }
      // Inválido para el modelo: rechazo antes de escribir.
      const malo = { ...V2.construirInicioV2(entrada, ctxDe()), adaptador: { nombre: 'Adaptador libre', version: '1' } };
      await assert.rejects(V2.registrarInicioV2(malo, P), e => e instanceof A1.ErrorEntradaInvalida, 'inicio inválido');
      assert.equal((await leerIni(malo.intento_id)).length, 0, 'inicio inválido no escrito');
    }

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
