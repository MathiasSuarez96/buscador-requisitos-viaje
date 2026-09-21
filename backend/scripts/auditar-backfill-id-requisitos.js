/**
 * AUDITOR INDEPENDIENTE (solo lectura) del backfill de `_id` en
 * requisitos[].
 *
 * DOS MODOS, controlados por MODO_POST_SCHEMA:
 *
 * MODO_POST_SCHEMA = false (default) — modo normal, paso 6 del orden:
 * corre DESPUÉS de backfill-id-requisitos.js y ANTES de tocar el
 * schema de Mongoose (paso 7). SI FALLA: no desplegar el schema; usar
 * revertir-backfill-id-requisitos.js (DRY_RUN=true primero).
 * Chequeos, todos independientes entre sí:
 *  1. COBERTURA TRIPLE EXACTA: el conjunto de destinos del respaldo,
 *     el del plan y el de Atlas deben ser EXACTAMENTE iguales entre
 *     sí (detecta también destinos de más en el respaldo). Por cada
 *     destino, la cantidad de requisitos del respaldo, la declarada
 *     en el plan y la de Atlas deben coincidir las tres.
 *  2. INVARIANTE "DESPUÉS": TODOS los requisitos tienen un `_id`
 *     ObjectId válido.
 *  3. UNICIDAD global de los `_id`.
 *  4. INVARIANCIA DE CONTENIDO GENÉRICA, sensible a presencia.
 *  5. CORRESPONDENCIA CON EL PLAN.
 *
 * MODO_POST_SCHEMA = true — paso 8 (verificación final), DESPUÉS de
 * desplegar el diff de schema: compara, para cada requisito del plan,
 * el `_id` visto por el DRIVER NATIVO, por MONGOOSE con `.lean()`, y
 * el `id_generado` del plan. Los tres deben ser exactamente iguales.
 * Falla si cualquiera de los tres difiere — esta es la verificación
 * final documentada en el orden acordado: no queda como comprobación
 * manual.
 *
 * En ambos modos: selección EXPLÍCITA del plan aprobado (PLAN_ARCHIVO
 * + PLAN_SHA256_ESPERADO, nunca "el archivo más reciente").
 *
 * Exit code 1 si cualquier chequeo falla.
 */

const MODO_POST_SCHEMA = false; // cambiar a true a mano para la verificación final (paso 8), después de desplegar el schema
const PLAN_ARCHIVO = 'plan-backfill-id-requisitos_2026-09-18_215334904.json'; // mismo valor fijado en backfill-id-requisitos.js
const PLAN_SHA256_ESPERADO = '5b49a4f560eddbd0bbfe69a9a73f90452e123ec3108638d8901529483b71bfd8'; // mismo valor fijado en backfill-id-requisitos.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EJSON, ObjectId } = require('bson');
const mongoose = require('mongoose');
const Destino = require('../models/Destino.model');

const DB_ESPERADA = 'buscador_requisitos';
const CANTIDAD_REFERENCIA = 27;
const OBJECT_ID_HEX = /^[0-9a-fA-F]{24}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

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

function hashArchivo(rutaCompleta) {
  return crypto.createHash('sha256').update(fs.readFileSync(rutaCompleta)).digest('hex');
}

