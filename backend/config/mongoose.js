/**
 * Configuración global de Mongoose para el servidor. Tiene que cargarse
 * ANTES de registrar cualquier modelo y antes de conectar: por eso es lo
 * primero que requieren server.js y app.js.
 *
 *  - autoCreate: false — al conectar, Mongoose no envía `create` por cada
 *    modelo registrado.
 *  - autoIndex: false — no envía `createIndexes` por los índices declarados
 *    en los esquemas (Destino no lo desactiva en su esquema).
 *
 * Las colecciones y los índices se crean como pasos explícitos y
 * verificados (scripts/crear-indices-propuestas.js), nunca como efecto
 * secundario de arrancar el servidor.
 *
 * Si algún modelo ya está registrado al cargar este módulo, la
 * configuración llegó tarde: se aborta en vez de seguir con un estado
 * ambiguo.
 */

const mongoose = require('mongoose');

if (mongoose.modelNames().length > 0) {
  throw new Error(
    `config/mongoose se cargó después de registrar modelos (${mongoose.modelNames().join(', ')}); tiene que cargarse antes.`
  );
}

mongoose.set('autoCreate', false);
mongoose.set('autoIndex', false);

module.exports = mongoose;
