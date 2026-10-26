const assert = require('node:assert/strict');
if (!globalThis.__SOLO_LOOPBACK__) throw new Error('Se requiere preload-solo-loopback');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { MongoClient, ObjectId } = require('mongodb');
const { SPEC, opciones, prechequear } = require('./preparar-indice-transversal');
const { ESTADOS_ACTIVOS } = require('../services/propuestas/contrato-propuestas');

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
    const destino_id = new ObjectId(), requisito_id = new ObjectId();
    const doc = (campo, estado = 'pendiente_aprobacion', extra = {}) => ({ destino_id, requisito_id, campo, estado, ...extra });
    await c.insertMany([doc('costo'), doc('requisito')]);
    comandos.length = 0;
    const duplicado = await prechequear(db);
    assert.ok(comandos.every(c => ['listIndexes', 'find', 'getMore', 'killCursors'].includes(c)), 'prechequeo: solo lecturas observadas por el driver');
    assert.equal(duplicado.habilitado, false);
    assert.equal(duplicado.duplicadas.length, 1);
    await assert.rejects(c.createIndex(SPEC.clave, opciones()), e => e.code === 11000);
    assert.ok((await c.indexes()).some(i => i.name === anterior), 'el fracaso conserva el índice anterior');
    await c.deleteMany({});
    await c.insertOne(doc('costo', 'aprobada', { requisito_id: null }));
    const invalido = await prechequear(db);
    assert.equal(invalido.habilitado, false);
    assert.equal(invalido.invalidas.length, 1);
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
      await c.insertOne(doc('requisito', 'rechazada'));
      await c.insertOne(doc('requisito', 'aplicada'));
      await c.insertOne(doc('requisito', 'pendiente_aprobacion', { requisito_id: new ObjectId() }));
    }
    await c.deleteMany({});
    const carreras = await Promise.allSettled([c.insertOne(doc('costo')), c.insertOne(doc('requisito'))]);
    assert.equal(carreras.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(carreras.filter(r => r.status === 'rejected' && r.reason.code === 11000).length, 1);
    assert.equal(await c.countDocuments({}), 1);
    await c.dropIndex(SPEC.nombre);
    assert.ok((await c.indexes()).some(i => i.name === anterior));
    await c.insertOne(doc(carreras[0].status === 'fulfilled' ? 'requisito' : 'costo'));
    assert.equal(await c.countDocuments({}), 2, 'rollback recupera la política anterior sin borrar propuestas');
    console.log('Índice transversal: duplicados y BSON inválido bloqueados en prechequeo; creación, tres estados activos, carreras y rollback comprobados en Mongo efímero.');
  } finally {
    await cliente?.close();
    await rs?.stop({ doCleanup: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
