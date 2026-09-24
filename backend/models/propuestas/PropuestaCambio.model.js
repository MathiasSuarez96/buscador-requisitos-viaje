/**
 * propuestas_cambio: sobre canónico INMUTABLE y hasheado (payload +
 * algoritmo_canonicalizacion + algoritmo_hash) más un puñado de campos
 * operativos que sí mutan (estado, decision_aprobacion_id,
 * ultimo_evento_id).
 *
 * `_id` es el ObjectId por defecto de Mongo. La identidad de negocio es
 * `propuesta_id` (UUID), campo propio y único — no un alias de `_id`.
 *
 * `destino_id`/`requisito_id`/`campo`/`run_id_origen` quedan como
 * campos EXTERNOS (además de estar duplicados dentro de `payload`)
 * porque son los únicos datos de negocio que hacen falta para índices y
 * consultas (el índice único parcial de propuesta activa, las búsquedas
 * por origen, etc.). El resto del contenido de negocio — `valor_anterior`,
 * `valor_propuesto`, `fuente` — NO se duplica afuera: vivían tanto
 * adentro como afuera del payload y el hook de la ronda anterior solo
 * comparaba ids/campo/run, dejando esos tres sin protección contra
 * divergencia. Ahora viven ÚNICAMENTE dentro de `payload`; se exponen
 * como virtuals de solo lectura (`valor_anterior`, `valor_propuesto`,
 * `fuente`, ver más abajo) para no romper la ergonomía de lectura sin
 * reintroducir una copia separada que se pueda desincronizar.
 *
 * SOBRE CANÓNICO Y HASH:
 *   sobre = { algoritmo_canonicalizacion, algoritmo_hash, payload }
 *   payload_hash = SHA-256hex( canonicalizar_toc_v1( sobre ) )
 * `algoritmo_canonicalizacion` fija el algoritmo de canonicalización
 * ("toc-v1": UTF-8, claves ordenadas recursivamente, fechas en UTC como
 * ISO string, `undefined` explícitamente prohibido). `algoritmo_hash`
 * fija el algoritmo de hash ("sha256", hex minúsculas). Versionarlos
 * por separado permite cambiar uno sin tocar el otro, sin romper hashes
 * viejos en silencio. `canonicalizarValor`/`hashSobreCanonico` viven en
 * ../../services/propuestas/canonicalizacion-propuestas.js — módulo
 * COMPARTIDO (no duplicado): el futuro servicio de creación de
 * propuestas debe calcular el payload_hash con exactamente el mismo
 * código que este modelo usa para validarlo.
 *
 * `payload` incluye, como string, `destino_id`, `requisito_id`, `campo`,
 * `run_id_origen` y `propuesta_id` — el hook de abajo exige que
 * coincidan EXACTAMENTE con los campos externos homónimos, para que
 * payload y metadatos del documento nunca puedan divergir en silencio.
 * También incluye `valor_anterior` ({presente, valor}), `valor_propuesto`
 * ({valor, valor_normalizado, evidencia}) y `fuente` ({nombre, url,
 * capturado_en}). Como `payload` es Mixed (para poder canonicalizarlo y
 * hashearlo como un todo), estos tres shapes ya no los valida Mongoose
 * por schema — el hook los valida a mano (`validarValorConPresencia`,
 * `validarValorPropuesto`, `validarFuente` más abajo) para no perder
 * esa cobertura.
 *
 * Contrato del payload (también dentro del contenido hasheado):
 * `version_contrato` === '1.0', `tipo_propuesta` ===
 * 'actualizacion_campo_requisito' y `fecha_propuesta` como ISO UTC
 * exacta (Date#toISOString). El hook rechaza cualquier otro valor
 * (`validarContrato`); las constantes viven en el módulo compartido.
 *
 * decision_aprobacion_id: se quitó la "immutable" funcional que existía
 * antes (evaluaba el valor YA guardado para permitir solo la primera
 * asignación). Esa función podía impedir la PRIMERA asignación de null
 * a un UUID, o comportarse de forma inconsistente según la ruta de
 * escritura de Mongoose (save() vs. findOneAndUpdate() vs. operaciones
 * con runValidators) — era una falsa garantía a nivel de schema. Ahora
 * es simplemente `{ type: String, default: null }`. La transición
 * null -> UUID (una única vez) se protege en la CAPA DE SERVICIO con un
 * filtro CAS, no acá:
 *
 *   updateOne(
 *     { propuesta_id, estado: estadoEsperado, payload_hash: hashEsperado,
 *       decision_aprobacion_id: null, version_coordinacion: versionEsperada },
 *     { $set: { decision_aprobacion_id: eventoAprobacionId, estado: 'aprobada',
 *               ultimo_evento_id: eventoAprobacionId },
 *       $inc: { version_coordinacion: 1 } }
 *   )
 *
 * `version_coordinacion` (arranca en 0) es la versión esperada EXPLÍCITA
 * para concurrencia optimista: toda transición CAS la filtra y la
 * incrementa. No se usa `__v`: es el versionKey interno de Mongoose, que
 * solo se incrementa en ciertas rutas de save() sobre arrays y no en
 * updateOne() — no sirve como contrato de coordinación.
 * `ultimo_evento_id` sigue siendo un puntero simple y mutable al último
 * evento (de cualquier tipo), actualizado en la misma transacción que
 * cada inserción en eventos_propuesta.
 *
 * Allowlist de campo proponible: el MVP solo soporta 'costo'.
 *
 * Defensa contra mutaciones (auxiliar, no garantía — ver nota extendida
 * en EjecucionLectura.model.js): el hook `pre('validate')` recalcula el
 * hash del sobre, valida que los duplicados no diverjan y bloquea tocar
 * `payload` en un doc ya existente. Esto NO reemplaza la protección
 * real (servicios con operaciones permitidas + filtros CAS).
 *
 * Índice único parcial (declarado, no creado en Atlas todavía): una
 * sola propuesta ACTIVA por (destino_id, requisito_id, campo), donde
 * "activa" son pendiente_aprobacion, aprobada y revision_requerida.
 */

