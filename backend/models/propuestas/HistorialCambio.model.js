/**
 * historial_cambios: SOLAMENTE cambios REALMENTE aplicados a un
 * requisito. Un documento acá significa "esto ya está escrito en
 * destinos.requisitos[]", nunca una intención o un intento fallido
 * (eso vive en intentos_aplicacion).
 *
 * `_id` es el ObjectId por defecto de Mongo; la identidad de negocio es
 * `historial_id` (UUID), campo propio y único — no un alias de `_id`.
 *
 * Referencias cruzadas — "propuesta, aprobación, intento y
 * revalidación":
 *  - propuesta_id: el `propuesta_id` de la PropuestaCambio aplicada.
 *  - decision_aprobacion_id: el `evento_id` del EventoPropuesta tipo
 *    "aprobacion" que autorizó este cambio (siempre presente: nada se
 *    aplica sin una aprobación explícita).
 *  - intento_aplicacion_id: el `intento_id` del IntentoAplicacion
 *    exitoso que produjo este cambio — referencia 1:1 (ese intento
 *    también apunta de vuelta acá vía su propio historial_id; ambos se
 *    escriben en la MISMA transacción).
 *  - revalidacion_id: el `revalidacion_id` embebido dentro de ESE mismo
 *    IntentoAplicacion — no se copia acá el contenido de la
 *    revalidación (la evidencia fresca vive en el intento; duplicarla
 *    acá crearía una segunda copia que podría desincronizarse de la
 *    original). Auditar la revalidación completa de un cambio es "ir a
 *    buscar el intento por intento_aplicacion_id", no leer una copia
 *    local desactualizable.
 *
 * `propuesta_id` e `intento_aplicacion_id` llevan índice ÚNICO (no solo
 * por performance): una propuesta, una vez aplicada, no puede volver a
 * generar una segunda entrada de historial — aplicarla de nuevo
 * requeriría una PROPUESTA NUEVA. El índice único es una garantía de
 * integridad contra un bug que intente aplicar dos veces la misma
 * propuesta/intento.
 *
 * Defensa contra mutaciones (auxiliar, no garantía — ver nota extendida
 * en EjecucionLectura.model.js): el hook `pre('validate')` bloquea
 * cualquier modificación posterior a la inserción.
 *
 * Política de timestamps: no se usa `{ timestamps: true }` —
 * `aplicado_en` ya es el timestamp de negocio (coincide con el
 * finalizado_en del IntentoAplicacion exitoso correspondiente).
 */

const mongoose = require('mongoose');
const crypto = require('crypto');

const valorConPresenciaSchema = new mongoose.Schema(
  {
    presente: { type: Boolean, required: true },
    valor: { type: mongoose.Schema.Types.Mixed, default: null }
  },
  { _id: false }
);

const historialCambioSchema = new mongoose.Schema(
  {
    historial_id: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      default: () => crypto.randomUUID()
    },

    destino_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Destino', required: true, immutable: true },
    requisito_id: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
    campo: { type: String, required: true, immutable: true },

    valor_anterior: { type: valorConPresenciaSchema, required: true, immutable: true },
    valor_nuevo: { type: valorConPresenciaSchema, required: true, immutable: true },

    aplicado_en: { type: Date, required: true, immutable: true },

    propuesta_id: { type: String, required: true, immutable: true },
    decision_aprobacion_id: { type: String, required: true, immutable: true },
    intento_aplicacion_id: { type: String, required: true, immutable: true },
    // Referencia por id a IntentoAplicacion.revalidacion.revalidacion_id
    // (no duplicar el contenido de la revalidación acá).
    revalidacion_id: { type: String, required: true, immutable: true }
  },
  {
    collection: 'historial_cambios',
    timestamps: false,
    autoIndex: false,
    // Ver nota equivalente en PropuestaCambio.model.js (consistencia
    // entre los 5 modelos de esta carpeta, aunque acá no hay Mixed).
    minimize: false
  }
);

historialCambioSchema.pre('validate', function () {
  if (!this.isNew) {
    throw new Error('historial_cambios es append-only e inmutable: no se puede modificar un cambio ya registrado.');
  }
});

// Auditoría "qué pasó con este campo a lo largo del tiempo".
historialCambioSchema.index({ destino_id: 1, requisito_id: 1, campo: 1, aplicado_en: -1 });
// Integridad: una propuesta no puede tener más de una entrada de historial.
historialCambioSchema.index({ propuesta_id: 1 }, { unique: true });
// Integridad: un intento exitoso no puede tener más de una entrada de historial.
historialCambioSchema.index({ intento_aplicacion_id: 1 }, { unique: true });

module.exports = mongoose.model('HistorialCambio', historialCambioSchema);
