const assert = require('node:assert/strict');
if (!globalThis.__SOLO_LOOPBACK__) throw new Error('Se requiere preload-solo-loopback');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { MongoClient, ObjectId } = require('mongodb');
const { crearSobreRequisitoV2, hashHechos, ALGORITMO_HECHOS_HASH } = require('../services/propuestas/payload-requisito-v2');
const { capturarIdentidadEInstantanea, CAMPOS_INSTANTANEA } = require('../services/propuestas/contrato-requisito-v2');
const { construirPlan, coincideRequisito, fechaMontevideo } = require('../services/propuestas/plan-aplicacion-requisito-v2');

(async () => {
  const t = new Date('2026-10-27T01:30:00.000Z');
  const valor = valor => ({ presente: true, bson_tipo: 'string', valor });
  const ausente = { presente: false, bson_tipo: 'ausente', valor: null };
  const destinoId = new ObjectId(), requisitoId = new ObjectId();
  const requisito = { _id: requisitoId, tipo: 'formulario_digital', nombre: 'Check-Mig',
    obligatorio: 'si', descripcion: 'Descripción anterior', fuente: 'Migración Colombia',
    link: 'https://www.migracioncolombia.gov.co/checkmig', estado: 'confirmado',
    costo: null, fecha_verificacion: '2026-10-20' };
  const captura = capturarIdentidadEInstantanea(requisito);
  const hechos = { obligatorio: false, recomendado: true };
  const fuente = { nombre: 'Migración Colombia', url: 'https://www.migracioncolombia.gov.co/checkmig',
    capturado_en: '2026-10-26T18:00:00.000Z', hechos, algoritmo_hechos_hash: ALGORITMO_HECHOS_HASH, hechos_hash: hashHechos(hechos) };
  const entrada = { fecha_propuesta: '2026-10-26T19:00:00.000Z', destino_id: destinoId.toHexString(),
    requisito_id: requisitoId.toHexString(), run_id_origen: '22222222-2222-4222-8222-222222222222',
    propuesta_id: '33333333-3333-4333-8333-333333333333', ...captura,
    cambios: [{ campo: 'obligatorio', propuesto: valor('no') },
      { campo: 'recomendado', propuesto: valor('si') },
      { campo: 'link', propuesto: ausente }], fuentes: [fuente], advertencias: ['quita_obligatoriedad'] };
  const sobre = crearSobreRequisitoV2(entrada);
  const fresca = { tipo: 'hechos', fuente_nombre: fuente.nombre, url: fuente.url, hechos,
    algoritmo_hechos_hash: ALGORITMO_HECHOS_HASH, revalidada_en: t };
  assert.equal(fechaMontevideo(t), '2026-10-26', 'fecha de verificación local, no fecha UTC');
  assert.equal(coincideRequisito(sobre.payload, requisito), true);
  assert.throws(() => coincideRequisito(sobre.payload, { ...requisito, inesperado: true }), /claves desconocidas/);
  for (const revalidaciones of [[], [fresca, fresca], [{ ...fresca, url: 'https://example.com/' }],
    [{ ...fresca, hechos: { obligatorio: true } }], [{ ...fresca, tipo: 'no_disponible' }],
    [{ ...fresca, revalidada_en: new Date(t.getTime() + 1) }],
    [{ ...fresca, revalidada_en: new Date(t.getTime() - 86400000) }]]) {
    assert.throws(() => construirPlan(sobre, revalidaciones, t));
  }
  assert.throws(() => construirPlan({ ...sobre, payload_hash: '0'.repeat(64) }, [fresca], t), /payload_hash/);
  const plan = construirPlan(sobre, [fresca], t);
  const medianoche = new Date('2026-10-27T03:00:00.000Z');
  const justoAntes = new Date('2026-10-27T02:59:59.000Z');
  assert.equal(construirPlan(sobre, [{ ...fresca, revalidada_en: justoAntes }], medianoche).fecha_verificacion,
    '2026-10-26', 'la fecha proviene de revalidación, no del día de escritura');
  assert.deepEqual(Object.keys(plan.update.$set).sort(), ['requisitos.$[r].fecha_verificacion', 'requisitos.$[r].obligatorio', 'requisitos.$[r].recomendado', 'updatedAt']);
  assert.deepEqual(plan.update.$unset, { 'requisitos.$[r].link': '' });
  assert.deepEqual(plan.opciones.arrayFilters[0]['r._id'], requisitoId);
  assert.equal(Object.keys(plan.opciones.arrayFilters[0]).length, CAMPOS_INSTANTANEA.length + 3);
  let rs, cliente;
  try {
    rs = await MongoMemoryReplSet.create({ binary: { version: '8.0.32' }, replSet: { count: 1 } });
    const uri = rs.getUri('buscador_requisitos');
    assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:/);
    cliente = await new MongoClient(uri).connect();
    const c = cliente.db().collection('destinos');
    const sembrar = async requisitos => { await c.deleteMany({}); await c.insertOne({ _id: destinoId, pais: 'Colombia', requisitos }); };
    for (const campo of [...CAMPOS_INSTANTANEA, 'nombre', 'tipo']) {
      const cambiado = { ...requisito };
      if (Object.hasOwn(cambiado, campo)) delete cambiado[campo];
      else cambiado[campo] = null;
      await sembrar([cambiado]);
      assert.equal((await c.updateOne(plan.filtro, plan.update, plan.opciones)).matchedCount, 0, `CAS captura completa: ${campo}`);
    }
    for (const variante of [
      { ...requisito, obligatorio: ['si'] },
      { ...requisito, costo: [null] },
      { ...requisito, costo: '' },
      { ...requisito, fecha_verificacion: new Date('2026-10-20T00:00:00.000Z') }
    ]) {
      await sembrar([variante]);
      assert.equal((await c.updateOne(plan.filtro, plan.update, plan.opciones)).matchedCount, 0, 'CAS distingue BSON escalar, array, null y fecha');
    }
    await sembrar([requisito, requisito]);
    assert.equal((await c.updateOne(plan.filtro, plan.update, plan.opciones)).matchedCount, 0, 'rechaza requisito_id duplicado');
    await sembrar([{ ...requisito, _id: new ObjectId() }, { ...requisito, descripcion: 'Modificada después de la lectura' }]);
    assert.equal((await c.updateOne(plan.filtro, plan.update, plan.opciones)).matchedCount, 0,
      'CAS debe cumplirse en el requisito identificado, no en otro elemento idéntico');
    await sembrar([{ ...requisito, _id: new ObjectId(), nombre: 'Otro' }, requisito]);
    const antes = await c.findOne({ _id: destinoId });
    const r = await c.updateOne(plan.filtro, plan.update, plan.opciones);
    assert.equal(r.modifiedCount, 1);
    const despues = await c.findOne({ _id: destinoId });
    assert.equal(despues.requisitos[1].obligatorio, 'no');
    assert.equal(despues.requisitos[1].recomendado, 'si');
    assert.equal(Object.hasOwn(despues.requisitos[1], 'link'), false);
    assert.equal(despues.requisitos[1].fecha_verificacion, '2026-10-26');
    assert.equal(typeof despues.requisitos[1].fecha_verificacion, 'string');
    assert.equal(despues.requisitos[1].costo, null);
    assert.deepEqual(despues.requisitos[0], antes.requisitos[0], 'otros requisitos intactos');
    assert.equal((await c.updateOne(plan.filtro, plan.update, plan.opciones)).matchedCount, 0, 'no reaplica la captura anterior');
    console.log('Plan 2.0: CAS completo e identidad, BSON real, duplicados, $set/$unset declarado, fuentes vigentes y fecha Montevideo: OK');
  } finally { await cliente?.close(); await rs?.stop({ doCleanup: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
