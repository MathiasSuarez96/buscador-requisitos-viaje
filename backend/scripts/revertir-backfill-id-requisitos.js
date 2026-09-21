/**
 * REVERSOR (todo-o-nada) del backfill de `_id` en requisitos[]. Se usa
 * SOLO si auditar-backfill-id-requisitos.js reporta fallas después de
 * un commit exitoso de backfill-id-requisitos.js.
 *
 * PRECONDICIÓN DE SEGURIDAD: revierte ÚNICAMENTE si el `_id` que hoy
 * está en vivo en cada requisito coincide EXACTAMENTE con el
 * `id_generado` que el MISMO plan pineado (PLAN_ARCHIVO,
 * PLAN_SHA256_ESPERADO — el mismo plan que usó
 * backfill-id-requisitos.js) había fijado para ese destino+índice. Si
 * un solo requisito no coincide, este script aborta COMPLETO sin
 * tocar nada: ahí no corresponde un revert automático, sino
 * investigación manual (tomar un respaldo nuevo del estado anómalo
 * para no perder evidencia, comparar a mano contra el respaldo ya
 * verificado, y restaurar el/los destino(s) puntuales con revisión
 * humana — fuera del alcance de este script).
 *
 * DRY_RUN = true (default): valida todo (plan+hash, estructura
 * completa del plan, respaldo+hash, cobertura triple respaldo/plan/
 * Atlas, que el _id en vivo coincide con el plan en los 163
 * requisitos) sin abrir transacción.
 * DRY_RUN = false: revierte de verdad.
 *
 * Todo-o-nada real: dentro de UNA transacción se hace $unset de
 * requisitos.<indice>._id para cada requisito del plan y, ANTES de
 * hacer commit — todavía dentro de la misma transacción — se relee el
 * estado ya revertido y se revalida: cobertura triple otra vez, y por
 * cada destino que hashRequisitos(requisitos sin _id) coincide
 * EXACTAMENTE con hash_requisitos_original del plan (que a su vez ya
 * fue verificado igual al respaldo cuando se generó el plan), y que
 * ningún requisito conserva `_id`. Si cualquiera de esos chequeos
 * falla, se lanza un error DENTRO de la transacción: withTransaction
 * hace rollback automático y no queda nada escrito.
 *
 * Después de que la transacción confirma el commit, se corre una
 * AUDITORÍA POSTERIOR INDEPENDIENTE: lectura fresca por driver nativo,
 * sin reusar la sesión/transacción, comparando el estado final contra
 * el respaldo desde cero. Si esta segunda auditoría falla, el commit
 * ya ocurrió pero el resultado NO está confirmado — exige
 * investigación manual inmediata, nunca un reintento automático.
 *
 * Recomendación operativa (no exigible por este script): tomar un
 * respaldo nuevo del estado actual justo antes de correr esto con
 * DRY_RUN=false, para conservar evidencia del estado que se está por
 * revertir.
 *
 * Solo por DRIVER NATIVO (Destino.collection), nunca por el modelo
 * Mongoose.
 */

const DRY_RUN = true; // cambiar a false a mano para ejecutar de verdad en Atlas
const PLAN_ARCHIVO = 'plan-backfill-id-requisitos_2026-09-18_215334904.json'; // el MISMO plan pineado que usó backfill-id-requisitos.js
const PLAN_SHA256_ESPERADO = '5b49a4f560eddbd0bbfe69a9a73f90452e123ec3108638d8901529483b71bfd8'; // el mismo valor

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

