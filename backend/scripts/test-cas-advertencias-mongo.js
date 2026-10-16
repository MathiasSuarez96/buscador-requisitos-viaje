const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const PropuestaCambio = require('../models/propuestas/PropuestaCambio.model');
const { construirFiltroCas } = require('../services/propuestas/decidir-propuesta');

if (!globalThis.__SOLO_LOOPBACK__) throw new Error('requiere preload solo-loopback');

const HASH = 'a'.repeat(64);
const GUARDADAS = ['degrada_estado_verificacion', 'quita_obligatoriedad'];
const UUID = (n) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;

function propuesta(propuestaId, advertencias) {
  return { propuesta_id: propuestaId, estado: 'pendiente_aprobacion', payload_hash: HASH, version_coordinacion: 0, decision_aprobacion_id: null, payload: { version_contrato: '2.0', advertencias } };
}

function entrada(p, advertencias, version = '2.0') {
  return construirFiltroCas({ tipo_evento: 'aprobacion', propuesta_id: p.propuesta_id, estado_esperado: p.estado, payload_hash_esperado: p.payload_hash, version_coordinacion_esperada: 0, decision_aprobacion_id_esperado: null, version_contrato_esperada: version, advertencias_aceptadas: advertencias });
}

const update = (eventoId) => ({ $set: { estado: 'aprobada', ultimo_evento_id: eventoId, updatedAt: new Date('2026-10-16T03:00:00.000Z') }, $inc: { version_coordinacion: 1 } });
const actualizar = (filtro, eventoId) => PropuestaCambio.updateOne(filtro, update(eventoId), { timestamps: false, strict: 'throw', runValidators: true });

(async () => {
  const repl = await MongoMemoryReplSet.create({ binary: { version: '8.0.32' }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
  try {
    await mongoose.connect(repl.getUri(), { dbName: 'cas_advertencias_efimero' });
    const col = PropuestaCambio.collection;
    const casos = [
      ['exacta', GUARDADAS, GUARDADAS, 1],
      ['reordenada', GUARDADAS, [...GUARDADAS].reverse(), 0],
      ['faltante', GUARDADAS, ['quita_obligatoriedad'], 0],
      ['sobrante', GUARDADAS, ['cambia_dominio_link', ...GUARDADAS], 0],
      ['mismo prefijo otra longitud', GUARDADAS, ['degrada_estado_verificacion'], 0],
      ['vacia contra vacia', [], [], 1],
      ['vacia contra una guardada', ['quita_obligatoriedad'], [], 0]
    ];
    let secuencia = 1;
    for (const [nombre, guardadas, aceptadas, esperado] of casos) {
      const p = propuesta(UUID(secuencia++), guardadas);
      await col.insertOne(p);
      const r = await actualizar(entrada(p, aceptadas), UUID(100 + secuencia));
      assert.deepStrictEqual([r.matchedCount, r.modifiedCount], [esperado, esperado], nombre);
      const despues = await col.findOne({ propuesta_id: p.propuesta_id });
      assert.deepStrictEqual(despues.payload.advertencias, guardadas, `${nombre}: payload inmutable`);
      assert.equal(despues.estado, esperado ? 'aprobada' : 'pendiente_aprobacion', `${nombre}: estado`);
      assert.equal(despues.version_coordinacion, esperado, `${nombre}: version`);
    }
    const versionDistinta = propuesta(UUID(secuencia++), GUARDADAS);
    await col.insertOne(versionDistinta);
    const noVersion = await actualizar(entrada(versionDistinta, GUARDADAS, '1.0'), UUID(200));
    assert.deepStrictEqual([noVersion.matchedCount, noVersion.modifiedCount], [0, 0], 'version distinta');

    const concurrente = propuesta(UUID(secuencia++), GUARDADAS);
    await col.insertOne(concurrente);
    const filtroCarrera = entrada(concurrente, GUARDADAS);
    const carreras = await Promise.all([actualizar(filtroCarrera, UUID(301)), actualizar(filtroCarrera, UUID(302))]);
    assert.deepStrictEqual(carreras.map((r) => r.matchedCount).sort(), [0, 1]);
    assert.equal(await col.countDocuments({ propuesta_id: concurrente.propuesta_id, estado: 'aprobada' }), 1);
    console.log('Mongo efimero + PropuestaCambio.updateOne: $eq exige array exacto, incluye [] y deja un solo ganador concurrente: OK');
  } finally {
    await mongoose.disconnect();
    await repl.stop();
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
