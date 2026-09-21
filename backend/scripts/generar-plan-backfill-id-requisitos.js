/**
 * GENERADOR DE PLAN (solo lectura) para el backfill de `_id` en
 * requisitos[] de los 27 destinos — Fase 2.
 *
 * ORDEN EXACTO del backfill completo:
 *  0. requisitoSchema sigue con `{ _id: false }`; ningún requisito
 *     tiene `_id` en Mongo. Todos los scripts leen/escriben por el
 *     driver nativo (Destino.collection), nunca por el modelo
 *     Mongoose (salvo el auditor en su modo post-schema explícito,
 *     que compara ambos a propósito).
 *  1. Respaldo fresco con backup-destinos.js. Selección EXPLÍCITA:
 *     RESPALDO_ARCHIVO y RESPALDO_SHA256_ESPERADO se fijan a mano
 *     (nunca "el respaldo más reciente") antes de correr este script.
 *  2. ESTE script + revisión humana + fijar PLAN_ARCHIVO/
 *     PLAN_SHA256_ESPERADO en backfill-id-requisitos.js,
 *     auditar-backfill-id-requisitos.js y
 *     revertir-backfill-id-requisitos.js.
 *  3. backfill-id-requisitos.js con DRY_RUN=true + revisión humana.
 *  4. VENTANA SIN ESCRITURAS: se abre.
 *  5. backfill-id-requisitos.js con DRY_RUN=false — única escritura
 *     de todo el proceso, transacción todo-o-nada que revalida TODO
 *     (cobertura, correspondencia de ids, unicidad, contenido sin
 *     _id) DENTRO de la misma transacción, ANTES del commit.
 *  6. auditar-backfill-id-requisitos.js (modo normal). SI FALLA: usar
 *     revertir-backfill-id-requisitos.js (DRY_RUN=true primero) sobre
 *     el MISMO plan y respaldo.
 *  7. Despliegue del diff de schema — solo si el paso 6 no encontró
 *     fallas.
 *  8. VERIFICACIÓN FINAL (cierra la ventana): correr
 *     auditar-backfill-id-requisitos.js con MODO_POST_SCHEMA=true —
 *     compara driver nativo, Mongoose .lean() y el plan aprobado; no
 *     es una comprobación manual.
 *
 * VENTANA SIN ESCRITURAS (pasos 4 a 8): la API hoy solo tiene rutas
 * GET sobre destinos, así que el tráfico normal no es un riesgo. El
 * riesgo es operativo: un solo operador, una sola corrida a la vez,
 * sin ediciones manuales en Compass/mongosh mientras dure.
 *
 * SI LA AUDITORÍA (paso 6) FALLA: ver
 * revertir-backfill-id-requisitos.js.
 *
 * NO escribe nada en Atlas. Lecturas por DRIVER NATIVO
 * (Destino.collection.find().toArray()), no por el modelo Mongoose.
 *
 * Selección EXPLÍCITA del respaldo: RESPALDO_ARCHIVO y
 * RESPALDO_SHA256_ESPERADO se fijan a mano, vacíos por defecto — este
 * script NUNCA elige automáticamente "el respaldo más reciente" de la
 * carpeta. El plan conserva EXACTAMENTE esos mismos dos valores como
 * respaldo_referencia/respaldo_hash_sha256 — nunca los recalcula ni
 * "descubre" el respaldo a usar por su cuenta.
 *
 * Valida además que ese respaldo pineado coincide EXACTAMENTE (por
 * hash) con el estado vivo del que se genera el plan, y valida la
 * ESTRUCTURA completa del plan antes de escribirlo a disco.
 */

const RESPALDO_ARCHIVO = 'destinos_2026-09-18_214905672.json';
const RESPALDO_SHA256_ESPERADO = '3d8128bd1eef3e380f14704eb97174af2f1ef4748e44e78ce3f293285399932c';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EJSON, ObjectId } = require('bson');
const mongoose = require('mongoose');
const Destino = require('../models/Destino.model');

