/** Aplicación explícita desde el panel, con instantánea y auditoría propias. */
const mongoose = require('mongoose');
const { validarAuditoria } = require('../propuestas/auditoria-aplicacion');
const { SHA256_HEX } = require('../propuestas/canonicalizacion-propuestas');
const { ESTADOS_PROPUESTA } = require('../propuestas/contrato-propuestas');
const { ErrorPrecondicionIndices } = require('../propuestas/indices-propuestas');
const {
  ErrorEntradaInvalida, ErrorInconsistencia, ErrorPropuestaNoEncontrada,
  ErrorPropuestaNoSoportada, ErrorEscrituraAbortada, ErrorResultadoIncierto,
  ErrorActorNoAutorizado, ErrorConfiguracionOperadores, ErrorSinAdaptador,
  aplicarPropuesta, crearDependenciasMongoose
} = require('../propuestas/aplicar-propuesta');
const { COMANDO_PANEL } = require('./operadores-panel');
const { COLECCIONES, ErrorLecturaNoDisponible } = require('./lectura-propuestas');
const COLECCIONES_APLICACION = Object.freeze({ ...COLECCIONES, intentos: 'intentos_aplicacion', historial: 'historial_cambios' });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLAVES = Object.freeze(['estado_esperado', 'payload_hash_esperado', 'version_coordinacion_esperada', 'decision_aprobacion_id_esperado']);
const esObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const estadoValido = (v) => ESTADOS_PROPUESTA.includes(v);

class ErrorCuerpoAplicacion extends Error {}
class ErrorAplicacionNoEncontrada extends Error {}
class ErrorAplicacionCambio extends Error { constructor(actual, intentoId = null) { super('propuesta_cambio'); this.actual = actual; this.intentoId = intentoId; } }
class ErrorAplicacionNoAplica extends Error { constructor(aplicacion, eventoId = null) { super('aplicacion_no_realizada'); this.aplicacion = aplicacion; this.eventoId = eventoId; } }
class ErrorAplicacionNoDisponible extends Error { constructor() { super('no_disponible'); } }
class ErrorAplicacionIncierta extends Error { constructor(intentoId = null) { super('resultado_incierto'); this.intentoId = intentoId; } }

function construirEntrada(propuestaId, cuerpo) {
  if (!UUID.test(propuestaId) || !esObjeto(cuerpo) || Object.getPrototypeOf(cuerpo) !== Object.prototype) throw new ErrorCuerpoAplicacion('cuerpo');
  const claves = Object.keys(cuerpo);
  if (claves.length !== CLAVES.length || claves.some((k) => !CLAVES.includes(k))) throw new ErrorCuerpoAplicacion('claves');
  if (cuerpo.estado_esperado !== 'aprobada') throw new ErrorCuerpoAplicacion('estado_esperado');
  if (typeof cuerpo.payload_hash_esperado !== 'string' || !SHA256_HEX.test(cuerpo.payload_hash_esperado)) throw new ErrorCuerpoAplicacion('payload_hash_esperado');
  if (!Number.isSafeInteger(cuerpo.version_coordinacion_esperada) || cuerpo.version_coordinacion_esperada < 0) throw new ErrorCuerpoAplicacion('version_coordinacion_esperada');
  if (typeof cuerpo.decision_aprobacion_id_esperado !== 'string' || !UUID.test(cuerpo.decision_aprobacion_id_esperado)) throw new ErrorCuerpoAplicacion('decision_aprobacion_id_esperado');
  return Object.freeze({
    propuesta_id: propuestaId,
    estado_esperado: cuerpo.estado_esperado,
    payload_hash_esperado: cuerpo.payload_hash_esperado,
    version_coordinacion_esperada: cuerpo.version_coordinacion_esperada,
    decision_aprobacion_id_esperado: cuerpo.decision_aprobacion_id_esperado
  });
}

