/**
 * ejecuciones_lectura: registro INMUTABLE de cada corrida de un piloto
 * de lectura (ej. piloto-lectura-uk-eta.js generalizado). Cada
 * documento representa una corrida ya terminada: se inserta una única
 * vez, al final, con iniciado_en/finalizado_en ya conocidos. No se
 * actualiza nunca (append-only, ver guard más abajo).
 *
 * `_id` queda como el ObjectId por defecto de Mongo. La identidad de
 * negocio de la corrida es `run_id` (UUID), un campo propio y único —
 * no se reutiliza `_id` para esto (los identificadores de proceso son
 * campos explícitos, nunca un alias silencioso de `_id`; ver la misma
 * decisión en los otros 4 modelos de esta carpeta).
 *
 * `destino_id`/`requisito_id` son los `_id` REALES y ESTABLES de Mongo
 * (destino_id: Destino._id; requisito_id: el _id del subdocumento
 * dentro de destinos.requisitos[], habilitado desde el backfill de
 * Fase 2 — ver Destino.model.js). Pueden faltar si la corrida falló
 * antes de identificar el requisito.
 *
 * `propuesta_referencia.propuesta_id_referenciada` apunta al
 * `propuesta_id` (no al `_id`) de la PropuestaCambio con la que esta
 * ejecución terminó asociada — sea porque la creó, o porque encontró
 * una ya activa (incluyendo el caso de colisión E11000: si crear una
 * propuesta pierde la carrera, esa transacción revierte por completo y
 * la ejecución perdedora queda vinculada a la propuesta activa
 * ganadora). `propuesta_fue_creada_por_esta_ejecucion` distingue ambos
 * casos sin dos campos opcionales mutuamente excluyentes.
 *
 * Política de timestamps: no se usa `{ timestamps: true }` —
 * iniciado_en/finalizado_en ya son los timestamps de negocio reales.
 *
 * Defensa contra mutaciones indebidas (AUXILIAR, no garantía de
 * inmutabilidad de la colección): el hook `pre('validate')` de abajo
 * bloquea cualquier modificación posterior a la inserción, pero solo
 * para código que pase por Mongoose y dispare validate(). NO cubre
 * updateOne/updateMany/findOneAndUpdate con runValidators desactivado,
 * ni ninguna escritura hecha con el driver nativo de MongoDB — un hook
 * de Mongoose no es una ACL de la base. La protección real de
 * "append-only" debe vivir en la capa de servicio: exponer únicamente
 * una operación de inserción (insertOne/create) contra esta colección,
 * nunca update, y — donde una escritura condicional sea inevitable en
 * otras colecciones de este contrato — usar filtros CAS
 * (compare-and-swap: `updateOne({_id, campoEsperado: valorEsperado},
 * ...)`) en vez de confiar en que nadie use el driver nativo para
 * saltarse este hook.
 */

const mongoose = require('mongoose');
const crypto = require('crypto');

const ETAPAS_FALLO = [
  'fetch_fuente',
  'parseo_fuente',
  'comparacion_fuente',
  'conexion_mongo',
  'identificacion_requisito_mongo',
  'deteccion_propuesta_existente',
  'creacion_propuesta',
  'desconocida'
];

const valorConPresenciaSchema = new mongoose.Schema(
  {
    presente: { type: Boolean, required: true },
    valor: { type: mongoose.Schema.Types.Mixed, default: null }
  },
  { _id: false }
);

const propuestaReferenciaSchema = new mongoose.Schema(
  {
    // Referencia al `propuesta_id` (no al `_id`) de PropuestaCambio.
    propuesta_id_referenciada: { type: String, required: false },
    propuesta_fue_creada_por_esta_ejecucion: {
      type: Boolean,
      required: function () {
        return this.propuesta_id_referenciada != null;
      }
    }
  },
  { _id: false }
);

const ejecucionLecturaSchema = new mongoose.Schema(
  {
    run_id: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      default: () => crypto.randomUUID()
    },

    estado_ejecucion: { type: String, required: true, enum: ['ok', 'fallo'], immutable: true },

    iniciado_en: { type: Date, required: true, immutable: true },
    finalizado_en: { type: Date, required: true, immutable: true },

    etapa_fallo: {
      type: String,
      enum: ETAPAS_FALLO,
      required: function () {
        return this.estado_ejecucion === 'fallo';
      },
      immutable: true
    },
    error_mensaje: {
      type: String,
      required: function () {
        return this.estado_ejecucion === 'fallo';
      },
      immutable: true
    },

    // Ausentes si la corrida falló antes de identificar destino/requisito.
    destino_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Destino', default: null, immutable: true },
    requisito_id: { type: mongoose.Schema.Types.ObjectId, default: null, immutable: true },

    campo: { type: String, required: true, immutable: true },

    fuente_nombre: { type: String, required: true, immutable: true },
    fuente_url: { type: String, required: true, immutable: true },

    evidencia: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },

    // Solo presente si estado_ejecucion === 'ok'.
    resultado_comparacion: {
      type: new mongoose.Schema(
        {
          categoria: {
            type: String,
            required: true,
            enum: [
              'SIN_COSTO_PREVIO_EN_MONGO',
              'IMPORTE_NO_COINCIDE',
              'MONEDA_DISTINTA',
              'MONEDA_AMBIGUA',
              'FORMATO_AMBIGUO_EN_MONGO',
              'VALOR_INESPERADO_EN_MONGO',
              'COINCIDE'
            ]
          },
          ambiguo: { type: Boolean, required: true }
        },
        { _id: false }
      ),
      required: function () {
        return this.estado_ejecucion === 'ok';
      },
      immutable: true
    },

    valor_previo_en_mongo: {
      type: valorConPresenciaSchema,
      required: function () {
        return this.estado_ejecucion === 'ok';
      },
      immutable: true
    },

    propuesta_referencia: { type: propuestaReferenciaSchema, required: false, immutable: true }
  },
  {
    collection: 'ejecuciones_lectura',
    timestamps: false,
    autoIndex: false, // los índices se declaran acá pero se crean en Atlas como paso aparte
    // Ver nota equivalente en PropuestaCambio.model.js: sin esto,
    // Mongoose borraría en silencio un `evidencia: {}` al serializar.
    minimize: false
  }
);

// Append-only (defensa auxiliar vía Mongoose — ver nota de cabecera
// sobre la garantía real en la capa de servicio).
ejecucionLecturaSchema.pre('validate', function () {
  if (!this.isNew) {
    throw new Error('ejecuciones_lectura es append-only: no se puede modificar un registro ya insertado.');
  }
});

ejecucionLecturaSchema.index({ destino_id: 1, requisito_id: 1, campo: 1, finalizado_en: -1 });
ejecucionLecturaSchema.index({ estado_ejecucion: 1, finalizado_en: -1 });
ejecucionLecturaSchema.index({ 'propuesta_referencia.propuesta_id_referenciada': 1 }, { sparse: true });

module.exports = mongoose.model('EjecucionLectura', ejecucionLecturaSchema);
