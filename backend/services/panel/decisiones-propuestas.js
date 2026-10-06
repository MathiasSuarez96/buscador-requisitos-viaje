/**
 * Decisiones del panel: aprobación y rechazo de una propuesta
 * (POST /api/panel/propuestas/:propuesta_id/aprobacion y /rechazo).
 *
 * La ÚNICA escritura es la de decidirPropuesta (CAS sobre
 * propuestas_cambio + EventoPropuesta, en una transacción). Este módulo
 * valida el body, hace una relectura previa de solo lectura con el driver
 * nativo y traduce el resultado; nunca escribe por su cuenta.
 *
 * BODY: objeto plano (prototipo Object.prototype) con exactamente estas
 * claves propias; cualquier otra (incluidas __proto__, constructor o
 * prototype, que JSON.parse crea como claves propias) es 400.
 *   estado_esperado                 'pendiente_aprobacion' (el único decidible)
 *   payload_hash_esperado           SHA-256 hex en minúsculas
 *   version_coordinacion_esperada   entero seguro >= 0
 *   motivo                          solo en rechazo, obligatorio: string bien
 *                                   formado, 1..MOTIVO_MAXIMO code points tras
 *                                   recortar, sin caracteres de control salvo
 *                                   \n y \t
 * tipo_evento sale de la ruta, decision_aprobacion_id_esperado lo fija el
 * servidor en null y el actor sale de req.operador (resolverIdentidad). La
 * entrada se arma campo por campo, nunca con spread del body. Claves
 * duplicadas en el JSON: JSON.parse se queda con la última, que igual pasa
 * por toda la validación (límite aceptado).
 *
 * RELECTURA PREVIA (fuera de la transacción; el CAS vuelve a proteger
 * estado, hash y versión). Nunca corrige los valores esperados: solo
 * compara y bloquea.
 *   1. propuesta inexistente → ErrorPropuestaInexistente (404).
 *   2. resolverActual, en este orden:
 *      a. lo visto (estado, payload_hash, version_coordinacion) difiere →
 *         reenvío idéntico: 200 ya_registrada; si no, ErrorPropuestaCambio
 *         (409). Recargar lo resuelve.
 *      b. lo visto coincide pero la coordinación es internamente inválida
 *         (pendiente con decision_aprobacion_id !== null) →
 *         ErrorPropuestaNoDecidible(['decision_previa_existente']) (422),
 *         en aprobación y rechazo. Recargar no lo resuelve. Acá no puede
 *         haber reenvío: la propuesta sigue pendiente y un reenvío exige
 *         que esté en el estado posterior a su último evento.
 *   3. solo aprobación: evaluarIntegridad del lector (la MISMA función que
 *      calcula acciones_bloqueadas.aprobar en el detalle GET: hash, datos,
 *      identidad del requisito y valor actual) → ErrorPropuestaNoDecidible
 *      (422). El rechazo solo necesita las precondiciones de coordinación:
 *      NO se bloquea por integridad, identidad ni cambio del valor actual.
 * Después del CAS, cas_no_coincide aplica la misma resolverActual (si todo
 * coincide igual, 409).
 *
 * REENVÍO IDÉNTICO (esReenvioIdentico): el último evento de la propuesta
 * (ultimo_evento_id) es exactamente esta decisión: mismo tipo, transición
 * (estado_anterior = esperado, estado_nuevo = destino del tipo), hash,
 * versión nueva = esperada + 1, motivo recortado, actor humano con el
 * mismo identificador, origen panel-propuestas e identidad_operador con el
 * mismo metodo y sub; la propuesta sigue en ese evento. Cualquier otra
 * decisión, u otro operador, es 409.
 *
 * Nada de lo leído sale tal cual: el 409 devuelve `actual` por lista
 * blanca (sin actor ni identidad), el 422 solo los códigos y el 200 los
 * datos del evento sin identidad_operador.
 */

const mongoose = require('mongoose');
const { SHA256_HEX } = require('../propuestas/canonicalizacion-propuestas');
const { ESTADOS_PROPUESTA, TIPOS_EVENTO, TRANSICIONES } = require('../propuestas/contrato-propuestas');
const { ErrorPrecondicionIndices } = require('../propuestas/indices-propuestas');
const {
  ErrorEntradaInvalida,
  ErrorTransicionInvalida,
  ErrorInconsistencia,
  decidirPropuesta,
  crearDependenciasMongoose
} = require('../propuestas/decidir-propuesta');
const { COMANDO_PANEL } = require('./operadores-panel');
const { COLECCIONES, ErrorLecturaNoDisponible, evaluarIntegridad } = require('./lectura-propuestas');

