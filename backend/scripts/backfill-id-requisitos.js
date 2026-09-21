/**
 * APLICADOR REAL (todo-o-nada) del backfill de `_id` en requisitos[]
 * de los 27 destinos — Fase 2. Cubre los pasos 3 (DRY_RUN=true) y 5
 * (DRY_RUN=false) del orden documentado en
 * generar-plan-backfill-id-requisitos.js.
 *
 * VENTANA SIN ESCRITURAS: el paso 5 (DRY_RUN=false) es el único
 * momento de todo el proceso en que se escribe en "destinos" (salvo
 * un eventual revert). Desde que arranca esa corrida hasta auditar
 * (paso 6) y desplegar el schema (paso 7), nadie más debe escribir en
 * "destinos". La API hoy no tiene ninguna ruta de escritura (solo
 * GET), así que el tráfico normal no es un riesgo; el riesgo es
 * operativo.
 *
 * SI LA AUDITORÍA POSTERIOR (paso 6) FALLA: usar
 * revertir-backfill-id-requisitos.js (DRY_RUN=true primero) sobre el
 * MISMO plan y respaldo pineados acá.
 *
 * Selección EXPLÍCITA del plan aprobado: PLAN_ARCHIVO y
 * PLAN_SHA256_ESPERADO se fijan a mano (nunca "el archivo más
 * reciente").
 *
 * Lecturas por DRIVER NATIVO, no por el modelo Mongoose. Las
 * escrituras también van por el driver nativo
 * (Destino.collection.updateOne).
 *
 * DRY_RUN = true (default): corre TODA la prevalidación (plan+hash,
 * estructura completa del plan, cobertura exacta contra Atlas,
 * respaldo+hash, hashes por destino contra el estado en vivo,
 * invariante "antes" de que nadie tenga _id todavía) sin abrir una
 * transacción de escritura.
 *
 * DRY_RUN = false: escribe de verdad, todo dentro de UNA transacción,
 * en dos fases:
 *  1. PRE-ESCRITURA: la misma prevalidación de arriba (cobertura,
 *     invariante "antes", hashes), ANTES de emitir un solo updateOne.
 *  2. Los 27 $set (uno por destino).
 *  3. POST-ESCRITURA, TODAVÍA DENTRO DE LA MISMA TRANSACCIÓN, ANTES
 *     DEL COMMIT: se relee el estado ya escrito y se revalida desde
 *     cero — cobertura, que cada _id escrito corresponde EXACTAMENTE
 *     al id_generado del plan, unicidad global de los 163 _id, y que
 *     cada requisito completo, eliminando ÚNICAMENTE `_id`, sigue
 *     coincidiendo con el respaldo (sensible a presencia: ausente !=
 *     presente en null). Cualquier diferencia en cualquiera de estos
 *     chequeos lanza un error DENTRO de la transacción —
 *     withTransaction hace rollback automático y no queda nada
 *     escrito, ni siquiera los destinos ya procesados en esa pasada.
 */

const DRY_RUN = true; // cambiar a false a mano para ejecutar de verdad en Atlas
const PLAN_ARCHIVO = 'plan-backfill-id-requisitos_2026-09-18_215334904.json'; // fijar a mano: nombre exacto del plan aprobado
const PLAN_SHA256_ESPERADO = '5b49a4f560eddbd0bbfe69a9a73f90452e123ec3108638d8901529483b71bfd8'; // fijar a mano: sha256 impreso al generar ese plan

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

function valorConPresencia(obj, clave) {
  const presente = Object.hasOwn(obj, clave);
  return { presente, valor: presente ? canonicalizarValor(obj[clave]) : null };
}

// Elimina ÚNICAMENTE `_id` y compara todas las claves restantes que
// existan en cualquiera de los dos objetos, sensible a presencia
// (ausente != presente en null).
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

function hashArchivo(rutaCompleta) {
  return crypto.createHash('sha256').update(fs.readFileSync(rutaCompleta)).digest('hex');
}

