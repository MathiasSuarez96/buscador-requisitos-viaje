/**
 * Crea en Atlas los tres índices que verificarIndices() de
 * services/propuestas/registrar-ejecucion-lectura.js exige antes de
 * escribir. Mientras falten, el servicio se niega a registrar nada.
 *
 *  - ejecuciones_lectura: run_id_1 (único)
 *  - propuestas_cambio: propuesta_id_1 (único)
 *  - propuestas_cambio: uniq_propuesta_activa_por_destino_requisito_campo
 *    (único PARCIAL sobre estados activos)
 *
 * Los specs (INDICES_REQUERIDOS) y la clasificación (evaluarIndice) se
 * importan del servicio: una forma cuenta como correcta acá si y solo
 * si el gate del servicio la acepta.
 *
 * MODO (se cambia a mano):
 *  - 'planificacion_local' (default): imprime los createIndex() exactos.
 *    NO se conecta a Mongo.
 *  - 'prechequeo_atlas': conecta, verifica databaseName, corre SOLO
 *    listIndexes() y muestra crear / ya_existe / conflicto por índice.
 *    No crea nada.
 *  - 'creacion_real': lo mismo que el prechequeo; si hay algún conflicto
 *    aborta sin crear ninguno. Si no, crea los faltantes y vuelve a
 *    verificar con listIndexes() + verificarListadoIndices() del servicio.
 *    createIndex() no es transaccional: si uno falla a mitad de camino,
 *    los anteriores quedan creados (se informa cuáles). Re-correr es
 *    seguro: los ya creados dan 'ya_existe' y se saltean.
 *
 * Uso: node scripts/crear-indices-propuestas.js
 * Pruebas offline: node scripts/test-crear-indices-propuestas.js
 */

const MODO = 'planificacion_local'; // 'planificacion_local' | 'prechequeo_atlas' | 'creacion_real'

const mongoose = require('mongoose');
const {
  INDICES_REQUERIDOS,
  evaluarIndice,
  verificarListadoIndices
} = require('../services/propuestas/registrar-ejecucion-lectura');

const DB_ESPERADA = 'buscador_requisitos';
const MODOS = ['planificacion_local', 'prechequeo_atlas', 'creacion_real'];
const COLECCIONES = [...new Set(INDICES_REQUERIDOS.map((spec) => spec.coleccion))];

function opcionesCreateIndex(spec) {
  const opciones = { name: spec.nombre, unique: true };
  if (spec.partialFilterExpression) opciones.partialFilterExpression = spec.partialFilterExpression;
  return opciones;
}

// Pura. listados: { [coleccion]: índices de listIndexes() } (una
// colección ausente del objeto se trata como inexistente).
function planificar(listados) {
  return INDICES_REQUERIDOS.map((spec) => ({ spec, ...evaluarIndice(listados[spec.coleccion] ?? [], spec) }));
}

function hayConflictos(plan) {
  return plan.some((p) => p.estado === 'conflicto');
}

function describirPlan(plan) {
  return plan.map(({ spec, estado, problemas }) => {
    const linea = `${estado.padEnd(9)} ${spec.coleccion}.${spec.nombre}`;
    return problemas.length > 0 ? `${linea}\n            ${problemas.join('\n            ')}` : linea;
  });
}

async function listarTodo(deps) {
  const listados = {};
  for (const coleccion of COLECCIONES) {
    try {
      listados[coleccion] = await deps.listarIndices(coleccion);
    } catch (err) {
      if (err.code !== 26) throw err;
      listados[coleccion] = []; // NamespaceNotFound: la colección todavía no existe
    }
  }
  return listados;
}

// deps: { conectar() -> databaseName, listarIndices(coleccion), crearIndice(coleccion, clave, opciones) }
async function ejecutar(modo, deps, log = console.log) {
  if (!MODOS.includes(modo)) throw new Error(`Modo desconocido "${modo}". Válidos: ${MODOS.join(', ')}.`);
  log(`Modo: ${modo}\n`);

  if (modo === 'planificacion_local') {
    for (const spec of INDICES_REQUERIDOS) {
      log(`db.${spec.coleccion}.createIndex(${JSON.stringify(spec.clave)}, ${JSON.stringify(opcionesCreateIndex(spec))})`);
    }
    log('\nNo hubo conexión a Mongo. El prechequeo de Atlas muestra qué haría la creación real.');
    return { modo, plan: null, creados: [] };
  }

  const dbName = await deps.conectar();
  if (dbName !== DB_ESPERADA) throw new Error(`Base de datos inesperada: "${dbName}" (se esperaba "${DB_ESPERADA}"). Abortando.`);
  log(`Conectado a "${dbName}"`);

  const plan = planificar(await listarTodo(deps));
  describirPlan(plan).forEach((linea) => log(linea));

  if (modo === 'prechequeo_atlas') {
    log(hayConflictos(plan) ? '\nHay conflictos: la creación real abortaría sin crear nada.' : '\nSin conflictos. No se creó nada.');
    return { modo, plan, creados: [] };
  }

  if (hayConflictos(plan)) throw new Error('Hay conflictos (ver arriba). No se creó ningún índice.');

  const creados = [];
  try {
    for (const { spec, estado } of plan) {
      if (estado !== 'crear') continue;
      await deps.crearIndice(spec.coleccion, spec.clave, opcionesCreateIndex(spec));
      creados.push(`${spec.coleccion}.${spec.nombre}`);
      log(`Creado: ${spec.coleccion}.${spec.nombre}`);
    }
  } catch (err) {
    err.message = `${err.message} (creados en esta corrida antes de fallar: ${creados.length ? creados.join(', ') : 'ninguno'})`;
    throw err;
  }

  log('\nReleyendo con listIndexes()...');
  const listadosFinales = await listarTodo(deps);
  describirPlan(planificar(listadosFinales)).forEach((linea) => log(linea));
  verificarListadoIndices(listadosFinales.propuestas_cambio, listadosFinales.ejecuciones_lectura);
  log('\nverificarListadoIndices() del servicio acepta el estado actual: el registro de propuestas ya puede escribir.');
  return { modo, plan, creados };
}

// No conecta al construirse: solo conectar() abre la conexión.
function crearDependenciasMongoose() {
  return {
    conectar: async () => {
      await mongoose.connect(process.env.MONGODB_URI);
      return mongoose.connection.db.databaseName;
    },
    listarIndices: (coleccion) => mongoose.connection.db.collection(coleccion).indexes(),
    crearIndice: (coleccion, clave, opciones) => mongoose.connection.db.collection(coleccion).createIndex(clave, opciones)
  };
}

if (require.main === module) {
  require('dotenv').config();
  ejecutar(MODO, crearDependenciasMongoose())
    .then(({ plan }) => {
      if (plan && hayConflictos(plan)) process.exitCode = 1;
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exitCode = 1;
    })
    .finally(async () => {
      if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    });
}

module.exports = {
  MODOS,
  DB_ESPERADA,
  opcionesCreateIndex,
  planificar,
  hayConflictos,
  describirPlan,
  ejecutar,
  crearDependenciasMongoose
};
