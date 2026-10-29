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
const A1 = require('../services/propuestas/aplicar-propuesta');
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
        leerIntento: id => col('intentos_aplicacion').findOne({ intento_id: id }),
        leerHistorial: id => col('historial_cambios').findOne({ historial_id: id }),
        ...V2.dependenciasDestino(Destino.collection),
        actualizarPropuestaCas: (f, u, s) => col('propuestas_cambio').updateOne(f, u, { session: s }),
        insertarHistorial: (d, s) => col('historial_cambios').insertOne(d, { session: s }),
        insertarIntento: (d, s) => col('intentos_aplicacion').insertOne(d, { session: s }),
        insertarEvento: (d, s) => col('eventos_propuesta').insertOne(d, { session: s }),
        insertarIntentoIndependiente: d => col('intentos_aplicacion').insertOne(d, { writeConcern: { w: 'majority' } })
      };
      return { ...base, ...alterar(base) };
    }

    // Propuesta 2.0 guardada + aprobación con las funciones reales de la decisión 2.0.
    async function sembrar({ destinoId = new ObjectId(), requisitoId = new ObjectId(), requisitos, objetivo, cambios = CAMBIOS,
      advertencias = ['quita_obligatoriedad'], aprobador = 'mathias-aprobador', insertarDestino = true } = {}) {
      const objetivoReq = objetivo ?? checkmig(requisitoId);
      const reqs = requisitos ?? [visa(), objetivoReq, visa()];
      if (insertarDestino) await col('destinos').insertOne({ _id: destinoId, pais: `Colombia-${destinoId}`, codigo_iso: String(destinoId).slice(-6), requisitos: reqs, updatedAt: new Date('2026-08-18T12:00:00Z') });
      const propuestaId = uuid();
      const sobre = crearSobreRequisitoV2({ fecha_propuesta: '2026-10-26T19:00:00.000Z', destino_id: String(destinoId), requisito_id: String(requisitoId),
        run_id_origen: uuid(), propuesta_id: propuestaId, ...capturarIdentidadEInstantanea({ ...objetivoReq, _id: requisitoId }), cambios, fuentes: [fuente], advertencias });
      await col('propuestas_cambio').insertOne({ propuesta_id: propuestaId, destino_id: destinoId, requisito_id: requisitoId, campo: 'requisito',
        algoritmo_canonicalizacion: sobre.algoritmo_canonicalizacion, algoritmo_hash: sobre.algoritmo_hash, payload: structuredClone(sobre.payload), payload_hash: sobre.payload_hash,
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
    const contexto = (entrada, operador) => ({ auditoria: auditoria(entrada, operador), revalidaciones });
    // Donde se espera un resultado, un rechazo se vuelve un resultado comparable (falla por aserción).
    const aplicar = (...a) => V2.aplicarPropuestaV2(...a).catch(e => ({ resultado: `rechazo:${e?.constructor?.name}`, mensaje: String(e?.message).slice(0, 200) }));
    const leerDestino = id => col('destinos').findOne({ _id: id });
    const huella = async c => ({ destino: JSON.stringify(await leerDestino(c.destinoId)), propuesta: await col('propuestas_cambio').findOne({ propuesta_id: c.propuestaId }) });
    async function conteos(propuestaId) {
      const intentos = await col('intentos_aplicacion').find({ propuesta_id: propuestaId }).toArray();
      return { intentos: intentos.map(i => i.resultado).sort(), historial: await col('historial_cambios').countDocuments({ propuesta_id: propuestaId }),
        eventos: (await col('eventos_propuesta').find({ propuesta_id: propuestaId, tipo_evento: { $ne: 'aprobacion' } }).toArray()).map(e => e.tipo_evento).sort() };
    }
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
    assert.deepEqual(historialCo.fecha_verificacion, { anterior: valor('2026-08-18'), nueva: valor(FECHA) });
    assert.deepEqual(historialCo.cambios.map(x => x.campo), ['descripcion', 'link', 'obligatorio']);
    assert.deepEqual([eventoCo.actor.tipo, eventoCo.estado_anterior, eventoCo.estado_nuevo, eventoCo.version_coordinacion_nueva, eventoCo.intento_aplicacion_id],
      ['sistema', 'aprobada', 'aplicada', 2, r.intento_id]);
    assert.equal(eventoCo.detalle.aprobacion.evento_id, co.eventoAprobacion);
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
      let inyectado = false, lecturas = 0;
      const deps = crearDeps(b => ({ leerDestino: async (f, s) => {
        const d = await b.leerDestino(f, s);
        if (s) lecturas++;
        if (s && !inyectado) { inyectado = true; await ext.updateOne({ _id: c.destinoId, 'requisitos._id': c.requisitoId }, { $set: { 'requisitos.$.descripcion': 'CAMBIO CONCURRENTE' } }); }
        return d;
      } }));
      const rc = await aplicar(c.entrada, contexto(c.entrada), deps);
      const d = (await leerDestino(c.destinoId)).requisitos[1];
      assert.deepEqual([d.descripcion, d.obligatorio, d.link], ['CAMBIO CONCURRENTE', 'si', fuente.url], 'el cambio concurrente se conserva');
      assert.equal(rc.resultado, 'valor_actual_cambio', JSON.stringify(rc));
      assert.ok(lecturas >= 2, 'el conflicto de escritura reintentó la transacción y releyó');
      assert.ok(!(await conteos(c.propuestaId)).intentos.includes('exito'));
    }

    // ---- matchedCount 0: sin aplicación ni auditoría de éxito ----
    {
      const c = await sembrar(), antes = await huella(c);
      const deps = crearDeps(() => ({ actualizarDestino: async () => ({ matchedCount: 0, modifiedCount: 0 }) }));
      await assert.rejects(V2.aplicarPropuestaV2(c.entrada, contexto(c.entrada), deps), A1.ErrorInconsistencia);
      await sinEscrituraDeDestino(c, antes, 'matchedCount 0: destino intacto');
      assert.equal((await col('propuestas_cambio').findOne({ propuesta_id: c.propuestaId })).estado, 'aprobada', 'CAS de la propuesta revertido');
      assert.deepEqual(await conteos(c.propuestaId), { intentos: ['escritura_abortada'], historial: 0, eventos: [] });
      const c2 = await sembrar();
      const deps2 = crearDeps(() => ({ actualizarDestino: async () => ({ matchedCount: 1, modifiedCount: 0 }) }));
      await assert.rejects(V2.aplicarPropuestaV2(c2.entrada, contexto(c2.entrada), deps2), A1.ErrorInconsistencia);
      assert.ok(!(await conteos(c2.propuestaId)).intentos.includes('exito'), 'modifiedCount 0 tampoco es éxito');
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
      await assert.rejects(V2.aplicarPropuestaV2(c.entrada, { auditoria: { ...auditoria(c.entrada), operador: '' }, revalidaciones }, crearDeps()), A1.ErrorEntradaInvalida);
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
      await assert.rejects(V2.aplicarPropuestaV2(c.entrada, { auditoria: auditoria(c.entrada), revalidaciones: viejas }, crearDeps()), e => e instanceof V2.ErrorRevalidacionV2 && e.codigo === 'revalidacion_vencida');
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

    console.log('Aplicador 2.0 (H1): vínculo con la aprobación, CAS, gemelo, conflictos, concurrencia, matchedCount, rollback, reintento, relectura, fecha string y $unset: OK');
  } finally { await mongoose.disconnect(); await externo?.close(); await rs?.stop({ doCleanup: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