function verificarNingunoTieneId(docs) {
  for (const d of docs) {
    (d.requisitos || []).forEach((r, i) => {
      if (Object.hasOwn(r, '_id')) {
        throw new Error(`Invariante violada: ${d.pais} [${i}] (${r.tipo}) ya tiene "_id" antes de escribir. Abortando TODA la migración.`);
      }
    });
  }
}

// Validación estructural COMPLETA del plan (idéntica, a propósito, a
// la de los otros tres scripts).
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
      throw new Error(`${d.pais}: índices no son consecutivos y únicos desde 0 (encontrados: ${JSON.stringify(indices)}).`);
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
  const idsUnicos = new Set(idsGlobales);
  if (idsUnicos.size !== idsGlobales.length) {
    throw new Error(`El plan contiene ids duplicados: ${idsGlobales.length} totales, ${idsUnicos.size} únicos.`);
  }
  return new Set(destinoIds);
}

function validarCoberturaContraAtlas(destinoIdsPlan, docsVivos) {
  const idsVivos = new Set(docsVivos.map((d) => String(d._id)));
  const faltanEnPlan = [...idsVivos].filter((id) => !destinoIdsPlan.has(id));
  const faltanEnAtlas = [...destinoIdsPlan].filter((id) => !idsVivos.has(id));
  if (faltanEnPlan.length > 0 || faltanEnAtlas.length > 0) {
    throw new Error(
      `Cobertura del plan contra Atlas no es exacta. En Atlas pero no en el plan: ${JSON.stringify(faltanEnPlan)}. En el plan pero no en Atlas: ${JSON.stringify(faltanEnAtlas)}.`
    );
  }
}

function cargarPlanPineado() {
  if (!PLAN_ARCHIVO || !PLAN_SHA256_ESPERADO) {
    throw new Error('PLAN_ARCHIVO y PLAN_SHA256_ESPERADO deben fijarse a mano antes de correr este script. Abortando.');
  }
  const backupsDir = path.join(__dirname, '..', 'backups');
  const rutaPlan = path.join(backupsDir, PLAN_ARCHIVO);
  if (!fs.existsSync(rutaPlan)) throw new Error(`El plan "${PLAN_ARCHIVO}" no existe en "${backupsDir}". Abortando.`);
  const hashReal = hashArchivo(rutaPlan);
  if (hashReal !== PLAN_SHA256_ESPERADO) {
    throw new Error(`El plan "${PLAN_ARCHIVO}" tiene sha256=${hashReal}, distinto de PLAN_SHA256_ESPERADO=${PLAN_SHA256_ESPERADO}. Abortando.`);
  }
  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(rutaPlan, 'utf8'));
  } catch (err) {
    throw new Error(`El plan "${PLAN_ARCHIVO}" no es JSON legible (${err.message}). Abortando.`);
  }
  if (plan.tipo_registro !== 'plan_backfill_id_requisitos') {
    throw new Error(`El archivo "${PLAN_ARCHIVO}" no tiene tipo_registro esperado. Abortando.`);
  }
  const destinoIdsPlan = validarEstructuraPlan(plan);
  console.log(`Plan pineado verificado: "${PLAN_ARCHIVO}" (sha256 coincide, estructura válida, ${plan.destinos.length} destinos).`);
  return { plan, destinoIdsPlan };
}