function actualSeguro(p, ev) {
  return {
    estado: estadoValido(p?.estado) ? p.estado : null,
    payload_hash: typeof p?.payload_hash === 'string' && SHA256_HEX.test(p.payload_hash) ? p.payload_hash : null,
    version_coordinacion: Number.isSafeInteger(p?.version_coordinacion) ? p.version_coordinacion : null,
    decision_aprobacion_id: typeof p?.decision_aprobacion_id === 'string' && UUID.test(p.decision_aprobacion_id) ? p.decision_aprobacion_id : null,
    ultimo_evento_id: typeof p?.ultimo_evento_id === 'string' && UUID.test(p.ultimo_evento_id) ? p.ultimo_evento_id : null,
    ultimo_evento: ev && typeof ev.tipo_evento === 'string' ? { tipo_evento: ev.tipo_evento, ocurrido_en: ev.ocurrido_en instanceof Date && !Number.isNaN(ev.ocurrido_en.getTime()) ? ev.ocurrido_en.toISOString() : null } : null
  };
}

function coincideInstantanea(entrada, p) {
  return p?.estado === entrada.estado_esperado && p?.payload_hash === entrada.payload_hash_esperado &&
    p?.version_coordinacion === entrada.version_coordinacion_esperada &&
    p?.decision_aprobacion_id === entrada.decision_aprobacion_id_esperado;
}

function auditoriaPanel(operador, requestId, entrada) {
  if (!operador || typeof operador.identificador !== 'string' || !operador.identidad_operador ||
      typeof operador.identidad_operador.metodo !== 'string' || typeof operador.identidad_operador.sub !== 'string' || !UUID.test(requestId)) {
    throw new Error('aplicacion panel: identidad autenticada incompleta.');
  }
  return validarAuditoria({
    origen: 'panel', request_id: requestId, operador: operador.identificador,
    identidad: Object.freeze({ metodo: operador.identidad_operador.metodo, sub: operador.identidad_operador.sub }),
    comando: COMANDO_PANEL,
    instantanea: Object.freeze({ ...entrada })
  }, entrada, true);
}

function esReenvioIdentico(entrada, operador, p, ev, intento, historial) {
  const a = ev?.detalle?.auditoria_panel;
  return p?.estado === 'aplicada' && p.ultimo_evento_id === ev?.evento_id && ev?.tipo_evento === 'aplicacion' &&
    ev.propuesta_id === entrada.propuesta_id && ev.estado_anterior === 'aprobada' && ev.estado_nuevo === 'aplicada' &&
    ev.hash_contenido_referenciado === entrada.payload_hash_esperado && ev.version_coordinacion_nueva === entrada.version_coordinacion_esperada + 1 &&
    intento?.resultado === 'exito' && intento.decision_aprobacion_id === entrada.decision_aprobacion_id_esperado &&
    historial?.decision_aprobacion_id === entrada.decision_aprobacion_id_esperado &&
    a?.origen === 'panel' && a.comando?.nombre === COMANDO_PANEL.nombre && a.comando?.version === COMANDO_PANEL.version &&
    a.operador === operador.identificador && a.identidad?.metodo === operador.identidad_operador.metodo && a.identidad?.sub === operador.identidad_operador.sub &&
    a.instantanea?.estado_esperado === entrada.estado_esperado && a.instantanea?.payload_hash_esperado === entrada.payload_hash_esperado &&
    a.instantanea?.version_coordinacion_esperada === entrada.version_coordinacion_esperada &&
    a.instantanea?.decision_aprobacion_id_esperado === entrada.decision_aprobacion_id_esperado;
}