const mongoose = require('mongoose');
const crypto = require('crypto');
const {
  ALGORITMO_CANONICALIZACION,
  ALGORITMO_HASH,
  SHA256_HEX,
  VERSION_CONTRATO_PROPUESTA,
  TIPO_PROPUESTA,
  esFechaIsoUtcExacta,
  hashSobreCanonico
} = require('../../services/propuestas/canonicalizacion-propuestas');

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

const ESTADOS_ACTIVOS = ['pendiente_aprobacion', 'aprobada', 'revision_requerida'];

// MVP: solo 'costo'. No agregar campos sin implementar su validador
// particular (nombre/obligatorio/fuente/link, etc. quedan afuera).
const CAMPOS_PROPONIBLES = ['costo'];

// Validaciones manuales de shape para el contenido de negocio que vive
// dentro de `payload` (Mixed) — ya no lo tipa Mongoose directamente.
function validarValorConPresencia(valor, nombreCampo) {
  if (valor === null || typeof valor !== 'object' || Array.isArray(valor)) {
    throw new Error(`propuestas_cambio: payload.${nombreCampo} debe ser un objeto {presente, valor}.`);
  }
  if (typeof valor.presente !== 'boolean') {
    throw new Error(`propuestas_cambio: payload.${nombreCampo}.presente debe ser boolean.`);
  }
  if (!('valor' in valor)) {
    throw new Error(`propuestas_cambio: payload.${nombreCampo}.valor es obligatorio (puede ser null).`);
  }
}

function validarValorPropuesto(valor) {
  if (valor === null || typeof valor !== 'object' || Array.isArray(valor)) {
    throw new Error('propuestas_cambio: payload.valor_propuesto debe ser un objeto {valor, valor_normalizado, evidencia}.');
  }
  for (const clave of ['valor', 'valor_normalizado', 'evidencia']) {
    if (!(clave in valor)) {
      throw new Error(`propuestas_cambio: payload.valor_propuesto.${clave} es obligatorio.`);
    }
  }
}

function validarContrato(payload) {
  if (payload.version_contrato !== VERSION_CONTRATO_PROPUESTA) {
    throw new Error(
      `propuestas_cambio: payload.version_contrato debe ser "${VERSION_CONTRATO_PROPUESTA}" (recibido ${JSON.stringify(payload.version_contrato)}).`
    );
  }
  if (payload.tipo_propuesta !== TIPO_PROPUESTA) {
    throw new Error(
      `propuestas_cambio: payload.tipo_propuesta debe ser "${TIPO_PROPUESTA}" (recibido ${JSON.stringify(payload.tipo_propuesta)}).`
    );
  }
  if (!esFechaIsoUtcExacta(payload.fecha_propuesta)) {
    throw new Error(
      `propuestas_cambio: payload.fecha_propuesta debe ser una fecha ISO UTC exacta (Date#toISOString), recibido ${JSON.stringify(payload.fecha_propuesta)}.`
    );
  }
}

function validarFuente(valor) {
  if (valor === null || typeof valor !== 'object' || Array.isArray(valor)) {
    throw new Error('propuestas_cambio: payload.fuente debe ser un objeto {nombre, url, capturado_en}.');
  }
  for (const clave of ['nombre', 'url', 'capturado_en']) {
    if (!valor[clave]) {
      throw new Error(`propuestas_cambio: payload.fuente.${clave} es obligatorio.`);
    }
  }
}