// Devuelve los documentos del respaldo (ya verificado por hash) — el
// aplicador ahora los necesita para la revalidación de contenido
// posterior a la escritura, no solo para confirmar que el archivo es
// legible.
function verificarRespaldoDelPlan(plan) {
  const backupsDir = path.join(__dirname, '..', 'backups');
  if (!plan.respaldo_referencia || !plan.respaldo_hash_sha256) {
    throw new Error('El plan no registra "respaldo_referencia"/"respaldo_hash_sha256". Abortando.');
  }
  const rutaRespaldo = path.join(backupsDir, plan.respaldo_referencia);
  if (!fs.existsSync(rutaRespaldo)) throw new Error(`El respaldo referenciado por el plan ("${plan.respaldo_referencia}") no existe. Abortando.`);
  if (hashArchivo(rutaRespaldo) !== plan.respaldo_hash_sha256) {
    throw new Error(`El respaldo "${plan.respaldo_referencia}" cambió desde que se generó el plan (sha256 distinto). Abortando.`);
  }
  let docs;
  try {
    docs = EJSON.parse(fs.readFileSync(rutaRespaldo, 'utf8'));
  } catch (err) {
    throw new Error(`El respaldo "${plan.respaldo_referencia}" no es legible (${err.message}). Abortando.`);
  }
  if (!Array.isArray(docs) || docs.length === 0) throw new Error(`El respaldo "${plan.respaldo_referencia}" no contiene documentos. Abortando.`);
  console.log(`Respaldo del plan verificado: "${plan.respaldo_referencia}" (sha256 coincide, ${docs.length} documentos).`);
  return docs;
}

function validarContraPlan(docs, planPorId, destinoIdsPlan) {
  if (docs.length !== CANTIDAD_REFERENCIA) {
    throw new Error(`Se esperaban ${CANTIDAD_REFERENCIA} destinos en Atlas y se encontraron ${docs.length}.`);
  }
  validarCoberturaContraAtlas(destinoIdsPlan, docs);
  verificarNingunoTieneId(docs);
  for (const d of docs) {
    const entradaPlan = planPorId.get(String(d._id));
    if (hashRequisitos(d.requisitos) !== entradaPlan.hash_requisitos_original) {
      throw new Error(`${d.pais} (${d.codigo_iso}) cambió desde que se generó el plan (hash distinto). Abortando TODA la migración.`);
    }
  }
}

// POST-ESCRITURA, dentro de la misma transacción, ANTES del commit:
// cobertura, correspondencia exacta de cada _id con el plan, unicidad
// global, y que cada requisito completo (menos _id) sigue coincidiendo
// con el respaldo. Cualquier discrepancia lanza acá — nunca corrige
// ni advierte, siempre aborta TODO.
function validarEscrituraContraRespaldo(docsPostEscritura, planPorId, destinoIdsPlan, respaldoPorId) {
  validarCoberturaContraAtlas(destinoIdsPlan, docsPostEscritura);

  const idsGlobales = [];
  for (const d of docsPostEscritura) {
    const entradaPlan = planPorId.get(String(d._id));
    const requisitos = d.requisitos || [];
    for (const r of entradaPlan.requisitos) {
      const actualR = requisitos[r.indice];
      if (!actualR || !Object.hasOwn(actualR, '_id') || String(actualR._id) !== r.id_generado) {
        throw new Error(
          `${d.pais} [${r.indice}]: tras escribir, _id (${actualR ? actualR._id : 'ausente'}) no coincide con el plan (${r.id_generado}). Abortando TODA la migración (rollback).`
        );
      }
      idsGlobales.push(String(actualR._id));
    }
  }

  const idsUnicos = new Set(idsGlobales);
  if (idsUnicos.size !== idsGlobales.length) {
    throw new Error(`Tras escribir, hay _id duplicados: ${idsGlobales.length} totales, ${idsUnicos.size} únicos. Abortando TODA la migración (rollback).`);
  }

  for (const d of docsPostEscritura) {
    const original = respaldoPorId.get(String(d._id));
    const requisitos = d.requisitos || [];
    const requisitosOriginales = original.requisitos || [];
    if (requisitos.length !== requisitosOriginales.length) {
      throw new Error(`${d.pais}: cantidad de requisitos cambió respecto del respaldo tras escribir. Abortando TODA la migración (rollback).`);
    }
    for (let i = 0; i < requisitos.length; i++) {
      const diffs = diferenciasSinId(requisitosOriginales[i], requisitos[i]);
      if (diffs.length > 0) {
        throw new Error(
          `${d.pais} [${i}]: tras escribir, el contenido (sin _id) ya no coincide con el respaldo: ${JSON.stringify(diffs)}. Abortando TODA la migración (rollback).`
        );
      }
    }
  }
}

