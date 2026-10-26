// Preparación local o prechequeo con un Db inyectado. No carga .env,
// no abre conexiones y no ofrece operaciones de escritura sobre Atlas.
const { createHash } = require('node:crypto');
const { ObjectId } = require('bson');
const { ESTADOS_ACTIVOS } = require('../services/propuestas/contrato-propuestas');
const { evaluarIndice } = require('../services/propuestas/indices-propuestas');

const SPEC = {
  coleccion: 'propuestas_cambio',
  nombre: 'uniq_propuesta_activa_por_destino_requisito',
  clave: { destino_id: 1, requisito_id: 1 },
  partialFilterExpression: { estado: { $in: [...ESTADOS_ACTIVOS] } }
};
const opciones = () => ({ name: SPEC.nombre, unique: true, partialFilterExpression: SPEC.partialFilterExpression });

async function prechequear(db) {
  if (db.databaseName !== 'buscador_requisitos') throw new Error('Base inesperada');
  const coleccion = db.collection(SPEC.coleccion);
  // No se capturan payloads, destinos ni identidad de operadores.
  const indices = await coleccion.listIndexes().toArray();
  const activas = await coleccion.find({ estado: { $in: ESTADOS_ACTIVOS } }, {
    projection: { _id: 1, propuesta_id: 1, destino_id: 1, requisito_id: 1, campo: 1, estado: 1 }
  }).toArray();
  const grupos = new Map();
  const invalidas = [];
  for (const p of activas) {
    if (!(p.destino_id instanceof ObjectId) || !(p.requisito_id instanceof ObjectId)) {
      invalidas.push(String(p._id));
      continue;
    }
    const clave = `${p.destino_id.toHexString()}:${p.requisito_id.toHexString()}`;
    const grupo = grupos.get(clave) ?? [];
    grupo.push(String(p._id));
    grupos.set(clave, grupo);
  }
  const duplicadas = [...grupos.entries()].filter(([, ids]) => ids.length > 1)
    .map(([clave, ids]) => ({ clave, ids: ids.sort() })).sort((a, b) => a.clave.localeCompare(b.clave));
  const indice = evaluarIndice(indices, SPEC);
  const plan = {
    base: db.databaseName, spec: SPEC, indice, indices,
    activas: activas.length,
    propuestas_activas: activas.sort((a, b) => String(a._id).localeCompare(String(b._id))),
    invalidas: invalidas.sort(), duplicadas,
    habilitado: indice.estado !== 'conflicto' && invalidas.length === 0 && duplicadas.length === 0
  };
  // Huella de esta observación, no una autorización ni una garantía frente a carreras.
  const hash = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
  return { ...plan, hash };
}

if (require.main === module) {
  console.log(JSON.stringify({ modo: 'planificacion_local', spec: SPEC, opciones: opciones(),
    aviso: 'Sin conexión a Mongo. Falta prechequeo real, revisión y autorización antes de crear el índice.' }, null, 2));
}
module.exports = { SPEC, opciones, prechequear };
