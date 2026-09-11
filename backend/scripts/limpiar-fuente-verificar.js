/**
 * LIMPIEZA de `fuente` / `fecha_verificacion` en los requisitos
 * `documentacion_menor` que quedaron en estado "verificar" tras
 * scripts/migrar-documentacion-menor.js.
 *
 * Motivo: esa migración retiró el texto genérico incorrecto y puso
 * estado "verificar", pero dejó `fuente` y `fecha_verificacion` con
 * los valores viejos (correspondían al texto genérico ya retirado).
 * Eso contradice el principio del proyecto de que fuente/fecha solo
 * se muestran junto a un dato confirmado. Este script vacía esos dos
 * campos (los deja en null, no los elimina) para las entradas que
 * tocó esa migración.
 *
 * DRY_RUN = true (default): NO escribe nada en Atlas, solo loguea qué
 * haría.
 * DRY_RUN = false: escribe de verdad. Cambiar manualmente esta
 * variable y volver a correr el script cuando se decida ejecutar la
 * limpieza real.
 *
 * Antes de tocar nada (incluso en modo DRY_RUN) el script:
 *  1. Verifica que existe un respaldo en backend/backups/, que sea
 *     legible con bson.EJSON.parse y que contenga documentos (aborta
 *     si no hay respaldo o no es legible). Mismo chequeo que usan
 *     backup-destinos.js y migrar-documentacion-menor.js.
 *  2. Verifica que mongoose.connection.db.databaseName sea
 *     "buscador_requisitos" (aborta si no).
 *
 * Alcance acotado: solo toca requisitos[].tipo === 'documentacion_menor'
 * con estado === 'verificar' — no toca ningún otro requisito, ningún
 * otro campo, ni ningún destino cuyo documentacion_menor esté en otro
 * estado (por ejemplo, contenido específico ya confirmado).
 *
 * Nota de schema: Destino.model.js declara `fuente` y
 * `fecha_verificacion` como `required: true`. Model.updateOne (a
 * diferencia de .save()) no corre los validadores del schema por
 * default, así que el update en null se aplica igual — pero queda
 * como una inconsistencia entre el schema y este estado real de los
 * datos, documentada acá para quien lea el modelo más adelante.
 */

const DRY_RUN = true; // cambiar a false a mano para ejecutar de verdad en Atlas

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { EJSON } = require('bson');
const mongoose = require('mongoose');
const Destino = require('../models/Destino.model');

const DB_ESPERADA = 'buscador_requisitos';

function verificarRespaldoReciente() {
  const backupsDir = path.join(__dirname, '..', 'backups');
  if (!fs.existsSync(backupsDir)) {
    throw new Error(`No existe la carpeta de respaldos "${backupsDir}". Abortando limpieza.`);
  }

  const archivos = fs.readdirSync(backupsDir).filter((f) => f.endsWith('.json')).sort();
  if (archivos.length === 0) {
    throw new Error(`No hay ningún respaldo en "${backupsDir}". Abortando limpieza.`);
  }

  const ultimoArchivo = archivos[archivos.length - 1];
  const rutaCompleta = path.join(backupsDir, ultimoArchivo);

  let docs;
  try {
    const raw = fs.readFileSync(rutaCompleta, 'utf8');
    docs = EJSON.parse(raw);
  } catch (err) {
    throw new Error(`El respaldo "${ultimoArchivo}" no es legible (${err.message}). Abortando limpieza.`);
  }

  if (!Array.isArray(docs) || docs.length === 0) {
    throw new Error(`El respaldo "${ultimoArchivo}" no contiene documentos. Abortando limpieza.`);
  }

  console.log(`Respaldo verificado: "${ultimoArchivo}" (${docs.length} documentos, legible).`);
}

function calcularAlcance(requisito) {
  if (!requisito) {
    return { alcance: false, motivo: 'No existe entrada documentacion_menor en requisitos.' };
  }

  if (requisito.estado !== 'verificar') {
    return {
      alcance: false,
      motivo: `Estado actual es "${requisito.estado}", no "verificar"; fuera de alcance de este script.`
    };
  }

  if (requisito.fuente == null && requisito.fecha_verificacion == null) {
    return { alcance: false, motivo: 'fuente y fecha_verificacion ya están en null; sin cambio.' };
  }

  return {
    alcance: true,
    motivo: 'estado "verificar" con fuente/fecha_verificacion presentes; se vacían ambos campos.'
  };
}

async function main() {
  console.log(`Modo: ${DRY_RUN ? 'DRY_RUN (no escribe nada)' : 'REAL (escribe en Atlas)'}`);

  verificarRespaldoReciente();

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Conectado a MongoDB Atlas');

  const dbName = mongoose.connection.db.databaseName;
  if (dbName !== DB_ESPERADA) {
    throw new Error(
      `Base de datos inesperada: "${dbName}" (se esperaba "${DB_ESPERADA}"). Abortando limpieza.`
    );
  }

  const docs = await Destino.find({}).sort({ pais: 1 }).lean();
  console.log(`Se encontraron ${docs.length} destinos.\n`);

  let modificados = 0;
  let sinCambio = 0;

  for (const d of docs) {
    const requisito = (d.requisitos || []).find((r) => r.tipo === 'documentacion_menor');
    const resultado = calcularAlcance(requisito);

    if (!resultado.alcance) {
      sinCambio += 1;
      console.log(`${d.pais} (${d.codigo_iso}): sin cambio — ${resultado.motivo}`);
      continue;
    }

    if (DRY_RUN) {
      modificados += 1;
      console.log(`${d.pais} (${d.codigo_iso}): [DRY_RUN] se limpiaría — ${resultado.motivo}`);
      continue;
    }

    const result = await Destino.updateOne(
      { _id: d._id, 'requisitos.tipo': 'documentacion_menor' },
      {
        $set: {
          'requisitos.$[elem].fuente': null,
          'requisitos.$[elem].fecha_verificacion': null
        }
      },
      { arrayFilters: [{ 'elem.tipo': 'documentacion_menor', 'elem.estado': 'verificar' }] }
    );

    if (result.modifiedCount === 1) {
      modificados += 1;
      console.log(`${d.pais} (${d.codigo_iso}): limpiado — ${resultado.motivo}`);
    } else {
      console.warn(
        `${d.pais} (${d.codigo_iso}): se esperaba modificar 1 documento pero modifiedCount=${result.modifiedCount}.`
      );
    }
  }

  console.log(
    `\nTotal destinos: ${docs.length} | modificados${DRY_RUN ? ' (simulado)' : ''}: ${modificados} | sin cambio: ${sinCambio}`
  );
  if (modificados !== 27) {
    console.warn(`Advertencia: se esperaban 27 documentos modificados y se contaron ${modificados}.`);
  }

  if (DRY_RUN) {
    console.log('\nDRY_RUN activo: no se escribió nada en Atlas.');
  }
}

main()
  .catch((err) => {
    console.error('Error en la limpieza:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