async function main() {
  console.log(`Modo: ${DRY_RUN ? 'DRY_RUN (no escribe nada)' : 'REAL (todo-o-nada en una transacción)'}`);
  autoverificarHashSensibleAPresencia();
  autoverificarDiffSensibleAPresencia();

  const { plan, destinoIdsPlan } = cargarPlanPineado();
  const respaldoDocs = verificarRespaldoDelPlan(plan);
  const respaldoPorId = new Map(respaldoDocs.map((d) => [String(d._id), d]));

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Conectado a MongoDB Atlas');

  const dbName = mongoose.connection.db.databaseName;
  if (dbName !== DB_ESPERADA) throw new Error(`Base de datos inesperada: "${dbName}" (se esperaba "${DB_ESPERADA}"). Abortando.`);

  const planPorId = new Map(plan.destinos.map((d) => [d.destino_id, d]));

  if (DRY_RUN) {
    const docs = await Destino.collection.find({}).sort({ pais: 1 }).toArray();
    try {
      validarContraPlan(docs, planPorId, destinoIdsPlan);
    } catch (err) {
      console.warn(`[DRY_RUN] ${err.message}`);
      console.warn('\n[DRY_RUN] La corrida real abortaría TODA la migración por lo anterior, sin escribir nada.');
      process.exitCode = 1;
      return;
    }
    docs.forEach((d) => {
      const entradaPlan = planPorId.get(String(d._id));
      console.log(`[DRY_RUN] ${d.pais} (${d.codigo_iso}): se asignarían ${entradaPlan.requisitos.length} id(s).`);
    });
    console.log('\n[DRY_RUN] Los 27 destinos coinciden con el plan (cobertura exacta) y ninguno tiene "_id" todavía. La corrida real podría aplicar sin abortar.');
    console.log('Recordatorio: abrir la ventana sin escrituras recién al pasar a DRY_RUN=false.');
    return;
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const docsPreEscritura = await Destino.collection.find({}, { session }).sort({ pais: 1 }).toArray();
      validarContraPlan(docsPreEscritura, planPorId, destinoIdsPlan);

      for (const d of docsPreEscritura) {
        const entradaPlan = planPorId.get(String(d._id));
        const set = {};
        for (const r of entradaPlan.requisitos) {
          set[`requisitos.${r.indice}._id`] = new ObjectId(r.id_generado);
        }
        const result = await Destino.collection.updateOne({ _id: d._id }, { $set: set }, { session });
        if (result.modifiedCount !== 1) {
          throw new Error(`${d.pais} (${d.codigo_iso}): se esperaba modifiedCount=1 y fue ${result.modifiedCount}. Abortando TODA la migración.`);
        }
        console.log(`${d.pais} (${d.codigo_iso}): ${entradaPlan.requisitos.length} id(s) asignado(s).`);
      }

      // POST-ESCRITURA, dentro de la misma transacción, ANTES del
      // commit: cobertura, correspondencia exacta de cada _id,
      // unicidad global, y contenido (sin _id) idéntico al respaldo.
      const docsPostEscritura = await Destino.collection.find({}, { session }).sort({ pais: 1 }).toArray();
      validarEscrituraContraRespaldo(docsPostEscritura, planPorId, destinoIdsPlan, respaldoPorId);
      console.log('Verificación previa al commit OK: cobertura, correspondencia de ids, unicidad y contenido (sin _id) coinciden con el plan/respaldo.');
    });

    console.log('\nTransacción confirmada: los 27 destinos se actualizaron atómicamente.');
    console.log('VENTANA SIN ESCRITURAS ABIERTA: no escribir nada más en "destinos" hasta desplegar el schema.');
    console.log('Siguiente paso obligatorio: correr auditar-backfill-id-requisitos.js.');
  } finally {
    await session.endSession();
  }
}

main()
  .catch((err) => {
    console.error('Error en el backfill (nada quedó escrito si esto ocurrió dentro de la transacción):', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  });