function respuestaAplicada(entrada, p, ev, intento, yaAplicada) {
  if (!p || p.estado !== 'aplicada' || p.ultimo_evento_id !== ev?.evento_id || p.version_coordinacion !== entrada.version_coordinacion_esperada + 1 ||
      p.payload_hash !== entrada.payload_hash_esperado || p.decision_aprobacion_id !== entrada.decision_aprobacion_id_esperado ||
      !ev || ev.tipo_evento !== 'aplicacion' || ev.propuesta_id !== entrada.propuesta_id || ev.estado_anterior !== 'aprobada' || ev.estado_nuevo !== 'aplicada' ||
      ev.hash_contenido_referenciado !== entrada.payload_hash_esperado || ev.version_coordinacion_nueva !== entrada.version_coordinacion_esperada + 1 ||
      !intento || intento.resultado !== 'exito' || intento.decision_aprobacion_id !== entrada.decision_aprobacion_id_esperado ||
      ev.intento_aplicacion_id !== intento.intento_id || !UUID.test(ev.evento_id) || !UUID.test(intento.intento_id) || !(ev.ocurrido_en instanceof Date) || Number.isNaN(ev.ocurrido_en.getTime())) {
    throw new ErrorAplicacionIncierta(intento?.intento_id ?? null);
  }
  return Object.freeze({
    propuesta_id: entrada.propuesta_id,
    resultado: 'exito',
    destino_modificado: true,
    estado_propuesta_nuevo: 'aplicada',
    version_coordinacion_nueva: entrada.version_coordinacion_esperada + 1,
    decision_aprobacion_id: entrada.decision_aprobacion_id_esperado,
    evento_id: ev.evento_id,
    intento_id: intento.intento_id,
    aplicado_en: ev.ocurrido_en.toISOString(),
    ya_aplicada: yaAplicada
  });
}

