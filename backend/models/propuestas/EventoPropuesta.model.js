/**
 * eventos_propuesta: log de eventos APPEND-ONLY (humanos y
 * automáticos) sobre una propuesta. Es la fuente de verdad histórica
 * del ciclo de vida de una PropuestaCambio; `propuestas_cambio.estado`
 * es un cache denormalizado que se actualiza EN LA MISMA transacción
 * que cada inserción acá.
 *
 * `_id` es el ObjectId por defecto de Mongo; la identidad de negocio es
 * `evento_id` (UUID), campo propio y único — no un alias de `_id`.
 *
 * `propuesta_id` referencia el `propuesta_id` (no el `_id`) de
 * PropuestaCambio.
 *
 * `tipo_evento` cubre los 8 tipos: aprobación, rechazo, cancelación,
 * obsolescencia, conflicto, entrada/salida de revisión, aplicación.
 *
 * Un evento debe demostrar QUÉ transición ocurrió SOBRE QUÉ contenido,
 * no solo que "algo pasó":
 *  - `estado_anterior`/`estado_nuevo`: obligatorios SIEMPRE (no solo
 *    para algunos tipo_evento), tomados del mismo enum de estados que
 *    PropuestaCambio.estado (duplicado a propósito acá, misma
 *    convención ya usada en el proyecto para canonicalizarValor). El
 *    hook de abajo rechaza cualquier evento donde ambos sean iguales:
 *    un "evento" que no representa una transición real no es válido.
 *  - `hash_contenido_referenciado`: obligatorio SIEMPRE, el
 *    `payload_hash` (SHA-256 hex) de la PropuestaCambio sobre la que
 *    actuó este evento — así un EventoPropuesta es auto-contenido para
 *    auditoría: no hace falta ir a buscar la propuesta para saber sobre
 *    qué versión exacta del contenido se decidió.
 *
 * Regla "una aprobación nunca se infiere por lectura, silencio o
 * tiempo": traducida como restricción estructural — el hook exige
 * actor.tipo === "humano" para tipo_evento === "aprobacion". Un proceso
 * automático no puede producir un evento de aprobación válido acá.
 *
 * Defensa contra mutaciones (auxiliar, no garantía — ver nota extendida
 * en EjecucionLectura.model.js): el hook `pre('validate')` bloquea
 * cualquier modificación posterior a la inserción para código que pase
 * por Mongoose.
 *
 * Política de timestamps: no se usa `{ timestamps: true }` —
 * `ocurrido_en` ya es el timestamp de negocio.
 */

const mongoose = require('mongoose');
const crypto = require('crypto');

const TIPOS_EVENTO = [
  'aprobacion',
  'rechazo',
  'cancelacion',
  'obsolescencia',
  'conflicto',
  'entrada_revision',
  'salida_revision',
  'aplicacion'
];

const TIPOS_QUE_REQUIEREN_MOTIVO = ['rechazo', 'cancelacion', 'conflicto', 'obsolescencia'];

// Duplicado a propósito desde PropuestaCambio.model.js.
const ESTADOS_PROPUESTA = [
  'pendiente_aprobacion',
  'aprobada',
  'rechazada',
  'obsoleta',
  'revision_requerida',
  'conflicto',
  'cancelada',
  'aplicada'
];

const SHA256_HEX = /^[0-9a-f]{64}$/;

const actorSchema = new mongoose.Schema(
  {
    tipo: { type: String, required: true, enum: ['humano', 'sistema'] },
    identificador: { type: String, required: true } // email/usuario si es humano; nombre del proceso si es sistema
  },
  { _id: false }
);

const eventoPropuestaSchema = new mongoose.Schema(
  {
    evento_id: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      default: () => crypto.randomUUID()
    },

    propuesta_id: { type: String, required: true, immutable: true },
    tipo_evento: { type: String, required: true, enum: TIPOS_EVENTO, immutable: true },

    estado_anterior: { type: String, required: true, enum: ESTADOS_PROPUESTA, immutable: true },
    estado_nuevo: { type: String, required: true, enum: ESTADOS_PROPUESTA, immutable: true },
    hash_contenido_referenciado: { type: String, required: true, match: SHA256_HEX, immutable: true },

    ocurrido_en: { type: Date, required: true, immutable: true },
    actor: { type: actorSchema, required: true, immutable: true },

    motivo: {
      type: String,
      required: function () {
        return TIPOS_QUE_REQUIEREN_MOTIVO.includes(this.tipo_evento);
      },
      immutable: true
    },

    // Forma libre a propósito: contenido específico por tipo_evento.
    detalle: { type: mongoose.Schema.Types.Mixed, required: false, immutable: true },

    // Solo para tipo_evento === "aplicacion".
    intento_aplicacion_id: {
      type: String,
      required: function () {
        return this.tipo_evento === 'aplicacion';
      },
      immutable: true
    }
  },
  {
    collection: 'eventos_propuesta',
    timestamps: false,
    autoIndex: false,
    // Ver nota equivalente en PropuestaCambio.model.js: sin esto,
    // Mongoose borraría en silencio un `detalle: {}` al serializar.
    minimize: false
  }
);

eventoPropuestaSchema.pre('validate', function () {
  if (this.tipo_evento === 'aprobacion' && this.actor && this.actor.tipo !== 'humano') {
    throw new Error('eventos_propuesta: un evento de tipo "aprobacion" exige actor.tipo === "humano" (nunca se infiere automáticamente).');
  }
  if (this.estado_anterior != null && this.estado_nuevo != null && this.estado_anterior === this.estado_nuevo) {
    throw new Error('eventos_propuesta: estado_anterior y estado_nuevo son iguales; esto no representa una transición real.');
  }
  if (!this.isNew) {
    throw new Error('eventos_propuesta es append-only: no se puede modificar un evento ya insertado.');
  }
});

eventoPropuestaSchema.index({ propuesta_id: 1, ocurrido_en: 1 });
eventoPropuestaSchema.index({ tipo_evento: 1, ocurrido_en: -1 });

module.exports = mongoose.model('EventoPropuesta', eventoPropuestaSchema);
