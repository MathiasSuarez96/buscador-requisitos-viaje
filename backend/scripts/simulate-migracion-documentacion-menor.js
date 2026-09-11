/**
 * SIMULACIÓN (dry-run) de la migración de `documentacion_menor` sobre
 * los destinos de la colección `destinos`.
 *
 * NO escribe nada en Atlas. Solo lee, calcula el valor propuesto para
 * requisitos[].tipo === 'documentacion_menor' en cada destino, y
 * muestra/guarda el resultado para revisión humana antes de construir
 * el script de migración real (que se hace aparte, después de revisar
 * esta simulación).
 *
 * Reglas aplicadas (acordadas antes de escribir este script):
 *  - El texto genérico viejo (vigencia 180 días, "aplica igual para
 *    cualquier país de destino") se retira siempre que aparezca.
 *  - Si el requisito documentacion_menor de un destino NO es ese texto
 *    genérico exacto, se asume contenido específico real y se conserva
 *    tal cual, sin tocarlo.
 *  - Si no queda contenido específico verificado tras retirar el texto
 *    genérico, el requisito pasa a estado "verificar" con un texto
 *    placeholder neutro (nunca vacío, nunca inventando un dato nuevo).
 *
 * Chequeo hecho antes de escribir este script: se inspeccionó el
 * respaldo backups/destinos_2026-09-10_220913313.json y la colección
 * reglas_generales en Atlas (solo lectura) — a la fecha no existe
 * contenido específico verificado para ningún país: los 27 destinos
 * tienen el mismo texto genérico exacto. Por eso esta simulación
 * propone estado "verificar" para los 27. Si en el futuro algún
 * destino tiene contenido específico real, este mismo script lo
 * detecta (no coincide con el texto genérico) y lo conserva sin
 * tocarlo.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
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

function timestamp() {
  const d = new Date();
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${pad(d.getMilliseconds(), 3)}`;
}

function calcularPropuesta(requisito) {
  if (!requisito) {
    return {
      cambia: false,
      valorPropuesto: null,
      motivo: 'No existe entrada documentacion_menor en requisitos; la simulación no crea una nueva.'
    };
  }

  const esTextoGenerico = requisito.descripcion === TEXTO_GENERICO_VIEJO;

  if (!esTextoGenerico) {
    return {
      cambia: false,
      valorPropuesto: requisito,
      motivo: 'Contenido específico existente (no coincide con el texto genérico viejo); se conserva tal cual.'
    };
  }

  return {
    cambia: true,
    valorPropuesto: {
      ...requisito,
      descripcion: TEXTO_VERIFICAR,
      estado: 'verificar'
    },
    motivo: 'Texto genérico retirado, sin dato específico verificado para este destino; pasa a estado "verificar".'
  };
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Conectado a MongoDB Atlas');

  const dbName = mongoose.connection.db.databaseName;
  if (dbName !== DB_ESPERADA) {
    throw new Error(
      `Base de datos inesperada: "${dbName}" (se esperaba "${DB_ESPERADA}"). Abortando simulación.`
    );
  }

  const docs = await Destino.find({}).sort({ pais: 1 }).lean();
  console.log(`Se encontraron ${docs.length} destinos.\n`);

  const resultados = docs.map((d) => {
    const requisito = (d.requisitos || []).find((r) => r.tipo === 'documentacion_menor');
    const propuesta = calcularPropuesta(requisito);
    return {
      pais: d.pais,
      codigo_iso: d.codigo_iso,
      valor_actual: requisito ? requisito.descripcion : null,
      estado_actual: requisito ? requisito.estado : null,
      cambia: propuesta.cambia,
      valor_propuesto: propuesta.valorPropuesto ? propuesta.valorPropuesto.descripcion : null,
      estado_propuesto: propuesta.valorPropuesto ? propuesta.valorPropuesto.estado : null,
      motivo: propuesta.motivo
    };
  });

  console.log('=== RESUMEN (país | estado actual -> propuesto | motivo) ===\n');
  resultados.forEach((r) => {
    console.log(`${r.pais} (${r.codigo_iso}): ${r.estado_actual} -> ${r.estado_propuesto}  |  ${r.motivo}`);
  });

  console.log('\n=== DETALLE COMPLETO (27 destinos) ===\n');
  resultados.forEach((r) => {
    console.log(`--- ${r.pais} (${r.codigo_iso}) ---`);
    console.log(`  valor actual:    ${r.valor_actual}`);
    console.log(`  valor propuesto: ${r.valor_propuesto}`);
    console.log(`  motivo: ${r.motivo}`);
    console.log('');
  });

  const cambios = resultados.filter((r) => r.cambia).length;
  console.log(
    `Total destinos: ${resultados.length} | con cambio propuesto: ${cambios} | sin cambio: ${resultados.length - cambios}`
  );

  const outDir = path.join(__dirname, 'simulacion-output');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `documentacion_menor_${timestamp()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(resultados, null, 2), { flag: 'wx' });
  console.log(`\nResultado guardado en ${outFile} (NO se escribió nada en Atlas).`);
}

main()
  .catch((err) => {
    console.error('Error en la simulación:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