const DB_ESPERADA = 'buscador_requisitos';
const CANTIDAD_REFERENCIA = 27;
// Más estricto que ObjectId.isValid, que también acepta strings de 12
// caracteres (bytes crudos): acá solo interesa el formato hex de 24
// caracteres que efectivamente se guarda en el plan.
const OBJECT_ID_HEX = /^[0-9a-fA-F]{24}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function timestamp() {
  const d = new Date();
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${pad(d.getMilliseconds(), 3)}`;
}

// Duplicado a propósito en los cuatro scripts del backfill.
function canonicalizarValor(valor) {
  if (valor instanceof Date) return valor.toISOString();
  if (valor instanceof ObjectId) return valor.toHexString();
  if (Array.isArray(valor)) return valor.map(canonicalizarValor);
  if (valor !== null && typeof valor === 'object') {
    const claves = Object.keys(valor).sort();
    const obj = {};
    for (const k of claves) obj[k] = canonicalizarValor(valor[k]);
    return obj;
  }
  return valor === undefined ? null : valor;
}

// GARANTÍA: un objeto sin la clave X produce un canónico SIN esa
// clave; un objeto con la clave X en null produce un canónico CON esa
// clave en null. autoverificarHashSensibleAPresencia() lo comprueba
// en tiempo de ejecución, no solo por comentario.
function hashRequisitos(requisitos) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalizarValor(requisitos || []))).digest('hex');
}

function autoverificarHashSensibleAPresencia() {
  const hashAusente = hashRequisitos([{ tipo: 'x' }]);
  const hashConNull = hashRequisitos([{ tipo: 'x', costo: null }]);
  if (hashAusente === hashConNull) {
    throw new Error('Verificación interna falló: el hash no distingue un campo ausente de un campo en null. Abortando.');
  }
}

function hashArchivo(rutaCompleta) {
  return crypto.createHash('sha256').update(fs.readFileSync(rutaCompleta)).digest('hex');
}

// Selección EXPLÍCITA del respaldo: nunca "el más reciente" de la
// carpeta. RESPALDO_ARCHIVO y RESPALDO_SHA256_ESPERADO deben fijarse
// a mano antes de correr este script.
function cargarRespaldoPineado() {
  if (!RESPALDO_ARCHIVO || !RESPALDO_SHA256_ESPERADO) {
    throw new Error('RESPALDO_ARCHIVO y RESPALDO_SHA256_ESPERADO deben fijarse a mano antes de generar el plan (nunca "el respaldo más reciente"). Abortando.');
  }
  const backupsDir = path.join(__dirname, '..', 'backups');
  const rutaCompleta = path.join(backupsDir, RESPALDO_ARCHIVO);
  if (!fs.existsSync(rutaCompleta)) {
    throw new Error(`El respaldo "${RESPALDO_ARCHIVO}" no existe en "${backupsDir}". Abortando.`);
  }
  const hashReal = hashArchivo(rutaCompleta);
  if (hashReal !== RESPALDO_SHA256_ESPERADO) {
    throw new Error(`El respaldo "${RESPALDO_ARCHIVO}" tiene sha256=${hashReal}, distinto de RESPALDO_SHA256_ESPERADO=${RESPALDO_SHA256_ESPERADO}. Abortando.`);
  }
  let docs;
  try {
    docs = EJSON.parse(fs.readFileSync(rutaCompleta, 'utf8'));
  } catch (err) {
    throw new Error(`El respaldo "${RESPALDO_ARCHIVO}" no es legible (${err.message}). Abortando.`);
  }
  if (!Array.isArray(docs) || docs.length === 0) {
    throw new Error(`El respaldo "${RESPALDO_ARCHIVO}" no contiene documentos. Abortando.`);
  }
  console.log(`Respaldo pineado verificado: "${RESPALDO_ARCHIVO}" (sha256 coincide, ${docs.length} documentos).`);
  return { nombre: RESPALDO_ARCHIVO, docs, hashArchivoRespaldo: RESPALDO_SHA256_ESPERADO };
}

function verificarNingunoTieneId(docs, origen) {
  for (const d of docs) {
    (d.requisitos || []).forEach((r, i) => {
      if (Object.hasOwn(r, '_id')) {
        throw new Error(`Invariante violada (${origen}): ${d.pais} [${i}] (${r.tipo}) ya tiene "_id" antes del backfill. Abortando.`);
      }
    });
  }
}

// Validación estructural COMPLETA del plan (duplicada a propósito en
// los cuatro scripts): destino_id con formato ObjectId hex válido,
// destinos únicos, id_generado con formato ObjectId hex válido,
// hashes SHA-256 (respaldo_hash_sha256 y hash_requisitos_original por
// destino) con formato hex de 64 caracteres, índices consecutivos y
// únicos desde 0 en cada destino, y coherencia de TODAS las
// cantidades.
function validarEstructuraPlan(plan) {
  if (typeof plan.respaldo_referencia !== 'string' || plan.respaldo_referencia.length === 0) {
    throw new Error('El plan no registra "respaldo_referencia" como string no vacío.');
  }
  if (typeof plan.respaldo_hash_sha256 !== 'string' || !SHA256_HEX.test(plan.respaldo_hash_sha256)) {
    throw new Error(`respaldo_hash_sha256 "${plan.respaldo_hash_sha256}" no tiene formato SHA-256 hexadecimal válido (64 caracteres hex).`);
  }
  if (!Array.isArray(plan.destinos) || plan.destinos.length !== CANTIDAD_REFERENCIA) {
    throw new Error(`El plan no tiene ${CANTIDAD_REFERENCIA} destinos (tiene ${plan.destinos ? plan.destinos.length : 0}).`);
  }
  if (plan.cantidad_destinos !== plan.destinos.length) {
    throw new Error(`cantidad_destinos=${plan.cantidad_destinos} no coincide con destinos.length=${plan.destinos.length}.`);
  }

  const destinoIds = plan.destinos.map((d) => d.destino_id);
  if (new Set(destinoIds).size !== destinoIds.length) throw new Error('El plan tiene destino_id duplicados.');

  let totalDeclarado = 0;
  const idsGlobales = [];

  for (const d of plan.destinos) {
    if (typeof d.destino_id !== 'string' || !OBJECT_ID_HEX.test(d.destino_id)) {
      throw new Error(`destino_id "${d.destino_id}" (${d.pais}) no es un ObjectId hexadecimal de 24 caracteres válido.`);
    }
    if (typeof d.hash_requisitos_original !== 'string' || !SHA256_HEX.test(d.hash_requisitos_original)) {
      throw new Error(`${d.pais}: hash_requisitos_original "${d.hash_requisitos_original}" no tiene formato SHA-256 hexadecimal válido.`);
    }
    if (!Array.isArray(d.requisitos)) {
      throw new Error(`${d.pais} (${d.destino_id}): "requisitos" no es un array en el plan.`);
    }
    if (d.requisitos.length !== d.cantidad_requisitos) {
      throw new Error(`${d.pais}: cantidad_requisitos=${d.cantidad_requisitos} no coincide con requisitos.length=${d.requisitos.length}.`);
    }

    const indices = d.requisitos.map((r) => r.indice).slice().sort((a, b) => a - b);
    const indicesEsperados = d.requisitos.map((_, i) => i);
    if (JSON.stringify(indices) !== JSON.stringify(indicesEsperados)) {
      throw new Error(`${d.pais}: índices no son consecutivos y únicos desde 0 (encontrados: ${JSON.stringify(indices)}).`);
    }

    for (const r of d.requisitos) {
      if (typeof r.id_generado !== 'string' || !OBJECT_ID_HEX.test(r.id_generado)) {
        throw new Error(`${d.pais} [${r.indice}]: id_generado "${r.id_generado}" no es un ObjectId hexadecimal de 24 caracteres válido.`);
      }
      idsGlobales.push(r.id_generado);
    }
    totalDeclarado += d.requisitos.length;
  }

  if (totalDeclarado !== plan.cantidad_requisitos) {
    throw new Error(`El plan declara cantidad_requisitos=${plan.cantidad_requisitos} pero la suma real por destino es ${totalDeclarado}.`);
  }
  const idsUnicos = new Set(idsGlobales);
  if (idsUnicos.size !== idsGlobales.length) {
    throw new Error(`El plan contiene ids duplicados: ${idsGlobales.length} totales, ${idsUnicos.size} únicos.`);
  }

  return new Set(destinoIds);
}

async function main() {
  autoverificarHashSensibleAPresencia();

  const respaldo = cargarRespaldoPineado();
  verificarNingunoTieneId(respaldo.docs, 'respaldo');

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Conectado a MongoDB Atlas (solo lectura)');

  const dbName = mongoose.connection.db.databaseName;
  if (dbName !== DB_ESPERADA) throw new Error(`Base de datos inesperada: "${dbName}" (se esperaba "${DB_ESPERADA}"). Abortando.`);

  const docsVivos = await Destino.collection.find({}).sort({ pais: 1 }).toArray();
  console.log(`Se encontraron ${docsVivos.length} destinos en vivo.`);
  if (docsVivos.length !== CANTIDAD_REFERENCIA) {
    throw new Error(`Se esperaban ${CANTIDAD_REFERENCIA} destinos en vivo y se encontraron ${docsVivos.length}. Abortando.`);
  }
  if (respaldo.docs.length !== docsVivos.length) {
    throw new Error(`El respaldo tiene ${respaldo.docs.length} destinos y el estado vivo tiene ${docsVivos.length}. Abortando.`);
  }
  verificarNingunoTieneId(docsVivos, 'estado vivo');

  const respaldoPorId = new Map(respaldo.docs.map((d) => [String(d._id), d]));
  const discrepancias = [];
  for (const vivo of docsVivos) {
    const idStr = String(vivo._id);
    const backup = respaldoPorId.get(idStr);
    if (!backup) { discrepancias.push(`${vivo.pais} (${idStr}): existe en vivo pero no en el respaldo.`); continue; }
    if (hashRequisitos(vivo.requisitos) !== hashRequisitos(backup.requisitos)) {
      discrepancias.push(`${vivo.pais} (${idStr}): requisitos[] del respaldo no coincide con el estado vivo (hash distinto).`);
    }
  }
  for (const backup of respaldo.docs) {
    if (!docsVivos.some((v) => String(v._id) === String(backup._id))) {
      discrepancias.push(`${backup.pais} (${backup._id}): existe en el respaldo pero no en vivo.`);
    }
  }
  if (discrepancias.length > 0) {
    console.error('El respaldo pineado NO coincide con el estado vivo. Fijar un respaldo más nuevo (RESPALDO_ARCHIVO/RESPALDO_SHA256_ESPERADO) antes de reintentar:');
    discrepancias.forEach((d) => console.error(`- ${d}`));
    throw new Error('Respaldo desincronizado del estado vivo. Abortando sin generar plan.');
  }
  console.log('Respaldo pineado verificado contra el estado vivo (mismos destinos, mismo hash de requisitos[] en los 27).');

  const idsGenerados = [];
  const planDestinos = docsVivos.map((d) => {
    const requisitos = d.requisitos || [];
    const requisitosPlan = requisitos.map((r, indice) => {
      const idGenerado = new ObjectId();
      idsGenerados.push(idGenerado.toHexString());
      return { indice, tipo: r.tipo, nombre: r.nombre ?? null, id_generado: idGenerado.toHexString() };
    });
    return {
      destino_id: String(d._id),
      pais: d.pais,
      codigo_iso: d.codigo_iso,
      cantidad_requisitos: requisitos.length,
      hash_requisitos_original: hashRequisitos(requisitos),
      requisitos: requisitosPlan
    };
  });

  const totalRequisitos = planDestinos.reduce((acc, d) => acc + d.requisitos.length, 0);

  // El plan conserva EXACTAMENTE los valores pineados — nunca los
  // recalcula ni elige otro respaldo por su cuenta.
  const plan = {
    tipo_registro: 'plan_backfill_id_requisitos',
    generado_en: new Date().toISOString(),
    respaldo_referencia: respaldo.nombre,
    respaldo_hash_sha256: respaldo.hashArchivoRespaldo,
    cantidad_destinos: planDestinos.length,
    cantidad_requisitos: totalRequisitos,
    destinos: planDestinos
  };

  validarEstructuraPlan(plan);
  console.log(`Plan estructuralmente válido: ${totalRequisitos} requisitos, ids únicos, índices consecutivos por destino, hashes con formato correcto.`);

  const backupsDir = path.join(__dirname, '..', 'backups');
  const nombrePlan = `plan-backfill-id-requisitos_${timestamp()}.json`;
  const planFile = path.join(backupsDir, nombrePlan);
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2), { flag: 'wx' });

  console.log(`\nPlan guardado en ${planFile}.`);
  console.log(`PLAN_ARCHIVO = '${nombrePlan}'`);
  console.log(`PLAN_SHA256_ESPERADO = '${hashArchivo(planFile)}'`);
  console.log('\nCopiar esas dos constantes en backfill-id-requisitos.js, auditar-backfill-id-requisitos.js y revertir-backfill-id-requisitos.js recién después de revisar el plan a mano.');
  console.log('No se escribió nada en Atlas.');
}

main()
  .catch((err) => {
    console.error('Error generando el plan:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  });
