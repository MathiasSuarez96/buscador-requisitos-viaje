/**
 * H2.1 — Persistidores de auditoría 2.0 sobre los modelos existentes
 * (intentos_aplicacion, historial_cambios, eventos_propuesta). No está
 * conectado a rutas, CLI ni panel.
 *
 * - Siempre una instancia NUEVA con strict 'throw': validación y hooks
 *   reales de Mongoose en cada llamada (también en cada reintento del
 *   callback de la transacción), sin descartar claves en silencio.
 * - Escrituras transaccionales: exigen la sesión de una transacción activa
 *   y la pasan explícitamente a save(); Mongoose no la propaga sola.
 * - Registro independiente (intento terminado fuera de la transacción):
 *   sin sesión y con writeConcern majority, como en el 1.0.
 * - Nunca collection.insertOne: eludiría los modelos de auditoría. Las
 *   lecturas de relectura sí son nativas, sin casting.
 * - Los destinos NO pasan por aquí: se leen y escriben con
 *   Destino.collection (dependenciasDestino en aplicar-propuesta-v2.js).
 */
const mongoose = require('mongoose');
const IntentoAplicacion = require('../../models/propuestas/IntentoAplicacion.model');
const HistorialCambio = require('../../models/propuestas/HistorialCambio.model');
const EventoPropuesta = require('../../models/propuestas/EventoPropuesta.model');

// Pura. Hoja con su tipo: Date y ObjectId no se confunden con su texto.
function hoja(v) {
  if (v instanceof Date) return `Date(${Number.isNaN(v.getTime()) ? 'invalida' : v.toISOString()})`;
  if (v?._bsontype === 'ObjectId') return `ObjectId(${v.toHexString()})`;
  // JSON.stringify daría undefined (= ausente) para funciones y lanzaría con BigInt.
  if (typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') return `${typeof v}()`;
  return JSON.stringify(v);
}
// Pura. [ruta, hoja] de cada hoja; un objeto o array vacío es una hoja. La ruta
// es la lista de claves (una clave con punto no se confunde con un anidamiento).
function hojas(v, ruta = []) {
  if (v !== null && typeof v === 'object' && !(v instanceof Date) && v._bsontype !== 'ObjectId' && Object.keys(v).length) {
    return Object.entries(v).flatMap(([k, x]) => hojas(x, [...ruta, k]));
  }
  return [[JSON.stringify(ruta), hoja(v)]];
}
// Única conversión admitida: un string hex que el esquema guarda como ObjectId
// (destino_id/requisito_id, como en el 1.0). String ISO → Date u ObjectId → String no.
const igual = (entrada, salida) => entrada === salida
  || (entrada?.startsWith('"') && salida?.startsWith('ObjectId(') && `ObjectId(${JSON.parse(entrada)})` === salida);

// strict 'throw' del constructor solo cubre el primer nivel: los subdocumentos
// descartarían en silencio. Se exige que cada hoja de la entrada sobreviva con
// el mismo tipo y valor (salvo hex→ObjectId) en el documento construido.
function nuevo(Modelo, doc) {
  const m = new Modelo(doc, null, { strict: 'throw' });
  const salida = new Map(hojas(m.toObject({ depopulate: true, versionKey: false })));
  const distintas = hojas(doc).filter(([ruta, valor]) => !igual(valor, salida.get(ruta))).map(([ruta]) => JSON.parse(ruta).join('.'));
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
    insertarIntento: async (doc, session) => { exigirSesion(session); await nuevo(IntentoAplicacion, doc).save({ session }); },
    insertarHistorial: async (doc, session) => { exigirSesion(session); await nuevo(HistorialCambio, doc).save({ session }); },
    insertarEvento: async (doc, session) => { exigirSesion(session); await nuevo(EventoPropuesta, doc).save({ session }); },
    insertarIntentoIndependiente: async (doc) => { await nuevo(IntentoAplicacion, doc).save({ writeConcern: { w: 'majority' } }); },
    leerIntento: (intentoId) => IntentoAplicacion.collection.findOne({ intento_id: intentoId }),
    leerHistorial: (historialId) => HistorialCambio.collection.findOne({ historial_id: historialId })
  });
}

module.exports = { crearPersistenciaV2 };