const TIPOS_PANEL = Object.freeze(['aprobacion', 'rechazo']);
const ESTADO_DECIDIBLE = 'pendiente_aprobacion';
const MOTIVO_MAXIMO = 500;
const CLAVES_CUERPO = Object.freeze({
  aprobacion: Object.freeze(['estado_esperado', 'payload_hash_esperado', 'version_coordinacion_esperada']),
  rechazo: Object.freeze(['estado_esperado', 'payload_hash_esperado', 'version_coordinacion_esperada', 'motivo'])
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Cualquier carácter de control (Cc, incluidos C1 y \r) salvo \n y \t.
const CONTROL_NO_PERMITIDO = /(?![\n\t])\p{Cc}/u;
// Marca que decidirPropuesta agrega al mensaje cuando falló también la
// relectura de confirmación (no se sabe si la decisión quedó escrita).
const MARCA_INCIERTO = 'resultado INCIERTO';
const ETIQUETAS_TRANSITORIAS = ['TransientTransactionError', 'UnknownTransactionCommitResult'];
const ERRORES_RED = ['MongoNetworkError', 'MongoNetworkTimeoutError', 'MongoServerSelectionError', 'MongoNotConnectedError'];

// 400 solicitud_invalida (el mensaje es un código fijo).
class ErrorCuerpoInvalido extends Error {}
// 404 no_encontrado.
class ErrorPropuestaInexistente extends Error {}
// 409 propuesta_cambio: lo que el operador vio ya no es el estado actual.
class ErrorPropuestaCambio extends Error {
  constructor(actual) {
    super('propuesta_cambio');
    this.actual = actual;
  }
}
// 422 propuesta_no_decidible: lo visto sigue vigente, pero no se puede aprobar.
class ErrorPropuestaNoDecidible extends Error {
  constructor(motivos) {
    super(`propuesta_no_decidible: ${motivos.join(', ')}`);
    this.motivos = motivos;
  }
}
// 500 resultado_incierto: no se pudo confirmar si la decisión quedó escrita.
class ErrorResultadoIncierto extends Error {
  constructor(causa) {
    super('resultado_incierto');
    this.causa = causa;
  }
}
// 503 no_disponible: índices ausentes o transacción revertida por un error
// transitorio (no quedó nada escrito).
class ErrorDecisionNoDisponible extends Error {
  constructor(motivo, causa) {
    super(motivo);
    this.causa = causa;
  }
}

const esObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fechaIso = (v) => (v instanceof Date && !Number.isNaN(v.getTime()) ? v.toISOString() : null);

// ------------------------------------------------------------------
// Entrada (puras)
// ------------------------------------------------------------------

// Pura. Valida el body y devuelve la entrada EXACTA de decidirPropuesta.
function construirEntrada(tipoEvento, propuestaId, cuerpo) {
  const falla = (m) => {
    throw new ErrorCuerpoInvalido(m);
  };
  if (!TIPOS_PANEL.includes(tipoEvento)) throw new TypeError(`construirEntrada: tipo_evento no soportado por el panel: ${tipoEvento}`);
  if (!esObjeto(cuerpo) || Object.getPrototypeOf(cuerpo) !== Object.prototype) falla('cuerpo');
  const permitidas = CLAVES_CUERPO[tipoEvento];
  const claves = Object.keys(cuerpo);
  if (claves.length !== permitidas.length || claves.some((k) => !permitidas.includes(k))) falla('claves');

  if (cuerpo.estado_esperado !== ESTADO_DECIDIBLE) falla('estado_esperado');
  if (typeof cuerpo.payload_hash_esperado !== 'string' || !SHA256_HEX.test(cuerpo.payload_hash_esperado)) falla('payload_hash_esperado');
  const version = cuerpo.version_coordinacion_esperada;
  if (!Number.isSafeInteger(version) || version < 0) falla('version_coordinacion_esperada');

  const entrada = {
    tipo_evento: tipoEvento,
    propuesta_id: propuestaId,
    estado_esperado: ESTADO_DECIDIBLE,
    payload_hash_esperado: cuerpo.payload_hash_esperado,
    version_coordinacion_esperada: version,
    decision_aprobacion_id_esperado: null
  };
  if (tipoEvento === 'rechazo') {
    const motivo = cuerpo.motivo;
    if (typeof motivo !== 'string' || !motivo.isWellFormed()) falla('motivo');
    const largo = [...motivo.trim()].length;
    if (largo < 1 || largo > MOTIVO_MAXIMO) falla('motivo_largo');
    if (CONTROL_NO_PERMITIDO.test(motivo)) falla('motivo_control');
    entrada.motivo = motivo;
  }
  return entrada;
}

// Pura. ¿Lo que el operador vio (estado, hash, versión) sigue siendo lo actual?
function coincideLoVisto(entrada, p) {
  return (
    p.estado === entrada.estado_esperado &&
    p.payload_hash === entrada.payload_hash_esperado &&
    p.version_coordinacion === entrada.version_coordinacion_esperada
  );
}

// Pura. Con lo visto vigente, ¿la coordinación es internamente válida? Hoy
// la única inconsistencia posible es una decisión previa en una pendiente
// (el CAS exige decision_aprobacion_id: null).
const tieneDecisionPrevia = (p) => (p.decision_aprobacion_id ?? null) !== null;

// Pura. true solo si el último evento de la propuesta es EXACTAMENTE esta
// decisión, ya registrada por el mismo operador desde el panel.
function esReenvioIdentico(entrada, operador, p, ev) {
  if (!esObjeto(p) || !esObjeto(ev)) return false;
  const io = esObjeto(ev.detalle?.identidad_operador) ? ev.detalle.identidad_operador : {};
  const motivo = entrada.motivo === undefined ? null : entrada.motivo.trim();
  const decisionEsperada = entrada.tipo_evento === 'aprobacion' ? ev.evento_id : null;
  return (
    typeof ev.evento_id === 'string' &&
    p.ultimo_evento_id === ev.evento_id &&
    ev.propuesta_id === entrada.propuesta_id &&
    // la propuesta sigue en ese evento
    p.estado === ev.estado_nuevo &&
    p.version_coordinacion === ev.version_coordinacion_nueva &&
    p.payload_hash === ev.hash_contenido_referenciado &&
    (p.decision_aprobacion_id ?? null) === decisionEsperada &&
    // misma decisión
    ev.tipo_evento === entrada.tipo_evento &&
    ev.estado_anterior === entrada.estado_esperado &&
    ev.estado_nuevo === TRANSICIONES[entrada.tipo_evento].hacia &&
    ev.hash_contenido_referenciado === entrada.payload_hash_esperado &&
    ev.version_coordinacion_nueva === entrada.version_coordinacion_esperada + 1 &&
    (ev.motivo ?? null) === motivo &&
    // mismo operador, desde el panel
    ev.actor?.tipo === 'humano' &&
    ev.actor?.identificador === operador.actor.identificador &&
    ev.detalle?.comando?.nombre === COMANDO_PANEL.nombre &&
    io.metodo === operador.identidad_operador.metodo &&
    io.sub === operador.identidad_operador.sub
  );
}

// Pura. Estado actual para el 409, por lista blanca (sin actor ni identidad).
function actualSeguro(p, ev) {
  return {
    estado: ESTADOS_PROPUESTA.includes(p.estado) ? p.estado : null,
    version_coordinacion: Number.isInteger(p.version_coordinacion) ? p.version_coordinacion : null,
    payload_hash: typeof p.payload_hash === 'string' && SHA256_HEX.test(p.payload_hash) ? p.payload_hash : null,
    ultimo_evento: esObjeto(ev)
      ? { tipo_evento: TIPOS_EVENTO.includes(ev.tipo_evento) ? ev.tipo_evento : null, ocurrido_en: fechaIso(ev.ocurrido_en) }
      : null
  };
}

// Pura. Respuesta 200 por lista blanca. `ev` es el resultado de
// decidirPropuesta o el evento leído (reenvío): mismos nombres de campo.
function decisionSegura(ev, yaRegistrada) {
  return {
    tipo_evento: ev.tipo_evento,
    propuesta_id: ev.propuesta_id,
    evento_id: ev.evento_id,
    estado_anterior: ev.estado_anterior,
    estado_nuevo: ev.estado_nuevo,
    version_coordinacion_nueva: ev.version_coordinacion_nueva,
    ocurrido_en: fechaIso(ev.ocurrido_en),
    actor: { tipo: ev.actor.tipo, identificador: ev.actor.identificador },
    ya_registrada: yaRegistrada
  };
}

// Pura. Errores del servicio que este módulo sabe interpretar; el resto
// sigue tal cual (el router los convierte en 500 error_interno).
function interpretarErrorServicio(err) {
  if (String(err?.message ?? '').includes(MARCA_INCIERTO)) return new ErrorResultadoIncierto(err);
  if (err instanceof ErrorPrecondicionIndices) return new ErrorDecisionNoDisponible('indices', err);
  if (err instanceof ErrorInconsistencia) return err;
  const transitorio = typeof err?.hasErrorLabel === 'function' && ETIQUETAS_TRANSITORIAS.some((e) => err.hasErrorLabel(e));
  if (transitorio || ERRORES_RED.includes(err?.name)) return new ErrorDecisionNoDisponible('transaccion_revertida', err);
  return err;
}

// Con resolverIdentidad inyectado el servicio nunca debería consultarlas;
// si lo hiciera, falla en vez de leer process.env o connectionStatus.
function sinIdentidadCli() {
  throw new Error('decisiones del panel: la identidad sale del token OIDC, no de la allowlist de la CLI.');
}

// ------------------------------------------------------------------
// Servicio (lecturas nativas + decidirPropuesta)
// ------------------------------------------------------------------

// obtenerDb: () => Db nativo conectado o null. decidir/dependencias:
// inyectables para pruebas (por defecto decidirPropuesta con las
// dependencias de Mongoose de la conexión por defecto).
function crearDecisionesPropuestas({
  obtenerDb,
  decidir = decidirPropuesta,
  dependencias = () => crearDependenciasMongoose(mongoose.connection, { operadoresJson: null }),
  adaptadores
} = {}) {
  if (typeof obtenerDb !== 'function') throw new TypeError('crearDecisionesPropuestas: obtenerDb es obligatorio.');
  const db = () => {
    const d = obtenerDb();
    if (!d || typeof d.collection !== 'function') throw new ErrorLecturaNoDisponible('sin_conexion_mongo');
    return d;
  };
  const leerPropuesta = (propuestaId) => db().collection(COLECCIONES.propuestas).findOne({ propuesta_id: propuestaId });
  const leerUltimoEvento = (p) =>
    typeof p.ultimo_evento_id === 'string' && UUID.test(p.ultimo_evento_id)
      ? db().collection(COLECCIONES.eventos).findOne({ evento_id: p.ultimo_evento_id })
      : null;

  // Lo que hay ahora, en orden: reenvío idéntico (200) → lo visto difiere
  // (409) → coordinación inválida con lo visto vigente (422). null = todo
  // coincide.
  async function resolverActual(entrada, operador, p, origen) {
    if (!coincideLoVisto(entrada, p)) {
      const ev = await leerUltimoEvento(p);
      if (esReenvioIdentico(entrada, operador, p, ev)) {
        return { decision: decisionSegura(ev, true), registro: { ya_registrada: true, reenvio_detectado_en: origen } };
      }
      throw new ErrorPropuestaCambio(actualSeguro(p, ev));
    }
    if (tieneDecisionPrevia(p)) throw new ErrorPropuestaNoDecidible(['decision_previa_existente']);
    return null;
  }

  // operador: req.operador (congelado por crearAutorizar). Devuelve
  // { decision, registro }: decision va a la respuesta, registro solo al log.
  async function decidirDesdePanel(tipoEvento, propuestaId, cuerpo, operador) {
    const entrada = construirEntrada(tipoEvento, propuestaId, cuerpo);

    const p = await leerPropuesta(propuestaId);
    if (!p) throw new ErrorPropuestaInexistente('propuesta_inexistente');
    const previa = await resolverActual(entrada, operador, p, 'relectura_previa');
    if (previa) return previa;
    if (tipoEvento === 'aprobacion') {
      const { motivos } = await evaluarIntegridad(db(), p, adaptadores);
      if (motivos.length > 0) throw new ErrorPropuestaNoDecidible(motivos);
    }

    let r;
    try {
      r = await decidir(entrada, {
        ...dependencias(),
        resolverIdentidad: () => operador,
        operadoresAutorizados: sinIdentidadCli,
        usuariosAutenticados: sinIdentidadCli
      });
    } catch (err) {
      throw interpretarErrorServicio(err);
    }

    if (r?.resultado === 'decision_registrada') {
      return {
        decision: decisionSegura(r, false),
        registro: { ya_registrada: false, confirmada_por_relectura: r.confirmada_por_relectura, causa_relectura: r.causa_relectura }
      };
    }
    if (r?.resultado === 'cas_no_coincide') {
      const actual = await leerPropuesta(propuestaId);
      if (!actual) throw new ErrorPropuestaInexistente('propuesta_inexistente_tras_cas');
      const tras = await resolverActual(entrada, operador, actual, 'cas_no_coincide');
      if (tras) return tras;
      // Todo coincide ahora pero el CAS no encontró la propuesta: cambió y volvió.
      throw new ErrorPropuestaCambio(actualSeguro(actual, await leerUltimoEvento(actual)));
    }
    throw new Error(`decidirPropuesta devolvió un resultado desconocido: ${JSON.stringify(r?.resultado)}`);
  }

  return Object.freeze({ decidir: decidirDesdePanel });
}

module.exports = {
  TIPOS_PANEL,
  MOTIVO_MAXIMO,
  CLAVES_CUERPO,
  MARCA_INCIERTO,
  ErrorCuerpoInvalido,
  ErrorPropuestaInexistente,
  ErrorPropuestaCambio,
  ErrorPropuestaNoDecidible,
  ErrorResultadoIncierto,
  ErrorDecisionNoDisponible,
  ErrorEntradaInvalida,
  ErrorTransicionInvalida,
  ErrorInconsistencia,
  construirEntrada,
  coincideLoVisto,
  tieneDecisionPrevia,
  esReenvioIdentico,
  actualSeguro,
  decisionSegura,
  interpretarErrorServicio,
  crearDecisionesPropuestas
};