function diferenciasCompletas(original, actual) {
  const claves = new Set([...Object.keys(original), ...Object.keys(actual)]);
  const diffs = [];
  for (const clave of claves) {
    const a = valorConPresencia(original, clave);
    const b = valorConPresencia(actual, clave);
    if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push({ campo: clave, original: a, actual: b });
  }
  return diffs;
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

function validarCoberturaTriple(idsRespaldo, idsPlan, idsAtlas) {
  const setRespaldo = new Set(idsRespaldo);
  const setPlan = new Set(idsPlan);
  const setAtlas = new Set(idsAtlas);
  const problemas = [];
  const chequear = (nombreA, setA, nombreB, setB) => {
    const faltantes = [...setA].filter((id) => !setB.has(id));
    if (faltantes.length > 0) problemas.push(`En ${nombreA} pero no en ${nombreB}: ${JSON.stringify(faltantes)}`);
  };
  chequear('el respaldo', setRespaldo, 'el plan', setPlan);
  chequear('el respaldo', setRespaldo, 'Atlas', setAtlas);
  chequear('el plan', setPlan, 'el respaldo', setRespaldo);
  chequear('el plan', setPlan, 'Atlas', setAtlas);
  chequear('Atlas', setAtlas, 'el respaldo', setRespaldo);
  chequear('Atlas', setAtlas, 'el plan', setPlan);
  if (problemas.length > 0) {
    throw new Error(`Cobertura no es exacta entre respaldo/plan/Atlas:\n- ${problemas.join('\n- ')}`);
  }
}

function cargarPlanPineado() {
  if (!PLAN_ARCHIVO || !PLAN_SHA256_ESPERADO) {
    throw new Error('PLAN_ARCHIVO y PLAN_SHA256_ESPERADO deben fijarse a mano (el MISMO plan que usó backfill-id-requisitos.js). Abortando.');
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
  console.log(`Plan pineado verificado: "${PLAN_ARCHIVO}" (sha256 coincide, estructura válida).`);
  return { plan, destinoIdsPlan };
}

function cargarRespaldoDelPlan(plan) {
  const backupsDir = path.join(__dirname, '..', 'backups');
  const rutaRespaldo = path.join(backupsDir, plan.respaldo_referencia);
  if (!fs.existsSync(rutaRespaldo)) throw new Error(`El respaldo "${plan.respaldo_referencia}" no existe. Abortando.`);
  if (hashArchivo(rutaRespaldo) !== plan.respaldo_hash_sha256) {
    throw new Error(`El respaldo "${plan.respaldo_referencia}" cambió desde que se generó el plan (sha256 distinto). Abortando.`);
  }
  const docs = EJSON.parse(fs.readFileSync(rutaRespaldo, 'utf8'));
  if (!Array.isArray(docs) || docs.length === 0) throw new Error(`El respaldo "${plan.respaldo_referencia}" no contiene documentos. Abortando.`);
  console.log(`Respaldo del plan verificado: "${plan.respaldo_referencia}" (sha256 coincide, ${docs.length} documentos).`);
  return docs;
}

// Confirma que el _id EN VIVO de cada requisito coincide EXACTAMENTE
// con el id_generado del plan — condición obligatoria para que el
// revert automático sea seguro. No lanza acá: devuelve la lista de
// discrepancias para que DRY_RUN pueda reportarlas todas antes de
// decidir, y la corrida real las use para abortar.
function detectarDiscrepanciasConPlan(docsVivos, planPorId) {
  const discrepancias = [];
  for (const d of docsVivos) {
    const entradaPlan = planPorId.get(String(d._id));
    if (!entradaPlan) { discrepancias.push(`${d.pais} (${d._id}): no está en el plan.`); continue; }
    const requisitos = d.requisitos || [];
    for (const r of entradaPlan.requisitos) {
      const actualR = requisitos[r.indice];
      if (!actualR || !Object.hasOwn(actualR, '_id') || String(actualR._id) !== r.id_generado) {
        discrepancias.push(
          `${d.pais} [${r.indice}]: _id en vivo (${actualR ? actualR._id : 'ausente'}) no coincide con el plan (${r.id_generado}).`
        );
      }
    }
  }
  return discrepancias;
}

async function main() {
  console.log(`Modo: ${DRY_RUN ? 'DRY_RUN (no escribe nada)' : 'REAL (revert todo-o-nada en una transacción)'}`);
  autoverificarHashSensibleAPresencia();

  const { plan, destinoIdsPlan } = cargarPlanPineado();
  const respaldo = cargarRespaldoDelPlan(plan);

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Conectado a MongoDB Atlas');

  const dbName = mongoose.connection.db.databaseName;
  if (dbName !== DB_ESPERADA) throw new Error(`Base de datos inesperada: "${dbName}". Abortando.`);

  const planPorId = new Map(plan.destinos.map((d) => [d.destino_id, d]));
  const respaldoPorId = new Map(respaldo.map((d) => [String(d._id), d]));

  if (DRY_RUN) {
    const docsVivos = await Destino.collection.find({}).sort({ pais: 1 }).toArray();
    try {
      validarCoberturaTriple(respaldo.map((d) => String(d._id)), [...destinoIdsPlan], docsVivos.map((d) => String(d._id)));
    } catch (err) {
      console.error(`[DRY_RUN] ${err.message}`);
      console.error('\n[DRY_RUN] El revert automático abortaría por cobertura. Requiere investigación manual.');
      process.exitCode = 1;
      return;
    }

    const discrepancias = detectarDiscrepanciasConPlan(docsVivos, planPorId);
    if (discrepancias.length > 0) {
      console.error('[DRY_RUN] El _id en vivo NO coincide con el plan en estos casos — el revert automático NO correría, requiere investigación manual:');
      discrepancias.forEach((d) => console.error(`- ${d}`));
      process.exitCode = 1;
      return;
    }

    console.log('[DRY_RUN] Los 163 requisitos tienen exactamente el _id que fijó el plan. El revert real podría aplicar un $unset seguro sobre esos mismos paths.');
    return;
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const docsVivos = await Destino.collection.find({}, { session }).sort({ pais: 1 }).toArray();

      validarCoberturaTriple(respaldo.map((d) => String(d._id)), [...destinoIdsPlan], docsVivos.map((d) => String(d._id)));

      const discrepancias = detectarDiscrepanciasConPlan(docsVivos, planPorId);
      if (discrepancias.length > 0) {
        throw new Error(`El _id en vivo no coincide con el plan en ${discrepancias.length} caso(s); primero: ${discrepancias[0]}. Abortando el revert sin tocar nada.`);
      }

      // Revertir: $unset acotado a exactamente los paths que el
      // backfill escribió, nada más.
      for (const d of docsVivos) {
        const entradaPlan = planPorId.get(String(d._id));
        const unset = {};
        for (const r of entradaPlan.requisitos) {
          unset[`requisitos.${r.indice}._id`] = '';
        }
        const result = await Destino.collection.updateOne({ _id: d._id }, { $unset: unset }, { session });
        if (result.modifiedCount !== 1) {
          throw new Error(`${d.pais} (${d.codigo_iso}): se esperaba modifiedCount=1 revirtiendo y fue ${result.modifiedCount}. Abortando TODO el revert.`);
        }
      }

      // Verificación DENTRO de la transacción, ANTES del commit: se
      // relee el estado ya revertido y se revalida cobertura + hash
      // contra hash_requisitos_original del plan y la ausencia de
      // _id. Si algo no cierra, se lanza acá y withTransaction hace
      // rollback — no queda nada escrito.
      const docsRevertidos = await Destino.collection.find({}, { session }).sort({ pais: 1 }).toArray();
      validarCoberturaTriple(respaldo.map((d) => String(d._id)), [...destinoIdsPlan], docsRevertidos.map((d) => String(d._id)));
      for (const d of docsRevertidos) {
        const entradaPlan = planPorId.get(String(d._id));
        if (hashRequisitos(d.requisitos) !== entradaPlan.hash_requisitos_original) {
          throw new Error(`${d.pais} (${d.codigo_iso}): tras el $unset, el hash no coincide con hash_requisitos_original del plan. Abortando TODO el revert (rollback).`);
        }
        if ((d.requisitos || []).some((r) => Object.hasOwn(r, '_id'))) {
          throw new Error(`${d.pais} (${d.codigo_iso}): todavía queda algún requisito con "_id" tras el $unset. Abortando TODO el revert (rollback).`);
        }
      }

      console.log('Verificación previa al commit OK: cobertura y hashes coinciden con el plan/respaldo en los 27 destinos.');
    });

    console.log('\nTransacción de revert confirmada.');
  } finally {
    await session.endSession();
  }

  // Auditoría posterior INDEPENDIENTE: lectura fresca, sin reusar la
  // sesión/transacción, comparando contra el respaldo desde cero — no
  // se confía en el chequeo pre-commit de arriba.
  console.log('\nCorriendo auditoría posterior independiente...');
  const docsFinal = await Destino.collection.find({}).sort({ pais: 1 }).toArray();

  const fallas = [];
  try {
    validarCoberturaTriple(respaldo.map((d) => String(d._id)), [...destinoIdsPlan], docsFinal.map((d) => String(d._id)));
  } catch (err) {
    fallas.push(err.message);
  }

  for (const actual of docsFinal) {
    const original = respaldoPorId.get(String(actual._id));
    if (!original) continue; // ya reportado por la cobertura triple
    const requisitosOriginales = original.requisitos || [];
    const requisitosActuales = actual.requisitos || [];
    if (requisitosOriginales.length !== requisitosActuales.length) {
      fallas.push(`${actual.pais}: cantidad de requisitos distinta del respaldo tras el revert.`);
      continue;
    }
    for (let i = 0; i < requisitosActuales.length; i++) {
      const actualR = requisitosActuales[i];
      const originalR = requisitosOriginales[i];
      if (Object.hasOwn(actualR, '_id')) {
        fallas.push(`${actual.pais} [${i}] (${actualR.tipo}): todavía tiene "_id" tras el revert.`);
      }
      const diffs = diferenciasCompletas(originalR, actualR);
      if (diffs.length > 0) {
        fallas.push(`${actual.pais} [${i}] (${originalR.tipo}): ${diffs.length} campo(s) distinto(s) del respaldo: ${JSON.stringify(diffs)}`);
      }
    }
  }

  if (fallas.length > 0) {
    console.error(`\n=== AUDITORÍA POSTERIOR AL REVERT: ${fallas.length} FALLA(S) ===`);
    fallas.forEach((f) => console.error(`- ${f}`));
    console.error('\nEl commit ya ocurrió pero el resultado NO está confirmado. Investigación manual inmediata, no reintentar automáticamente.');
    process.exitCode = 1;
  } else {
    console.log('\nAuditoría posterior al revert OK: el estado coincide exactamente con el respaldo pre-migración.');
  }
}

main()
  .catch((err) => {
    console.error('Error en el revert (nada quedó escrito si esto ocurrió dentro de la transacción):', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  });
