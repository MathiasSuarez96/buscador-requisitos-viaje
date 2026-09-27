/**
 * intentos_aplicacion: cada intento de aplicar una PropuestaCambio,
 * exitoso o no. Cada documento representa un intento YA TERMINADO — no
 * existe un estado "en curso" persistido acá (el arranque de cada
 * intento se registra aparte en inicios_intento_aplicacion, ver
 * InicioIntentoAplicacion.model.js).
 *
 * `_id` es el ObjectId por defecto de Mongo; la identidad de negocio es
 * `intento_id` (UUID), campo propio y único — no un alias de `_id`.
 * El mismo intento_id se usa en inicios_intento_aplicacion, en el
 * intento terminado y en HistorialCambio/EventoPropuesta. Como es
 * único, cada intento tiene A LO SUMO UN resultado terminal registrado.
 *
 * `propuesta_id` referencia el `propuesta_id` (no el `_id`) de
 * PropuestaCambio.
 *
 * CÓMO SE ESCRIBE: ver "PERSISTENCIA DE CADA RESULTADO" en
 * ../../services/propuestas/contrato-propuestas.js. En resumen: exito y
 * los resultados semánticos (con transición de estado) se insertan
 * dentro de la transacción que mueve el estado; los demás, y todo
 * escritura_abortada, como insert independiente fuera de transacción.
 *
 * Roles separados (ver contrato):
 *  - `operador`: el humano que lanzó el intento (evidencia operativa,
 *    no no repudio — ver nota en EventoPropuesta.model.js).
 *  - `proceso_aplicador`: {nombre, version} del proceso que escribe; es
 *    el actor 'sistema' de los eventos que produce este intento.
 *  - el aprobador NO se copia: se referencia por `decision_aprobacion_id`
 *    (evento_id de la aprobación). Puede ser null SOLO en
 *    propuesta_no_aplicable (p. ej. propuesta no aprobada).
 *
 * Otros campos siempre presentes: `hash_contenido_referenciado` (el
 * payload_hash leído), `version_coordinacion_esperada`, `adaptador`
 * ({nombre, version} del adaptador de revalidación) y `evidencia_fresca`
 * (Mixed, aunque sea parcial; nunca un valor inventado).
 *
 * `etapa_fallo` (ETAPAS_POR_RESULTADO): obligatoria en todo resultado
 * salvo exito, donde no se admite.
 *
 * `resultado_no_registrado`: solo en escritura_abortada con etapa
 * transicion_por_fallo — el resultado semántico cuya transacción falló
 * y que por lo tanto NO quedó registrado (ni su intento, ni el cambio de
 * estado, ni el evento).
 *
 * RESULTADO EFECTIVO: el resultado de negocio que describe la evidencia
 * del intento. Es `resultado_no_registrado` en ese caso de
 * escritura_abortada, y `resultado` en cualquier otro. Los campos
 * condicionales siguen al resultado efectivo, así el intento abortado
 * conserva la misma evidencia que habría tenido el resultado semántico:
 *  - `revalidacion` (con revalidacion_id y revalidada_en): obligatoria
 *    si la revalidación externa terminó correctamente con un valor
 *    inequívoco — resultado efectivo en RESULTADOS_CON_REVALIDACION, o
 *    etapa_fallo escritura_aplicacion (a esa etapa solo se llega con la
 *    revalidación terminada). NO se admite en ningún otro caso.
 *    `coincide_con_propuesta` es false solo si el resultado efectivo es
 *    fuente_cambio.
 *  - `precondicion`: valor ESPERADO en Mongo (payload.valor_anterior) —
 *    resultado efectivo exito o valor_actual_cambio.
 *  - `valor_observado`: valor encontrado realmente — solo resultado
 *    efectivo valor_actual_cambio.
 *  - `identidad_esperada_no_coincide`: solo resultado efectivo
 *    identidad_requisito_cambio.
 *  - `historial_id`: solo (y obligatorio en) exito.
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
const {
  RESULTADOS_INTENTO,
  RESULTADOS_CON_TRANSICION,
  ETAPAS_INTENTO,
  ETAPAS_POR_RESULTADO,
  CATEGORIAS_IDENTIDAD_NO_COINCIDE
} = require('../../services/propuestas/contrato-propuestas');

const SHA256_HEX = /^[0-9a-f]{64}$/;

// Resultados efectivos a los que solo se llega con la revalidación
// externa terminada y un valor inequívoco de la fuente.
const RESULTADOS_CON_REVALIDACION = ['exito', 'fuente_cambio', 'valor_actual_cambio', 'identidad_requisito_cambio', 'revalidacion_vencida'];
// Etapas a las que solo se llega con la revalidación terminada correctamente.
const ETAPAS_CON_REVALIDACION = ['escritura_aplicacion'];

const RESULTADOS_CON_PRECONDICION = ['exito', 'valor_actual_cambio'];
const RESULTADOS_CON_VALOR_OBSERVADO = ['valor_actual_cambio'];
const RESULTADOS_CON_IDENTIDAD_ESPERADA = ['identidad_requisito_cambio'];
const RESULTADOS_SIN_DECISION_OBLIGATORIA = ['propuesta_no_aplicable'];

function registraTransicionFallida(doc) {
  return doc.resultado === 'escritura_abortada' && doc.etapa_fallo === 'transicion_por_fallo';
}

function resultadoEfectivo(doc) {
  return registraTransicionFallida(doc) ? doc.resultado_no_registrado : doc.resultado;
}

function exigeRevalidacion(doc) {
  return RESULTADOS_CON_REVALIDACION.includes(resultadoEfectivo(doc)) || ETAPAS_CON_REVALIDACION.includes(doc.etapa_fallo);
}

const valorConPresenciaSchema = new mongoose.Schema(
  {
    presente: { type: Boolean, required: true },
    valor: { type: mongoose.Schema.Types.Mixed, default: null }
  },
  { _id: false }
);

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

const revalidacionSchema = new mongoose.Schema(
  {
    // Id propio de esta revalidación puntual — HistorialCambio lo
    // referencia por id en vez de copiar el contenido.
    revalidacion_id: {
      type: String,
      required: true,
      default: () => crypto.randomUUID()
    },
    revalidada_en: { type: Date, required: true },
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

    operador: { type: operadorSchema, required: true, immutable: true },
    proceso_aplicador: { type: nombreVersionSchema, required: true, immutable: true },
    adaptador: { type: nombreVersionSchema, required: true, immutable: true },

    hash_contenido_referenciado: { type: String, required: true, match: SHA256_HEX, immutable: true },
    version_coordinacion_esperada: {
      type: Number,
      required: true,
      min: 0,
      immutable: true,
      validate: { validator: Number.isInteger, message: 'version_coordinacion_esperada debe ser entero.' }
    },
    decision_aprobacion_id: {
      type: String,
      default: null,
      required: function () {
        return !RESULTADOS_SIN_DECISION_OBLIGATORIA.includes(this.resultado);
      },
      immutable: true
    },

    iniciado_en: { type: Date, required: true, immutable: true },
    finalizado_en: { type: Date, required: true, immutable: true },

    resultado: { type: String, required: true, enum: RESULTADOS_INTENTO, immutable: true },
    etapa_fallo: {
      type: String,
      enum: ETAPAS_INTENTO,
      required: function () {
        return this.resultado !== 'exito';
      },
      immutable: true
    },
    resultado_no_registrado: {
      type: String,
      enum: RESULTADOS_CON_TRANSICION,
      required: function () {
        return registraTransicionFallida(this);
      },
      immutable: true
    },
    error_mensaje: {
      type: String,
      required: function () {
        return this.resultado !== 'exito';
      },
      immutable: true
    },

    evidencia_fresca: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },

    // Revalidación externa contra la fuente ORIGINAL, SIEMPRE hecha
    // antes de abrir cualquier transacción de Mongo (nunca HTTP dentro
    // de una transacción). Condicional: ver exigeRevalidacion().
    revalidacion: {
      type: revalidacionSchema,
      required: function () {
        return exigeRevalidacion(this);
      },
      immutable: true
    },

    // Valor ESPERADO (payload.valor_anterior) exigido atómicamente en la escritura.
    precondicion: {
      type: valorConPresenciaSchema,
      required: function () {
        return RESULTADOS_CON_PRECONDICION.includes(resultadoEfectivo(this));
      },
      immutable: true
    },

    // Valor realmente encontrado dentro de la transacción cuando no
    // coincidía con `precondicion`.
    valor_observado: {
      type: valorConPresenciaSchema,
      required: function () {
        return RESULTADOS_CON_VALOR_OBSERVADO.includes(resultadoEfectivo(this));
      },
      immutable: true
    },

    identidad_esperada_no_coincide: {
      type: identidadEsperadaSchema,
      required: function () {
        return RESULTADOS_CON_IDENTIDAD_ESPERADA.includes(resultadoEfectivo(this));
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

  if (this.resultado === 'exito' && this.etapa_fallo != null) {
    throw new Error('intentos_aplicacion: un intento "exito" no admite etapa_fallo.');
  }
  if (this.resultado !== 'exito' && this.etapa_fallo != null) {
    const permitidas = ETAPAS_POR_RESULTADO[this.resultado] ?? [];
    if (!permitidas.includes(this.etapa_fallo)) {
      throw new Error(
        `intentos_aplicacion: resultado "${this.resultado}" admite etapa_fallo en [${permitidas.join(', ')}] (recibido "${this.etapa_fallo}").`
      );
    }
  }
  if (!registraTransicionFallida(this) && this.resultado_no_registrado != null) {
    throw new Error('intentos_aplicacion: resultado_no_registrado solo se admite en escritura_abortada con etapa transicion_por_fallo.');
  }

  if (this.revalidacion != null && !exigeRevalidacion(this)) {
    throw new Error(
      `intentos_aplicacion: resultado "${this.resultado}" en etapa "${this.etapa_fallo}" no admite revalidacion (la revalidación externa no terminó correctamente).`
    );
  }
  if (this.revalidacion) {
    const debeCoincidir = resultadoEfectivo(this) !== 'fuente_cambio';
    if (this.revalidacion.coincide_con_propuesta !== debeCoincidir) {
      throw new Error(
        `intentos_aplicacion: resultado efectivo "${resultadoEfectivo(this)}" exige revalidacion.coincide_con_propuesta === ${debeCoincidir}.`
      );
    }
  }

  if (this.resultado !== 'exito' && this.historial_id != null) {
    throw new Error('intentos_aplicacion: solo un intento "exito" puede referenciar un historial_id.');
  }
  if (!RESULTADOS_CON_VALOR_OBSERVADO.includes(resultadoEfectivo(this)) && this.valor_observado != null) {
    throw new Error(`intentos_aplicacion: resultado efectivo "${resultadoEfectivo(this)}" no admite valor_observado.`);
  }
});

// Integridad: a lo sumo un intento exitoso por propuesta.
intentoAplicacionSchema.index(
  { propuesta_id: 1 },
  { unique: true, partialFilterExpression: { resultado: 'exito' }, name: 'uniq_intento_exitoso_por_propuesta' }
);
// Solo rendimiento.
intentoAplicacionSchema.index({ propuesta_id: 1, finalizado_en: -1 });
intentoAplicacionSchema.index({ resultado: 1, finalizado_en: -1 });

module.exports = mongoose.model('IntentoAplicacion', intentoAplicacionSchema);
