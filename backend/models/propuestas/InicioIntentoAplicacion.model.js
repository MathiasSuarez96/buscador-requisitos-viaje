/**
 * inicios_intento_aplicacion: registro APPEND-ONLY del ARRANQUE de cada
 * intento de aplicación, escrito como insert independiente (fuera de
 * toda transacción, writeConcern majority) justo antes de la
 * revalidación externa.
 *
 * Existe para detectar procesos INTERRUMPIDOS: si el proceso muere
 * entre el arranque y el registro del intento terminado (por ejemplo,
 * después de abortar la transacción de escritura y antes de insertar el
 * IntentoAplicacion fallido), queda un inicio sin intento terminado con
 * el mismo intento_id. Auditoría: inicios sin IntentoAplicacion
 * correspondiente y con iniciado_en más viejo que el tiempo máximo de
 * un intento => intento interrumpido.
 *
 * intentos_aplicacion sigue guardando solo intentos TERMINADOS; esta
 * colección nunca se actualiza para "cerrar" un inicio (eso rompería el
 * append-only). La correspondencia es por intento_id.
 *
 * Los campos de contexto (propuesta, hash, versión, operador, proceso
 * aplicador, adaptador) se repiten acá a propósito: si el proceso
 * muere, este documento es la ÚNICA evidencia de ese intento. Mismos
 * roles separados que IntentoAplicacion (ver contrato-propuestas.js).
 */

const mongoose = require('mongoose');

const SHA256_HEX = /^[0-9a-f]{64}$/;

// MVP: el operador siempre es un humano que corre el comando administrativo.
const operadorSchema = new mongoose.Schema(
  {
    tipo: { type: String, required: true, enum: ['humano'] },
    identificador: { type: String, required: true }
  },
  { _id: false }
);

const nombreVersionSchema = new mongoose.Schema(
  {
    nombre: { type: String, required: true },
    version: { type: String, required: true }
  },
  { _id: false }
);

const inicioIntentoAplicacionSchema = new mongoose.Schema(
  {
    // Sin default: lo genera el servicio una sola vez y lo reutiliza en
    // el intento terminado, el historial y los eventos.
    intento_id: { type: String, required: true, unique: true, immutable: true },
    propuesta_id: { type: String, required: true, immutable: true },
    hash_contenido_referenciado: { type: String, required: true, match: SHA256_HEX, immutable: true },
    version_coordinacion_esperada: {
      type: Number,
      required: true,
      min: 0,
      immutable: true,
      validate: { validator: Number.isInteger, message: 'version_coordinacion_esperada debe ser entero.' }
    },
    operador: { type: operadorSchema, required: true, immutable: true },
    proceso_aplicador: { type: nombreVersionSchema, required: true, immutable: true },
    adaptador: { type: nombreVersionSchema, required: true, immutable: true },
    iniciado_en: { type: Date, required: true, immutable: true },
    // Contexto del proceso (host, pid) para rastrear un intento
    // interrumpido. Forma libre.
    proceso: { type: mongoose.Schema.Types.Mixed, required: false, immutable: true }
  },
  {
    collection: 'inicios_intento_aplicacion',
    timestamps: false,
    autoIndex: false,
    minimize: false
  }
);

inicioIntentoAplicacionSchema.pre('validate', function () {
  if (!this.isNew) {
    throw new Error('inicios_intento_aplicacion es append-only: no se puede modificar un inicio ya insertado.');
  }
});

// Solo rendimiento (auditoría de interrumpidos por propuesta y fecha).
inicioIntentoAplicacionSchema.index({ propuesta_id: 1, iniciado_en: -1 });

module.exports = mongoose.model('InicioIntentoAplicacion', inicioIntentoAplicacionSchema);
