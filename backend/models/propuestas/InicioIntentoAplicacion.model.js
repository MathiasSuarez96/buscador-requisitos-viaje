/**
 * inicios_intento_aplicacion: registro APPEND-ONLY del ARRANQUE de cada
 * intento de aplicación, escrito como insert independiente (fuera de
 * toda transacción, writeConcern majority) justo antes de la
 * revalidación externa.
 *
 * Existe para detectar procesos INTERRUMPIDOS: si el proceso muere
 * entre el arranque y el registro del intento terminado (por ejemplo,
 * después de abortar la transacción de escritura y antes de insertar el
 * IntentoAplicacion fallido), queda un inicio sin intento terminado con
 * el mismo intento_id. Auditoría: inicios sin IntentoAplicacion
 * correspondiente y con iniciado_en más viejo que el tiempo máximo de
 * un intento => intento interrumpido.
 *
 * intentos_aplicacion sigue guardando solo intentos TERMINADOS; esta
 * colección nunca se actualiza para "cerrar" un inicio (eso rompería el
 * append-only). La correspondencia es por intento_id.
 *
 * Los campos de contexto (propuesta, hash, versión, operador, proceso
 * aplicador, adaptador) se repiten acá a propósito: si el proceso
 * muere, este documento es la ÚNICA evidencia de ese intento. Mismos
 * roles separados que IntentoAplicacion (ver contrato-propuestas.js).
 *
 * VERSIONES: sin `version_contrato` el documento es 1.0 y rigen las reglas
 * de arriba (también para históricos). Con `version_contrato: '2.0'` (H3.1)
 * el inicio reserva los tres identificadores del intento (intento_id,
 * evento_id, historial_id), guarda la decisión esperada y exige auditoría
 * coherente con el operador, proceso aplicar-propuesta-v2 y adaptador
 * técnico. Sin `proceso` (host/pid) en 2.0: el núcleo compara el registro
 * completo. No hay default de versión ni migración.
 */

const mongoose = require('mongoose');
const { validarAuditoria } = require('../../services/propuestas/auditoria-aplicacion');

const SHA256_HEX = /^[0-9a-f]{64}$/;

// ---- Contrato 2.0 (solo con version_contrato: '2.0') ----
const VERSIONES_CONTRATO = ['2.0'];
const esV2 = (doc) => doc.version_contrato === '2.0';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NOMBRE_TECNICO = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PROCESO_V2 = Object.freeze({ nombre: 'aplicar-propuesta-v2', version: '1' });
const CAMPOS_SOLO_V2 = ['evento_id', 'historial_id', 'decision_aprobacion_id_esperado'];
const CAMPOS_SOLO_V1 = ['proceso'];
const presenteEn = (doc, campo) => doc.get(campo) !== undefined;

// Humano autenticado por OIDC (panel) o connection_status (comando administrativo).
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

const inicioIntentoAplicacionSchema = new mongoose.Schema(
  {
    // Sin default: lo genera el servicio una sola vez y lo reutiliza en
    // el intento terminado, el historial y los eventos.
    intento_id: { type: String, required: true, unique: true, immutable: true },
    propuesta_id: { type: String, required: true, immutable: true },
    hash_contenido_referenciado: { type: String, required: true, match: SHA256_HEX, immutable: true },
    version_coordinacion_esperada: {
      type: Number,
      required: true,
      min: 0,
      immutable: true,
      validate: { validator: Number.isInteger, message: 'version_coordinacion_esperada debe ser entero.' }
    },
    operador: { type: operadorSchema, required: true, immutable: true },
    // Opcional para documentos históricos; toda escritura del servicio actual lo exige.
    auditoria: { type: mongoose.Schema.Types.Mixed, immutable: true, validate: { validator: v => { validarAuditoria(v); return true; }, message: 'Auditoría inválida.' } },
    proceso_aplicador: { type: nombreVersionSchema, required: true, immutable: true },
    adaptador: { type: nombreVersionSchema, required: true, immutable: true },
    iniciado_en: { type: Date, required: true, immutable: true },
    // Contexto del proceso (host, pid) para rastrear un intento
    // interrumpido. Forma libre.
    proceso: { type: mongoose.Schema.Types.Mixed, required: false, immutable: true },

    // Ausente = 1.0 (históricos incluidos). Sin default.
    version_contrato: { type: String, enum: VERSIONES_CONTRATO, immutable: true },
    // ---- Solo 2.0: identificadores reservados y decisión esperada ----
    evento_id: { type: String, immutable: true },
    historial_id: { type: String, immutable: true },
    decision_aprobacion_id_esperado: { type: String, immutable: true }
  },
  {
    collection: 'inicios_intento_aplicacion',
    timestamps: false,
    autoIndex: false,
    minimize: false
  }
);

