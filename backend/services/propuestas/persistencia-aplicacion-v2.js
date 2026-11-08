/**
 * H2.1 — Persistidores de auditoría 2.0 sobre los modelos existentes
 * (intentos_aplicacion, historial_cambios, eventos_propuesta y, desde H3.1,
 * inicios_intento_aplicacion). No está conectado a rutas, CLI ni panel.
 *
 * - Siempre una instancia NUEVA con strict 'throw': validación y hooks
 *   reales de Mongoose en cada llamada (también en cada reintento del
 *   callback de la transacción), sin descartar claves en silencio.
 * - Escrituras transaccionales: exigen la sesión de una transacción activa
 *   y la pasan explícitamente a save(); Mongoose no la propaga sola.
 * - Registro independiente (intento terminado fuera de la transacción) e
 *   inicio del intento: sin sesión y con writeConcern majority, como en el 1.0.
 * - Nunca collection.insertOne: eludiría los modelos de auditoría. Las
 *   lecturas de relectura sí son nativas, sin casting.
 * - Los destinos NO pasan por aquí: se leen y escriben con
 *   Destino.collection (dependenciasDestino en aplicar-propuesta-v2.js).
 */
const mongoose = require('mongoose');
const IntentoAplicacion = require('../../models/propuestas/IntentoAplicacion.model');
const HistorialCambio = require('../../models/propuestas/HistorialCambio.model');
const EventoPropuesta = require('../../models/propuestas/EventoPropuesta.model');
const InicioIntentoAplicacion = require('../../models/propuestas/InicioIntentoAplicacion.model');

// Marcadores de hoja: no son strings, así que nunca coinciden con una hoja admitida.
const NO_ADMITIDO = Symbol('no_admitido');
const INDEFINIDO = Symbol('indefinido');
const esPlano = v => Array.isArray(v) || [Object.prototype, null].includes(Object.getPrototypeOf(v));
// Pura. Hoja con su tipo: Date y ObjectId no se confunden con su texto. Solo se
// admiten tipos que BSON guarda tal cual; funciones, símbolos, BigInt, números no
// finitos, Date inválidos y objetos no planos (String, Map, RegExp…) son NO_ADMITIDO:
// Mongoose puede conservarlos en un Mixed, pero Mongo los descartaría o cambiaría.
function hoja(v) {
  if (v === undefined) return INDEFINIDO;
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number') return Number.isFinite(v) ? JSON.stringify(v) : NO_ADMITIDO;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? NO_ADMITIDO : `Date(${v.toISOString()})`;
  if (v?._bsontype === 'ObjectId') return `ObjectId(${v.toHexString()})`;
  if (typeof v === 'object' && esPlano(v)) return JSON.stringify(v); // {} o [] vacíos
  return NO_ADMITIDO;
}
// Pura. [ruta, hoja] de cada hoja; un objeto o array vacío es una hoja. La ruta
// es la lista de claves (una clave con punto no se confunde con un anidamiento).
function hojas(v, ruta = []) {
  if (v !== null && typeof v === 'object' && esPlano(v) && Object.keys(v).length) {
    return Object.entries(v).flatMap(([k, x]) => hojas(x, [...ruta, k]));
  }
  return [[JSON.stringify(ruta), hoja(v)]];
}
// Un undefined solo equivale a «campo opcional ausente» si el esquema declara esa
// ruta exacta y el documento tampoco la tiene. schema.path() resuelve cualquier
// subruta de un Mixed raíz al propio Mixed: por eso se exige además que el padre
// no sea Mixed (un Mixed anidado no resuelve sus subrutas).
function opcionalAusente(Modelo, ruta, salida) {
  const partes = JSON.parse(ruta).filter(k => !/^\d+$/.test(k));
  const declarada = Modelo.schema.path(partes.join('.')) != null
    && (partes.length === 1 || Modelo.schema.path(partes.slice(0, -1).join('.'))?.instance !== 'Mixed');
  return declarada && !salida.has(ruta);
}
// Única conversión admitida: un string hex que el esquema guarda como ObjectId
// (destino_id/requisito_id, como en el 1.0). String ISO → Date u ObjectId → String no.
const igual = (entrada, salida) => entrada === salida
  || (typeof entrada === 'string' && typeof salida === 'string' && entrada.startsWith('"') && salida.startsWith('ObjectId(') && `ObjectId(${JSON.parse(entrada)})` === salida);

