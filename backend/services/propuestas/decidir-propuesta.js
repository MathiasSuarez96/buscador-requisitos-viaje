/**
 * Decisiones HUMANAS sobre una PropuestaCambio: aprobación, rechazo y
 * cancelación (los tipos de TRANSICIONES cuyo único actor es 'humano').
 * Cada decisión es UNA transacción con dos escrituras: el CAS sobre
 * propuestas_cambio y la inserción del EventoPropuesta. O quedan las dos
 * o no queda ninguna.
 *
 * La entrada son los valores que el operador VIO (estado, payload_hash,
 * version_coordinacion, decision_aprobacion_id); el servicio no los relee
 * antes del CAS. Si la propuesta cambió desde que se mostró, el CAS no
 * encuentra nada, no se escribe nada y se devuelve cas_no_coincide con el
 * estado actual. Sin reintento de aplicación: el operador tiene que volver
 * a mirar. El único reintento es el de withTransaction ante
 * TransientTransactionError (p. ej. WriteConflict con otra decisión
 * concurrente), que es seguro porque evento_id y ocurrido_en se generan
 * UNA sola vez, fuera del callback: la re-ejecución repite exactamente el
 * mismo filtro y el mismo evento, y la segunda decisión concurrente
 * termina en cas_no_coincide.
 *
 * Filtros CAS (V = versión vista, H = hash visto, D = decisión vista):
 *  - aprobacion:  { propuesta_id, estado: 'pendiente_aprobacion', payload_hash: H,
 *                   version_coordinacion: V, decision_aprobacion_id: null }
 *                 $set estado 'aprobada', decision_aprobacion_id y ultimo_evento_id = evento_id
 *  - rechazo:     mismo filtro; $set estado 'rechazada', ultimo_evento_id
 *                 (decision_aprobacion_id queda en null)
 *  - cancelacion: { propuesta_id, estado: <'aprobada' | 'revision_requerida', el visto>,
 *                   payload_hash: H, version_coordinacion: V, decision_aprobacion_id: D }
 *                 $set estado 'cancelada', ultimo_evento_id (D se conserva)
 * Todas: $inc version_coordinacion 1 y $set updatedAt = ocurrido_en
 * (timestamps: false, para que coincida con el evento). El estado del
 * filtro es SIEMPRE un valor único, nunca un $in de TRANSICIONES.desde.
 * `decision_aprobacion_id: null` matchea también el campo ausente (así
 * se comporta Mongo); los documentos nacen con default null.
 *
 * Relectura de confirmación: ante un error de transacción (commit
 * ambiguo), un E11000 de evento_id_1 / uniq_evento_por_propuesta_version
 * o un CAS sin coincidencia, se releen la propuesta y el evento. Solo se
 * declara la decisión confirmada si la propuesta tiene ultimo_evento_id,
 * estado, version_coordinacion, payload_hash, decision_aprobacion_id y
 * updatedAt (=== ocurrido_en del evento) post-transición y el evento
 * existe y coincide exactamente (evento_id, propuesta, tipo, estados,
 * hash, versión, ocurrido_en, actor, motivo y detalle completo; actor y
 * detalle se comparan canonicalizados, sin depender del orden de claves).
 * Un E11000 sin esa coincidencia es ErrorInconsistencia: alguien escribió
 * por fuera del servicio.
 *
 * Identidad: la entrada NUNCA acepta actor ni datos de identidad. La
 * resuelve el servicio por una de dos vías:
 *  - deps.resolverIdentidad() inyectada (panel): devuelve
 *    { actor, identidad_operador, comando } construido y verificado por el
 *    servidor a partir del token OIDC (ver middleware/panel.js);
 *  - si no se inyecta (CLI): connectionStatus + allowlist, ver
 *    operadores-autorizados.js (evidencia operativa; NO es no repudio).
 * En ambos casos la forma se valida (validarResolucionIdentidad) antes del
 * gate: una resolución malformada no llega a ninguna escritura.
 *
 * Orden: validar entrada → cargar allowlist → resolver actor → gate de
 * índices (INDICES_DECISION) → generar evento_id/ocurrido_en → validar el
 * evento con el modelo → transacción. Nada de la configuración ni de la
 * identidad llega al gate o a una transacción si falla.
 *
 * Las dependencias de Mongo se inyectan (crearDependenciasMongoose) para
 * probar el flujo sin conexión — ver scripts/test-servicio-decision-propuesta.js.
 */

