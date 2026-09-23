/**
 * intentos_aplicacion: cada intento de aplicar una PropuestaCambio,
 * exitoso o no. Cada documento representa un intento YA TERMINADO — no
 * existe un estado "en curso" persistido acá.
 *
 * `_id` es el ObjectId por defecto de Mongo; la identidad de negocio es
 * `intento_id` (UUID), campo propio y único — no un alias de `_id`.
 *
 * `propuesta_id` referencia el `propuesta_id` (no el `_id`) de
 * PropuestaCambio.
 *
 * `resultado` es un enum de categorías explícitas (no un booleano
 * exitoso|fallo disfrazado), porque "fallo" solo no alcanza para
 * decidir qué hacer después:
 *   - exito
 *   - fuente_temporalmente_no_disponible (red/HTTP, reintentable)
 *   - extraccion_ambigua (la fuente respondió pero no se pudo parsear
 *     un valor inequívoco)
 *   - fuente_cambio (la fuente ya no dice lo mismo que cuando se creó
 *     la propuesta — la propuesta quedó obsoleta)
 *   - valor_actual_cambio (la precondición sobre destinos.requisitos[]
 *     ya no se cumple: otra escritura tocó ese campo mientras tanto)
 *   - identidad_requisito_cambio (el requisito_id ya no identifica lo
 *     mismo — mismas categorías de identidad que el piloto de lectura:
 *     destino_no_encontrado, requisito_id_no_encontrado,
 *     requisito_id_duplicado, identidad_semantica_no_coincide, ver
 *     piloto-lectura-uk-eta.js)
 *
 * Los campos de evidencia/revalidación/precondición/identidad son
 * CONDICIONALES según `resultado`, porque no todo intento llega a la
 * misma etapa:
 *  - `evidencia_fresca` (Mixed): SIEMPRE requerida — incluso en
 *    fuente_temporalmente_no_disponible es evidencia parcial del
 *    fallo (ej. status HTTP, cantidad de reintentos), nunca un valor
 *    inventado.
 *  - `revalidacion` (fuente_nombre/url/valor_revalidado/
 *    coincide_con_propuesta + revalidacion_id propio): requerida solo
 *    cuando la fuente SÍ devolvió un valor inequívoco — exito,
 *    fuente_cambio, valor_actual_cambio, identidad_requisito_cambio.
 *    NO se exige para extraccion_ambigua (no hay valor_revalidado
 *    inequívoco que guardar) ni para fuente_temporalmente_no_disponible
 *    (la fuente ni siquiera respondió). El hook además exige que
 *    `coincide_con_propuesta` sea consistente con el resultado:
 *    false para fuente_cambio, true para exito/valor_actual_cambio/
 *    identidad_requisito_cambio (en estos últimos dos, el problema NO
 *    es la fuente — la fuente sigue validando la propuesta).
 *  - `precondicion` (snapshot presente/null/valor en Mongo al momento
 *    del intento): requerida solo cuando se llegó a inspeccionar el
 *    valor actual en Mongo — exito (precondición que SE CUMPLIÓ y
 *    habilitó la escritura) y valor_actual_cambio (precondición que
 *    NO se cumplió). No aplica a los resultados que abortan antes de
 *    llegar a esa etapa (fuente_cambio, extraccion_ambigua,
 *    fuente_temporalmente_no_disponible) ni a identidad_requisito_cambio,
 *    que falla por identidad, no por valor.
 *  - `identidad_esperada_no_coincide` (categoria + detalle): requerida
 *    solo para identidad_requisito_cambio — el análogo de
 *    `precondicion` pero para identidad en vez de valor.
 *  - `historial_id`: solo si resultado === "exito".
 *
 * Defensa contra mutaciones (auxiliar, no garantía — ver nota extendida
 * en EjecucionLectura.model.js): el hook `pre('validate')` bloquea
 * cualquier modificación posterior a la inserción.
 *
 * Política de timestamps: no se usa `{ timestamps: true }` —
 * iniciado_en/finalizado_en ya cubren el ciclo de vida del intento.
 */

const mongoose = require('mongoose');
const crypto = require('crypto');

const RESULTADOS = [
  'exito',
  'fuente_temporalmente_no_disponible',
  'extraccion_ambigua',
  'fuente_cambio',
  'valor_actual_cambio',
  'identidad_requisito_cambio'
];

// Resultados donde la fuente SÍ devolvió un valor inequívoco (con o sin
// coincidencia respecto de la propuesta) -> exigen `revalidacion`.
const RESULTADOS_CON_REVALIDACION = ['exito', 'fuente_cambio', 'valor_actual_cambio', 'identidad_requisito_cambio'];
// Resultados donde `revalidacion.coincide_con_propuesta` debe ser true
// (la fuente sigue validando la propuesta; el problema no es la fuente).
const RESULTADOS_CON_FUENTE_COINCIDENTE = ['exito', 'valor_actual_cambio', 'identidad_requisito_cambio'];