// Validación estructural COMPLETA del plan (idéntica a los otros tres
// scripts).
function validarEstructuraPlan(plan) {
  if (typeof plan.respaldo_referencia !== 'string' || plan.respaldo_referencia.length === 0) {
    throw new Error('El plan no registra "respaldo_referencia" como string no vacío.');
  }
  if (typeof plan.respaldo_hash_sha256 !== 'string' || !SHA256_HEX.test(plan.respaldo_hash_sha256)) {
    throw new Error(`respaldo_hash_sha256 "${plan.respaldo_hash_sha256}" no tiene formato SHA-256 válido.`);
  }
  if (!Array.isArray(plan.destinos) || plan.destinos.length !== CANTIDAD_REFERENCIA) {
    throw new Error(`El plan no tiene ${CANTIDAD_REFERENCIA} destinos.`);
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
      throw new Error(`destino_id "${d.destino_id}" (${d.pais}) no es un ObjectId hexadecimal válido.`);
    }
    if (typeof d.hash_requisitos_original !== 'string' || !SHA256_HEX.test(d.hash_requisitos_original)) {
      throw new Error(`${d.pais}: hash_requisitos_original no tiene formato SHA-256 válido.`);
    }
    if (!Array.isArray(d.requisitos)) throw new Error(`${d.pais} (${d.destino_id}): "requisitos" no es un array.`);
    if (d.requisitos.length !== d.cantidad_requisitos) {
      throw new Error(`${d.pais}: cantidad_requisitos=${d.cantidad_requisitos} no coincide con requisitos.length=${d.requisitos.length}.`);
    }
    const indices = d.requisitos.map((r) => r.indice).slice().sort((a, b) => a - b);
    const indicesEsperados = d.requisitos.map((_, i) => i);
    if (JSON.stringify(indices) !== JSON.stringify(indicesEsperados)) {
      throw new Error(`${d.pais}: índices no son consecutivos y únicos desde 0.`);
    }
    for (const r of d.requisitos) {
      if (typeof r.id_generado !== 'string' || !OBJECT_ID_HEX.test(r.id_generado)) {
        throw new Error(`${d.pais} [${r.indice}]: id_generado "${r.id_generado}" no es un ObjectId hexadecimal válido.`);
      }
      idsGlobales.push(r.id_generado);
    }
    totalDeclarado += d.requisitos.length;
  }
  if (totalDeclarado !== plan.cantidad_requisitos) {
    throw new Error(`cantidad_requisitos=${plan.cantidad_requisitos} no coincide con la suma real (${totalDeclarado}).`);
  }
  if (new Set(idsGlobales).size !== idsGlobales.length) throw new Error('El plan contiene ids duplicados.');
  return new Set(destinoIds);
}

function validarCoberturaTriple(idsA, idsB, idsC, nombreA, nombreB, nombreC) {
  const setA = new Set(idsA);
  const setB = new Set(idsB);
  const setC = new Set(idsC);
  const problemas = [];
  const chequear = (nA, sA, nB, sB) => {
    const faltantes = [...sA].filter((id) => !sB.has(id));
    if (faltantes.length > 0) problemas.push(`En ${nA} pero no en ${nB}: ${JSON.stringify(faltantes)}`);
  };
  chequear(nombreA, setA, nombreB, setB);
  chequear(nombreA, setA, nombreC, setC);
  chequear(nombreB, setB, nombreA, setA);
  chequear(nombreB, setB, nombreC, setC);
  chequear(nombreC, setC, nombreA, setA);
  chequear(nombreC, setC, nombreB, setB);
  if (problemas.length > 0) {
    throw new Error(`Cobertura no es exacta entre ${nombreA}/${nombreB}/${nombreC}:\n- ${problemas.join('\n- ')}`);
  }
}

function cargarPlanPineado() {
  if (!PLAN_ARCHIVO || !PLAN_SHA256_ESPERADO) {
    throw new Error('PLAN_ARCHIVO y PLAN_SHA256_ESPERADO deben fijarse a mano antes de correr este script.');
  }
  const backupsDir = path.join(__dirname, '..', 'backups');
  const rutaPlan = path.join(backupsDir, PLAN_ARCHIVO);
  if (!fs.existsSync(rutaPlan)) throw new Error(`El plan "${PLAN_ARCHIVO}" no existe en "${backupsDir}".`);
  const hashReal = hashArchivo(rutaPlan);
  if (hashReal !== PLAN_SHA256_ESPERADO) {
    throw new Error(`El plan "${PLAN_ARCHIVO}" tiene sha256=${hashReal}, distinto de PLAN_SHA256_ESPERADO=${PLAN_SHA256_ESPERADO}.`);
  }
  const plan = JSON.parse(fs.readFileSync(rutaPlan, 'utf8'));
  const destinoIdsPlan = validarEstructuraPlan(plan);
  console.log(`Plan pineado verificado: "${PLAN_ARCHIVO}" (sha256 coincide, estructura válida).`);
  return { plan, destinoIdsPlan };
}

function cargarRespaldoDelPlan(plan) {
  const backupsDir = path.join(__dirname, '..', 'backups');
  const rutaRespaldo = path.join(backupsDir, plan.respaldo_referencia);
  if (hashArchivo(rutaRespaldo) !== plan.respaldo_hash_sha256) {
    throw new Error(`El respaldo "${plan.respaldo_referencia}" cambió desde que se generó el plan (sha256 distinto).`);
  }
  const docs = EJSON.parse(fs.readFileSync(rutaRespaldo, 'utf8'));
  console.log(`Respaldo pre-migración verificado: "${plan.respaldo_referencia}" (sha256 coincide, ${docs.length} documentos).`);
  return docs;
}

