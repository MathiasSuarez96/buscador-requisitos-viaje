/**
 * MIGRACIÓN de `requisitos[].obligatorio` de Boolean a String enum
 * ('si' | 'no' | 'verificar') en los 27 destinos de la colección
 * `destinos`, acompañando el cambio de schema en Destino.model.js.
 *
 * Mapeo: true -> 'si', false -> 'no'. La auditoría de
 * scripts/auditar-requisitos.js confirmó que los 163 requisitos
 * existentes tienen `obligatorio` con un booleano real (ninguno
 * falta), así que en principio no debería haber ningún caso que
 * necesite 'verificar' en esta pasada. Si igual aparece un valor que
 * NO sea exactamente `true` o `false`, este script NO asume nada: lo
 * loguea como advertencia y lo deja sin migrar, para revisión manual.
 *
 * DRY_RUN = true (default): NO escribe nada en Atlas, solo loguea qué
 * haría.
 * DRY_RUN = false: escribe de verdad. Cambiar manualmente esta
 * variable y volver a correr el script cuando se decida ejecutar la
 * migración real.
 *
 * Antes de tocar nada (incluso en modo DRY_RUN) el script:
 *  1. Verifica que existe un respaldo en backend/backups/, que sea
 *     legible con bson.EJSON.parse y que contenga documentos (aborta
 *     si no hay respaldo o no es legible). Mismo chequeo que los
 *     scripts anteriores.
 *  2. Verifica que mongoose.connection.db.databaseName sea
 *     "buscador_requisitos" (aborta si no).
 *
 * Alcance: TODOS los requisitos[] de cada destino (no solo
 * documentacion_menor) — solo se toca el campo `obligatorio`.
 *
 * Nota importante sobre casting (por qué esto NO usa Destino.updateOne
 * como los scripts anteriores):
 * Esta migración corre DESPUÉS de cambiar el tipo de `obligatorio` en
 * el schema de Boolean a String. Si escribiéramos con el método del
 * modelo Mongoose (`Destino.updateOne(...)`), Mongoose intenta castear
 * los valores usados en `arrayFilters` (p. ej. `{ 'elem.obligatorio':
 * true }`) contra el tipo declarado en el schema — que ya es String.
 * Eso puede convertir el `true`/`false` del filtro en la cadena
 * "true"/"false" ANTES de mandar la query a Mongo, y como los
 * documentos todavía tienen el booleano real guardado, el filtro
 * dejaría de matchear (o mongoose podría directamente tirar un error
 * de cast). Para evitar esa trampa, las escrituras de este script usan
 * `Destino.collection` (el driver nativo de MongoDB que expone
 * Mongoose), que no aplica ningún casting de schema — el filtro llega
 * a Mongo tal cual, comparando booleano contra booleano. Las lecturas
 * siguen usando el modelo Mongoose con `.lean()`, que tampoco hidrata
 * ni castea nada, así que no hay riesgo ahí en ningún orden.
 */

const DRY_RUN = false; // cambiar a false a mano para ejecutar de verdad en Atlas

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
  if (docs.length !== 27) {
    console.warn(`Advertencia: se esperaban 27 destinos y se encontraron ${docs.length}.\n`);
  }

  const coleccion = Destino.collection; // driver nativo: sin casting de schema (ver nota arriba)

  let totalRequisitos = 0;
  let totalSi = 0;
  let totalNo = 0;
  let totalRaros = 0;

  for (const d of docs) {
    const requisitos = d.requisitos || [];
    totalRequisitos += requisitos.length;

    const raros = requisitos.filter((r) => r.obligatorio !== true && r.obligatorio !== false);
    raros.forEach((r) => {
      totalRaros += 1;
      console.warn(
        `${d.pais} (${d.codigo_iso}) | ${r.tipo} | obligatorio=${JSON.stringify(r.obligatorio)} no es booleano true/false — NO se migra, revisar a mano.`
      );
    });

    const trueCount = requisitos.filter((r) => r.obligatorio === true).length;
    const falseCount = requisitos.filter((r) => r.obligatorio === false).length;

    if (trueCount === 0 && falseCount === 0) {
      console.log(`${d.pais} (${d.codigo_iso}): sin valores booleanos para migrar.`);
      continue;
    }

    if (DRY_RUN) {
      totalSi += trueCount;
      totalNo += falseCount;
      console.log(
        `${d.pais} (${d.codigo_iso}): [DRY_RUN] se migrarían ${trueCount} a 'si' y ${falseCount} a 'no'.`
      );
      continue;
    }

    if (trueCount > 0) {
      const result = await coleccion.updateOne(
        { _id: d._id },
        { $set: { 'requisitos.$[elem].obligatorio': 'si' } },
        { arrayFilters: [{ 'elem.obligatorio': true }] }
      );
      if (result.modifiedCount === 1) {
        totalSi += trueCount;
      } else {
        console.warn(
          `${d.pais} (${d.codigo_iso}): se esperaba modifiedCount=1 migrando a 'si' pero fue ${result.modifiedCount}.`
        );
      }
    }

    if (falseCount > 0) {
      const result = await coleccion.updateOne(
        { _id: d._id },
        { $set: { 'requisitos.$[elem].obligatorio': 'no' } },
        { arrayFilters: [{ 'elem.obligatorio': false }] }
      );
      if (result.modifiedCount === 1) {
        totalNo += falseCount;
      } else {
        console.warn(
          `${d.pais} (${d.codigo_iso}): se esperaba modifiedCount=1 migrando a 'no' pero fue ${result.modifiedCount}.`
        );
      }
    }

    console.log(`${d.pais} (${d.codigo_iso}): migrado — ${trueCount} a 'si', ${falseCount} a 'no'.`);
  }

  console.log(
    `\nTotal requisitos: ${totalRequisitos} | migrados a 'si': ${totalSi} | migrados a 'no': ${totalNo} | casos raros sin migrar: ${totalRaros}`
  );

  const totalEsperado = totalSi + totalNo + totalRaros;
  if (totalEsperado !== totalRequisitos) {
    console.warn(
      `Advertencia: la suma (${totalEsperado}) no coincide con el total de requisitos (${totalRequisitos}).`
    );
  }
  if (totalRaros > 0) {
    console.warn(
      `Advertencia: hay ${totalRaros} requisito(s) con "obligatorio" no booleano. Revisar manualmente antes de dar la migración por completa.`
    );
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
