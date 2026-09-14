/**
 * AUDITORÍA de solo lectura sobre requisitos[] de los 27 destinos.
 *
 * NO escribe nada en Atlas (ningún updateOne, ningún save). Por ser
 * solo lectura no requiere la verificación de respaldo previo que usan
 * los scripts de escritura de esta carpeta.
 *
 * Recorre TODOS los tipos de requisito (visa, formulario_digital,
 * vacuna, validez_pasaporte, documentacion_menor, tasa_aeropuerto,
 * seguro_medico), no solo documentacion_menor.
 *
 * Contrato de campos auditado (acordado antes de escribir este script;
 * el schema actual en Destino.model.js todavía no lo refleja del todo):
 *  - obligatorio: siempre debe estar presente. Hoy es Boolean; va a
 *    pasar a enum 'si'/'no'/'verificar' más adelante — esta auditoría
 *    NO migra nada, solo chequea presencia.
 *  - descripcion: siempre presente y nunca vacía.
 *  - fuente: exigida SOLO si estado === 'confirmado'. Puede faltar si
 *    estado === 'verificar'.
 *  - fecha_verificacion: misma regla que fuente.
 *  - costo: exigido (texto explícito, no vacío) SOLO si
 *    estado === 'confirmado'. Puede faltar si estado === 'verificar'.
 *  - obligatorio puede valer true/false aunque el estado general del
 *    requisito siga en "verificar": eso NO es una violación.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Destino = require('../models/Destino.model');

const DB_ESPERADA = 'buscador_requisitos';

function esVacio(valor) {
  return valor === undefined || valor === null || (typeof valor === 'string' && valor.trim() === '');
}

function auditarRequisito(requisito) {
  const violaciones = [];

  if (esVacio(requisito.obligatorio) && requisito.obligatorio !== false) {
    violaciones.push({
      campo: 'obligatorio',
      motivo: 'Falta el campo "obligatorio" (debe estar siempre presente).'
    });
  }

  if (esVacio(requisito.descripcion)) {
    violaciones.push({
      campo: 'descripcion',
      motivo: 'Falta o está vacía la "descripcion" (debe estar siempre presente y no vacía).'
    });
  }

  const confirmado = requisito.estado === 'confirmado';

  if (confirmado && esVacio(requisito.fuente)) {
    violaciones.push({
      campo: 'fuente',
      motivo: 'estado === "confirmado" pero falta "fuente".'
    });
  }

  if (confirmado && esVacio(requisito.fecha_verificacion)) {
    violaciones.push({
      campo: 'fecha_verificacion',
      motivo: 'estado === "confirmado" pero falta "fecha_verificacion".'
    });
  }

  if (confirmado && esVacio(requisito.costo)) {
    violaciones.push({
      campo: 'costo',
      motivo: 'estado === "confirmado" pero falta "costo" (debe ser texto explícito).'
    });
  }

  if (requisito.estado !== 'confirmado' && requisito.estado !== 'verificar') {
    violaciones.push({
      campo: 'estado',
      motivo: `"estado" tiene un valor inesperado: ${JSON.stringify(requisito.estado)} (se esperaba "confirmado" o "verificar").`
    });
  }

  return violaciones;
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Conectado a MongoDB Atlas');

  const dbName = mongoose.connection.db.databaseName;
  if (dbName !== DB_ESPERADA) {
    throw new Error(
      `Base de datos inesperada: "${dbName}" (se esperaba "${DB_ESPERADA}"). Abortando auditoría.`
    );
  }

  const docs = await Destino.find({}).sort({ pais: 1 }).lean();
  console.log(`Se encontraron ${docs.length} destinos.\n`);
  if (docs.length !== 27) {
    console.warn(`Advertencia: se esperaban 27 destinos y se encontraron ${docs.length}.\n`);
  }

  const todasLasViolaciones = [];
  let totalRequisitos = 0;

  for (const d of docs) {
    const requisitos = d.requisitos || [];
    for (const requisito of requisitos) {
      totalRequisitos += 1;
      const violaciones = auditarRequisito(requisito);
      for (const v of violaciones) {
        todasLasViolaciones.push({
          pais: d.pais,
          codigo_iso: d.codigo_iso,
          tipo: requisito.tipo,
          campo: v.campo,
          motivo: v.motivo
        });
      }
    }
  }

  console.log('=== VIOLACIONES ENCONTRADAS (país | tipo | campo | motivo) ===\n');
  if (todasLasViolaciones.length === 0) {
    console.log('Ninguna. Todos los requisitos cumplen el contrato auditado.\n');
  } else {
    todasLasViolaciones.forEach((v) => {
      console.log(`${v.pais} (${v.codigo_iso}) | ${v.tipo} | ${v.campo} | ${v.motivo}`);
    });
    console.log('');
  }

  const resumenPorCampo = {};
  for (const v of todasLasViolaciones) {
    resumenPorCampo[v.campo] = (resumenPorCampo[v.campo] || 0) + 1;
  }

  console.log('=== RESUMEN ===\n');
  console.log(`Destinos auditados: ${docs.length}`);
  console.log(`Requisitos auditados: ${totalRequisitos}`);
  console.log(`Total de violaciones: ${todasLasViolaciones.length}\n`);

  const camposOrdenados = ['obligatorio', 'descripcion', 'fuente', 'fecha_verificacion', 'costo', 'estado'];
  camposOrdenados.forEach((campo) => {
    if (resumenPorCampo[campo]) {
      console.log(`  - ${campo}: ${resumenPorCampo[campo]} requisito(s)`);
    }
  });
  Object.keys(resumenPorCampo)
    .filter((campo) => !camposOrdenados.includes(campo))
    .forEach((campo) => {
      console.log(`  - ${campo}: ${resumenPorCampo[campo]} requisito(s)`);
    });

  console.log('\nAuditoría de solo lectura: no se modificó nada en Atlas.');
}

main()
  .catch((err) => {
    console.error('Error en la auditoría:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