inicioIntentoAplicacionSchema.pre('validate', function () {
  if (!this.isNew) {
    throw new Error('inicios_intento_aplicacion es append-only: no se puede modificar un inicio ya insertado.');
  }
  if (esV2(this)) validarV2(this);
  else {
    const mezclados = CAMPOS_SOLO_V2.filter((c) => presenteEn(this, c));
    if (mezclados.length) throw new Error(`inicios_intento_aplicacion: un documento 1.0 no admite campos 2.0 (${mezclados.join(', ')}).`);
    if (this.proceso_aplicador?.nombre === PROCESO_V2.nombre) throw new Error('inicios_intento_aplicacion: el proceso 2.0 exige version_contrato "2.0".');
  }
});

function falla2(mensaje) {
  throw new Error(`inicios_intento_aplicacion 2.0: ${mensaje}`);
}

function validarV2(doc) {
  const mezclados = CAMPOS_SOLO_V1.filter((c) => presenteEn(doc, c));
  if (mezclados.length) falla2(`campos exclusivos del 1.0 no admitidos (${mezclados.join(', ')}).`);
  for (const c of ['intento_id', 'evento_id', 'historial_id', 'propuesta_id', 'decision_aprobacion_id_esperado']) {
    if (typeof doc[c] !== 'string' || !UUID.test(doc[c])) falla2(`${c} debe ser UUID.`);
  }
  if (new Set([doc.intento_id, doc.evento_id, doc.historial_id]).size !== 3) falla2('intento_id, evento_id e historial_id deben ser distintos.');
  if (doc.proceso_aplicador?.nombre !== PROCESO_V2.nombre || doc.proceso_aplicador?.version !== PROCESO_V2.version) falla2('proceso_aplicador no es el aplicador 2.0.');
  if (!NOMBRE_TECNICO.test(doc.adaptador?.nombre ?? '') || !NOMBRE_TECNICO.test(doc.adaptador?.version ?? '')) falla2('adaptador debe tener nombre y versión técnicos.');
  // Obligatoria en 2.0: ausente o inválida falla en validarAuditoria (iniciado_en lo cubre el esquema).
  let a;
  try { a = validarAuditoria(doc.auditoria); } catch { falla2('auditoria inválida.'); }
  if (doc.operador?.identificador !== a.operador) falla2('operador no coincide con la auditoría.');
  // La instantánea del panel describe exactamente este inicio.
  const s = a.instantanea;
  if (s && (s.propuesta_id !== doc.propuesta_id || s.payload_hash_esperado !== doc.hash_contenido_referenciado ||
      s.version_coordinacion_esperada !== doc.version_coordinacion_esperada || s.decision_aprobacion_id_esperado !== doc.decision_aprobacion_id_esperado)) {
    falla2('la instantánea de la auditoría no corresponde a este inicio.');
  }
}

// Solo rendimiento (auditoría de interrumpidos por propuesta y fecha).
inicioIntentoAplicacionSchema.index({ propuesta_id: 1, iniciado_en: -1 });

module.exports = mongoose.model('InicioIntentoAplicacion', inicioIntentoAplicacionSchema);