function crearAplicacionesPropuestas({ obtenerDb, aplicar = aplicarPropuesta, dependencias = () => crearDependenciasMongoose(mongoose.connection) } = {}) {
  if (typeof obtenerDb !== 'function') throw new TypeError('crearAplicacionesPropuestas: obtenerDb es obligatorio.');
  const db = () => {
    const d = obtenerDb();
    if (!d || typeof d.collection !== 'function') throw new ErrorAplicacionNoDisponible();
    return d;
  };
  const leerPropuesta = (id) => db().collection(COLECCIONES.propuestas).findOne({ propuesta_id: id });
  const leerTrasAplicacion = async (leer, intentoId) => {
    try { return await leer(); }
    catch { throw new ErrorAplicacionIncierta(typeof intentoId === 'string' && UUID.test(intentoId) ? intentoId : null); }
  };
  const buscarUltimo = async (p) => {
    if (typeof p?.ultimo_evento_id !== 'string' || !UUID.test(p.ultimo_evento_id)) return null;
    return db().collection(COLECCIONES.eventos).findOne({ evento_id: p.ultimo_evento_id });
  };
  async function aplicarDesdePanel(propuestaId, cuerpo, operador, requestId) {
    const entrada = construirEntrada(propuestaId, cuerpo);
    if (!operador?.permisos?.includes('aplicar')) throw new Error('aplicacion panel: permiso ausente.');
    const audit = auditoriaPanel(operador, requestId, entrada);
    const d = db();
    const propuesta = await leerPropuesta(propuestaId);
    if (!propuesta) throw new ErrorAplicacionNoEncontrada('propuesta_inexistente');
    if (propuesta.estado === 'aplicada') {
      const ev = await buscarUltimo(propuesta);
      const intentoId = ev?.intento_aplicacion_id;
      const intento = intentoId ? await d.collection(COLECCIONES_APLICACION.intentos).findOne({ intento_id: intentoId }) : null;
      const historial = intento?.historial_id ? await d.collection(COLECCIONES_APLICACION.historial).findOne({ historial_id: intento.historial_id }) : null;
      if (esReenvioIdentico(entrada, operador, propuesta, ev, intento, historial)) return { aplicacion: respuestaAplicada(entrada, propuesta, ev, intento, true), registro: { ya_aplicada: true } };
      throw new ErrorAplicacionCambio(actualSeguro(propuesta, ev));
    }
    if (!coincideInstantanea(entrada, propuesta)) throw new ErrorAplicacionCambio(actualSeguro(propuesta, await buscarUltimo(propuesta)));
    let resultado;
    try { resultado = await aplicar(entrada, dependencias(), audit); }
    catch (err) {
      if (err instanceof ErrorResultadoIncierto || err instanceof ErrorEscrituraAbortada || err instanceof ErrorInconsistencia) throw new ErrorAplicacionIncierta(err.intento_id ?? null);
      if (err instanceof ErrorPrecondicionIndices || err instanceof ErrorConfiguracionOperadores || err instanceof ErrorActorNoAutorizado) throw new ErrorAplicacionNoDisponible();
      if (err instanceof ErrorPropuestaNoEncontrada) throw new ErrorAplicacionNoEncontrada('propuesta_inexistente');
      if (err instanceof ErrorPropuestaNoSoportada || err instanceof ErrorSinAdaptador) throw new ErrorAplicacionNoAplica({ destino_modificado: false, resultado: 'propuesta_no_aplicable', estado_propuesta_nuevo: propuesta.estado, intento_id: null });
      if (err instanceof ErrorEntradaInvalida) throw new ErrorAplicacionIncierta(null);
      if (err instanceof ErrorLecturaNoDisponible) throw new ErrorAplicacionNoDisponible();
      if (['MongoNetworkError', 'MongoNetworkTimeoutError', 'MongoServerSelectionError', 'MongoNotConnectedError'].includes(err?.name)) throw new ErrorAplicacionIncierta(err.intento_id ?? null);
      throw new ErrorAplicacionIncierta(err.intento_id ?? null);
    }
    if (resultado?.resultado === 'exito') {
      const actual = await leerTrasAplicacion(() => leerPropuesta(propuestaId), resultado.intento_id);
      const ev = resultado.evento_id ? await leerTrasAplicacion(() => d.collection(COLECCIONES.eventos).findOne({ evento_id: resultado.evento_id }), resultado.intento_id) : null;
      const intento = resultado.intento_id ? await leerTrasAplicacion(() => d.collection(COLECCIONES_APLICACION.intentos).findOne({ intento_id: resultado.intento_id }), resultado.intento_id) : null;
      if (!actual || actual.estado !== 'aplicada' || actual.version_coordinacion !== entrada.version_coordinacion_esperada + 1 ||
          actual.payload_hash !== entrada.payload_hash_esperado || actual.decision_aprobacion_id !== entrada.decision_aprobacion_id_esperado) throw new ErrorAplicacionIncierta(resultado.intento_id ?? null);
      return { aplicacion: respuestaAplicada(entrada, actual, ev, intento, false), registro: { ya_aplicada: false } };
    }
    const actual = await leerTrasAplicacion(() => leerPropuesta(propuestaId), resultado?.intento_id);
    if (resultado?.resultado === 'propuesta_no_aplicable' && actual && !coincideInstantanea(entrada, actual)) {
      const ev = await leerTrasAplicacion(() => buscarUltimo(actual), resultado?.intento_id);
      // Ya pasó por el servicio: conserva inicio/intento y responde 409, nunca reenvío sin escrituras.
      throw new ErrorAplicacionCambio(actualSeguro(actual, ev), resultado.intento_id ?? null);
    }
    const resultadoSeguro = typeof resultado?.resultado === 'string' && /^[a-z_]{1,80}$/.test(resultado.resultado) ? resultado.resultado : 'propuesta_no_aplicable';
    throw new ErrorAplicacionNoAplica({
      destino_modificado: false,
      resultado: resultadoSeguro,
      estado_propuesta_nuevo: estadoValido(actual?.estado) ? actual.estado : estadoValido(resultado?.estado_propuesta_nuevo) ? resultado.estado_propuesta_nuevo : null,
      intento_id: typeof resultado?.intento_id === 'string' && UUID.test(resultado.intento_id) ? resultado.intento_id : null
    }, typeof resultado?.evento_id === 'string' && UUID.test(resultado.evento_id) ? resultado.evento_id : null);
  }
  return Object.freeze({ aplicar: aplicarDesdePanel });
}

module.exports = {
  CLAVES, ErrorCuerpoAplicacion, ErrorAplicacionNoEncontrada, ErrorAplicacionCambio,
  ErrorAplicacionNoAplica, ErrorAplicacionNoDisponible, ErrorAplicacionIncierta,
  construirEntrada, coincideInstantanea, actualSeguro, esReenvioIdentico,
  respuestaAplicada, crearAplicacionesPropuestas
};
