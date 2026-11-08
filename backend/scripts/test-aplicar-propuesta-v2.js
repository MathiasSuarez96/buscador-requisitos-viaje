// H1: servicio aislado de aplicación 2.0 contra Mongo efímero (replica set).
// Las aprobaciones se construyen con las funciones reales de decidir-propuesta;
// los persistidores de prueba escriben en colecciones nativas con los índices
// de aplicación y el transversal creados. Nada toca Atlas.
const assert = require('node:assert/strict');
if (!globalThis.__SOLO_LOOPBACK__) throw new Error('Se requiere preload-solo-loopback');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { MongoClient, ObjectId, MongoServerError, MongoNetworkError } = require('mongodb');
const Destino = require('../models/Destino.model');
const V2 = require('../services/propuestas/aplicar-propuesta-v2');
const { crearPersistenciaV2 } = require('../services/propuestas/persistencia-aplicacion-v2');
const A1 = require('../services/propuestas/aplicar-propuesta');
const { crearLectorPropuestas } = require('../services/panel/lectura-propuestas');
const D = require('../services/propuestas/decidir-propuesta');
const { crearSobreRequisitoV2, hashHechos, ALGORITMO_HECHOS_HASH } = require('../services/propuestas/payload-requisito-v2');
const { capturarIdentidadEInstantanea } = require('../services/propuestas/contrato-requisito-v2');
const { INDICES_APLICACION, ErrorPrecondicionIndices } = require('../services/propuestas/indices-propuestas');
const { hashSobreCanonico } = require('../services/propuestas/canonicalizacion-propuestas');

// 02:30 UTC del 27/10 es 23:30 del 26/10 en Montevideo.
const T = new Date('2026-10-27T02:30:00.000Z'), FECHA = '2026-10-26';
const COLOMBIA = '6a87828da8282a4aa6ddfbd4', CHECKMIG = '6aaddd0e9f54309f9d82727b';
const valor = v => ({ presente: true, bson_tipo: 'string', valor: v });
const ausente = { presente: false, bson_tipo: 'ausente', valor: null };
const uuid = () => crypto.randomUUID();
const hechos = { obligatorio: false, formulario: 'Check-Mig' };
const fuente = { nombre: 'Migración Colombia', url: 'https://www.migracioncolombia.gov.co/checkmig', capturado_en: '2026-10-26T18:00:00.000Z',
  hechos, algoritmo_hechos_hash: ALGORITMO_HECHOS_HASH, hechos_hash: hashHechos(hechos) };
const revalidaciones = [{ tipo: 'hechos', fuente_nombre: fuente.nombre, url: fuente.url, hechos, algoritmo_hechos_hash: ALGORITMO_HECHOS_HASH, revalidada_en: T }];
const checkmig = id => ({ _id: id, tipo: 'formulario_digital', nombre: 'Check-Mig', obligatorio: 'si', descripcion: 'Formulario previo al viaje',
  fuente: 'Migración Colombia', link: 'https://www.migracioncolombia.gov.co/checkmig', estado: 'confirmado', fecha_verificacion: '2026-08-18' });
const visa = () => ({ _id: new ObjectId(), tipo: 'visa', nombre: 'Visa de turismo', obligatorio: 'no', descripcion: 'No requiere visa', fuente: 'Cancillería', estado: 'confirmado', fecha_verificacion: '2026-08-01' });
const CAMBIOS = [{ campo: 'obligatorio', propuesto: valor('no') }, { campo: 'descripcion', propuesto: valor('Check-Mig ya no es obligatorio') }, { campo: 'link', propuesto: ausente }];