function valorConPresencia(obj, clave) {
  const presente = Object.hasOwn(obj, clave);
  return { presente, valor: presente ? canonicalizarValor(obj[clave]) : null };
}

function diferenciasSinId(original, actual) {
  const { _id: _idOriginal, ...restoOriginal } = original;
  const { _id: _idActual, ...restoActual } = actual;
  const claves = new Set([...Object.keys(restoOriginal), ...Object.keys(restoActual)]);
  const diffs = [];
  for (const clave of claves) {
    const a = valorConPresencia(restoOriginal, clave);
    const b = valorConPresencia(restoActual, clave);
    if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push({ campo: clave, original: a, actual: b });
  }
  return diffs;
}

function autoverificarDiffSensibleAPresencia() {
  const diffs = diferenciasSinId({ tipo: 'x' }, { tipo: 'x', costo: null });
  if (diffs.length === 0) {
    throw new Error('Verificación interna falló: la comparación de contenido no distingue un campo ausente de un campo en null. Abortando.');
  }
}

// MODO_POST_SCHEMA = true: compara driver nativo, Mongoose .lean() y
// el plan aprobado. Falla si cualquiera de los tres muestra un _id
// distinto para cualquier requisito.
async function auditarPostSchema(plan, destinoIdsPlan) {
  const docsNativo = await Destino.collection.find({}).sort({ pais: 1 }).toArray();
  const docsMongoose = await Destino.find({}).sort({ pais: 1 }).lean();

  const fallas = [];

  if (docsNativo.length !== CANTIDAD_REFERENCIA || docsMongoose.length !== CANTIDAD_REFERENCIA) {
    fallas.push(`Cantidad de destinos inesperada: nativo=${docsNativo.length}, mongoose=${docsMongoose.length} (se esperaban ${CANTIDAD_REFERENCIA}).`);
  }

  try {
    validarCoberturaTriple(
      docsNativo.map((d) => String(d._id)),
      [...destinoIdsPlan],
      docsMongoose.map((d) => String(d._id)),
      'el driver nativo',
      'el plan',
      'Mongoose (.lean())'
    );
  } catch (err) {
    fallas.push(err.message);
  }

  const nativoPorId = new Map(docsNativo.map((d) => [String(d._id), d]));
  const mongoosePorId = new Map(docsMongoose.map((d) => [String(d._id), d]));

  for (const planDestino of plan.destinos) {
    const nativo = nativoPorId.get(planDestino.destino_id);
    const mng = mongoosePorId.get(planDestino.destino_id);
    if (!nativo || !mng) {
      fallas.push(`${planDestino.pais} (${planDestino.destino_id}): falta en la lectura nativa o en la de Mongoose.`);
      continue;
    }
    const reqNativo = nativo.requisitos || [];
    const reqMongoose = mng.requisitos || [];

    for (const r of planDestino.requisitos) {
      const rNativo = reqNativo[r.indice];
      const rMongoose = reqMongoose[r.indice];
      const idNativo = rNativo && Object.hasOwn(rNativo, '_id') ? String(rNativo._id) : null;
      const idMongoose = rMongoose && Object.hasOwn(rMongoose, '_id') ? String(rMongoose._id) : null;
      const idPlan = r.id_generado;

      if (idNativo !== idPlan || idMongoose !== idPlan || idNativo !== idMongoose) {
        fallas.push(
          `${planDestino.pais} [${r.indice}]: ids distintos entre orígenes — nativo=${idNativo}, mongoose=${idMongoose}, plan=${idPlan}.`
        );
      }
    }
  }

  if (fallas.length > 0) {
    console.error(`\n=== VERIFICACIÓN POST-SCHEMA: ${fallas.length} FALLA(S) ===`);
    fallas.forEach((f) => console.error(`- ${f}`));
    console.error('\nNO dar el backfill por confirmado: hay una discrepancia entre el driver nativo, Mongoose o el plan.');
    process.exitCode = 1;
  } else {
    console.log('\nVerificación post-schema OK: driver nativo, Mongoose .lean() y el plan coinciden en todos los _id. Ventana sin escrituras cerrada.');
  }
}