const propuestaCambioSchema = new mongoose.Schema(
  {
    propuesta_id: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      default: () => crypto.randomUUID()
    },

    destino_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Destino', required: true, immutable: true },
    requisito_id: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
    campo: { type: String, required: true, enum: CAMPOS_PROPONIBLES, immutable: true },

    algoritmo_canonicalizacion: { type: String, required: true, enum: [ALGORITMO_CANONICALIZACION], immutable: true },
    algoritmo_hash: { type: String, required: true, enum: [ALGORITMO_HASH], immutable: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
    payload_hash: { type: String, required: true, match: SHA256_HEX, immutable: true },

    run_id_origen: { type: String, required: true, immutable: true },

    estado: { type: String, required: true, enum: ESTADOS_PROPUESTA, default: 'pendiente_aprobacion' },

    // Versión esperada explícita para las transiciones CAS (ver nota de
    // cabecera); no se usa __v.
    version_coordinacion: { type: Number, required: true, default: 0, min: 0 },

    // Sin `immutable` funcional (corrección: ver nota de cabecera). La
    // transición null -> UUID, una sola vez, se protege con un filtro
    // CAS en la capa de servicio, no acá.
    decision_aprobacion_id: { type: String, default: null },

    // Puntero simple, mutable, al último evento.
    ultimo_evento_id: { type: String, default: null }
  },
  {
    collection: 'propuestas_cambio',
    timestamps: true,
    autoIndex: false,
    // minimize:false es obligatorio acá: por defecto Mongoose borra en
    // silencio las claves cuyo valor es un objeto vacío ({}) al
    // serializar (toObject/toJSON/save). `payload` es un sobre
    // hasheado — si Mongo (vía Mongoose) le borra una clave como
    // `evidencia: {}` en un round-trip, el documento persistido ya NO
    // coincidiría con el payload_hash calculado al crearlo.
    minimize: false,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

// Virtuals de solo lectura: valor_anterior/valor_propuesto/fuente viven
// únicamente dentro de `payload` (corrección); estos getters evitan que
// los consumidores tengan que acceder a `doc.payload.*` a mano, sin
// reintroducir una copia separada que pueda desincronizarse.
propuestaCambioSchema.virtual('valor_anterior').get(function () {
  return this.payload ? this.payload.valor_anterior : undefined;
});
propuestaCambioSchema.virtual('valor_propuesto').get(function () {
  return this.payload ? this.payload.valor_propuesto : undefined;
});
propuestaCambioSchema.virtual('fuente').get(function () {
  return this.payload ? this.payload.fuente : undefined;
});

propuestaCambioSchema.pre('validate', function () {
  if (!this.isNew && this.isModified('payload')) {
    throw new Error('propuestas_cambio: el payload es inmutable, no se puede modificar tras la creación.');
  }

  if (this.payload === null || typeof this.payload !== 'object' || Array.isArray(this.payload)) {
    throw new Error('propuestas_cambio: payload debe ser un objeto.');
  }

  // destino_id/requisito_id/campo/run_id_origen/propuesta_id externos
  // deben coincidir EXACTAMENTE con los del payload canónico.
  const camposAComparar = [
    ['destino_id', this.destino_id != null ? String(this.destino_id) : null],
    ['requisito_id', this.requisito_id != null ? String(this.requisito_id) : null],
    ['campo', this.campo],
    ['run_id_origen', this.run_id_origen],
    ['propuesta_id', this.propuesta_id]
  ];
  for (const [nombreCampo, valorExterno] of camposAComparar) {
    const valorEnPayload = this.payload[nombreCampo];
    if (valorEnPayload !== valorExterno) {
      throw new Error(
        `propuestas_cambio: "${nombreCampo}" del payload (${JSON.stringify(valorEnPayload)}) no coincide con el campo externo "${nombreCampo}" (${JSON.stringify(valorExterno)}); no pueden divergir.`
      );
    }
  }

  // valor_anterior/valor_propuesto/fuente solo existen dentro de
  // payload — se validan a mano porque Mongoose ya no los tipa.
  validarContrato(this.payload);
  validarValorConPresencia(this.payload.valor_anterior, 'valor_anterior');
  validarValorPropuesto(this.payload.valor_propuesto);
  validarFuente(this.payload.fuente);

  if (this.algoritmo_canonicalizacion === ALGORITMO_CANONICALIZACION && this.algoritmo_hash === ALGORITMO_HASH) {
    const hashRecalculado = hashSobreCanonico(this.payload, this.algoritmo_canonicalizacion, this.algoritmo_hash);
    if (hashRecalculado !== this.payload_hash) {
      throw new Error(
        `propuestas_cambio: payload_hash (${this.payload_hash}) no coincide con el hash recalculado del sobre canónico completo (${hashRecalculado}).`
      );
    }
  }
});

// Índice único PARCIAL: una sola propuesta activa por
// (destino_id, requisito_id, campo). Declarado, no creado en Atlas.
propuestaCambioSchema.index(
  { destino_id: 1, requisito_id: 1, campo: 1 },
  {
    unique: true,
    partialFilterExpression: { estado: { $in: ESTADOS_ACTIVOS } },
    name: 'uniq_propuesta_activa_por_destino_requisito_campo'
  }
);

propuestaCambioSchema.index({ run_id_origen: 1 });
propuestaCambioSchema.index({ decision_aprobacion_id: 1 }, { sparse: true });
propuestaCambioSchema.index({ ultimo_evento_id: 1 }, { sparse: true });
propuestaCambioSchema.index({ estado: 1, createdAt: -1 });

module.exports = mongoose.model('PropuestaCambio', propuestaCambioSchema);
