/**
 * MIGRACIÓN de `documentacion_menor` sobre los 27 destinos de la
 * colección `destinos`.
 *
 * Misma lógica ya validada en
 * scripts/simulate-migracion-documentacion-menor.js (ver ese archivo
 * para el detalle de las reglas). Si se cambia el texto genérico o el
 * placeholder ahí, hay que cambiarlo acá también — están duplicados a
 * propósito para que este script sea autocontenido.
 *
 * DRY_RUN = true (default): NO escribe nada en Atlas, solo loguea qué
 * haría (igual que la simulación).
 * DRY_RUN = false: escribe de verdad. Cambiar manualmente esta
 * variable y volver a correr el script cuando se decida ejecutar la
 * migración real.
 *
 * Antes de tocar nada (incluso en modo DRY_RUN) el script:
 *  1. Verifica que existe un respaldo en backend/backups/, que sea
 *     legible con bson.EJSON.parse y que contenga documentos (aborta
 *     si no hay respaldo o no es legible). No usa el contenido del
 *     respaldo para la migración en sí, solo confirma que hay red de
 *     seguridad antes de escribir.
 *  2. Verifica que mongoose.connection.db.databaseName sea
 *     "buscador_requisitos" (aborta si no).
 *
 * Actualiza SOLO requisitos[].tipo === 'documentacion_menor' de cada
 * destino, vía updateOne + arrayFilters — no toca ningún otro campo
 * del documento ni ningún otro requisito.
 */

const DRY_RUN = true; // cambiar a false a mano para ejecutar de verdad en Atlas

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { EJSON } = require('bson');
const mongoose = require('mongoose');
const Destino = require('../models/Destino.model');

const DB_ESPERADA = 'buscador_requisitos';

const TEXTO_GENERICO_VIEJO =
  'Si el menor viaja sin ambos padres (con uno solo, con tercero, o solo), ' +
  'se requiere Permiso de Menor para viajar al exterior: autorización notarial, ' +
  'consular o judicial de quien no viaja. Vigencia 180 días desde emisión, ' +
  'permite de 1 a 10 viajes. Trámite ante DNIC o consulado uruguayo. ' +
  'Aplica igual para cualquier país de destino.';

const TEXTO_VERIFICAR =
  'Requisito de documentación para menores pendiente de verificar para este ' +
  'destino específico. Se retiró el texto genérico anterior porque indicaba ' +
  'un plazo (180 días) y un alcance ("aplica igual para cualquier país de ' +
  'destino") incorrectos.';

function verificarRespaldoReciente() {
  const backupsDir = path.join(__dirname, '..', 'backups');
  if (!fs.existsSync(backupsDir)) {
    throw new Error(`No existe la carpeta de respaldos "${backupsDir}". Abortando migración.`);
  }

  const archivos = fs.readdirSync(backupsDir).filter((f) => f.endsWith('.json')).sort();
  if (archivos.length === 0) {
    throw new Error(`No hay ningún respaldo en "${backupsDir}". Abortando migración.`);
  }

  const ultimoArchivo = archivos[archivos.length - 1];
  const rutaCompleta = path.join(backupsDir, ultimoArchivo);

  let docs;
  try {
    const raw = fs.readFileSync(rutaCompleta, 'utf8');
    docs = EJSON.parse(raw);
  } catch (err) {
    throw new Error(`El respaldo "${ultimoArchivo}" no es legible (${err.message}). Abortando migración.`);
  }

  if (!Array.isArray(docs) || docs.length === 0) {
    throw new Error(`El respaldo "${ultimoArchivo}" no contiene documentos. Abortando migración.`);
  }

  console.log(`Respaldo verificado: "${ultimoArchivo}" (${docs.length} documentos, legible).`);
}

function calcularPropuesta(requisito) {
  if (!requisito) {
    return {
      cambia: false,
      motivo: 'No existe entrada documentacion_menor en requisitos; no se crea una nueva.'
    };
  }

  const esTextoGenerico = requisito.descripcion === TEXTO_GENERICO_VIEJO;

  if (!esTextoGenerico) {
    return { cambia: false, motivo: 'Contenido específico existente; se conserva tal cual.' };
  }

  return {
    cambia: true,
    motivo: 'Texto genérico retirado, sin dato específico verificado; pasa a estado "verificar".'
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
      `Base de datos inesperada: "${dbName}" (se esperaba "${DB_ESPERADA}"). Abortando migración.`
    );
  }

  const docs = await Destino.find({}).sort({ pais: 1 }).lean();
  console.log(`Se encontraron ${docs.length} destinos.\n`);

  let modificados = 0;
  let sinCambio = 0;

  for (const d of docs) {
    const requisito = (d.requisitos || []).find((r) => r.tipo === 'documentacion_menor');
    const propuesta = calcularPropuesta(requisito);

    if (!propuesta.cambia) {
      sinCambio += 1;
      console.log(`${d.pais} (${d.codigo_iso}): sin cambio — ${propuesta.motivo}`);
      continue;
    }

    if (DRY_RUN) {
      modificados += 1;
      console.log(`${d.pais} (${d.codigo_iso}): [DRY_RUN] se actualizaría — ${propuesta.motivo}`);
      continue;
    }

    const result = await Destino.updateOne(
      { _id: d._id, 'requisitos.tipo': 'documentacion_menor' },
      {
        $set: {
          'requisitos.$[elem].descripcion': TEXTO_VERIFICAR,
          'requisitos.$[elem].estado': 'verificar'
        }
      },
      { arrayFilters: [{ 'elem.tipo': 'documentacion_menor' }] }
    );

    if (result.modifiedCount === 1) {
      modificados += 1;
      console.log(`${d.pais} (${d.codigo_iso}): actualizado — ${propuesta.motivo}`);
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
    console.error('Error en la migración:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