async function auditarModoNormal(plan, destinoIdsPlan) {
  const respaldo = cargarRespaldoDelPlan(plan);

  const docsActuales = await Destino.collection.find({}).sort({ pais: 1 }).toArray();

  validarCoberturaTriple(
    respaldo.map((d) => String(d._id)),
    [...destinoIdsPlan],
    docsActuales.map((d) => String(d._id)),
    'el respaldo',
    'el plan',
    'Atlas'
  );

  const respaldoPorId = new Map(respaldo.map((d) => [String(d._id), d]));
  const planPorId = new Map(plan.destinos.map((d) => [d.destino_id, d]));

  const fallas = [];
  const todosLosIds = [];

  for (const actual of docsActuales) {
    const idStr = String(actual._id);
    const original = respaldoPorId.get(idStr);
    const planDestino = planPorId.get(idStr);

    const requisitosOriginales = original.requisitos || [];
    const requisitosActuales = actual.requisitos || [];

    if (requisitosOriginales.length !== planDestino.cantidad_requisitos) {
      fallas.push(`${actual.pais}: cantidad_requisitos del plan (${planDestino.cantidad_requisitos}) no coincide con el respaldo (${requisitosOriginales.length}).`);
    }
    if (requisitosActuales.length !== planDestino.cantidad_requisitos) {
      fallas.push(`${actual.pais}: cantidad_requisitos del plan (${planDestino.cantidad_requisitos}) no coincide con Atlas (${requisitosActuales.length}).`);
    }
    if (requisitosOriginales.length !== requisitosActuales.length) {
      fallas.push(`${actual.pais}: cantidad de requisitos cambió del respaldo a Atlas (${requisitosOriginales.length} -> ${requisitosActuales.length}).`);
      continue;
    }

    for (let i = 0; i < requisitosActuales.length; i++) {
      const actualR = requisitosActuales[i];
      const originalR = requisitosOriginales[i];
      const planR = planDestino.requisitos[i];

      if (!Object.hasOwn(actualR, '_id') || !ObjectId.isValid(actualR._id)) {
        fallas.push(`${actual.pais} [${i}] (${originalR.tipo}): falta "_id" válido tras la migración.`);
        continue;
      }
      if (String(actualR._id) !== planR.id_generado) {
        fallas.push(`${actual.pais} [${i}] (${originalR.tipo}): _id escrito (${actualR._id}) no coincide con el plan (${planR.id_generado}).`);
      }
      todosLosIds.push(String(actualR._id));

      const diffs = diferenciasSinId(originalR, actualR);
      if (diffs.length > 0) {
        fallas.push(`${actual.pais} [${i}] (${originalR.tipo}): ${diffs.length} campo(s) distinto(s): ${JSON.stringify(diffs)}`);
      }
    }
  }

  const idsUnicos = new Set(todosLosIds);
  if (idsUnicos.size !== todosLosIds.length) {
    fallas.push(`Hay _id duplicados: ${todosLosIds.length} ids totales, solo ${idsUnicos.size} únicos.`);
  }

  console.log(`\nRequisitos auditados: ${todosLosIds.length}. Ids únicos: ${idsUnicos.size}.`);

  if (fallas.length > 0) {
    console.error(`\n=== ${fallas.length} FALLA(S) ENCONTRADA(S) ===`);
    fallas.forEach((f) => console.error(`- ${f}`));
    console.error('\nNO desplegar el schema. Usar revertir-backfill-id-requisitos.js (DRY_RUN=true primero).');
    process.exitCode = 1;
  } else {
    console.log('\nAuditoría OK: cobertura triple exacta, invariante "después", unicidad, invariancia de contenido sensible a presencia y correspondencia con el plan verificadas.');
    console.log('Recién ahora es seguro desplegar el schema, y correr este mismo auditor con MODO_POST_SCHEMA=true como verificación final.');
  }
}

async function main() {
  const { plan, destinoIdsPlan } = cargarPlanPineado();

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Conectado a MongoDB Atlas (solo lectura)');

  const dbName = mongoose.connection.db.databaseName;
  if (dbName !== DB_ESPERADA) throw new Error(`Base de datos inesperada: "${dbName}".`);

  if (MODO_POST_SCHEMA) {
    await auditarPostSchema(plan, destinoIdsPlan);
    return;
  }

  autoverificarDiffSensibleAPresencia();
  await auditarModoNormal(plan, destinoIdsPlan);
}

main()
  .catch((err) => {
    console.error('Error en la auditoría:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  });
