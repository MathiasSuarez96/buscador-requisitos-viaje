/**
 * Respaldo de la colección `destinos` (backend/models/Destino.model.js)
 * previo a la migración de `documentacion_menor`.
 *
 * Nota de dominio: `documentacion_menor` NO es un campo del documento —
 * es uno de los valores posibles de `requisitos[].tipo` (ver el enum en
 * Destino.model.js). Este script respalda el documento completo tal cual
 * está, sin tocar ese campo. La migración que lo reescriba deberá
 * recorrer `requisitos` buscando `tipo === 'documentacion_menor'`.
 *
 * Por qué EJSON y no JSON.stringify: JSON.stringify convertiría
 * `fecha_verificacion` (Date) y cualquier ObjectId a string plano,
 * perdiendo su tipo nativo de Mongo. bson.EJSON preserva esos tipos en
 * el archivo de respaldo. Esto es un problema de serialización,
 * distinto del bug de corrimiento de zona horaria ya resuelto en el
 * frontend (que era de parseo/renderizado de fechas al mostrarlas, no
 * de cómo se guardan los datos acá).
 *
 * Restauración: el archivo generado (backups/destinos_<timestamp>.json)
 * se lee con bson.EJSON.parse(...) para recuperar los documentos con
 * sus tipos nativos intactos. Cómo y cuándo volver a escribirlos en la
 * colección es responsabilidad de un script de restauración aparte, con
 * su propia validación de base de datos y su propio respaldo previo
 * antes de tocar datos — no se documenta acá como un snippet listo para
 * copiar/pegar.
 *
 * Lectura por DRIVER NATIVO (Destino.collection.find().toArray()), no
 * por el modelo Mongoose: preserva fielmente lo que Mongo tiene
 * guardado, sin que el schema de Mongoose oculte u omita campos que no
 * declara. Este es un respaldo general de la colección, no exclusivo
 * de ningún momento puntual: sirve igual antes y después de que un
 * requisito tenga `_id` (por ejemplo, tras el backfill de Fase 2) —
 * respalda documentos con o sin `_id` en requisitos[] tal cual estén.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { EJSON } = require('bson');
const Destino = require('../models/Destino.model');

const DB_ESPERADA = 'buscador_requisitos';
const CANTIDAD_REFERENCIA = 27; // informativo: cambia a medida que se agreguen destinos (Fase 4)

function timestamp() {
  const d = new Date();
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${pad(d.getMilliseconds(), 3)}`;
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Conectado a MongoDB Atlas');

  const dbName = mongoose.connection.db.databaseName;
  if (dbName !== DB_ESPERADA) {
    throw new Error(
      `Base de datos inesperada: "${dbName}" (se esperaba "${DB_ESPERADA}"). Abortando respaldo sin escribir archivo.`
    );
  }

  // Driver nativo, no el modelo Mongoose (ver nota de cabecera).
  const docs = await Destino.collection.find({}).sort({ pais: 1 }).toArray();
  if (docs.length === 0) {
    throw new Error(
      'La colección "destinos" no devolvió documentos (0 resultados). Abortando respaldo sin escribir archivo.'
    );
  }
  if (docs.length !== CANTIDAD_REFERENCIA) {
    console.warn(
      `Advertencia: se encontraron ${docs.length} documentos (referencia: ${CANTIDAD_REFERENCIA}). Continuando de todos modos.`
    );
  } else {
    console.log(`Se encontraron ${docs.length} documentos, como se esperaba.`);
  }

  const backupsDir = path.join(__dirname, '..', 'backups');
  fs.mkdirSync(backupsDir, { recursive: true });

  const filePath = path.join(backupsDir, `destinos_${timestamp()}.json`);
  fs.writeFileSync(filePath, EJSON.stringify(docs, null, 2, { relaxed: false }), { flag: 'wx' });

  console.log(`Respaldo escrito en ${filePath} (${docs.length} documentos).`);
}

main()
  .catch((err) => {
    console.error('Error al generar el respaldo:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