(async () => {
  let rs, externo;
  try {
    rs = await MongoMemoryReplSet.create({ binary: { version: '8.0.32' }, replSet: { count: 1 } });
    const uri = rs.getUri('buscador_requisitos');
    assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:/);
    await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
    externo = await new MongoClient(uri).connect();
    const conexion = mongoose.connection, db = conexion.db, col = n => db.collection(n), ext = externo.db().collection('destinos');
    const indices = [...INDICES_APLICACION, V2.INDICE_TRANSVERSAL];
    const crearIndice = s => col(s.coleccion).createIndex(s.clave, { name: s.nombre, unique: true, ...(s.partialFilterExpression ? { partialFilterExpression: s.partialFilterExpression } : {}) });
    for (const s of indices) await crearIndice(s);

    const listados = async () => Object.fromEntries(await Promise.all([...new Set(indices.map(s => s.coleccion))].map(async c => [c, await col(c).indexes()])));
    function crearDeps(alterar = () => ({})) {
      const base = {
        uuid, ahora: () => T,
        verificarIndices: async () => V2.verificarIndicesV2(await listados()),
        ejecutarTransaccion: fn => conexion.transaction(fn, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } }),
        leerPropuesta: (id, s) => col('propuestas_cambio').findOne({ propuesta_id: id }, s ? { session: s } : {}),
        leerEvento: (id, s) => col('eventos_propuesta').findOne({ evento_id: id }, s ? { session: s } : {}),
        // H2.1: persistidores reales (modelos, strict 'throw', sesión explícita).
        ...crearPersistenciaV2(),
        ...V2.dependenciasDestino(Destino.collection),
        actualizarPropuestaCas: (f, u, s) => col('propuestas_cambio').updateOne(f, u, { session: s }),
      };
      return { ...base, ...alterar(base) };
    }

    // Propuesta 2.0 guardada + aprobación con las funciones reales de la decisión 2.0.
    async function sembrar({ destinoId = new ObjectId(), requisitoId = new ObjectId(), requisitos, objetivo, cambios = CAMBIOS,
      advertencias = ['quita_obligatoriedad'], aprobador = 'mathias-aprobador', insertarDestino = true, fuentes = [fuente], corromper = null } = {}) {
      const objetivoReq = objetivo ?? checkmig(requisitoId);
      const reqs = requisitos ?? [visa(), objetivoReq, visa()];
      if (insertarDestino) await col('destinos').insertOne({ _id: destinoId, pais: `Colombia-${destinoId}`, codigo_iso: String(destinoId).slice(-6), requisitos: reqs, updatedAt: new Date('2026-08-18T12:00:00Z') });
      const propuestaId = uuid();
      let sobre = crearSobreRequisitoV2({ fecha_propuesta: '2026-10-26T19:00:00.000Z', destino_id: String(destinoId), requisito_id: String(requisitoId),
        run_id_origen: uuid(), propuesta_id: propuestaId, ...capturarIdentidadEInstantanea({ ...objetivoReq, _id: requisitoId }), cambios, fuentes, advertencias });
      // `corromper` simula un payload guardado fuera de contrato, con hash y aprobación coherentes con él.
      const payload = structuredClone(sobre.payload);
      if (corromper) { corromper(payload); sobre = { ...sobre, payload, payload_hash: hashSobreCanonico(payload, sobre.algoritmo_canonicalizacion, sobre.algoritmo_hash) }; }
      await col('propuestas_cambio').insertOne({ propuesta_id: propuestaId, destino_id: destinoId, requisito_id: requisitoId, campo: 'requisito',
        algoritmo_canonicalizacion: sobre.algoritmo_canonicalizacion, algoritmo_hash: sobre.algoritmo_hash, payload, payload_hash: sobre.payload_hash,
        run_id_origen: sobre.payload.run_id_origen, estado: 'pendiente_aprobacion', version_coordinacion: 0, decision_aprobacion_id: null, ultimo_evento_id: null });
      const e = D.validarEntrada({ tipo_evento: 'aprobacion', propuesta_id: propuestaId, estado_esperado: 'pendiente_aprobacion', payload_hash_esperado: sobre.payload_hash,
        version_coordinacion_esperada: 0, decision_aprobacion_id_esperado: null, version_contrato_esperada: '2.0', advertencias_aceptadas: [...sobre.payload.advertencias] });
      const eventoId = uuid(), enAprobacion = new Date('2026-10-26T20:00:00.000Z');
      assert.equal((await col('propuestas_cambio').updateOne(D.construirFiltroCas(e), D.construirUpdateCas(e, eventoId, enAprobacion))).matchedCount, 1, 'aprobación real');
      await col('eventos_propuesta').insertOne(D.construirEvento(e, eventoId, enAprobacion, { actor: { tipo: 'humano', identificador: aprobador },
        identidad_operador: { metodo: 'oidc_google', sub: `sub-${aprobador}` }, comando: { nombre: 'panel-propuestas', version: '1' } }));
      const entrada = { propuesta_id: propuestaId, estado_esperado: 'aprobada', payload_hash_esperado: sobre.payload_hash, version_coordinacion_esperada: 1, decision_aprobacion_id_esperado: eventoId };
      return { destinoId, requisitoId, propuestaId, eventoAprobacion: eventoId, entrada, sobre };
    }
    const auditoria = (entrada, operador = 'mathias-aplicador') => ({ origen: 'panel', request_id: uuid(), operador, identidad: { metodo: 'oidc_google', sub: `sub-${operador}` },
      comando: { nombre: 'panel-propuestas', version: '1' }, instantanea: { ...entrada } });
    const ADAPTADOR = { nombre: 'migracion-colombia-checkmig', version: '1' };
    const contexto = (entrada, operador) => ({ adaptador: ADAPTADOR, auditoria: auditoria(entrada, operador), revalidaciones });
    // Donde se espera un resultado, un rechazo se vuelve un resultado comparable (falla por aserción).
    const aplicar = (...a) => V2.aplicarPropuestaV2(...a).catch(e => ({ resultado: `rechazo:${e?.constructor?.name}`, mensaje: String(e?.message).slice(0, 200) }));
    const leerDestino = id => col('destinos').findOne({ _id: id });
    const huella = async c => ({ destino: JSON.stringify(await leerDestino(c.destinoId)), propuesta: await col('propuestas_cambio').findOne({ propuesta_id: c.propuestaId }) });
    async function conteos(propuestaId) {
      const intentos = await col('intentos_aplicacion').find({ propuesta_id: propuestaId }).toArray();
      return { intentos: intentos.map(i => i.resultado).sort(), historial: await col('historial_cambios').countDocuments({ propuesta_id: propuestaId }),
        eventos: (await col('eventos_propuesta').find({ propuesta_id: propuestaId, tipo_evento: { $ne: 'aprobacion' } }).toArray()).map(e => e.tipo_evento).sort() };
    }
    // H2.1: el intento abortado guarda solo un código cerrado y un mensaje fijo, nunca el error crudo.
    const abortadoCon = async (propuestaId, codigo, msg) => {
      const i = await col('intentos_aplicacion').findOne({ propuesta_id: propuestaId, resultado: 'escritura_abortada' });
      assert.deepEqual([i?.version_contrato, i?.error_externo, i?.error_mensaje], ['2.0', codigo, 'La escritura del aplicador 2.0 se abortó sin cambios en destinos; ver error_externo.'], msg);
      return i;
    };
    // H2.2: lectura real del panel sobre lo persistido. Misma forma de evento que el 1.0 y nada privado:
    // ni sub, request_id, instantánea, usuario_atlas ni la auditoría o identidades del detalle.
    const OP_LECTOR = { identificador: 'lector-panel', permisos: ['decidir', 'aplicar'] };
    const leerPanel = async propuestaId => {
      const vista = await crearLectorPropuestas({ obtenerDb: () => db }).detalle(propuestaId, OP_LECTOR);
      const texto = JSON.stringify(vista);
      for (const prohibido of ['sub-', 'request_id', 'instantanea', 'usuario_atlas', 'identidad_operador', 'auditoria', 'decision_aprobacion_id_esperado', 'mongodb://', 'eyJ']) {
        assert.ok(!texto.includes(prohibido), `respuesta del panel sin ${prohibido}`);
      }
      for (const ev of await col('eventos_propuesta').find({ propuesta_id: propuestaId }).toArray()) {
        if (typeof ev.detalle?.auditoria?.request_id === 'string') assert.ok(!texto.includes(ev.detalle.auditoria.request_id), 'request_id del aplicador oculto');
      }
      return vista;
    };
    const eventoPanel = (ev, extra = {}) => ({ evento_id: ev.evento_id, tipo_evento: ev.tipo_evento, estado_anterior: 'aprobada', estado_nuevo: ev.estado_nuevo, ocurrido_en: ev.ocurrido_en.toISOString(),
      version_coordinacion_nueva: ev.version_coordinacion_nueva, hash_contenido_referenciado: ev.hash_contenido_referenciado, actor: { tipo: 'sistema', identificador: 'aplicar-propuesta-v2' },
      // Origen y método salen de las hojas seguras de detalle.auditoria (la auditoría de esta suite es del panel).
      origen: 'panel-propuestas', metodo_identidad: 'oidc_google', motivo: null, intento_aplicacion_id: ev.intento_aplicacion_id, ...extra });
    const sinEscrituraDeDestino = async (c, antes, msg) => assert.equal(JSON.stringify(await leerDestino(c.destinoId)), antes.destino, msg);

    // ---- El 1.0 rechaza una propuesta 2.0 antes de escribir (comportamiento sin cambios) ----
    {
      const c = await sembrar();
      const p = await col('propuestas_cambio').findOne({ propuesta_id: c.propuestaId });
      let escrituras = 0;
      const prohibido = () => { escrituras++; throw new Error('el 1.0 no debe escribir'); };
      const deps1 = { verificarIndices: async () => {}, uuid, ahora: () => T, contextoProceso: () => ({ host: 'h', pid: 1 }),
        leerPropuesta: async () => p, leerEvento: async () => null, elegirAdaptador: prohibido, insertarInicio: prohibido, validarInicio: prohibido,
        insertarIntentoIndependiente: prohibido, ejecutarTransaccion: prohibido };
      await assert.rejects(A1.aplicarPropuesta(c.entrada, deps1, auditoria(c.entrada)), A1.ErrorPropuestaNoSoportada);
      assert.equal(escrituras, 0, '1.0: ninguna escritura ni adaptador ante 2.0');
    }

    // ---- Índice transversal ausente: no se escribe nada ----
    {
      const c = await sembrar(), antes = await huella(c);
      await col('propuestas_cambio').dropIndex(V2.INDICE_TRANSVERSAL.nombre);
      await assert.rejects(V2.aplicarPropuestaV2(c.entrada, contexto(c.entrada), crearDeps()), ErrorPrecondicionIndices);
      await sinEscrituraDeDestino(c, antes, 'sin índice transversal: destino intacto');
      assert.deepEqual(await conteos(c.propuestaId), { intentos: [], historial: 0, eventos: [] });
      await crearIndice(V2.INDICE_TRANSVERSAL);
      // Se deja en estado no activo para no ocupar el índice transversal.
      await col('propuestas_cambio').updateOne({ propuesta_id: c.propuestaId }, { $set: { estado: 'cancelada' } });
    }

    // ---- Éxito con los ids reales de Colombia/Check-Mig; la misma persona aprueba y aplica ----
    const destinoCo = ObjectId.createFromHexString(COLOMBIA), checkmigId = ObjectId.createFromHexString(CHECKMIG);
    const co = await sembrar({ destinoId: destinoCo, requisitoId: checkmigId, aprobador: 'mathias-operador' });
    const coAntes = await leerDestino(destinoCo);
    const r = await aplicar(co.entrada, contexto(co.entrada, 'mathias-operador'), crearDeps());
    assert.equal(r.resultado, 'exito', JSON.stringify(r));
    assert.equal(r.confirmado_por_relectura, false);
    assert.equal(r.fecha_verificacion, FECHA, '02:30 UTC → día de Montevideo');
    const coDespues = await leerDestino(destinoCo);
    const esperado = { ...checkmig(checkmigId), obligatorio: 'no', descripcion: 'Check-Mig ya no es obligatorio', fecha_verificacion: FECHA };
    delete esperado.link;
    assert.deepEqual(coDespues.requisitos[1], esperado, 'requisito objetivo exacto');
    assert.equal(Object.hasOwn(coDespues.requisitos[1], 'link'), false, '$unset elimina el campo');
    assert.equal(await col('destinos').countDocuments({ _id: destinoCo, 'requisitos.link': { $type: 'null' } }), 0, '$unset nunca deja null');
    assert.equal(await col('destinos').countDocuments({ _id: destinoCo, requisitos: { $elemMatch: { _id: checkmigId, fecha_verificacion: { $type: 'string', $eq: FECHA } } } }), 1, 'BSON final string');
    assert.deepEqual([coDespues.requisitos[0], coDespues.requisitos[2]], [coAntes.requisitos[0], coAntes.requisitos[2]], 'otros requisitos intactos');
    assert.equal(coDespues.updatedAt.getTime(), T.getTime());
    const pCo = await col('propuestas_cambio').findOne({ propuesta_id: co.propuestaId });
    assert.deepEqual([pCo.estado, pCo.version_coordinacion, pCo.ultimo_evento_id], ['aplicada', 2, r.evento_id]);
    assert.deepEqual(await conteos(co.propuestaId), { intentos: ['exito'], historial: 1, eventos: ['aplicacion'] });
    const intentoCo = await col('intentos_aplicacion').findOne({ intento_id: r.intento_id });
    const historialCo = await col('historial_cambios').findOne({ historial_id: r.historial_id });
    const eventoCo = await col('eventos_propuesta').findOne({ evento_id: r.evento_id });
    assert.ok(intentoCo && historialCo && eventoCo, 'intento, historial y evento con los ids devueltos');
    assert.equal(intentoCo.aprobacion.actor.identificador, 'mathias-operador');
    assert.equal(intentoCo.operador.identificador, 'mathias-operador');
    assert.deepEqual([intentoCo.aprobacion.evento_id, intentoCo.aprobacion.identidad_operador.sub, intentoCo.identidad_operador.sub],
      [co.eventoAprobacion, 'sub-mathias-operador', 'sub-mathias-operador'], 'aprobador y aplicador por separado aunque sean la misma persona');
    assert.equal(intentoCo.auditoria.request_id.length, 36);
    // El resumen de revalidaciones sale del payload aprobado, ya validado.
    assert.deepEqual(intentoCo.revalidaciones, [{ url: fuente.url, fuente_nombre: fuente.nombre, hechos_hash: fuente.hechos_hash, revalidada_en: T }]);
    assert.deepEqual(historialCo.fecha_verificacion, { anterior: valor('2026-08-18'), nueva: valor(FECHA) });
    assert.deepEqual(historialCo.cambios.map(x => x.campo), ['descripcion', 'link', 'obligatorio']);
    assert.deepEqual([eventoCo.actor.tipo, eventoCo.estado_anterior, eventoCo.estado_nuevo, eventoCo.version_coordinacion_nueva, eventoCo.intento_aplicacion_id],
      ['sistema', 'aprobada', 'aplicada', 2, r.intento_id]);
    // H2.2: el evento referencia al aprobador sin copiar identidades; el aplicador queda en su auditoría.
    assert.deepEqual(Object.keys(eventoCo.detalle).sort(), ['adaptador', 'auditoria', 'decision_aprobacion_id', 'proceso_aplicador', 'resultado', 'version_contrato']);
    assert.deepEqual([eventoCo.detalle.decision_aprobacion_id, eventoCo.detalle.version_contrato, eventoCo.detalle.resultado], [co.eventoAprobacion, '2.0', 'exito']);
    assert.deepEqual(eventoCo.detalle.auditoria, intentoCo.auditoria, 'el aplicador del evento es el del intento');
    assert.deepEqual(eventoCo.detalle.adaptador, intentoCo.adaptador);
    for (const c of ['aprobacion', 'identidad_operador', 'operador', 'propuesta_id', 'auditoria_panel']) assert.equal(Object.hasOwn(eventoCo.detalle, c), false, `evento 2.0 sin copia de ${c}`);
    {
      const vista = await leerPanel(co.propuestaId);
      assert.deepEqual(vista.eventos.map(e => e.tipo_evento), ['aprobacion', 'aplicacion'], 'eventos en orden de versión');
      assert.deepEqual(vista.eventos[1], eventoPanel(eventoCo), 'evento 2.0 de aplicación con la forma exacta del panel');
      assert.deepEqual([vista.eventos[0].actor, vista.eventos[0].origen], [{ tipo: 'humano', identificador: 'mathias-operador' }, 'panel-propuestas'], 'aprobador por separado, en su evento');
    }
    // Reaplicar la misma entrada no escribe de nuevo.
    const reaplicada = await aplicar(co.entrada, contexto(co.entrada), crearDeps());
    assert.equal(reaplicada.resultado, 'propuesta_no_aplicable');
    assert.deepEqual(await leerDestino(destinoCo), coDespues);
    assert.deepEqual((await conteos(co.propuestaId)).intentos, ['exito', 'propuesta_no_aplicable']);
    // Control negativo: el MODELO castea el string a Date; por eso se escribe con Destino.collection.
    {
      const id = new ObjectId(), rid = new ObjectId();
      await col('destinos').insertOne({ _id: id, pais: 'control', codigo_iso: 'CTL', requisitos: [{ ...checkmig(rid) }] });
      await Destino.updateOne({ _id: id }, { $set: { 'requisitos.$[r].fecha_verificacion': FECHA } }, { arrayFilters: [{ 'r._id': rid }] });
      assert.equal(await col('destinos').countDocuments({ _id: id, 'requisitos.fecha_verificacion': { $type: 'date' } }), 1, 'el modelo convierte a Date');
      assert.throws(() => V2.dependenciasDestino(Destino), TypeError, 'se rechaza el modelo');
    }

    // ---- Gemelo M6: mismo contenido, distinto _id; solo cambia el objetivo ----
    {
      const requisitoId = new ObjectId(), gemelo = checkmig(new ObjectId());
      const c = await sembrar({ requisitoId, requisitos: [gemelo, checkmig(requisitoId)] });
      const rg = await aplicar(c.entrada, contexto(c.entrada), crearDeps());
      assert.equal(rg.resultado, 'exito');
      const d = await leerDestino(c.destinoId);
      assert.deepEqual(d.requisitos[0], gemelo, 'gemelo intacto');
      assert.equal(d.requisitos[1].obligatorio, 'no');
      // Personas distintas: cada identidad queda en su lugar.
      const i = await col('intentos_aplicacion').findOne({ intento_id: rg.intento_id });
      assert.ok(i, 'intento con el id devuelto');
      assert.deepEqual([i.aprobacion.actor.identificador, i.aprobacion.identidad_operador.sub, i.operador.identificador, i.identidad_operador.sub],
        ['mathias-aprobador', 'sub-mathias-aprobador', 'mathias-aplicador', 'sub-mathias-aplicador']);
    }

    // ---- Rastro parcial tras un error: nunca se confirma por evidencia incompleta ----
    // Commit real y luego se quita exactamente UNA pieza: el resto coincide byte a byte.
    for (const falta of ['intento', 'historial', 'evento', 'cas_propuesta']) {
      const c = await sembrar();
      const ids = [uuid(), uuid(), uuid()]; let n = 0;
      const deps = crearDeps(b => ({ uuid: () => ids[n++], ejecutarTransaccion: async fn => {
        await b.ejecutarTransaccion(fn);
        const [intentoId, eventoId, historialId] = ids;
        if (falta === 'intento') await col('intentos_aplicacion').deleteOne({ intento_id: intentoId });
        if (falta === 'historial') await col('historial_cambios').deleteOne({ historial_id: historialId });
        if (falta === 'evento') await col('eventos_propuesta').deleteOne({ evento_id: eventoId });
        if (falta === 'cas_propuesta') await col('propuestas_cambio').updateOne({ propuesta_id: c.propuestaId }, { $set: { estado: 'aprobada', ultimo_evento_id: c.eventoAprobacion }, $inc: { version_coordinacion: -1 } });
        throw new MongoNetworkError('sin respuesta');
      } }));
      const rp = await aplicar(c.entrada, contexto(c.entrada), deps);
      assert.equal(rp.resultado, 'rechazo:ErrorInconsistencia', `rastro parcial sin ${falta}: ${JSON.stringify(rp)}`);
    }

    // ---- Conflictos de identidad o contenido: transición existente "conflicto", sin escribir el destino ----
    async function conflicto(nombre, opciones, resultadoEsperado, categoria) {
      const c = await sembrar(opciones), antes = await huella(c);
      const rc = await aplicar(c.entrada, contexto(c.entrada), crearDeps());
      assert.equal(rc.resultado, resultadoEsperado, `${nombre}: ${JSON.stringify(rc)}`);
      assert.equal(rc.conflicto.categoria, categoria, nombre);
      assert.equal(rc.estado_propuesta_nuevo, 'conflicto');
      if (opciones.insertarDestino !== false) await sinEscrituraDeDestino(c, antes, `${nombre}: destino intacto`);
      assert.deepEqual(await conteos(c.propuestaId), { intentos: [resultadoEsperado], historial: 0, eventos: ['conflicto'] }, nombre);
      const ev = await col('eventos_propuesta').findOne({ evento_id: rc.evento_id });
      assert.deepEqual([ev.detalle.resultado, ev.detalle.decision_aprobacion_id, Object.hasOwn(ev.detalle, 'aprobacion')], [resultadoEsperado, c.eventoAprobacion, false], `${nombre}: detalle 2.0`);
      const vista = await leerPanel(c.propuestaId);
      assert.deepEqual(vista.eventos.at(-1), eventoPanel(ev, { motivo: vista.eventos.at(-1).motivo }), `${nombre}: evento de conflicto en el panel`);
      assert.equal(typeof vista.eventos.at(-1).motivo, 'string', `${nombre}: motivo saneado presente`);
      return rc;
    }
    { const id = new ObjectId(); await conflicto('claves desconocidas', { requisitoId: id, objetivo: checkmig(id), requisitos: [visa(), { ...checkmig(id), notas_internas: 'agregado' }] }, 'valor_actual_cambio', 'claves_desconocidas'); }
    { const id = new ObjectId(); const sinId = checkmig(id); delete sinId._id;
      await conflicto('requisito sin _id', { requisitoId: id, objetivo: checkmig(id), requisitos: [visa(), sinId] }, 'identidad_requisito_cambio', 'requisito_id_no_encontrado'); }
    { const id = new ObjectId(); await conflicto('_id duplicado', { requisitoId: id, requisitos: [checkmig(id), checkmig(id)] }, 'identidad_requisito_cambio', 'requisito_id_duplicado'); }
    { const id = new ObjectId(); await conflicto('_id como string', { requisitoId: id, requisitos: [checkmig(id), { ...checkmig(id), _id: String(id) }] }, 'identidad_requisito_cambio', 'requisito_id_duplicado'); }
    { const id = new ObjectId(); await conflicto('solo _id string', { requisitoId: id, objetivo: checkmig(id), requisitos: [visa(), { ...checkmig(id), _id: String(id) }] }, 'identidad_requisito_cambio', 'requisito_id_no_encontrado'); }
    await conflicto('destino inexistente', { insertarDestino: false }, 'identidad_requisito_cambio', 'destino_no_encontrado');
    { const id = new ObjectId(); await conflicto('identidad semántica', { requisitoId: id, objetivo: checkmig(id), requisitos: [{ ...checkmig(id), nombre: 'Otro formulario' }] }, 'identidad_requisito_cambio', 'identidad_semantica_no_coincide'); }

    // ---- Cambio concurrente del requisito entre la lectura y la escritura: no se pisa ----
    {
      const c = await sembrar();
      // La inyección no depende de la sesión: ocurre tras el PRIMER acceso al destino.
      let inyectado = false, lecturas = 0;
      const deps = crearDeps(b => ({ leerDestino: async (f, s) => {
        const d = await b.leerDestino(f, s);
        lecturas++;
        if (!inyectado) { inyectado = true; await ext.updateOne({ _id: c.destinoId, 'requisitos._id': c.requisitoId }, { $set: { 'requisitos.$.descripcion': 'CAMBIO CONCURRENTE' } }); }
        return d;
      } }));
      const rc = await aplicar(c.entrada, contexto(c.entrada), deps);
      const d = (await leerDestino(c.destinoId)).requisitos[1];
      assert.deepEqual([d.descripcion, d.obligatorio, d.link], ['CAMBIO CONCURRENTE', 'si', fuente.url], 'el cambio concurrente se conserva');
      assert.equal(rc.resultado, 'valor_actual_cambio', JSON.stringify(rc));
      assert.ok(lecturas >= 1);
      assert.ok(!(await conteos(c.propuestaId)).intentos.includes('exito'));
    }

    // ---- Orden: una clave desconocida agregada DESPUÉS de iniciar el snapshot (tras el CAS) ----
    // El filtro del núcleo no mira claves desconocidas: solo la lectura del destino dentro
    // de la transacción, posterior al inicio del snapshot, lo detecta (sonda de reordenamiento).
    {
      const c = await sembrar(); let hecho = false;
      const deps = crearDeps(b => ({ actualizarPropuestaCas: async (f, u, s) => {
        const x = await b.actualizarPropuestaCas(f, u, s);
        if (!hecho) { hecho = true; await ext.updateOne({ _id: c.destinoId, 'requisitos._id': c.requisitoId }, { $set: { 'requisitos.$.notas_internas': 'agregada en paralelo' } }); }
        return x;
      } }));
      const rc = await aplicar(c.entrada, contexto(c.entrada), deps);
      assert.equal(rc.resultado, 'valor_actual_cambio', JSON.stringify(rc));
      const d = (await leerDestino(c.destinoId)).requisitos[1];
      assert.deepEqual([d.obligatorio, d.notas_internas], ['si', 'agregada en paralelo'], 'no se aplica sobre una clave desconocida concurrente');
      assert.ok(!(await conteos(c.propuestaId)).intentos.includes('exito'));
    }

    // ---- Contrato de sesión (ESTRUCTURAL): toda operación del callback usa la sesión de la transacción ----
    {
      const c = await sembrar(); let sesionTx = null; const usos = [];
      const espiar = (b, nombre) => async (...a) => { usos.push([nombre, a[a.length - 1] === sesionTx && sesionTx !== null]); return b[nombre](...a); };
      const deps = crearDeps(b => ({
        ejecutarTransaccion: fn => b.ejecutarTransaccion(s => { sesionTx = s; return fn(s); }),
        ...Object.fromEntries(['leerDestino', 'actualizarDestino', 'actualizarPropuestaCas', 'insertarHistorial', 'insertarIntento', 'insertarEvento'].map(n => [n, espiar(b, n)]))
      }));
      assert.equal((await aplicar(c.entrada, contexto(c.entrada), deps)).resultado, 'exito');
      assert.deepEqual(usos.map(u => u[0]), ['actualizarPropuestaCas', 'leerDestino', 'actualizarDestino', 'insertarHistorial', 'insertarIntento', 'insertarEvento']);
      assert.ok(usos.every(u => u[1]), `todas con la sesión de la transacción: ${JSON.stringify(usos)}`);
    }

    // ---- matchedCount 0: sin aplicación ni auditoría de éxito ----
    {
      const c = await sembrar(), antes = await huella(c);
      const deps = crearDeps(() => ({ actualizarDestino: async () => ({ matchedCount: 0, modifiedCount: 0 }) }));
      await assert.rejects(V2.aplicarPropuestaV2(c.entrada, contexto(c.entrada), deps), A1.ErrorInconsistencia);
      await sinEscrituraDeDestino(c, antes, 'matchedCount 0: destino intacto');
      assert.equal((await col('propuestas_cambio').findOne({ propuesta_id: c.propuestaId })).estado, 'aprobada', 'CAS de la propuesta revertido');
      assert.deepEqual(await conteos(c.propuestaId), { intentos: ['escritura_abortada'], historial: 0, eventos: [] });
      await abortadoCon(c.propuestaId, 'inconsistencia', 'matchedCount 0: código inconsistencia');
      const c2 = await sembrar();
      const deps2 = crearDeps(() => ({ actualizarDestino: async () => ({ matchedCount: 1, modifiedCount: 0 }) }));
      await assert.rejects(V2.aplicarPropuestaV2(c2.entrada, contexto(c2.entrada), deps2), A1.ErrorInconsistencia);
      assert.ok(!(await conteos(c2.propuestaId)).intentos.includes('exito'), 'modifiedCount 0 tampoco es éxito');
    }

    // ---- H2.1: un documento de auditoría que el modelo rechaza frena todo antes de la transacción ----
    for (const validar of ['validarHistorial', 'validarIntento', 'validarEvento']) {
      const c = await sembrar(), antes = await huella(c);
      let transacciones = 0;
      const deps = crearDeps(b => ({ [validar]: async () => { throw new Error('rechazado por el modelo'); }, ejecutarTransaccion: fn => { transacciones++; return b.ejecutarTransaccion(fn); } }));
      await assert.rejects(V2.aplicarPropuestaV2(c.entrada, contexto(c.entrada), deps), e => e instanceof A1.ErrorInconsistencia && e.message.includes(validar), validar);
      assert.equal(transacciones, 0, `${validar}: sin abrir la transacción`);
      await sinEscrituraDeDestino(c, antes, `${validar}: destino intacto`);
      assert.deepEqual(await conteos(c.propuestaId), { intentos: [], historial: 0, eventos: [] }, `${validar}: sin auditoría`);
      assert.equal((await col('propuestas_cambio').findOne({ propuesta_id: c.propuestaId })).estado, 'aprobada', `${validar}: propuesta intacta`);
    }

    // ---- Payload alterado con hash recalculado y entradas que intentan sustituir lo aprobado ----
    {
      const c = await sembrar(), antes = await huella(c);
      const alterado = structuredClone(c.sobre.payload);
      alterado.cambios = alterado.cambios.map(x => x.campo === 'descripcion' ? { ...x, propuesto: valor('TEXTO NO APROBADO') } : x);
      const hash = hashSobreCanonico(alterado, c.sobre.algoritmo_canonicalizacion, c.sobre.algoritmo_hash);
      await col('propuestas_cambio').updateOne({ propuesta_id: c.propuestaId }, { $set: { payload: alterado, payload_hash: hash } });
      const entrada = { ...c.entrada, payload_hash_esperado: hash };
      const ra = await aplicar(entrada, contexto(entrada), crearDeps());
      assert.equal(ra.resultado, 'propuesta_no_aplicable');
      assert.ok(ra.fallas.includes('aprobacion_invalida'), JSON.stringify(ra.fallas));
      await sinEscrituraDeDestino(c, antes, 'payload alterado: destino intacto');
      await assert.rejects(V2.aplicarPropuestaV2({ ...c.entrada, payload: c.sobre.payload }, contexto(c.entrada), crearDeps()), A1.ErrorEntradaInvalida);
      await assert.rejects(V2.aplicarPropuestaV2(c.entrada, { ...contexto(c.entrada), operador: 'otro' }, crearDeps()), A1.ErrorEntradaInvalida);
      await assert.rejects(V2.aplicarPropuestaV2(c.entrada, { adaptador: ADAPTADOR, auditoria: { ...auditoria(c.entrada), operador: '' }, revalidaciones }, crearDeps()), A1.ErrorEntradaInvalida);
    }

    // ---- Aprobación desactualizada y advertencias no aceptadas ----
    async function rechazo(nombre, alterar, falla) {
      const c = await sembrar(), antes = await huella(c);
      await alterar(c);
      const rr = await aplicar(c.entrada, contexto(c.entrada), crearDeps());
      assert.equal(rr.resultado, 'propuesta_no_aplicable', nombre);
      assert.ok(rr.fallas.includes(falla), `${nombre}: ${JSON.stringify(rr.fallas)}`);
      await sinEscrituraDeDestino(c, antes, nombre);
      assert.deepEqual(await conteos(c.propuestaId), { intentos: ['propuesta_no_aplicable'], historial: 0, eventos: [] }, nombre);
      assert.equal((await col('intentos_aplicacion').findOne({ intento_id: rr.intento_id }))?.etapa_fallo, 'precondiciones_propuesta', `${nombre}: rechazo en etapa 0`);
    }
    // La aprobación cambia entre la etapa 0 y la transacción: solo la revalidación interna lo detiene
    // (el CAS de la propuesta no cubre las advertencias del evento).
    {
      const c = await sembrar(), antes = await huella(c);
      const deps = crearDeps(b => ({ ejecutarTransaccion: async fn => {
        await col('eventos_propuesta').updateOne({ evento_id: c.eventoAprobacion }, { $set: { 'detalle.advertencias_aceptadas': [] } });
        return b.ejecutarTransaccion(fn);
      } }));
      const rr = await aplicar(c.entrada, contexto(c.entrada), deps);
      assert.equal(rr.resultado, 'propuesta_no_aplicable', JSON.stringify(rr));
      assert.ok(rr.fallas?.includes('advertencias_no_aceptadas'));
      await sinEscrituraDeDestino(c, antes, 'aprobación alterada antes de la transacción');
      assert.equal((await col('intentos_aplicacion').findOne({ intento_id: rr.intento_id }))?.etapa_fallo, 'escritura_aplicacion');
    }
    await rechazo('último evento distinto de la aprobación', c => col('propuestas_cambio').updateOne({ propuesta_id: c.propuestaId }, { $set: { ultimo_evento_id: uuid() } }), 'aprobacion_invalida');
    await rechazo('aprobación con otra versión', c => col('eventos_propuesta').updateOne({ evento_id: c.eventoAprobacion }, { $set: { version_coordinacion_nueva: 7 } }), 'aprobacion_invalida');
    await rechazo('advertencias no aceptadas', c => col('eventos_propuesta').updateOne({ evento_id: c.eventoAprobacion }, { $set: { 'detalle.advertencias_aceptadas': [] } }), 'advertencias_no_aceptadas');
    await rechazo('aprobación sin contrato 2.0', c => col('eventos_propuesta').updateOne({ evento_id: c.eventoAprobacion }, { $unset: { 'detalle.version_contrato': '' } }), 'advertencias_no_aceptadas');
    await rechazo('versión de coordinación esperada distinta', async c => { c.entrada = { ...c.entrada, version_coordinacion_esperada: 0 }; }, 'version_no_coincide');

    // ---- Revalidación vencida: no escribe; el registro del intento queda para H3 ----
    {
      const c = await sembrar(), antes = await huella(c);
      const viejas = [{ ...revalidaciones[0], revalidada_en: new Date(T.getTime() - 16 * 60 * 1000) }];
      await assert.rejects(V2.aplicarPropuestaV2(c.entrada, { adaptador: ADAPTADOR, auditoria: auditoria(c.entrada), revalidaciones: viejas }, crearDeps()), e => e instanceof V2.ErrorRevalidacionV2 && e.codigo === 'revalidacion_vencida');
      await sinEscrituraDeDestino(c, antes, 'revalidación vencida');
      assert.deepEqual(await conteos(c.propuestaId), { intentos: [], historial: 0, eventos: [] });
    }

    // ---- Dos aplicaciones concurrentes: exactamente una efectiva ----
    {
      const c = await sembrar();
      const rs2 = await Promise.allSettled([V2.aplicarPropuestaV2(c.entrada, contexto(c.entrada, 'operador-a'), crearDeps()),
        V2.aplicarPropuestaV2(c.entrada, contexto(c.entrada, 'operador-b'), crearDeps())]);
      const exitos = rs2.filter(x => x.status === 'fulfilled' && x.value.resultado === 'exito');
      assert.equal(exitos.length, 1, JSON.stringify(rs2.map(x => x.value?.resultado ?? x.reason?.constructor?.name)));
      const k = await conteos(c.propuestaId);
      assert.equal(k.intentos.filter(x => x === 'exito').length, 1);
      assert.deepEqual([k.historial, k.eventos], [1, ['aplicacion']]);
      assert.equal((await leerDestino(c.destinoId)).requisitos[1].obligatorio, 'no');
    }

    // ---- Fallo entre escrituras: rollback completo ----
    {
      const c = await sembrar(), antes = await huella(c);
      const deps = crearDeps(() => ({ insertarEvento: async () => { throw new Error('fallo inyectado entre escrituras'); } }));
      await assert.rejects(V2.aplicarPropuestaV2(c.entrada, contexto(c.entrada), deps), V2.ErrorEscrituraAbortadaV2);
      await sinEscrituraDeDestino(c, antes, 'rollback del destino');
      assert.equal((await col('propuestas_cambio').findOne({ propuesta_id: c.propuestaId })).estado, 'aprobada', 'rollback del CAS');
      assert.deepEqual(await conteos(c.propuestaId), { intentos: ['escritura_abortada'], historial: 0, eventos: [] }, 'rollback de historial e intento');
      await abortadoCon(c.propuestaId, 'desconocido', 'error ajeno a Mongo: código desconocido');
    }

    // ---- Reintento del callback por error transitorio: sin duplicar auditoría ----
    {
      const c = await sembrar();
      const transitorio = new MongoServerError({ message: 'transitorio inyectado', errmsg: 'transitorio inyectado', code: 112, codeName: 'WriteConflict', errorLabels: ['TransientTransactionError'] });
      assert.ok(transitorio.hasErrorLabel('TransientTransactionError'));
      let llamadas = 0, lecturasEnSesion = 0;
      const deps = crearDeps(b => ({
        insertarEvento: async (d, s) => { if (++llamadas === 1) throw transitorio; return b.insertarEvento(d, s); },
        leerPropuesta: async (id, s) => { if (s) lecturasEnSesion++; return b.leerPropuesta(id, s); }
      }));
      const rt = await aplicar(c.entrada, contexto(c.entrada), deps);
      assert.equal(rt.resultado, 'exito');
      assert.equal(lecturasEnSesion, 2, 'el callback se ejecutó dos veces');
      assert.deepEqual(await conteos(c.propuestaId), { intentos: ['exito'], historial: 1, eventos: ['aplicacion'] });
    }

    // ---- Respuesta perdida después del commit: confirmación por evidencia completa ----
    {
      const c = await sembrar();
      const deps = crearDeps(b => ({ ejecutarTransaccion: async fn => { await b.ejecutarTransaccion(fn); throw new MongoNetworkError('respuesta perdida tras commit'); } }));
      const rp = await aplicar(c.entrada, contexto(c.entrada), deps);
      assert.deepEqual([rp.resultado, rp.confirmado_por_relectura, rp.causa_relectura], ['exito', true, 'error_transaccion']);
      assert.deepEqual(await conteos(c.propuestaId), { intentos: ['exito'], historial: 1, eventos: ['aplicacion'] });
    }

    // ---- Requisito con los valores esperados pero sin commit: NO se confirma ----
    {
      const c = await sembrar();
      const deps = crearDeps(() => ({ ejecutarTransaccion: async () => {
        await ext.updateOne({ _id: c.destinoId, 'requisitos._id': c.requisitoId }, { $set: { 'requisitos.$.obligatorio': 'no', 'requisitos.$.descripcion': 'Check-Mig ya no es obligatorio',
          'requisitos.$.fecha_verificacion': FECHA, updatedAt: T }, $unset: { 'requisitos.$.link': '' } });
        throw new MongoNetworkError('sin respuesta');
      } }));
      await assert.rejects(V2.aplicarPropuestaV2(c.entrada, contexto(c.entrada), deps), V2.ErrorEscrituraAbortadaV2);
      assert.equal((await col('propuestas_cambio').findOne({ propuesta_id: c.propuestaId })).estado, 'aprobada');
      assert.deepEqual(await conteos(c.propuestaId), { intentos: ['escritura_abortada'], historial: 0, eventos: [] });
      await abortadoCon(c.propuestaId, 'red', 'error de red: código red');
    }

    // ---- Relectura fallida: resultado incierto, sin registrar más ni reintentar ----
    {
      const c = await sembrar();
      let tras = false, transacciones = 0;
      const deps = crearDeps(b => ({
        ejecutarTransaccion: async fn => { transacciones++; await b.ejecutarTransaccion(fn); tras = true; throw new MongoNetworkError('corte'); },
        leerPropuesta: async (id, s) => { if (tras && !s) throw new MongoNetworkError('relectura caída'); return b.leerPropuesta(id, s); }
      }));
      await assert.rejects(V2.aplicarPropuestaV2(c.entrada, contexto(c.entrada), deps), A1.ErrorResultadoIncierto);
      assert.equal(transacciones, 1, 'sin reintento a ciegas');
      assert.deepEqual(await conteos(c.propuestaId), { intentos: ['exito'], historial: 1, eventos: ['aplicacion'] }, 'el commit ocurrió; no se agregó escritura_abortada');
    }

    // ---- Secretos FICTICIOS: nada del llamador sin validar llega a la auditoría ni a los errores públicos ----
    {
      const SECRETOS = ['ClaveFicticia123', 'tok_FICTICIO_9f8e', 'hunter2-ficticia', 'AKIA_FICTICIA_42', 'cluster-ficticio.mongodb.net'];
      const conSecretos = 'mongodb+srv://admin:ClaveFicticia123@cluster-ficticio.mongodb.net/db token=tok_FICTICIO_9f8e password=hunter2-ficticia apiKey=AKIA_FICTICIA_42';
      const maliciosas = [{ ...revalidaciones[0], url: 'https://usuario:ClaveFicticia123@www.migracioncolombia.gov.co/checkmig', fuente_nombre: conSecretos }];
      const limpio = (texto, donde) => assert.deepEqual(SECRETOS.filter(x => texto.includes(x)), [], `secretos expuestos en ${donde}`);
      const publico = e => `${e?.message}\n${e?.stack}\n${String(e)}`;
      // Rechazo de etapa 0 con revalidaciones maliciosas: se registra, sin `revalidaciones`.
      const c1 = await sembrar();
      await col('propuestas_cambio').updateOne({ propuesta_id: c1.propuestaId }, { $set: { ultimo_evento_id: uuid() } });
      const r1 = await aplicar(c1.entrada, { adaptador: ADAPTADOR, auditoria: auditoria(c1.entrada), revalidaciones: maliciosas }, crearDeps());
      assert.equal(r1.resultado, 'propuesta_no_aplicable');
      const i1 = await col('intentos_aplicacion').findOne({ intento_id: r1.intento_id });
      assert.ok(i1 && i1.etapa_fallo === 'precondiciones_propuesta' && i1.precondiciones.length > 0, 'el rechazo temprano se registra con motivos seguros');
      assert.equal(Object.hasOwn(i1, 'revalidaciones'), false, 'rechazo temprano sin revalidaciones del llamador');
      // Propuesta válida con revalidaciones maliciosas: no coinciden con la fuente aprobada → sin escribir.
      const c2 = await sembrar(), antes2 = await huella(c2);
      let e2 = null;
      try { await V2.aplicarPropuestaV2(c2.entrada, { adaptador: ADAPTADOR, auditoria: auditoria(c2.entrada), revalidaciones: maliciosas }, crearDeps()); } catch (e) { e2 = e; }
      assert.ok(e2 instanceof V2.ErrorRevalidacionV2, String(e2));
      limpio(publico(e2), 'ErrorRevalidacionV2');
      await sinEscrituraDeDestino(c2, antes2, 'revalidación maliciosa');
      assert.deepEqual(await conteos(c2.propuestaId), { intentos: [], historial: 0, eventos: [] });
      // Error con secretos dentro de la transacción: mensaje público y auditoría limpios.
      const c3 = await sembrar();
      let e3 = null;
      try { await V2.aplicarPropuestaV2(c3.entrada, contexto(c3.entrada), crearDeps(() => ({ insertarEvento: async () => { throw new Error(conSecretos); } }))); } catch (e) { e3 = e; }
      assert.ok(e3 instanceof V2.ErrorEscrituraAbortadaV2);
      limpio(publico(e3), 'ErrorEscrituraAbortadaV2');
      assert.deepEqual(await conteos(c3.propuestaId), { intentos: ['escritura_abortada'], historial: 0, eventos: [] });
      // Éxito con las mismas reglas: resumen validado del payload.
      const c4 = await sembrar();
      const r4 = await aplicar(c4.entrada, contexto(c4.entrada), crearDeps());
      assert.equal(r4.resultado, 'exito');
      assert.equal((await col('intentos_aplicacion').findOne({ intento_id: r4.intento_id }))?.revalidaciones?.[0]?.url, fuente.url);
      const auditoriaTotal = JSON.stringify(await Promise.all(['intentos_aplicacion', 'historial_cambios', 'eventos_propuesta', 'propuestas_cambio'].map(n => col(n).find({}).toArray())));
      limpio(auditoriaTotal, 'colecciones de auditoría');
    }

    // ---- 3a. Revalidación con fuente cambiada y fuente no única: punto real de rechazo ----
    const fuente2 = { nombre: 'Cancillería de Colombia', url: 'https://www.cancilleria.gov.co/requisitos', capturado_en: '2026-10-26T18:00:00.000Z',
      hechos: { visa: false }, algoritmo_hechos_hash: ALGORITMO_HECHOS_HASH, hechos_hash: hashHechos({ visa: false }) };
    const revDe = (f, en) => ({ tipo: 'hechos', fuente_nombre: f.nombre, url: f.url, hechos: f.hechos, algoritmo_hechos_hash: ALGORITMO_HECHOS_HASH, revalidada_en: en });
    for (const [nombre, opciones, revs, codigo] of [
      ['fuente cambiada', {}, [{ ...revalidaciones[0], hechos: { obligatorio: true, formulario: 'Check-Mig' } }], 'fuente_cambio'],
      ['fuente no única (dos fuentes, misma URL)', { fuentes: [fuente, fuente2] }, [revDe(fuente, T), revDe(fuente, T)], 'revalidacion_no_unica'],
      ['revalidación duplicada con una fuente', {}, [revalidaciones[0], revalidaciones[0]], 'revalidaciones_incompletas']
    ]) {
      const c = await sembrar(opciones), antes = await huella(c);
      let e = null;
      try { await V2.aplicarPropuestaV2(c.entrada, { adaptador: ADAPTADOR, auditoria: auditoria(c.entrada), revalidaciones: revs }, crearDeps()); } catch (x) { e = x; }
      assert.ok(e instanceof V2.ErrorRevalidacionV2 && e.codigo === codigo, `${nombre}: ${e?.codigo ?? e}`);
      await sinEscrituraDeDestino(c, antes, nombre);
      assert.equal((await col('propuestas_cambio').findOne({ propuesta_id: c.propuestaId })).estado, 'aprobada', nombre);
      assert.deepEqual(await conteos(c.propuestaId), { intentos: [], historial: 0, eventos: [] }, `${nombre}: el registro queda para H3`);
    }

    // ---- 3b. Varias fuentes con fechas distintas: vale la más antigua, en Montevideo ----
    {
      // 02:50Z = 26/10 23:50 y 03:02Z = 27/10 00:02 en Montevideo; t = 03:04Z (27/10 en Montevideo).
      const t2 = new Date('2026-10-27T03:04:00.000Z');
      const c = await sembrar({ fuentes: [fuente, fuente2] });
      const revs = [revDe(fuente, new Date('2026-10-27T02:50:00.000Z')), revDe(fuente2, new Date('2026-10-27T03:02:00.000Z'))];
      const r = await aplicar(c.entrada, { adaptador: ADAPTADOR, auditoria: auditoria(c.entrada), revalidaciones: revs }, crearDeps(() => ({ ahora: () => t2 })));
      assert.deepEqual([r.resultado, r.fecha_verificacion], ['exito', '2026-10-26'], JSON.stringify(r));
      assert.equal(await col('destinos').countDocuments({ _id: c.destinoId, requisitos: { $elemMatch: { _id: c.requisitoId, fecha_verificacion: { $type: 'string', $eq: '2026-10-26' } } } }), 1);
      const i = await col('intentos_aplicacion').findOne({ intento_id: r.intento_id });
      assert.deepEqual(i.revalidaciones.map(x => [x.url, x.revalidada_en.toISOString()]),
        [[fuente2.url, '2026-10-27T03:02:00.000Z'], [fuente.url, '2026-10-27T02:50:00.000Z']]);
      assert.equal((await col('historial_cambios').findOne({ historial_id: r.historial_id })).fecha_verificacion.nueva.valor, '2026-10-26');
    }

    // ---- 3c. E11000 dentro de la transacción: sin éxito ni escritura del destino ----
    {
      const c = await sembrar(), antes = await huella(c), ids = [uuid(), uuid(), uuid()]; let n = 0;
      await col('historial_cambios').insertOne({ historial_id: ids[2], propuesta_id: uuid(), intento_aplicacion_id: uuid() });
      const r = await aplicar(c.entrada, contexto(c.entrada), crearDeps(() => ({ uuid: () => ids[n++] })));
      assert.equal(r.resultado, 'rechazo:ErrorInconsistencia', JSON.stringify(r));
      await sinEscrituraDeDestino(c, antes, 'E11000 en la transacción');
      assert.equal((await col('propuestas_cambio').findOne({ propuesta_id: c.propuestaId })).estado, 'aprobada');
      assert.deepEqual(await conteos(c.propuestaId), { intentos: [], historial: 0, eventos: [] });
    }

    // ---- 3d. intento_id duplicado en el registro independiente (sin plan) y dentro de la transacción ----
    {
      const c = await sembrar(), ids = [uuid(), uuid(), uuid()]; let n = 0;
      await col('intentos_aplicacion').insertOne({ intento_id: ids[0], propuesta_id: uuid(), resultado: 'escritura_abortada' });
      await col('propuestas_cambio').updateOne({ propuesta_id: c.propuestaId }, { $set: { ultimo_evento_id: uuid() } });
      const r = await aplicar(c.entrada, contexto(c.entrada), crearDeps(() => ({ uuid: () => ids[n++] })));
      assert.equal(r.resultado, 'rechazo:ErrorInconsistencia', `registro independiente duplicado: ${JSON.stringify(r)}`);
      assert.deepEqual(await conteos(c.propuestaId), { intentos: [], historial: 0, eventos: [] });
      const c2 = await sembrar(), antes2 = await huella(c2), ids2 = [uuid(), uuid(), uuid()]; let m = 0;
      await col('intentos_aplicacion').insertOne({ intento_id: ids2[0], propuesta_id: uuid(), resultado: 'escritura_abortada' });
      const r2 = await aplicar(c2.entrada, contexto(c2.entrada), crearDeps(() => ({ uuid: () => ids2[m++], insertarEvento: async () => { throw new Error('fallo tras el intento'); } })));
      assert.equal(r2.resultado, 'rechazo:ErrorInconsistencia', `intento_id ajeno en la transacción: ${JSON.stringify(r2)}`);
      await sinEscrituraDeDestino(c2, antes2, 'intento_id ajeno');
      assert.deepEqual(await conteos(c2.propuestaId), { intentos: [], historial: 0, eventos: [] });
    }

    // ---- 3e. Payload guardado corrupto (hash y aprobación coherentes con él) y propuesta 1.0 ----
    {
      const c = await sembrar({ corromper: p => { p.cambios = [...p.cambios, { campo: 'costo', propuesto: valor('USD 999') }]; } }), antes = await huella(c);
      const r = await aplicar(c.entrada, contexto(c.entrada), crearDeps());
      assert.deepEqual([r.resultado, r.fallas], ['propuesta_no_aplicable', ['payload_2_0_invalido']], JSON.stringify(r));
      await sinEscrituraDeDestino(c, antes, 'payload corrupto');
      const i = await col('intentos_aplicacion').findOne({ intento_id: r.intento_id });
      assert.equal(i.etapa_fallo, 'precondiciones_propuesta');
      assert.equal(Object.hasOwn(i, 'revalidaciones'), false);
      // Propuesta 1.0 (campo costo) aprobada con el flujo 1.0 real.
      const destinoId = new ObjectId(), requisitoId = new ObjectId(), propuestaId = uuid();
      await col('destinos').insertOne({ _id: destinoId, pais: `uno-${destinoId}`, codigo_iso: 'U10', requisitos: [{ ...checkmig(requisitoId), costo: 'USD 10' }] });
      const payload = { version_contrato: '1.0', tipo_propuesta: 'actualizacion_campo_requisito', campo: 'costo', destino_id: String(destinoId), requisito_id: String(requisitoId),
        valor_anterior: { presente: true, valor: 'USD 10' }, valor_propuesto: { valor: 'USD 12', valor_normalizado: { monto: 12, moneda: 'USD' } } };
      const hash = hashSobreCanonico(payload, c.sobre.algoritmo_canonicalizacion, c.sobre.algoritmo_hash);
      await col('propuestas_cambio').insertOne({ propuesta_id: propuestaId, destino_id: destinoId, requisito_id: requisitoId, campo: 'costo', algoritmo_canonicalizacion: c.sobre.algoritmo_canonicalizacion,
        algoritmo_hash: c.sobre.algoritmo_hash, payload, payload_hash: hash, estado: 'pendiente_aprobacion', version_coordinacion: 0, decision_aprobacion_id: null, ultimo_evento_id: null });
      const e = D.validarEntrada({ tipo_evento: 'aprobacion', propuesta_id: propuestaId, estado_esperado: 'pendiente_aprobacion', payload_hash_esperado: hash, version_coordinacion_esperada: 0, decision_aprobacion_id_esperado: null });
      const ev = uuid();
      assert.equal((await col('propuestas_cambio').updateOne(D.construirFiltroCas(e), D.construirUpdateCas(e, ev, T))).matchedCount, 1);
      await col('eventos_propuesta').insertOne(D.construirEvento(e, ev, T, { actor: { tipo: 'humano', identificador: 'aprobador' }, identidad_operador: { metodo: 'oidc_google', sub: 's' }, comando: { nombre: 'panel-propuestas', version: '1' } }));
      const entrada = { propuesta_id: propuestaId, estado_esperado: 'aprobada', payload_hash_esperado: hash, version_coordinacion_esperada: 1, decision_aprobacion_id_esperado: ev };
      const r10 = await aplicar(entrada, contexto(entrada), crearDeps());
      assert.equal(r10.resultado, 'propuesta_no_aplicable', JSON.stringify(r10));
      assert.ok(r10.fallas.includes('contrato_no_2_0'), JSON.stringify(r10.fallas));
      assert.equal((await col('destinos').findOne({ _id: destinoId })).requisitos[0].costo, 'USD 10', 'el 2.0 no toca una propuesta 1.0');
      assert.equal((await col('propuestas_cambio').findOne({ propuesta_id: propuestaId })).estado, 'aprobada');
    }

    // ---- 3f. Transacción que registra el conflicto: fallo, respuesta perdida y CAS perdido ----
    {
      const conClave = () => { const id = new ObjectId(); return { requisitoId: id, objetivo: checkmig(id), requisitos: [{ ...checkmig(id), notas_internas: 'x' }] }; };
      // Fallo al insertar el evento de conflicto.
      const c1 = await sembrar(conClave()), antes1 = await huella(c1);
      const r1 = await aplicar(c1.entrada, contexto(c1.entrada), crearDeps(b => ({ insertarEvento: async (d, s) => { if (d.tipo_evento === 'conflicto') throw new Error('fallo en el conflicto'); return b.insertarEvento(d, s); } })));
      assert.equal(r1.resultado, 'rechazo:ErrorEscrituraAbortadaV2', JSON.stringify(r1));
      await sinEscrituraDeDestino(c1, antes1, 'fallo del conflicto');
      assert.equal((await col('propuestas_cambio').findOne({ propuesta_id: c1.propuestaId })).estado, 'aprobada', 'CAS del conflicto revertido');
      assert.deepEqual(await conteos(c1.propuestaId), { intentos: ['escritura_abortada'], historial: 0, eventos: [] });
      assert.equal((await col('intentos_aplicacion').findOne({ propuesta_id: c1.propuestaId })).etapa_fallo, 'transicion_por_fallo');
      const a1 = await abortadoCon(c1.propuestaId, 'desconocido', 'fallo del conflicto: código desconocido');
      assert.deepEqual([a1.resultado_no_registrado, a1.conflicto?.categoria], ['valor_actual_cambio', 'claves_desconocidas'], 'transición por fallo con el conflicto no registrado');
      // Respuesta perdida después del commit del conflicto.
      const c2 = await sembrar(conClave()); let tx2 = 0;
      const r2 = await aplicar(c2.entrada, contexto(c2.entrada), crearDeps(b => ({ ejecutarTransaccion: async fn => { const k = ++tx2; const r = await b.ejecutarTransaccion(fn); if (k === 2) throw new MongoNetworkError('respuesta perdida'); return r; } })));
      assert.deepEqual([r2.resultado, r2.confirmado_por_relectura, r2.estado_propuesta_nuevo], ['valor_actual_cambio', true, 'conflicto'], JSON.stringify(r2));
      assert.deepEqual(await conteos(c2.propuestaId), { intentos: ['valor_actual_cambio'], historial: 0, eventos: ['conflicto'] });
      // La propuesta cambia entre la transacción abortada y la del conflicto.
      const c3 = await sembrar(conClave()); let tx3 = 0;
      const r3 = await aplicar(c3.entrada, contexto(c3.entrada), crearDeps(b => ({ ejecutarTransaccion: async fn => {
        if (++tx3 === 2) await col('propuestas_cambio').updateOne({ propuesta_id: c3.propuestaId }, { $set: { estado: 'cancelada' } });
        return b.ejecutarTransaccion(fn);
      } })));
      assert.equal(r3.resultado, 'propuesta_no_aplicable', JSON.stringify(r3));
      assert.deepEqual(await conteos(c3.propuestaId), { intentos: ['propuesta_no_aplicable'], historial: 0, eventos: [] });
      assert.equal((await col('propuestas_cambio').findOne({ propuesta_id: c3.propuestaId })).estado, 'cancelada');
    }

    console.log('Aplicador 2.0 (H1): vínculo con la aprobación, CAS, gemelo, conflictos, concurrencia, matchedCount, rollback, reintento, relectura, fecha string y $unset: OK');
  } finally { await mongoose.disconnect(); await externo?.close(); await rs?.stop({ doCleanup: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