// Resultados donde se llegó a inspeccionar el valor actual en Mongo.
const RESULTADOS_CON_PRECONDICION = ['exito', 'valor_actual_cambio'];

// Único resultado que falla por identidad, no por valor.
const RESULTADOS_CON_IDENTIDAD_ESPERADA = ['identidad_requisito_cambio'];

// Mismas categorías de identidad que el piloto de lectura
// (piloto-lectura-uk-eta.js) — reutilizadas a propósito, no reinventadas.
const CATEGORIAS_IDENTIDAD_NO_COINCIDE = [
  'destino_no_encontrado',
  'requisito_id_no_encontrado',
  'requisito_id_duplicado',
  'identidad_semantica_no_coincide'
];

const valorConPresenciaSchema = new mongoose.Schema(
  {
    presente: { type: Boolean, required: true },
    valor: { type: mongoose.Schema.Types.Mixed, default: null }
  },
  { _id: false }
);

const revalidacionSchema = new mongoose.Schema(
  {
    // Id propio de esta revalidación puntual — HistorialCambio lo
    // referencia por id en vez de copiar el contenido.
    revalidacion_id: {
      type: String,
      required: true,
      default: () => crypto.randomUUID()
    },
    fuente_nombre: { type: String, required: true },
    url: { type: String, required: true },
    valor_revalidado: { type: mongoose.Schema.Types.Mixed, required: true },
    coincide_con_propuesta: { type: Boolean, required: true }
  },
  { _id: false }
);

const identidadEsperadaSchema = new mongoose.Schema(
  {
    categoria: { type: String, required: true, enum: CATEGORIAS_IDENTIDAD_NO_COINCIDE },
    detalle: { type: mongoose.Schema.Types.Mixed, required: false }
  },
  { _id: false }
);

const intentoAplicacionSchema = new mongoose.Schema(
  {
    intento_id: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      default: () => crypto.randomUUID()
    },

    propuesta_id: { type: String, required: true, immutable: true },

    iniciado_en: { type: Date, required: true, immutable: true },
    finalizado_en: { type: Date, required: true, immutable: true },

    resultado: { type: String, required: true, enum: RESULTADOS, immutable: true },
    error_mensaje: {
      type: String,
      required: function () {
        return this.resultado !== 'exito';
      },
      immutable: true
    },

    // Evidencia disponible de la consulta a la fuente — siempre
    // requerida, aunque sea parcial (nunca inventa un valor).
    evidencia_fresca: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },

    // Revalidación externa contra la fuente ORIGINAL, SIEMPRE hecha
    // antes de abrir la transacción de Mongo (nunca HTTP dentro de una
    // transacción). Condicional: ver RESULTADOS_CON_REVALIDACION.
    revalidacion: {
      type: revalidacionSchema,
      required: function () {
        return RESULTADOS_CON_REVALIDACION.includes(this.resultado);
      },
      immutable: true
    },

    // Snapshot presente/null/valor exigido atómicamente en la
    // escritura. Condicional: ver RESULTADOS_CON_PRECONDICION.
    precondicion: {
      type: valorConPresenciaSchema,
      required: function () {
        return RESULTADOS_CON_PRECONDICION.includes(this.resultado);
      },
      immutable: true
    },

    // Análogo a precondicion pero para identidad, no valor. Condicional:
    // solo identidad_requisito_cambio.
    identidad_esperada_no_coincide: {
      type: identidadEsperadaSchema,
      required: function () {
        return RESULTADOS_CON_IDENTIDAD_ESPERADA.includes(this.resultado);
      },
      immutable: true
    },

    // Solo si resultado === "exito".
    historial_id: {
      type: String,
      required: function () {
        return this.resultado === 'exito';
      },
      immutable: true
    }
  },
  {
    collection: 'intentos_aplicacion',
    timestamps: false,
    autoIndex: false,
    // Ver nota equivalente en PropuestaCambio.model.js: sin esto,
    // Mongoose borraría en silencio un `evidencia_fresca: {}` al serializar.
    minimize: false
  }
);

intentoAplicacionSchema.pre('validate', function () {
  if (!this.isNew) {
    throw new Error('intentos_aplicacion es append-only: no se puede modificar un intento ya insertado.');
  }

  if (this.revalidacion) {
    const debeCoincidir = RESULTADOS_CON_FUENTE_COINCIDENTE.includes(this.resultado);
    if (this.revalidacion.coincide_con_propuesta !== debeCoincidir) {
      throw new Error(
        `intentos_aplicacion: resultado "${this.resultado}" exige revalidacion.coincide_con_propuesta === ${debeCoincidir}.`
      );
    }
  }
});

intentoAplicacionSchema.index({ propuesta_id: 1, finalizado_en: -1 });
intentoAplicacionSchema.index({ resultado: 1, finalizado_en: -1 });

module.exports = mongoose.model('IntentoAplicacion', intentoAplicacionSchema);
