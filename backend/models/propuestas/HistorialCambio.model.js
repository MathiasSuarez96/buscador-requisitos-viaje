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
 *
 * VERSIONES: sin `version_contrato` el documento es 1.0 (un solo campo,
 * valor_anterior/valor_nuevo y revalidacion_id), también para históricos.
 * Con `version_contrato: '2.0'`: campo 'requisito', cambios[] con valores
 * capturados {presente, bson_tipo, valor} y fecha_verificacion
 * {anterior, nueva}; las revalidaciones se leen del intento referenciado
 * por intento_aplicacion_id (no se copian ni se referencian por id).
 */

const mongoose = require('mongoose');
const crypto = require('crypto');
const { CAMPO_EXTERNO, CAMPOS_MODIFICABLES, esFechaCalendario, validarValorCapturado } = require('../../services/propuestas/contrato-requisito-v2');

// ---- Contrato 2.0 (solo con version_contrato: '2.0') ----
const VERSIONES_CONTRATO = ['2.0'];
const esV2 = (doc) => doc.version_contrato === '2.0';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CAMPOS_SOLO_V1 = ['valor_anterior', 'valor_nuevo', 'revalidacion_id'];
const CAMPOS_SOLO_V2 = ['cambios', 'fecha_verificacion'];
const presenteEn = (doc, campo) => doc.get(campo) !== undefined;

// Valor capturado 2.0. Todo Mixed: Mongoose no convierte boolean/fecha/string;
// la forma exacta la valida validarValorCapturado en el hook. Strict por defecto en
// subesquemas (ver IntentoAplicacion): la persistencia 2.0 detecta descartes anidados.
const valorCapturadoSchema = new mongoose.Schema(
  {
    presente: { type: mongoose.Schema.Types.Mixed },
    bson_tipo: { type: mongoose.Schema.Types.Mixed },
    valor: { type: mongoose.Schema.Types.Mixed }
  },
  { _id: false, minimize: false }
);

const cambioV2Schema = new mongoose.Schema(
  {
    campo: { type: String, required: true },
    anterior: { type: valorCapturadoSchema, required: true },
    nuevo: { type: valorCapturadoSchema, required: true }
  },
  { _id: false }
);

const fechaV2Schema = new mongoose.Schema(
  {
    anterior: { type: valorCapturadoSchema, required: true },
    nueva: { type: valorCapturadoSchema, required: true }
  },
  { _id: false }
);

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

    // Ausente = 1.0 (históricos incluidos). Sin default.
    version_contrato: { type: String, enum: VERSIONES_CONTRATO, immutable: true },

    destino_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Destino', required: true, immutable: true },
    requisito_id: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
    campo: { type: String, required: true, immutable: true },

    // Solo 1.0.
    valor_anterior: { type: valorConPresenciaSchema, required: function () { return !esV2(this); }, immutable: true },
    valor_nuevo: { type: valorConPresenciaSchema, required: function () { return !esV2(this); }, immutable: true },

    aplicado_en: { type: Date, required: true, immutable: true },

    propuesta_id: { type: String, required: true, immutable: true },
    decision_aprobacion_id: { type: String, required: true, immutable: true },
    intento_aplicacion_id: { type: String, required: true, immutable: true },
    // Referencia por id a IntentoAplicacion.revalidacion.revalidacion_id
    // (no duplicar el contenido de la revalidación acá).
    revalidacion_id: { type: String, required: function () { return !esV2(this); }, immutable: true },

    // ---- Solo 2.0 ----
    cambios: { type: [cambioV2Schema], default: undefined, immutable: true },
    fecha_verificacion: { type: fechaV2Schema, immutable: true }
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
  if (esV2(this)) validarV2(this);
  else {
    const mezclados = CAMPOS_SOLO_V2.filter((c) => presenteEn(this, c));
    if (mezclados.length) throw new Error(`historial_cambios: un documento 1.0 no admite campos 2.0 (${mezclados.join(', ')}).`);
  }
});

function falla2(mensaje) {
  throw new Error(`historial_cambios 2.0: ${mensaje}`);
}

// Pura sobre el subdocumento: exige las tres claves (valor ausente → null, nunca undefined).
function capturado(sub, nombre) {
  const v = sub?.toObject ? sub.toObject() : sub;
  if (v == null || !Object.hasOwn(v, 'valor')) falla2(`${nombre} debe contener presente, bson_tipo y valor.`);
  try { return validarValorCapturado({ presente: v.presente, bson_tipo: v.bson_tipo, valor: v.valor }, nombre); }
  catch { falla2(`${nombre} no es un valor capturado válido.`); }
}

function validarV2(doc) {
  const mezclados = CAMPOS_SOLO_V1.filter((c) => presenteEn(doc, c));
  if (mezclados.length) falla2(`campos exclusivos del 1.0 no admitidos (${mezclados.join(', ')}).`);
  if (doc.campo !== CAMPO_EXTERNO) falla2(`campo debe ser "${CAMPO_EXTERNO}".`);
  for (const campo of ['historial_id', 'propuesta_id', 'decision_aprobacion_id', 'intento_aplicacion_id']) {
    if (!UUID.test(doc[campo] ?? '')) falla2(`${campo} debe ser UUID.`);
  }
  if (!Array.isArray(doc.cambios) || doc.cambios.length === 0) falla2('cambios es obligatorio y no vacío.');
  let previo = null;
  for (const [i, c] of doc.cambios.entries()) {
    if (c == null) falla2(`cambios[${i}] vacío.`);
    if (!CAMPOS_MODIFICABLES.includes(c.campo)) falla2(`cambios[${i}].campo no modificable.`);
    if (previo !== null && !(previo < c.campo)) falla2('cambios debe estar ordenado por campo y sin repetidos.');
    previo = c.campo;
    const anterior = capturado(c.anterior, `cambios[${i}].anterior`), nuevo = capturado(c.nuevo, `cambios[${i}].nuevo`);
    if (anterior.presente === nuevo.presente && anterior.bson_tipo === nuevo.bson_tipo && anterior.valor === nuevo.valor) falla2(`cambios[${i}] sin efecto.`);
  }
  if (doc.fecha_verificacion == null) falla2('fecha_verificacion es obligatoria.');
  const anterior = capturado(doc.fecha_verificacion.anterior, 'fecha_verificacion.anterior');
  const nueva = capturado(doc.fecha_verificacion.nueva, 'fecha_verificacion.nueva');
  if (anterior.bson_tipo === 'string' && !esFechaCalendario(anterior.valor)) falla2('fecha_verificacion.anterior no es YYYY-MM-DD válido.');
  if (nueva.bson_tipo !== 'string' || !esFechaCalendario(nueva.valor)) falla2('fecha_verificacion.nueva debe ser string YYYY-MM-DD válido.');
}

// Auditoría "qué pasó con este campo a lo largo del tiempo".
historialCambioSchema.index({ destino_id: 1, requisito_id: 1, campo: 1, aplicado_en: -1 });
// Integridad: una propuesta no puede tener más de una entrada de historial.
historialCambioSchema.index({ propuesta_id: 1 }, { unique: true });
// Integridad: un intento exitoso no puede tener más de una entrada de historial.
historialCambioSchema.index({ intento_aplicacion_id: 1 }, { unique: true });

module.exports = mongoose.model('HistorialCambio', historialCambioSchema);