// strict 'throw' del constructor solo cubre el primer nivel: los subdocumentos
// descartarían en silencio. Se exige que cada hoja de la entrada sobreviva con
// el mismo tipo y valor (salvo hex→ObjectId) en el documento construido. Los
// tipos no persistibles se rechazan antes de construir nada.
function nuevo(Modelo, doc) {
  const entrada = hojas(doc);
  const rutas = lista => lista.map(([ruta]) => JSON.parse(ruta).join('.'));
  const noAdmitidas = rutas(entrada.filter(([, valor]) => valor === NO_ADMITIDO));
  if (noAdmitidas.length) throw new mongoose.Error.StrictModeError(noAdmitidas[0], `persistencia 2.0: tipos no persistibles (${noAdmitidas.join(', ')}).`);
  const m = new Modelo(doc, null, { strict: 'throw' });
  const salida = new Map(hojas(m.toObject({ depopulate: true, versionKey: false })));
  // Una hoja definida debe reaparecer igual (si falta, salida.get da undefined y no es igual);
  // una ruta presente con undefined solo pasa si es un campo opcional declarado y ausente.
  const distintas = rutas(entrada.filter(([ruta, valor]) => valor === INDEFINIDO
    ? !opcionalAusente(Modelo, ruta, salida)
    : !igual(valor, salida.get(ruta))));
  if (distintas.length) throw new mongoose.Error.StrictModeError(distintas[0], `persistencia 2.0: claves descartadas o valores convertidos por el esquema (${distintas.join(', ')}).`);
  return m;
}

function exigirSesion(session) {
  if (!session || typeof session.inTransaction !== 'function' || !session.inTransaction()) {
    throw new TypeError('persistencia 2.0: la escritura exige la sesión de una transacción activa.');
  }
}

function crearPersistenciaV2() {
  return Object.freeze({
    validarIntento: (doc) => nuevo(IntentoAplicacion, doc).validate(),
    validarHistorial: (doc) => nuevo(HistorialCambio, doc).validate(),
    validarEvento: (doc) => nuevo(EventoPropuesta, doc).validate(),
    validarInicio: (doc) => nuevo(InicioIntentoAplicacion, doc).validate(),
    insertarIntento: async (doc, session) => { exigirSesion(session); await nuevo(IntentoAplicacion, doc).save({ session }); },
    insertarHistorial: async (doc, session) => { exigirSesion(session); await nuevo(HistorialCambio, doc).save({ session }); },
    insertarEvento: async (doc, session) => { exigirSesion(session); await nuevo(EventoPropuesta, doc).save({ session }); },
    insertarIntentoIndependiente: async (doc) => { await nuevo(IntentoAplicacion, doc).save({ writeConcern: { w: 'majority' } }); },
    // Inicio: insert independiente, antes de cualquier consulta externa (nunca dentro de una transacción).
    insertarInicio: async (doc) => { await nuevo(InicioIntentoAplicacion, doc).save({ writeConcern: { w: 'majority' } }); },
    leerIntento: (intentoId) => IntentoAplicacion.collection.findOne({ intento_id: intentoId }),
    leerHistorial: (historialId) => HistorialCambio.collection.findOne({ historial_id: historialId }),
    // Con la sesión de la transacción cuando se verifica el inicio dentro de ella.
    leerInicio: (intentoId, session) => InicioIntentoAplicacion.collection.findOne({ intento_id: intentoId }, session ? { session } : {})
  });
}

module.exports = { crearPersistenciaV2 };
