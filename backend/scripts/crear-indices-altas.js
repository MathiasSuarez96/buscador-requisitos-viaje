/**
 * Índices que exige el alta automática (services/propuestas/altas/alta-destino-v1.js, INDICES_ALTA).
 * Los dos de `destinos` (codigo_iso_1, pais_1, únicos) YA existen en Atlas y se reutilizan: este script
 * nunca los crea ni modifica; si faltaran o tuvieran otra forma, aborta. Crea solo los de la colección
 * nueva `altas_destino`: alta_id_1 y uniq_alta_por_codigo_iso (únicos).
 *
 *   node scripts/crear-indices-altas.js --plan         Sin conexión: imprime los createIndex exactos.
 *   node scripts/crear-indices-altas.js --prechequeo   Conecta con MONGODB_URI_INDICES y corre SOLO
 *                                                      listIndexes: crear / ya_existe / conflicto.
 *   node scripts/crear-indices-altas.js --crear        Igual que el prechequeo; sin conflictos, crea los
 *                                                      faltantes de altas_destino y vuelve a verificar.
 *                                                      Requiere AUTORIZACIÓN explícita (cambio de estructura).
 * MONGODB_URI_INDICES: credencial de operador con createIndex (no la del ciclo ni la de la app).
 * Re-correrlo es seguro: lo existente da ya_existe. Salida: 0 OK · 1 error o conflicto.
 */
const { evaluarIndice, verificarConjuntoIndices } = require('../services/propuestas/indices-propuestas');
const { INDICES_ALTA } = require('../services/propuestas/altas/alta-destino-v1');

const BASE = 'buscador_requisitos';
const CREABLES = new Set(['altas_destino']);
const sinUri = t => String(t ?? '').replace(/mongodb(\+srv)?:\/\/\S+/g, '<uri>');
const crearIndice = s => `db.${s.coleccion}.createIndex(${JSON.stringify(s.clave)}, { name: '${s.nombre}', unique: true })`;

// Pura. Plan a partir de los listados actuales.
function planificar(listados) {
  return INDICES_ALTA.map(s => {
    const { estado, problemas } = evaluarIndice(listados[s.coleccion] ?? [], s);
    const accion = estado === 'crear' && !CREABLES.has(s.coleccion) ? 'conflicto' : estado;
    return { coleccion: s.coleccion, nombre: s.nombre, accion, problemas: accion === 'conflicto' && estado === 'crear' ? ['índice de destinos ausente: no lo crea este script'] : problemas ?? [] };
  });
}

async function listar(db) {
  return Object.fromEntries(await Promise.all([...new Set(INDICES_ALTA.map(s => s.coleccion))].map(async c => {
    try { return [c, await db.collection(c).indexes()]; } catch (e) { if (e?.code === 26) return [c, []]; throw e; }
  })));
}

async function main(modo, env, log) {
  if (modo === 'plan') { for (const s of INDICES_ALTA) log(`${CREABLES.has(s.coleccion) ? 'crear si falta' : 'exigir (no se crea)'}: ${crearIndice(s)}`); return 0; }
  const { MongoClient } = require('mongodb');
  if (!/^mongodb(\+srv)?:\/\//.test(env.MONGODB_URI_INDICES ?? '')) { log('MONGODB_URI_INDICES ausente.'); return 1; }
  const cliente = new MongoClient(env.MONGODB_URI_INDICES);
  try {
    await cliente.connect();
    const db = cliente.db(BASE);
    const plan = planificar(await listar(db));
    for (const p of plan) log(`${p.coleccion}.${p.nombre}: ${p.accion}${p.problemas.length ? ` (${p.problemas.join('; ')})` : ''}`);
    if (plan.some(p => p.accion === 'conflicto')) { log('Conflicto: no se crea nada.'); return 1; }
    if (modo === 'prechequeo') return 0;
    for (const p of plan.filter(x => x.accion === 'crear')) {
      const s = INDICES_ALTA.find(x => x.nombre === p.nombre && x.coleccion === p.coleccion);
      await db.collection(s.coleccion).createIndex(s.clave, { name: s.nombre, unique: true });
      log(`creado ${s.coleccion}.${s.nombre}`);
    }
    verificarConjuntoIndices(INDICES_ALTA, await listar(db));
    log('Verificación posterior: OK.');
    return 0;
  } catch (e) {
    log(`error: ${sinUri(e?.message ?? e)}`);
    return 1;
  } finally {
    await cliente.close().catch(() => {});
  }
}

module.exports = { planificar, main, CREABLES };

if (require.main === module) {
  const modo = { '--plan': 'plan', '--prechequeo': 'prechequeo', '--crear': 'crear' }[process.argv[2]];
  if (!modo || process.argv.length !== 3) { console.log('Uso: node scripts/crear-indices-altas.js --plan | --prechequeo | --crear'); process.exitCode = process.argv.length > 2 ? 1 : 0; }
  else main(modo, process.env, console.log).then(c => { process.exitCode = c; });
}
