/**
 * eventos_propuesta: log de eventos APPEND-ONLY (humanos y
 * automáticos) sobre una propuesta. Es la fuente de verdad histórica
 * del ciclo de vida de una PropuestaCambio; `propuestas_cambio.estado`
 * es un cache denormalizado que se actualiza EN LA MISMA transacción
 * CAS que cada inserción acá.
 *
 * `_id` es el ObjectId por defecto de Mongo; la identidad de negocio es
 * `evento_id` (UUID), campo propio y único — no un alias de `_id`.
 *
 * `propuesta_id` referencia el `propuesta_id` (no el `_id`) de
 * PropuestaCambio.
 *
 * Un evento debe demostrar QUÉ transición ocurrió SOBRE QUÉ contenido
 * y EN QUÉ versión, no solo que "algo pasó":
 *  - `estado_anterior`/`estado_nuevo`/`tipo_evento`/`actor.tipo`: la
 *    combinación debe estar en TRANSICIONES
 *    (../../services/propuestas/contrato-propuestas.js). Eso incluye
 *    "aprobación, rechazo y cancelación solo por un humano", "aplicación
 *    y transiciones por fallo solo por el proceso aplicador (sistema)" y
 *    "nunca estado_anterior === estado_nuevo".
 *  - `hash_contenido_referenciado`: el `payload_hash` de la
 *    PropuestaCambio sobre la que actuó este evento.
 *  - `version_coordinacion_nueva`: el valor de
 *    PropuestaCambio.version_coordinacion DESPUÉS de la transición CAS
 *    que acompaña a este evento (la anterior es esta menos 1). El
 *    índice único (propuesta_id, version_coordinacion_nueva) garantiza
 *    una historia LINEAL: dos eventos nunca pueden reclamar la misma
 *    transición de versión de la misma propuesta.
 *
 * `intento_aplicacion_id`: obligatorio para los tipos que en el MVP
 * solo nacen de un IntentoAplicacion (aplicacion y las transiciones
 * automáticas por fallo — ver TIPOS_EVENTO_CON_INTENTO).
 *
 * Sin índice único (propuesta_id, tipo_evento): la unicidad de cada
 * decisión ya la garantizan el CAS (estado esperado +
 * decision_aprobacion_id: null para aprobar) y el índice de versión;
 * además bloquearía ciclos legítimos futuros (p. ej. si se agrega una
 * salida de revisión, entrar y salir de revisión más de una vez).
 *
 * `actor`: para eventos humanos (aprobación, rechazo, cancelación), en
 * el MVP el identificador lo resuelve el comando administrativo a
 * partir del usuario de Atlas autenticado (connectionStatus). Es
 * evidencia OPERATIVA, no autenticación ni no repudio: quien tenga esa
 * credencial puede escribir directamente en Mongo. El panel futuro
 * deberá aportar identidad autenticada por el backend. Para eventos de
 * sistema, el identificador es el proceso aplicador; el operador que
 * lanzó el intento queda en el IntentoAplicacion referenciado.
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
const {
  ESTADOS_PROPUESTA,
  TIPOS_EVENTO,
  TIPOS_ACTOR,
  TIPOS_QUE_REQUIEREN_MOTIVO,
  TIPOS_EVENTO_CON_INTENTO,
  motivoTransicionInvalida
} = require('../../services/propuestas/contrato-propuestas');

const SHA256_HEX = /^[0-9a-f]{64}$/;

const actorSchema = new mongoose.Schema(
  {
    tipo: { type: String, required: true, enum: TIPOS_ACTOR },
    identificador: { type: String, required: true } // usuario Atlas mapeado si es humano; nombre del proceso si es sistema
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

    version_coordinacion_nueva: {
      type: Number,
      required: true,
      min: 1,
      immutable: true,
      validate: { validator: Number.isInteger, message: 'version_coordinacion_nueva debe ser entero.' }
    },

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

    intento_aplicacion_id: {
      type: String,
      required: function () {
        return TIPOS_EVENTO_CON_INTENTO.includes(this.tipo_evento);
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
  if (!this.isNew) {
    throw new Error('eventos_propuesta es append-only: no se puede modificar un evento ya insertado.');
  }
  if (this.tipo_evento === 'aprobacion' && this.actor && this.actor.tipo !== 'humano') {
    throw new Error('eventos_propuesta: un evento de tipo "aprobacion" exige actor.tipo === "humano" (nunca se infiere automáticamente).');
  }
  if (this.estado_anterior != null && this.estado_nuevo != null && this.estado_anterior === this.estado_nuevo) {
    throw new Error('eventos_propuesta: estado_anterior y estado_nuevo son iguales; esto no representa una transición real.');
  }
  if (this.tipo_evento != null && this.estado_anterior != null && this.estado_nuevo != null && this.actor) {
    const motivo = motivoTransicionInvalida(this.tipo_evento, this.estado_anterior, this.estado_nuevo, this.actor.tipo);
    if (motivo) throw new Error(`eventos_propuesta: transición no permitida: ${motivo}`);
  }
});

// Integridad: historia lineal, un evento por transición de versión.
eventoPropuestaSchema.index(
  { propuesta_id: 1, version_coordinacion_nueva: 1 },
  { unique: true, name: 'uniq_evento_por_propuesta_version' }
);
// Solo rendimiento.
eventoPropuestaSchema.index({ propuesta_id: 1, ocurrido_en: 1 });
eventoPropuestaSchema.index({ tipo_evento: 1, ocurrido_en: -1 });

module.exports = mongoose.model('EventoPropuesta', eventoPropuestaSchema);
