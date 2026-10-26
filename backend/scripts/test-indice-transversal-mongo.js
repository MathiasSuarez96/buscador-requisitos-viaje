const assert = require('node:assert/strict');
if (!globalThis.__SOLO_LOOPBACK__) throw new Error('Se requiere preload-solo-loopback');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { MongoClient, ObjectId } = require('mongodb');
const { SPEC, opciones, prechequear } = require('./preparar-indice-transversal');
const { ESTADOS_ACTIVOS, ESTADOS_PROPUESTA } = require('../services/propuestas/contrato-propuestas');

(async () => {
  let rs, cliente;
  try {
    rs = await MongoMemoryReplSet.create({ binary: { version: '8.0.32' }, replSet: { count: 1 } });
    const uri = rs.getUri('buscador_requisitos');
    assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:/);
    cliente = await new MongoClient(uri, { monitorCommands: true }).connect();
    const comandos = [];
    cliente.on('commandStarted', e => comandos.push(e.commandName));
    const db = cliente.db('buscador_requisitos');
    const c = await db.createCollection(SPEC.coleccion);
    const anterior = 'uniq_propuesta_activa_por_destino_requisito_campo';
    await c.createIndex({ destino_id: 1, requisito_id: 1, campo: 1 }, {
      name: anterior, unique: true, partialFilterExpression: { estado: { $in: ESTADOS_ACTIVOS } }
    });
    const indiceAnterior = (await c.indexes()).find(i => i.name === anterior);
    let coleccionConsultada = false;
    const cursorVacio = () => ({ toArray: async () => [] });
    await assert.rejects(prechequear({ databaseName: 'otra_base', collection() {
      coleccionConsultada = true;
      return { listIndexes: cursorVacio, find: cursorVacio };
    } }), /Base inesperada/);
    assert.equal(coleccionConsultada, false, 'base incorrecta: aborta antes de pedir una colección');
    const destino_id = new ObjectId(), requisito_id = new ObjectId();
    const doc = (campo, estado = 'pendiente_aprobacion', extra = {}) => ({ destino_id, requisito_id, campo, estado, ...extra });
    await c.insertMany([doc('costo'), doc('requisito')]);
    comandos.length = 0;
    const duplicado = await prechequear(db);
    assert.ok(comandos.every(c => ['listIndexes', 'find', 'getMore', 'killCursors'].includes(c)), 'prechequeo: solo lecturas observadas por el driver');
    assert.equal(duplicado.habilitado, false);
    assert.equal(duplicado.duplicadas.length, 1);
    await assert.rejects(c.createIndex(SPEC.clave, opciones()), e => e.code === 11000);
    assert.deepEqual((await c.indexes()).find(i => i.name === anterior), indiceAnterior, 'el fracaso conserva la definición completa del índice anterior');
    await c.deleteMany({});
    for (const valor of [null, '012345678901234567890123', 42, undefined]) {
      await c.deleteMany({});
      const p = doc('costo', 'aprobada', { requisito_id: valor });
      if (valor === undefined) delete p.requisito_id;
      await c.insertOne(p);
      let invalido = null;
      try { invalido = await prechequear(db); } catch { /* La aserción exige una clasificación, no una excepción. */ }
      assert.ok(invalido, 'BSON inválido debe clasificarse sin lanzar');
      assert.equal(invalido.habilitado, false);
      assert.equal(invalido.invalidas.length, 1);
    }
    await c.deleteMany({});
    for (const estado of ESTADOS_PROPUESTA.filter(e => !ESTADOS_ACTIVOS.includes(e))) await c.insertOne(doc('requisito', estado));
    await c.insertOne(doc('costo'));
    const historial = await prechequear(db);
    assert.equal(historial.activas, 1, 'el prechequeo ignora los cinco estados inactivos');
    assert.equal(historial.habilitado, true);
    assert.equal(historial.duplicadas.length, 0);
    assert.equal((await prechequear(db)).hash, historial.hash, 'mismos datos generan el mismo hash');
    await c.updateOne({ estado: 'pendiente_aprobacion' }, { $set: { campo: 'descripcion' } });
    assert.notEqual((await prechequear(db)).hash, historial.hash, 'el hash incluye el contenido activo, no solo su cantidad');
    await c.deleteMany({});
    assert.equal((await prechequear(db)).habilitado, true);
    await c.createIndex(SPEC.clave, { name: SPEC.nombre });
    assert.equal((await prechequear(db)).habilitado, false, 'rechaza un índice con el nombre correcto pero sin unicidad ni filtro');
    await c.dropIndex(SPEC.nombre);
    await c.createIndex(SPEC.clave, opciones());
    assert.equal((await prechequear(db)).indice.estado, 'ya_existe');
    for (const estado of ESTADOS_ACTIVOS) {
      await c.deleteMany({});
      await c.insertOne(doc('costo', estado));
      await assert.rejects(c.insertOne(doc('requisito')), e => e.code === 11000);
      for (const inactivo of ESTADOS_PROPUESTA.filter(e => !ESTADOS_ACTIVOS.includes(e))) await c.insertOne(doc('requisito', inactivo));
      await c.insertOne(doc('requisito', 'pendiente_aprobacion', { requisito_id: new ObjectId() }));
    }
    await c.deleteMany({});
    const carreras = await Promise.allSettled([c.insertOne(doc('costo')), c.insertOne(doc('requisito'))]);
    assert.equal(carreras.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(carreras.filter(r => r.status === 'rejected' && r.reason.code === 11000).length, 1);
    assert.equal(await c.countDocuments({}), 1);
    await c.dropIndex(SPEC.nombre);
    assert.deepEqual((await c.indexes()).find(i => i.name === anterior), indiceAnterior, 'rollback conserva la definición completa del índice anterior');
    await c.insertOne(doc(carreras[0].status === 'fulfilled' ? 'requisito' : 'costo'));
    assert.equal(await c.countDocuments({}), 2, 'rollback recupera la política anterior sin borrar propuestas');
    console.log('Índice transversal: duplicados y BSON inválido bloqueados en prechequeo; creación, tres estados activos, carreras y rollback comprobados en Mongo efímero.');
  } finally {
    await cliente?.close();
    await rs?.stop({ doCleanup: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