const crypto = require('crypto');
const mongoose = require('mongoose');
const PropuestaCambio = require('../../models/propuestas/PropuestaCambio.model');
const EventoPropuesta = require('../../models/propuestas/EventoPropuesta.model');
const { SHA256_HEX, canonicalizarValor } = require('./canonicalizacion-propuestas');
const { ESTADOS_PROPUESTA, TRANSICIONES, TIPOS_QUE_REQUIEREN_MOTIVO, motivoTransicionInvalida } = require('./contrato-propuestas');
const { ErrorPrecondicionIndices, INDICES_DECISION, verificarConjuntoIndices } = require('./indices-propuestas');
const {
  ErrorConfiguracionOperadores,
  ErrorActorNoAutorizado,
  cargarOperadoresAutorizados,
  resolverActor
} = require('./operadores-autorizados');

// Derivado del contrato: los tipos cuyo único actor permitido es humano.
const TIPOS_DECISION = Object.keys(TRANSICIONES).filter(
  (t) => TRANSICIONES[t].actores.length === 1 && TRANSICIONES[t].actores[0] === 'humano'
);

// Índices de corrección que este servicio exige (ver indices-propuestas.js).
const INDICES_REQUERIDOS = INDICES_DECISION;

const COMANDO = { nombre: 'decidir-propuesta', version: '1' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CAMPOS_ENTRADA = [
  'tipo_evento',
  'propuesta_id',
  'estado_esperado',
  'payload_hash_esperado',
  'version_coordinacion_esperada',
  'decision_aprobacion_id_esperado',
  'motivo'
];

class ErrorEntradaInvalida extends Error {}
class ErrorTransicionInvalida extends Error {}
class ErrorInconsistencia extends Error {}
// Interno: aborta la transacción cuando el CAS no encuentra la propuesta.
class ErrorCasNoCoincide extends Error {}

function validarEntrada(e) {
  const falla = (m) => {
    throw new ErrorEntradaInvalida(`decidirPropuesta: ${m}`);
  };
  if (e === null || typeof e !== 'object' || Array.isArray(e)) falla('la entrada debe ser un objeto.');
  const extras = Object.keys(e).filter((k) => !CAMPOS_ENTRADA.includes(k));
  if (extras.length > 0) {
    falla(`campos no admitidos: ${extras.join(', ')} (el actor lo resuelve el servicio, nunca la entrada).`);
  }
  if (!TIPOS_DECISION.includes(e.tipo_evento)) {
    falla(`tipo_evento debe ser una decisión humana (${TIPOS_DECISION.join(', ')}), recibido ${JSON.stringify(e.tipo_evento)}.`);
  }
  if (typeof e.propuesta_id !== 'string' || !UUID.test(e.propuesta_id)) falla('propuesta_id debe ser un UUID.');
  if (!ESTADOS_PROPUESTA.includes(e.estado_esperado)) falla(`estado_esperado desconocido: ${JSON.stringify(e.estado_esperado)}.`);
  if (typeof e.payload_hash_esperado !== 'string' || !SHA256_HEX.test(e.payload_hash_esperado)) {
    falla('payload_hash_esperado debe ser SHA-256 hex en minúsculas.');
  }
  if (!Number.isInteger(e.version_coordinacion_esperada) || e.version_coordinacion_esperada < 0) {
    falla('version_coordinacion_esperada debe ser un entero >= 0.');
  }
  if (!('decision_aprobacion_id_esperado' in e)) {
    falla('decision_aprobacion_id_esperado es obligatorio (null si la propuesta no tiene aprobación).');
  }
  if (TIPOS_QUE_REQUIEREN_MOTIVO.includes(e.tipo_evento)) {
    if (typeof e.motivo !== 'string' || e.motivo.trim() === '') falla(`"${e.tipo_evento}" exige un motivo no vacío.`);
  } else if (e.motivo !== undefined && (typeof e.motivo !== 'string' || e.motivo.trim() === '')) {
    falla('motivo, si se envía, debe ser un string no vacío.');
  }

  const regla = TRANSICIONES[e.tipo_evento];
  const motivo = motivoTransicionInvalida(e.tipo_evento, e.estado_esperado, regla.hacia, 'humano');
  if (motivo) throw new ErrorTransicionInvalida(`decidirPropuesta: transición no permitida: ${motivo}`);

  const d = e.decision_aprobacion_id_esperado;
  if (e.tipo_evento === 'cancelacion') {
    if (d === null || d === undefined) {
      throw new ErrorInconsistencia(
        `decidirPropuesta: una propuesta en "${e.estado_esperado}" debería tener decision_aprobacion_id; se vio null. No se escribe nada.`
      );
    }
    if (typeof d !== 'string' || !UUID.test(d)) falla('decision_aprobacion_id_esperado debe ser un UUID en cancelación.');
  } else if (d !== null) {
    falla(`"${e.tipo_evento}" exige decision_aprobacion_id_esperado === null.`);
  }
}

function construirFiltroCas(e) {
  return {
    propuesta_id: e.propuesta_id,
    estado: e.estado_esperado,
    payload_hash: e.payload_hash_esperado,
    version_coordinacion: e.version_coordinacion_esperada,
    decision_aprobacion_id: e.decision_aprobacion_id_esperado
  };
}

function construirUpdateCas(e, eventoId, ocurridoEn) {
  const $set = { estado: TRANSICIONES[e.tipo_evento].hacia, ultimo_evento_id: eventoId, updatedAt: ocurridoEn };
  if (e.tipo_evento === 'aprobacion') $set.decision_aprobacion_id = eventoId;
  return { $set, $inc: { version_coordinacion: 1 } };
}

// `resolucion.comando` (obligatorio) identifica el origen de la decisión:
// la CLI ('decidir-propuesta') o el panel ('panel-propuestas'). Sin él no
// hay evento: nunca se atribuye una decisión a un origen por defecto.
function construirEvento(e, eventoId, ocurridoEn, resolucion) {
  const { comando } = resolucion ?? {};
  if (comando === null || typeof comando !== 'object' || typeof comando.nombre !== 'string' || typeof comando.version !== 'string') {
    throw new TypeError('construirEvento: resolucion.comando { nombre, version } es obligatorio.');
  }
  const detalle = { identidad_operador: { ...resolucion.identidad_operador }, comando: { nombre: comando.nombre, version: comando.version } };
  if (e.tipo_evento === 'cancelacion') detalle.decision_aprobacion_id_cancelada = e.decision_aprobacion_id_esperado;
  const evento = {
    evento_id: eventoId,
    propuesta_id: e.propuesta_id,
    tipo_evento: e.tipo_evento,
    estado_anterior: e.estado_esperado,
    estado_nuevo: TRANSICIONES[e.tipo_evento].hacia,
    hash_contenido_referenciado: e.payload_hash_esperado,
    version_coordinacion_nueva: e.version_coordinacion_esperada + 1,
    ocurrido_en: ocurridoEn,
    actor: { ...resolucion.actor },
    detalle
  };
  if (e.motivo !== undefined) evento.motivo = e.motivo.trim();
  return evento;
}

function resumenActual(p) {
  if (!p) return null;
  return {
    estado: p.estado,
    payload_hash: p.payload_hash,
    version_coordinacion: p.version_coordinacion,
    decision_aprobacion_id: p.decision_aprobacion_id ?? null,
    ultimo_evento_id: p.ultimo_evento_id ?? null
  };
}

const canonico = (v) => JSON.stringify(canonicalizarValor(v ?? null));
const instante = (v) => (v instanceof Date ? v.getTime() : v == null ? null : new Date(v).getTime());

// Pura. [] = la decisión de `evento` quedó confirmada exactamente.
function diferenciasDecisionConfirmada(e, evento, propuesta, eventoLeido) {
  const diffs = [];
  const comparar = (nombre, real, esperado) => {
    if (real !== esperado) diffs.push(`${nombre}=${JSON.stringify(real)} (esperado ${JSON.stringify(esperado)})`);
  };

  if (!propuesta) {
    diffs.push('la propuesta no existe');
  } else {
    comparar('propuesta.ultimo_evento_id', propuesta.ultimo_evento_id ?? null, evento.evento_id);
    comparar('propuesta.estado', propuesta.estado, evento.estado_nuevo);
    comparar('propuesta.version_coordinacion', propuesta.version_coordinacion, evento.version_coordinacion_nueva);
    comparar('propuesta.payload_hash', propuesta.payload_hash, evento.hash_contenido_referenciado);
    comparar(
      'propuesta.decision_aprobacion_id',
      propuesta.decision_aprobacion_id ?? null,
      e.tipo_evento === 'aprobacion' ? evento.evento_id : e.decision_aprobacion_id_esperado
    );
    comparar('propuesta.updatedAt', instante(propuesta.updatedAt), instante(evento.ocurrido_en));
  }

  if (!eventoLeido) {
    diffs.push(`el evento ${evento.evento_id} no existe`);
  } else {
    for (const campo of [
      'evento_id',
      'propuesta_id',
      'tipo_evento',
      'estado_anterior',
      'estado_nuevo',
      'hash_contenido_referenciado',
      'version_coordinacion_nueva'
    ]) {
      comparar(`evento.${campo}`, eventoLeido[campo], evento[campo]);
    }
    comparar('evento.ocurrido_en', instante(eventoLeido.ocurrido_en), instante(evento.ocurrido_en));
    comparar('evento.actor', canonico(eventoLeido.actor), canonico(evento.actor));
    comparar('evento.motivo', eventoLeido.motivo ?? null, evento.motivo ?? null);
    comparar('evento.detalle', canonico(eventoLeido.detalle), canonico(evento.detalle));
  }
  return diffs;
}

async function releerDecision(e, evento, deps) {
  const [propuesta, eventoLeido] = await Promise.all([deps.leerPropuesta(e.propuesta_id), deps.leerEvento(evento.evento_id)]);
  return { propuesta, eventoLeido, diferencias: diferenciasDecisionConfirmada(e, evento, propuesta, eventoLeido) };
}

// Algo de ESTA decisión quedó escrito, pero no completo.
function quedoRastroParcial({ propuesta, eventoLeido }, evento) {
  return Boolean(eventoLeido) || propuesta?.ultimo_evento_id === evento.evento_id;
}

function mismasClaves(a, b) {
  if (a == null || typeof a !== 'object') return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
}

function esDuplicadoEvento(err) {
  return (
    err?.code === 11000 &&
    (mismasClaves(err.keyPattern, { evento_id: 1 }) ||
      mismasClaves(err.keyPattern, { propuesta_id: 1, version_coordinacion_nueva: 1 }))
  );
}

function resultadoRegistrada(evento, causaRelectura = null) {
  return {
    resultado: 'decision_registrada',
    tipo_evento: evento.tipo_evento,
    propuesta_id: evento.propuesta_id,
    evento_id: evento.evento_id,
    estado_anterior: evento.estado_anterior,
    estado_nuevo: evento.estado_nuevo,
    version_coordinacion_nueva: evento.version_coordinacion_nueva,
    ocurrido_en: evento.ocurrido_en,
    actor: evento.actor,
    confirmada_por_relectura: causaRelectura !== null,
    causa_relectura: causaRelectura
  };
}

const esObjetoPlano = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const esTexto = (v) => typeof v === 'string' && v.trim() !== '' && v === v.trim();

// Pura. Valida la forma de una resolución de identidad y devuelve una copia
// congelada. Solo actor humano; identidad_operador con `metodo` y valores
// string; comando { nombre, version }. Una forma inválida es un error de
// programación (TypeError): nunca se escribe con una identidad dudosa.
function validarResolucionIdentidad(r) {
  const falla = (m) => {
    throw new TypeError(`decidirPropuesta: resolución de identidad inválida: ${m}`);
  };
  if (!esObjetoPlano(r)) falla('no es un objeto.');
  const { actor, identidad_operador: io, comando } = r;
  if (!esObjetoPlano(actor) || Object.keys(actor).sort().join() !== 'identificador,tipo') falla('actor debe ser { tipo, identificador }.');
  if (actor.tipo !== 'humano') falla('actor.tipo debe ser "humano".');
  if (!esTexto(actor.identificador)) falla('actor.identificador vacío.');
  if (!esObjetoPlano(io) || !esTexto(io.metodo)) falla('identidad_operador debe traer metodo.');
  if (!Object.values(io).every(esTexto)) falla('identidad_operador solo admite strings no vacíos.');
  if (!esObjetoPlano(comando) || Object.keys(comando).sort().join() !== 'nombre,version' || !esTexto(comando.nombre) || !esTexto(comando.version)) {
    falla('comando debe ser { nombre, version }.');
  }
  return Object.freeze({
    actor: Object.freeze({ tipo: actor.tipo, identificador: actor.identificador }),
    identidad_operador: Object.freeze({ ...io }),
    comando: Object.freeze({ nombre: comando.nombre, version: comando.version })
  });
}

// Vía de la CLI: connectionStatus + allowlist. La allowlist se carga antes de
// consultar la conexión (una configuración inválida aborta primero).
async function identidadPorConnectionStatus(deps) {
  const operadores = deps.operadoresAutorizados();
  const { actor, identidad_operador } = resolverActor(await deps.usuariosAutenticados(), operadores);
  return { actor, identidad_operador, comando: { ...COMANDO } };
}

async function decidirPropuesta(entrada, deps = crearDependenciasMongoose()) {
  validarEntrada(entrada);
  const resolucion = validarResolucionIdentidad(
    typeof deps.resolverIdentidad === 'function' ? await deps.resolverIdentidad() : await identidadPorConnectionStatus(deps)
  );
  await deps.verificarIndices();

  // Una sola vez, fuera del callback: toda re-ejecución de la
  // transacción usa exactamente el mismo evento.
  const eventoId = deps.uuid();
  const ocurridoEn = deps.ahora();
  if (typeof eventoId !== 'string' || !UUID.test(eventoId)) throw new Error('deps.uuid() no devolvió un UUID.');
  if (!(ocurridoEn instanceof Date) || Number.isNaN(ocurridoEn.getTime())) throw new Error('deps.ahora() no devolvió un Date válido.');

  const evento = construirEvento(entrada, eventoId, ocurridoEn, resolucion);
  await deps.validarEvento(evento);
  const filtro = construirFiltroCas(entrada);
  const update = construirUpdateCas(entrada, eventoId, ocurridoEn);

  try {
    await deps.ejecutarTransaccion(async (session) => {
      const r = await deps.actualizarPropuestaCas(filtro, update, session);
      if (r.matchedCount !== 1) throw new ErrorCasNoCoincide();
      if (r.modifiedCount !== 1) {
        throw new ErrorInconsistencia(`El CAS encontró la propuesta pero modifiedCount=${r.modifiedCount}. Transacción abortada.`);
      }
      await deps.insertarEvento(evento, session);
    });
    return resultadoRegistrada(evento);
  } catch (err) {
    if (err instanceof ErrorInconsistencia) throw err;

    if (err instanceof ErrorCasNoCoincide) {
      let relectura;
      try {
        relectura = await releerDecision(entrada, evento, deps);
      } catch (errRelectura) {
        return {
          resultado: 'cas_no_coincide',
          escrito: false,
          propuesta_id: entrada.propuesta_id,
          esperado: resumenEsperado(entrada),
          actual: undefined,
          relectura_fallida: String(errRelectura?.message ?? errRelectura)
        };
      }
      if (relectura.diferencias.length === 0) return resultadoRegistrada(evento, 'cas_no_coincide');
      if (quedoRastroParcial(relectura, evento)) {
        throw new ErrorInconsistencia(`CAS sin coincidencia con rastro parcial de esta decisión: ${relectura.diferencias.join('; ')}`);
      }
      return {
        resultado: 'cas_no_coincide',
        escrito: false,
        propuesta_id: entrada.propuesta_id,
        esperado: resumenEsperado(entrada),
        actual: resumenActual(relectura.propuesta)
      };
    }

    let relectura;
    try {
      relectura = await releerDecision(entrada, evento, deps);
    } catch (errRelectura) {
      const detalle = `falló también la relectura de confirmación (${errRelectura?.message ?? errRelectura}); resultado INCIERTO, verificar a mano el evento ${eventoId}`;
      if (esDuplicadoEvento(err)) throw new ErrorInconsistencia(`E11000 al insertar el evento (${err.message}) y ${detalle}.`);
      err.message = `${err.message} (${detalle})`;
      throw err;
    }

    if (relectura.diferencias.length === 0) {
      return resultadoRegistrada(evento, esDuplicadoEvento(err) ? 'duplicado_evento' : 'error_transaccion');
    }
    if (esDuplicadoEvento(err)) {
      throw new ErrorInconsistencia(
        `E11000 al insertar el evento sin que la decisión esté confirmada (alguien escribió por fuera del servicio). ${err.message}. Diferencias: ${relectura.diferencias.join('; ')}`
      );
    }
    if (quedoRastroParcial(relectura, evento)) {
      throw new ErrorInconsistencia(
        `Error de transacción (${err.message}) con rastro parcial de esta decisión: ${relectura.diferencias.join('; ')}`
      );
    }
    throw err; // la transacción revirtió: no quedó nada
  }
}

function resumenEsperado(e) {
  return {
    estado: e.estado_esperado,
    payload_hash: e.payload_hash_esperado,
    version_coordinacion: e.version_coordinacion_esperada,
    decision_aprobacion_id: e.decision_aprobacion_id_esperado
  };
}

async function listarIndices(Model) {
  try {
    return await Model.collection.indexes();
  } catch (err) {
    if (err.code === 26) return []; // NamespaceNotFound: la colección no existe
    throw err;
  }
}

// Pura (sin I/O) para poder probarla offline con listados armados a mano.
function verificarListadoIndices(indicesPropuestas, indicesEventos) {
  verificarConjuntoIndices(INDICES_REQUERIDOS, {
    propuestas_cambio: indicesPropuestas,
    eventos_propuesta: indicesEventos
  });
}

// listIndexes no puede correr dentro de una transacción: se llama antes.
async function verificarIndices() {
  const [indicesPropuestas, indicesEventos] = await Promise.all([listarIndices(PropuestaCambio), listarIndices(EventoPropuesta)]);
  verificarListadoIndices(indicesPropuestas, indicesEventos);
}

async function usuariosAutenticadosDe(conexion) {
  const estado = await conexion.db.command({ connectionStatus: 1 });
  return estado?.authInfo?.authenticatedUsers ?? [];
}

function crearDependenciasMongoose(conexion = mongoose.connection, { operadoresJson = process.env.OPERADORES_AUTORIZADOS_JSON } = {}) {
  return {
    uuid: () => crypto.randomUUID(),
    ahora: () => new Date(),
    operadoresAutorizados: () => cargarOperadoresAutorizados(operadoresJson),
    usuariosAutenticados: () => usuariosAutenticadosDe(conexion),
    verificarIndices,
    validarEvento: (doc) => new EventoPropuesta(doc).validate(),
    ejecutarTransaccion: (fn) =>
      conexion.transaction(fn, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } }),
    actualizarPropuestaCas: (filtro, update, session) =>
      PropuestaCambio.updateOne(filtro, update, { session, timestamps: false, strict: 'throw', runValidators: true }),
    insertarEvento: (doc, session) => new EventoPropuesta(doc).save({ session }),
    leerPropuesta: (propuestaId) => PropuestaCambio.findOne({ propuesta_id: propuestaId }).lean(),
    leerEvento: (eventoId) => EventoPropuesta.findOne({ evento_id: eventoId }).lean()
  };
}

module.exports = {
  TIPOS_DECISION,
  INDICES_REQUERIDOS,
  COMANDO,
  ErrorEntradaInvalida,
  ErrorTransicionInvalida,
  ErrorInconsistencia,
  ErrorConfiguracionOperadores,
  ErrorActorNoAutorizado,
  ErrorPrecondicionIndices,
  validarEntrada,
  validarResolucionIdentidad,
  identidadPorConnectionStatus,
  construirFiltroCas,
  construirUpdateCas,
  construirEvento,
  diferenciasDecisionConfirmada,
  esDuplicadoEvento,
  verificarListadoIndices,
  verificarIndices,
  usuariosAutenticadosDe,
  decidirPropuesta,
  crearDependenciasMongoose
};
