/**
 * APLICACIÓN de una PropuestaCambio aprobada: revalida contra la fuente
 * original y, si todo coincide, escribe el valor en destinos.requisitos[]
 * junto con el historial, el intento y el evento, en UNA transacción.
 * Persistencia de cada resultado: ver "PERSISTENCIA DE CADA RESULTADO" en
 * contrato-propuestas.js.
 *
 * Orden:
 *  1. Validar entrada → cargar allowlist → resolver operador → gate de
 *     índices (INDICES_APLICACION). Nada llega a Mongo si falla.
 *  2. Generar intento_id, evento_id, historial_id, revalidacion_id e
 *     iniciado_en UNA sola vez (se reutilizan en todo reintento).
 *  3. Etapa 0 (solo lectura): propuesta, ids del destino, adaptador y
 *     precondiciones (estado, versión, hash, aprobación). Propuesta
 *     inexistente, ids inválidos o sin adaptador único: se lanza sin
 *     persistir nada. Si fallan las precondiciones: inicio + intento
 *     propuesta_no_aplicable, sin consultar la fuente.
 *  4. InicioIntentoAplicacion (insert independiente, antes de revalidar).
 *  5. Etapa 1: adaptador.revalidar(), SIEMPRE fuera de toda transacción.
 *     no_disponible → intento fuente_temporalmente_no_disponible;
 *     ambiguo → extraccion_ambigua; valor distinto → fuente_cambio;
 *     valor igual → etapa 2.
 *  6. t = ahora(), tomado después de la revalidación e inmediatamente
 *     antes de abrir la transacción. Es el instante de TODAS las
 *     escrituras de este intento (updatedAt de propuesta y destino,
 *     aplicado_en, finalizado_en, ocurrido_en), idéntico en reintentos.
 *  7. Ventana: solo antes de escribir en destinos se exige
 *     0 <= t - revalidada_en <= VENTANA_REVALIDACION_MS; si no, intento
 *     revalidacion_vencida (insert independiente).
 *  8. Etapa 2, transacción de escritura, en este orden: CAS de la
 *     propuesta (primero, para que un reintento tras perder una carrera
 *     termine en propuesta_no_aplicable y no en un falso conflicto de
 *     valor), lectura del destino, identidad, valor actual, $set con
 *     $elemMatch, HistorialCambio, IntentoAplicacion exito, EventoPropuesta
 *     aplicacion. Si identidad o valor no coinciden, la transacción se
 *     aborta con un centinela y se abre OTRA, corta, que registra el
 *     resultado semántico (intento + CAS + evento).
 *
 * Precondición sobre el valor actual (payload.valor_anterior), nunca con
 * {costo: null} (en Mongo matchea null Y ausente):
 *   {presente:false}              → {costo: {$exists: false}}
 *   {presente:true, valor:null}   → {costo: {$type: 'null'}}
 *   {presente:true, valor:'£16'}  → {costo: '£16'}
 *
 * IDs del destino: payload.destino_id/requisito_id son strings hex de 24
 * (el contrato de propuestas, eventos e historiales los guarda como
 * string). Para toda consulta y escritura NATIVA sobre destinos se
 * convierten explícitamente a BSON ObjectId en convertirIdsDestino(); no
 * se depende del casting de Mongoose (el driver nativo no castea: un
 * string nunca matchea un _id guardado como ObjectId).
 *
 * Relectura (mismo patrón que decidir-propuesta.js): ante un error de
 * transacción, un E11000 o un CAS sin coincidencia se releen propuesta,
 * evento, intento, historial y destino. Confirmado solo si TODO coincide
 * exactamente; E11000 sin confirmación o rastro parcial →
 * ErrorInconsistencia. Relectura fallida (o registro de escritura_abortada
 * fallido) → ErrorResultadoIncierto: mensaje público saneado, `cause` =
 * el error original SIN modificar, intento_id y propuesta_id; no afirma
 * que el intento quedó registrado ni se registra nada más (queda el inicio
 * para auditoría). Si no quedó nada:
 *  - CAS sin coincidencia (la propuesta cambió entre la etapa 0 y la
 *    escritura): se registra y DEVUELVE propuesta_no_aplicable (éxito) o
 *    escritura_abortada/transicion_por_fallo (transacción corta). Son
 *    resultados operativos de una carrera, no errores.
 *  - cualquier otro error (inesperado): se registra escritura_abortada y
 *    se RELANZA como ErrorEscrituraAbortada, con `cause` = el error
 *    original e `intento_id`. Nunca se devuelve como resultado rutinario.
 *  - ErrorInconsistencia lanzada dentro de la transacción: se registra
 *    escritura_abortada y se relanza la MISMA ErrorInconsistencia (con
 *    `intento_id`).
 * Si el insert de escritura_abortada choca con intento_id_1, el commit sí
 * ocurrió: se relee y se informa ese resultado.
 *
 * SANEO CENTRALIZADO de todo texto de error persistido: construirIntento()
 * y construirEvento() son los únicos constructores de documentos con
 * texto libre, y ahí se aplica sanearMensaje() a error_mensaje y a
 * evento.motivo, y sanearTextosError() a evidencia_fresca (solo los
 * valores string bajo CLAVES_TEXTO_ERROR a cualquier profundidad: el
 * `error` del intento abortado y el `mensaje`/`error_extraccion`/`motivo`
 * que el adaptador pone cuando falla la fuente). El resto de la evidencia
 * (fragmentos HTML oficiales, avisos, valores, URLs de la fuente) se
 * persiste tal cual. Los errores públicos (ErrorEscrituraAbortada,
 * ErrorResultadoIncierto) también sanean su mensaje. El error original
 * queda intacto en `cause` (en memoria, nunca en Mongo).
 *
 * Las dependencias se inyectan (crearDependenciasMongoose) para probar
 * el flujo sin conexión — ver scripts/test-servicio-aplicacion-propuesta.js.
 */

const crypto = require('crypto');
const os = require('os');
const mongoose = require('mongoose');
const { ObjectId } = require('bson');
const PropuestaCambio = require('../../models/propuestas/PropuestaCambio.model');
const EventoPropuesta = require('../../models/propuestas/EventoPropuesta.model');
const IntentoAplicacion = require('../../models/propuestas/IntentoAplicacion.model');
const InicioIntentoAplicacion = require('../../models/propuestas/InicioIntentoAplicacion.model');
const HistorialCambio = require('../../models/propuestas/HistorialCambio.model');
const Destino = require('../../models/Destino.model');
const { SHA256_HEX, canonicalizarValor, hashSobreCanonico } = require('./canonicalizacion-propuestas');
const { TRANSICIONES, TRANSICION_POR_RESULTADO, VENTANA_REVALIDACION_MS } = require('./contrato-propuestas');
const { ErrorPrecondicionIndices, INDICES_APLICACION, coleccionesDe, verificarConjuntoIndices } = require('./indices-propuestas');
const {
  ErrorConfiguracionOperadores,
  ErrorActorNoAutorizado,
  cargarOperadoresAutorizados,
  resolverActor
} = require('./operadores-autorizados');
const { ErrorSinAdaptador, elegirAdaptador } = require('./adaptadores');
const { clasificarIdentidadRequisito } = require('./identidad-requisito');
const { usuariosAutenticadosDe } = require('./decidir-propuesta');

const INDICES_REQUERIDOS = INDICES_APLICACION;

const PROCESO_APLICADOR = Object.freeze({ nombre: 'aplicar-propuesta', version: '1' });
const ACTOR_SISTEMA = Object.freeze({ tipo: 'sistema', identificador: PROCESO_APLICADOR.nombre });

// MVP: mismo allowlist que PropuestaCambio (CAMPOS_PROPONIBLES). Agregar
// un campo exige revisar condicionValor() y updateDestino().
const CAMPOS_APLICABLES = ['costo'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OBJECT_ID_HEX = /^[0-9a-f]{24}$/;
const CAMPOS_ENTRADA = ['propuesta_id', 'payload_hash_esperado', 'version_coordinacion_esperada'];

class ErrorEntradaInvalida extends Error {}
class ErrorInconsistencia extends Error {}
class ErrorPropuestaNoEncontrada extends Error {}
class ErrorPropuestaNoSoportada extends Error {}
// Un error inesperado abortó una escritura; el intento quedó registrado
// como escritura_abortada. `cause` es el error original.
class ErrorEscrituraAbortada extends Error {
  constructor(ctx, intento, causa) {
    const detalle = intento.resultado_no_registrado ? `, resultado no registrado: ${intento.resultado_no_registrado}` : '';
    super(
      `aplicarPropuesta: escritura abortada (intento ${ctx.intento_id}, etapa ${intento.etapa_fallo}${detalle}); registrada como escritura_abortada. Causa: ${sanearMensaje(causa?.message ?? causa)}`,
      { cause: causa }
    );
    this.intento_id = ctx.intento_id;
    this.propuesta_id = ctx.propuesta_id;
    this.resultado = 'escritura_abortada';
    this.etapa_fallo = intento.etapa_fallo;
    this.resultado_no_registrado = intento.resultado_no_registrado ?? null;
  }
}
// No se sabe si la escritura quedó confirmada (falló la relectura, o falló
// el registro de escritura_abortada). NO afirma que haya un intento
// registrado. `cause` es el error original, que no se modifica; el mensaje
// público va saneado.
class ErrorResultadoIncierto extends Error {
  constructor(ctx, descripcion, causa, extras = {}) {
    super(
      `aplicarPropuesta: resultado INCIERTO (intento ${ctx.intento_id}, propuesta ${ctx.propuesta_id}): ${sanearMensaje(descripcion)} No se puede afirmar si quedó registrado un intento terminado; verificar a mano.`,
      { cause: causa }
    );
    this.intento_id = ctx.intento_id;
    this.propuesta_id = ctx.propuesta_id;
    Object.assign(this, extras);
  }
}
// Internos: abortan la transacción de escritura.
class ErrorCasPropuesta extends Error {}
class ErrorFalloSemantico extends Error {
  constructor(resultado, extras, evidencia, motivo) {
    super(motivo);
    this.resultado = resultado;
    this.extras = extras;
    this.evidencia = evidencia;
    this.motivo = motivo;
  }
}

const LARGO_MAXIMO_MENSAJE = 2000;

// Pura. Texto de un error externo apto para persistir: sin URIs de
// MongoDB (se reemplazan completas: host, usuario y opciones), sin
// userinfo (usuario:clave@) en ninguna otra URI y sin pares
// password/pwd/secret/token/apiKey=valor. Recorta a LARGO_MAXIMO_MENSAJE.
// Las URLs públicas sin credenciales (p. ej. la de la fuente) se conservan.
function sanearMensaje(texto) {
  let s = String(texto ?? '');
  s = s.replace(/mongodb(?:\+srv)?:\/\/[^\s'"<>]*/gi, '<uri-mongodb-redactada>');
  s = s.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"<>]+@/gi, '$1<credenciales-redactadas>@');
  s = s.replace(/\b(password|passwd|pwd|secret|token|api[_-]?key)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi, '$1$2<redactado>');
  return s.length > LARGO_MAXIMO_MENSAJE ? `${s.slice(0, LARGO_MAXIMO_MENSAJE)}…` : s;
}

// Claves cuyo valor string es TEXTO DE ERROR dentro de evidencia_fresca:
// `error` (intento abortado) y los textos de falla del adaptador
// (`mensaje` en fallas de fetch/HTTP, `error_extraccion` en fallas de
// extracción y `motivo` de no_disponible/ambiguo, que en el adaptador
// GOV.UK es un código pero la interfaz no lo garantiza; ver
// adaptadores/govuk-uk-eta.js).
const CLAVES_TEXTO_ERROR = ['error', 'mensaje', 'error_extraccion', 'motivo'];

// Pura. Copia de `valor` con sanearMensaje() aplicado SOLO a los strings
// bajo CLAVES_TEXTO_ERROR, a cualquier profundidad. Todo lo demás
// (fragmentos HTML, avisos, números, fechas) queda idéntico.
function sanearTextosError(valor) {
  if (valor instanceof Date || valor === null || typeof valor !== 'object') return valor;
  if (Array.isArray(valor)) return valor.map(sanearTextosError);
  return Object.fromEntries(
    Object.entries(valor).map(([k, v]) => [k, CLAVES_TEXTO_ERROR.includes(k) && typeof v === 'string' ? sanearMensaje(v) : sanearTextosError(v)])
  );
}

const esObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const esFechaValida = (v) => v instanceof Date && !Number.isNaN(v.getTime());
const instante = (v) => (v instanceof Date ? v.getTime() : v == null ? null : new Date(v).getTime());

// ------------------------------------------------------------------
// Entrada
// ------------------------------------------------------------------

function validarEntrada(e) {
  const falla = (m) => {
    throw new ErrorEntradaInvalida(`aplicarPropuesta: ${m}`);
  };
  if (!esObjeto(e)) falla('la entrada debe ser un objeto.');
  const extras = Object.keys(e).filter((k) => !CAMPOS_ENTRADA.includes(k));
  if (extras.length > 0) falla(`campos no admitidos: ${extras.join(', ')} (el operador lo resuelve el servicio, nunca la entrada).`);
  if (typeof e.propuesta_id !== 'string' || !UUID.test(e.propuesta_id)) falla('propuesta_id debe ser un UUID.');
  if (typeof e.payload_hash_esperado !== 'string' || !SHA256_HEX.test(e.payload_hash_esperado)) {
    falla('payload_hash_esperado debe ser SHA-256 hex en minúsculas.');
  }
  if (!Number.isInteger(e.version_coordinacion_esperada) || e.version_coordinacion_esperada < 0) {
    falla('version_coordinacion_esperada debe ser un entero >= 0.');
  }
}

// ------------------------------------------------------------------
// IDs nativos del destino (puras)
// ------------------------------------------------------------------

// Pura. String hex de 24 (minúsculas, como lo produce ObjectId#toHexString)
// → BSON ObjectId. Rechaza todo lo demás, incluidos strings de 12 bytes
// y ObjectId ya construidos: la fuente es siempre el string del contrato.
function aObjectId(valor, nombre) {
  if (typeof valor !== 'string' || !OBJECT_ID_HEX.test(valor)) {
    throw new ErrorInconsistencia(`${nombre} debe ser un string ObjectId de 24 hex en minúsculas (recibido ${JSON.stringify(valor)}).`);
  }
  return ObjectId.createFromHexString(valor);
}

// Pura. Única conversión string → ObjectId del servicio. Toma los ids del
// payload (hasheado) y exige que los campos externos coincidan.
function convertirIdsDestino(propuesta) {
  const payload = propuesta?.payload;
  if (!esObjeto(payload)) throw new ErrorInconsistencia('La propuesta no tiene payload.');
  for (const campo of ['destino_id', 'requisito_id']) {
    const externo = propuesta[campo] != null ? String(propuesta[campo]) : null;
    if (externo !== payload[campo]) {
      throw new ErrorInconsistencia(
        `${campo} externo (${JSON.stringify(externo)}) no coincide con payload.${campo} (${JSON.stringify(payload[campo])}).`
      );
    }
  }
  return {
    destino_hex: payload.destino_id,
    requisito_hex: payload.requisito_id,
    destino_id: aObjectId(payload.destino_id, 'payload.destino_id'),
    requisito_id: aObjectId(payload.requisito_id, 'payload.requisito_id')
  };
}

// ------------------------------------------------------------------
// Etapa 0: precondiciones de la propuesta (pura)
// ------------------------------------------------------------------

function diferenciasAprobacion(p, ev) {
  const d = p.decision_aprobacion_id ?? null;
  if (typeof d !== 'string') return ['la propuesta no tiene decision_aprobacion_id'];
  if (!ev) return [`no existe el evento de aprobación ${d}`];
  const diffs = [];
  const comparar = (nombre, real, esperado) => {
    if (real !== esperado) diffs.push(`${nombre}=${JSON.stringify(real ?? null)} (esperado ${JSON.stringify(esperado)})`);
  };
  comparar('evento.evento_id', ev.evento_id, d);
  comparar('evento.tipo_evento', ev.tipo_evento, 'aprobacion');
  comparar('evento.propuesta_id', ev.propuesta_id, p.propuesta_id);
  comparar('evento.estado_anterior', ev.estado_anterior, TRANSICIONES.aprobacion.desde[0]);
  comparar('evento.estado_nuevo', ev.estado_nuevo, TRANSICIONES.aprobacion.hacia);
  comparar('evento.hash_contenido_referenciado', ev.hash_contenido_referenciado, p.payload_hash);
  comparar('evento.version_coordinacion_nueva', ev.version_coordinacion_nueva, p.version_coordinacion);
  comparar('evento.actor.tipo', ev.actor?.tipo, 'humano');
  comparar('propuesta.ultimo_evento_id', p.ultimo_evento_id ?? null, d);
  return diffs;
}

// Pura. [] = aplicable. Si no, cada falla {codigo, detalle}; la primera
// es la que se informa. Detalles canonicalizables (sin undefined).
function verificarPrecondicionesPropuesta(entrada, propuesta, eventoAprobacion) {
  const fallas = [];
  if (propuesta.estado !== 'aprobada') {
    fallas.push({ codigo: 'estado_no_aprobada', detalle: { esperado: 'aprobada', leido: propuesta.estado ?? null } });
  }
  if (propuesta.version_coordinacion !== entrada.version_coordinacion_esperada) {
    fallas.push({
      codigo: 'version_no_coincide',
      detalle: { esperado: entrada.version_coordinacion_esperada, leido: propuesta.version_coordinacion ?? null }
    });
  }
  let recalculado = null;
  let errorRecalculo = null;
  try {
    recalculado = hashSobreCanonico(propuesta.payload, propuesta.algoritmo_canonicalizacion, propuesta.algoritmo_hash);
  } catch (err) {
    errorRecalculo = String(err?.message ?? err);
  }
  if (propuesta.payload_hash !== entrada.payload_hash_esperado || recalculado !== propuesta.payload_hash) {
    fallas.push({
      codigo: 'hash_no_coincide',
      detalle: {
        esperado: entrada.payload_hash_esperado,
        leido: propuesta.payload_hash ?? null,
        recalculado,
        ...(errorRecalculo !== null ? { error_recalculo: errorRecalculo } : {})
      }
    });
  }
  const diffsAprobacion = diferenciasAprobacion(propuesta, eventoAprobacion);
  if (diffsAprobacion.length > 0) {
    fallas.push({
      codigo: 'aprobacion_invalida',
      detalle: { decision_aprobacion_id: propuesta.decision_aprobacion_id ?? null, diferencias: diffsAprobacion }
    });
  }
  return fallas;
}

// ------------------------------------------------------------------
// Etapa 1: clasificación de la revalidación (puras)
// ------------------------------------------------------------------

const canonico = (v) => JSON.stringify(canonicalizarValor(v ?? null));

function valoresCoinciden(valorRevalidado, valorPropuesto) {
  return valorRevalidado.valor === valorPropuesto.valor && canonico(valorRevalidado.valor_normalizado) === canonico(valorPropuesto.valor_normalizado);
}

// Pura. r: respuesta de adaptador.revalidar(). Devuelve
// {resultado, motivo, revalidacion}; resultado 'continuar' = pasa a etapa 2.
// `revalidacion` (subdocumento de IntentoAplicacion) solo con tipo valor.
function clasificarRevalidacion(propuesta, r, revalidacionId) {
  const falla = (m) => {
    throw new TypeError(`clasificarRevalidacion: respuesta del adaptador fuera de contrato: ${m}`);
  };
  if (!esObjeto(r)) falla('no es un objeto.');
  try {
    canonicalizarValor(r);
  } catch (err) {
    falla(`no es canonicalizable (${err.message}).`);
  }
  if (typeof r.motivo !== 'undefined' && typeof r.motivo !== 'string') falla('motivo debe ser string.');

  if (r.tipo === 'no_disponible') {
    return { resultado: 'fuente_temporalmente_no_disponible', motivo: r.motivo ?? 'sin_motivo', revalidacion: null };
  }
  if (!esFechaValida(r.revalidada_en)) falla('revalidada_en debe ser un Date válido.');
  if (typeof r.fuente_nombre !== 'string' || typeof r.url !== 'string') falla('fuente_nombre y url deben ser strings.');
  if (r.tipo === 'ambiguo') {
    return { resultado: 'extraccion_ambigua', motivo: r.motivo ?? 'sin_motivo', revalidacion: null };
  }
  if (r.tipo !== 'valor') falla(`tipo desconocido ${JSON.stringify(r.tipo)}.`);
  if (!esObjeto(r.valor) || typeof r.valor.valor !== 'string' || !esObjeto(r.valor.valor_normalizado)) {
    falla('valor debe ser {valor: string, valor_normalizado: objeto}.');
  }

  const vp = propuesta.payload.valor_propuesto;
  const coincide = valoresCoinciden(r.valor, vp);
  return {
    resultado: coincide ? 'continuar' : 'fuente_cambio',
    motivo: coincide ? null : `La fuente ahora informa ${JSON.stringify(r.valor.valor)} y la propuesta proponía ${JSON.stringify(vp.valor)}.`,
    revalidacion: {
      revalidacion_id: revalidacionId,
      revalidada_en: r.revalidada_en,
      fuente_nombre: r.fuente_nombre,
      url: r.url,
      valor_revalidado: { valor: r.valor.valor, valor_normalizado: r.valor.valor_normalizado },
      coincide_con_propuesta: coincide
    }
  };
}

// Pura. Ventana cerrada en ambos extremos: [revalidada_en, revalidada_en + ventana].
// Una revalidación "del futuro" (reloj hacia atrás) no es vigente.
function revalidacionVigente(revalidadaEn, t, ventanaMs = VENTANA_REVALIDACION_MS) {
  const edad = t.getTime() - revalidadaEn.getTime();
  return { vigente: edad >= 0 && edad <= ventanaMs, edad_ms: edad, ventana_ms: ventanaMs };
}

// ------------------------------------------------------------------
// Etapa 2: filtros y updates (puras)
// ------------------------------------------------------------------

// Pura. Condición sobre el valor actual del campo dentro del $elemMatch.
// Nunca {campo: null}: en Mongo matchea null Y ausente.
function condicionValor(campo, valorAnterior) {
  if (!CAMPOS_APLICABLES.includes(campo)) throw new TypeError(`condicionValor: campo no aplicable ${JSON.stringify(campo)}.`);
  if (!esObjeto(valorAnterior) || typeof valorAnterior.presente !== 'boolean' || !('valor' in valorAnterior)) {
    throw new TypeError('condicionValor: valor_anterior debe ser {presente, valor}.');
  }
  if (!valorAnterior.presente) {
    if (valorAnterior.valor !== null) throw new TypeError('condicionValor: {presente:false} exige valor null.');
    return { [campo]: { $exists: false } };
  }
  if (valorAnterior.valor === null) return { [campo]: { $type: 'null' } };
  if (typeof valorAnterior.valor !== 'string') {
    throw new TypeError(`condicionValor: ${campo} solo admite string o null (recibido ${typeof valorAnterior.valor}).`);
  }
  return { [campo]: valorAnterior.valor };
}

// Pura. ids: salida de convertirIdsDestino (ObjectId de BSON).
function filtroLecturaDestino(ids) {
  return { _id: ids.destino_id };
}

function filtroDestino(ids, campo, valorAnterior) {
  return {
    _id: ids.destino_id,
    requisitos: { $elemMatch: { _id: ids.requisito_id, ...condicionValor(campo, valorAnterior) } }
  };
}

// Pura. El $ posicional queda atado al elemento que cumplió el $elemMatch.
// Solo toca el campo y updatedAt (= t).
function updateDestino(campo, valorNuevo, t) {
  if (!CAMPOS_APLICABLES.includes(campo)) throw new TypeError(`updateDestino: campo no aplicable ${JSON.stringify(campo)}.`);
  if (typeof valorNuevo !== 'string' || valorNuevo === '') throw new TypeError('updateDestino: el valor nuevo debe ser un string no vacío.');
  return { $set: { [`requisitos.$.${campo}`]: valorNuevo, updatedAt: t } };
}

// Pura. Valor realmente presente en el subdocumento, distinguiendo
// ausente de null explícito.
function observarValor(requisito, campo) {
  const presente = Object.hasOwn(requisito, campo) && requisito[campo] !== undefined;
  return { presente, valor: presente ? requisito[campo] : null };
}

function mismoValorConPresencia(a, b) {
  return a.presente === b.presente && (a.valor ?? null) === (b.valor ?? null);
}

function filtroCasPropuesta(ctx) {
  return {
    propuesta_id: ctx.propuesta_id,
    estado: 'aprobada',
    payload_hash: ctx.hash_esperado,
    version_coordinacion: ctx.version_esperada,
    decision_aprobacion_id: ctx.decision_aprobacion_id,
    ultimo_evento_id: ctx.decision_aprobacion_id
  };
}

function updateCasPropuesta(tipoEvento, eventoId, t) {
  return {
    $set: { estado: TRANSICIONES[tipoEvento].hacia, ultimo_evento_id: eventoId, updatedAt: t },
    $inc: { version_coordinacion: 1 }
  };
}

// ------------------------------------------------------------------
// Documentos (puros)
// ------------------------------------------------------------------

function construirInicio(ctx, proceso) {
  const doc = {
    intento_id: ctx.intento_id,
    propuesta_id: ctx.propuesta_id,
    hash_contenido_referenciado: ctx.hash_leido,
    version_coordinacion_esperada: ctx.version_esperada,
    operador: { ...ctx.operador },
    proceso_aplicador: { ...PROCESO_APLICADOR },
    adaptador: { ...ctx.adaptador },
    iniciado_en: ctx.iniciado_en
  };
  if (proceso !== undefined) doc.proceso = proceso;
  return doc;
}

const CAMPOS_OPCIONALES_INTENTO = [
  'etapa_fallo',
  'resultado_no_registrado',
  'error_mensaje',
  'revalidacion',
  'precondicion',
  'valor_observado',
  'identidad_esperada_no_coincide',
  'historial_id'
];

function construirIntento(ctx, r) {
  const doc = {
    intento_id: ctx.intento_id,
    propuesta_id: ctx.propuesta_id,
    operador: { ...ctx.operador },
    proceso_aplicador: { ...PROCESO_APLICADOR },
    adaptador: { ...ctx.adaptador },
    hash_contenido_referenciado: ctx.hash_leido,
    version_coordinacion_esperada: ctx.version_esperada,
    decision_aprobacion_id: ctx.decision_aprobacion_id,
    iniciado_en: ctx.iniciado_en,
    finalizado_en: r.finalizado_en,
    resultado: r.resultado,
    // Saneo centralizado: único punto por donde pasa texto de error hacia intentos_aplicacion.
    evidencia_fresca: sanearTextosError(r.evidencia_fresca)
  };
  for (const campo of CAMPOS_OPCIONALES_INTENTO) if (r[campo] !== undefined) doc[campo] = r[campo];
  if (doc.error_mensaje !== undefined) doc.error_mensaje = sanearMensaje(doc.error_mensaje);
  return doc;
}

function construirHistorial(ctx, t) {
  return {
    historial_id: ctx.historial_id,
    destino_id: ctx.ids.destino_hex,
    requisito_id: ctx.ids.requisito_hex,
    campo: ctx.campo,
    valor_anterior: { presente: ctx.valor_anterior.presente, valor: ctx.valor_anterior.valor },
    valor_nuevo: { presente: true, valor: ctx.valor_nuevo },
    aplicado_en: t,
    propuesta_id: ctx.propuesta_id,
    decision_aprobacion_id: ctx.decision_aprobacion_id,
    intento_aplicacion_id: ctx.intento_id,
    revalidacion_id: ctx.revalidacion_id
  };
}

function construirEvento(ctx, tipoEvento, t, resultado, motivo) {
  const evento = {
    evento_id: ctx.evento_id,
    propuesta_id: ctx.propuesta_id,
    tipo_evento: tipoEvento,
    estado_anterior: 'aprobada',
    estado_nuevo: TRANSICIONES[tipoEvento].hacia,
    hash_contenido_referenciado: ctx.hash_esperado,
    version_coordinacion_nueva: ctx.version_esperada + 1,
    ocurrido_en: t,
    actor: { ...ACTOR_SISTEMA },
    detalle: {
      resultado,
      operador: { ...ctx.operador },
      identidad_operador: { ...ctx.identidad_operador },
      proceso_aplicador: { ...PROCESO_APLICADOR },
      adaptador: { ...ctx.adaptador }
    },
    intento_aplicacion_id: ctx.intento_id
  };
  // Saneo centralizado: el motivo puede incluir texto del adaptador.
  if (motivo != null) evento.motivo = sanearMensaje(motivo);
  return evento;
}

// ------------------------------------------------------------------
// Relectura (puras salvo releerEscritura)
// ------------------------------------------------------------------

const esObjectId = (v) => v instanceof ObjectId || (v != null && v._bsontype === 'ObjectId');

// Pura. ObjectId → hex para comparar lo leído (Mongoose castea
// HistorialCambio.destino_id a ObjectId) contra lo construido (strings).
function normalizarBson(v) {
  if (esObjectId(v)) return v.toHexString();
  if (v instanceof Date) return v;
  if (Array.isArray(v)) return v.map(normalizarBson);
  if (esObjeto(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalizarBson(x)]));
  return v;
}

function sinMetadatos(doc) {
  const { _id, __v, ...resto } = doc;
  return resto;
}

function compararDocumento(diffs, nombre, leido, esperado) {
  if (esperado === null) {
    if (leido) diffs.push(`${nombre} existe y no debería`);
    return;
  }
  if (!leido) {
    diffs.push(`${nombre} no existe`);
    return;
  }
  const real = canonico(normalizarBson(sinMetadatos(leido)));
  const ideal = canonico(normalizarBson(esperado));
  if (real !== ideal) diffs.push(`${nombre} distinto: leído ${real} (esperado ${ideal})`);
}

function requisitoUnico(destino, requisitoHex) {
  const coincidencias = (destino?.requisitos ?? []).filter((r) => r?._id != null && String(r._id) === requisitoHex);
  return coincidencias.length === 1 ? coincidencias[0] : null;
}

// Pura. [] = la escritura descrita por `esperado` quedó confirmada exactamente.
function diferenciasEscrituraConfirmada(esperado, leido) {
  const diffs = [];
  const comparar = (nombre, real, ideal) => {
    if (real !== ideal) diffs.push(`${nombre}=${JSON.stringify(real)} (esperado ${JSON.stringify(ideal)})`);
  };
  const p = leido.propuesta;
  if (!p) {
    diffs.push('la propuesta no existe');
  } else {
    const e = esperado.propuesta;
    comparar('propuesta.estado', p.estado, e.estado);
    comparar('propuesta.version_coordinacion', p.version_coordinacion, e.version_coordinacion);
    comparar('propuesta.ultimo_evento_id', p.ultimo_evento_id ?? null, e.ultimo_evento_id);
    comparar('propuesta.payload_hash', p.payload_hash, e.payload_hash);
    comparar('propuesta.decision_aprobacion_id', p.decision_aprobacion_id ?? null, e.decision_aprobacion_id);
    comparar('propuesta.updatedAt', instante(p.updatedAt), instante(e.updatedAt));
  }
  compararDocumento(diffs, 'evento', leido.evento, esperado.evento);
  compararDocumento(diffs, 'intento', leido.intento, esperado.intento);
  compararDocumento(diffs, 'historial', leido.historial, esperado.historial);
  if (esperado.destino) {
    const req = requisitoUnico(leido.destino, esperado.destino.requisito_hex);
    if (!req) {
      diffs.push('destino: no hay exactamente un requisito con el _id esperado');
    } else {
      comparar(`destino.requisito.${esperado.destino.campo}`, req[esperado.destino.campo] ?? null, esperado.destino.valor);
      comparar('destino.updatedAt', instante(leido.destino.updatedAt), instante(esperado.destino.updatedAt));
    }
  }
  return diffs;
}

// Pura. Algo de ESTE intento quedó escrito, pero no completo. Solo cuenta
// lo que lleva ids de este intento: el destino no se puede atribuir (otra
// aplicación concurrente puede haber escrito el mismo valor en el mismo t).
function quedoRastroParcial(leido, ctx) {
  return Boolean(leido.evento || leido.intento || leido.historial) || leido.propuesta?.ultimo_evento_id === ctx.evento_id;
}

// Pura. {coleccion, indice} del mensaje de un E11000, o null.
function indiceDuplicado(err) {
  if (err?.code !== 11000) return null;
  const texto = String(err.errmsg ?? err.errorResponse?.errmsg ?? err.message ?? '');
  const m = texto.match(/collection: \S*?\.?([A-Za-z0-9_]+) index: (\S+)/);
  return m ? { coleccion: m[1], indice: m[2] } : { coleccion: null, indice: null };
}

function esDuplicadoIntentoId(err) {
  const d = indiceDuplicado(err);
  return d !== null && d.coleccion === 'intentos_aplicacion' && d.indice === 'intento_id_1';
}

function resumenPropuesta(p) {
  if (!p) return null;
  return {
    estado: p.estado ?? null,
    payload_hash: p.payload_hash ?? null,
    version_coordinacion: p.version_coordinacion ?? null,
    decision_aprobacion_id: p.decision_aprobacion_id ?? null,
    ultimo_evento_id: p.ultimo_evento_id ?? null
  };
}

async function releerEscritura(ctx, deps) {
  const [propuesta, evento, intento, historial, destino] = await Promise.all([
    deps.leerPropuesta(ctx.propuesta_id),
    deps.leerEvento(ctx.evento_id),
    deps.leerIntento(ctx.intento_id),
    deps.leerHistorial(ctx.historial_id),
    deps.leerDestino(filtroLecturaDestino(ctx.ids), null)
  ]);
  return { propuesta, evento, intento, historial, destino };
}

// ------------------------------------------------------------------
// Resultados
// ------------------------------------------------------------------

function resultadoDesdeIntento(ctx, intento, { estadoNuevo = null, eventoId = null, causaRelectura = null } = {}) {
  return {
    resultado: intento.resultado,
    propuesta_id: ctx.propuesta_id,
    intento_id: ctx.intento_id,
    etapa_fallo: intento.etapa_fallo ?? null,
    resultado_no_registrado: intento.resultado_no_registrado ?? null,
    estado_propuesta_nuevo: estadoNuevo,
    evento_id: eventoId,
    historial_id: intento.historial_id ?? null,
    mensaje: intento.error_mensaje ?? null,
    confirmado_por_relectura: causaRelectura !== null,
    causa_relectura: causaRelectura
  };
}

// ------------------------------------------------------------------
// Escrituras
// ------------------------------------------------------------------

// Insert independiente (fuera de transacción) de un intento terminado.
// Con `plan`, un E11000 de intento_id significa que el commit de ese plan
// sí ocurrió: se relee y, si coincide, se devuelve {confirmado: true}.
async function registrarFueraDeTransaccion(ctx, doc, deps, plan = null) {
  await deps.validarIntento(doc);
  try {
    await deps.insertarIntentoIndependiente(doc);
    return { doc };
  } catch (err) {
    if (!esDuplicadoIntentoId(err)) throw err;
    if (!plan) {
      throw new ErrorInconsistencia(`E11000 al registrar el intento ${ctx.intento_id} (${doc.resultado}): ya existe otro intento con ese intento_id. ${err.message}`);
    }
    let leido;
    try {
      leido = await releerEscritura(ctx, deps);
    } catch (errRelectura) {
      throw new ErrorResultadoIncierto(
        ctx,
        `el registro de ${doc.resultado} chocó con intento_id_1 (el commit de "${plan.nombre}" pudo haber ocurrido) y falló la relectura de confirmación (${errRelectura?.message ?? errRelectura}).`,
        err,
        { error_relectura: errRelectura }
      );
    }
    const diffs = diferenciasEscrituraConfirmada(plan.esperado, leido);
    if (diffs.length === 0) return { confirmado: true };
    throw new ErrorInconsistencia(
      `E11000 al registrar ${doc.resultado} para el intento ${ctx.intento_id} sin que "${plan.nombre}" esté confirmado: ${diffs.join('; ')}`
    );
  }
}

// Registra el escritura_abortada de un error ya ocurrido. Si el propio
// registro falla (y no es una inconsistencia ni otro resultado incierto),
// no se pierde la causa: ErrorResultadoIncierto con `cause` = el error original.
async function registrarAbortado(ctx, doc, deps, plan, errOriginal) {
  try {
    return await registrarFueraDeTransaccion(ctx, doc, deps, plan);
  } catch (errRegistro) {
    if (errRegistro instanceof ErrorInconsistencia || errRegistro instanceof ErrorResultadoIncierto) throw errRegistro;
    throw new ErrorResultadoIncierto(
      ctx,
      `la escritura abortó (${errOriginal?.message ?? errOriginal}) y además falló el registro de escritura_abortada (${errRegistro?.message ?? errRegistro}).`,
      errOriginal,
      { error_registro: errRegistro }
    );
  }
}

async function escribirConConfirmacion(ctx, plan, deps) {
  let err;
  try {
    await deps.ejecutarTransaccion((session) => plan.cuerpo(session));
    return plan.resultadoConfirmado(null);
  } catch (e) {
    err = e;
  }

  if (err instanceof ErrorFalloSemantico) throw err;
  if (err instanceof ErrorInconsistencia) {
    // Lanzada por el callback: la transacción abortó con certeza.
    err.intento_id = ctx.intento_id;
    try {
      await registrarFueraDeTransaccion(ctx, plan.docAbortado(`Inconsistencia: ${err.message}`, deps.ahora()), deps, plan);
    } catch (errRegistro) {
      err.message = `${err.message} (transacción abortada; falló además el registro de escritura_abortada del intento ${ctx.intento_id}: ${sanearMensaje(errRegistro?.message ?? errRegistro)})`;
      err.error_registro = errRegistro;
      throw err;
    }
    err.message = `${err.message} (transacción abortada; intento ${ctx.intento_id} registrado como escritura_abortada)`;
    throw err;
  }

  const casNoCoincide = err instanceof ErrorCasPropuesta;
  const duplicado = err?.code === 11000;
  let leido;
  try {
    leido = await releerEscritura(ctx, deps);
  } catch (errRelectura) {
    // No se sabe si la escritura quedó confirmada: no se registra nada más
    // (queda el inicio para auditoría) y el error original no se modifica.
    throw new ErrorResultadoIncierto(
      ctx,
      `falló la escritura de "${plan.nombre}" (${err?.message ?? err}) y también la relectura de confirmación (${errRelectura?.message ?? errRelectura}); verificar a mano el evento ${ctx.evento_id}.`,
      err,
      { error_relectura: errRelectura, duplicado }
    );
  }

  const diffs = diferenciasEscrituraConfirmada(plan.esperado, leido);
  if (diffs.length === 0) {
    return plan.resultadoConfirmado(casNoCoincide ? 'cas_no_coincide' : duplicado ? 'duplicado' : 'error_transaccion');
  }
  if (duplicado) {
    throw new ErrorInconsistencia(
      `E11000 sin que "${plan.nombre}" esté confirmado (alguien escribió por fuera del servicio). ${err.message}. Diferencias: ${diffs.join('; ')}`
    );
  }
  if (quedoRastroParcial(leido, ctx)) {
    throw new ErrorInconsistencia(`${casNoCoincide ? 'CAS sin coincidencia' : `Error de transacción (${err.message})`} con rastro parcial de "${plan.nombre}": ${diffs.join('; ')}`);
  }

  const fin = deps.ahora();
  if (casNoCoincide) {
    // Resultado operativo de una carrera: se devuelve.
    const r = await registrarFueraDeTransaccion(ctx, plan.docCasNoCoincide(leido, fin), deps, plan);
    if (r.confirmado) return plan.resultadoConfirmado('duplicado_intento_id');
    return resultadoDesdeIntento(ctx, r.doc);
  }
  // Error inesperado: se registra y se relanza con la causa original.
  const mensaje = `La transacción falló y no quedó nada escrito: ${err?.message ?? err}`;
  const r = await registrarAbortado(ctx, plan.docAbortado(mensaje, fin), deps, plan, err);
  if (r.confirmado) return plan.resultadoConfirmado('duplicado_intento_id');
  throw new ErrorEscrituraAbortada(ctx, r.doc, err);
}

function esperadoPropuesta(ctx, tipoEvento, t) {
  return {
    estado: TRANSICIONES[tipoEvento].hacia,
    version_coordinacion: ctx.version_esperada + 1,
    ultimo_evento_id: ctx.evento_id,
    payload_hash: ctx.hash_esperado,
    decision_aprobacion_id: ctx.decision_aprobacion_id,
    updatedAt: t
  };
}

async function casPropuesta(ctx, tipoEvento, t, session, deps) {
  const r = await deps.actualizarPropuestaCas(filtroCasPropuesta(ctx), updateCasPropuesta(tipoEvento, ctx.evento_id, t), session);
  if (r.matchedCount !== 1) throw new ErrorCasPropuesta('la propuesta ya no está como se leyó en la etapa 0');
  if (r.modifiedCount !== 1) {
    throw new ErrorInconsistencia(`El CAS encontró la propuesta pero modifiedCount=${r.modifiedCount}.`);
  }
}

function planExito(ctx, revalidacion, evidencia, t, deps) {
  const precondicion = { presente: ctx.valor_anterior.presente, valor: ctx.valor_anterior.valor };
  const historial = construirHistorial(ctx, t);
  const intento = construirIntento(ctx, {
    resultado: 'exito',
    finalizado_en: t,
    evidencia_fresca: evidencia,
    revalidacion,
    precondicion,
    historial_id: ctx.historial_id
  });
  const evento = construirEvento(ctx, 'aplicacion', t, 'exito', null);
  const filtro = filtroDestino(ctx.ids, ctx.campo, ctx.valor_anterior);
  const update = updateDestino(ctx.campo, ctx.valor_nuevo, t);

  return {
    nombre: 'exito',
    documentos: { historial, intento, evento },
    esperado: {
      propuesta: esperadoPropuesta(ctx, 'aplicacion', t),
      evento,
      intento,
      historial,
      destino: { requisito_hex: ctx.ids.requisito_hex, campo: ctx.campo, valor: ctx.valor_nuevo, updatedAt: t }
    },
    cuerpo: async (session) => {
      await casPropuesta(ctx, 'aplicacion', t, session, deps);

      const destino = await deps.leerDestino(filtroLecturaDestino(ctx.ids), session);
      const identidad = clasificarIdentidadRequisito(destino, ctx.ids.requisito_hex, ctx.validarIdentidad);
      if (!identidad.ok) {
        const identidadNoCoincide = { categoria: identidad.categoria, detalle: identidad.detalle };
        throw new ErrorFalloSemantico(
          'identidad_requisito_cambio',
          { identidad_esperada_no_coincide: identidadNoCoincide },
          { identidad: identidadNoCoincide },
          `La identidad del requisito ya no coincide (${identidad.categoria}); no se escribe en destinos.`
        );
      }
      const observado = observarValor(identidad.requisito, ctx.campo);
      if (!mismoValorConPresencia(observado, precondicion)) {
        throw new ErrorFalloSemantico(
          'valor_actual_cambio',
          { precondicion, valor_observado: observado },
          { valor_observado: observado },
          `El valor actual de ${ctx.campo} (${JSON.stringify(observado)}) ya no es el valor_anterior de la propuesta (${JSON.stringify(precondicion)}).`
        );
      }

      const r = await deps.actualizarDestino(filtro, update, session);
      if (r.matchedCount !== 1) {
        throw new ErrorInconsistencia(
          `La lectura consistente del destino cumplía la precondición pero el $set con $elemMatch no encontró nada (matchedCount=${r.matchedCount}).`
        );
      }
      if (r.modifiedCount !== 1) throw new ErrorInconsistencia(`El $set del destino devolvió modifiedCount=${r.modifiedCount}.`);

      await deps.insertarHistorial(historial, session);
      await deps.insertarIntento(intento, session);
      await deps.insertarEvento(evento, session);
    },
    resultadoConfirmado: (causa) =>
      resultadoDesdeIntento(ctx, intento, { estadoNuevo: 'aplicada', eventoId: ctx.evento_id, causaRelectura: causa }),
    docAbortado: (mensaje, fin) =>
      construirIntento(ctx, {
        resultado: 'escritura_abortada',
        etapa_fallo: 'escritura_aplicacion',
        finalizado_en: fin,
        error_mensaje: mensaje,
        evidencia_fresca: { ...evidencia, error: mensaje },
        revalidacion,
        precondicion
      }),
    docCasNoCoincide: (leido, fin) => {
      const mensaje = 'La propuesta cambió entre la etapa 0 y la escritura (CAS sin coincidencia); no se escribió nada.';
      return construirIntento(ctx, {
        resultado: 'propuesta_no_aplicable',
        etapa_fallo: 'escritura_aplicacion',
        finalizado_en: fin,
        error_mensaje: mensaje,
        evidencia_fresca: { ...evidencia, propuesta_actual: resumenPropuesta(leido.propuesta) },
        revalidacion
      });
    }
  };
}

function planTransicion(ctx, resultado, etapa, extras, evidencia, motivo, t, deps) {
  const tipoEvento = TRANSICION_POR_RESULTADO[resultado];
  const intento = construirIntento(ctx, {
    resultado,
    etapa_fallo: etapa,
    finalizado_en: t,
    error_mensaje: motivo,
    evidencia_fresca: evidencia,
    ...extras
  });
  const evento = construirEvento(ctx, tipoEvento, t, resultado, motivo);
  const abortado = (mensaje, fin) =>
    construirIntento(ctx, {
      resultado: 'escritura_abortada',
      etapa_fallo: 'transicion_por_fallo',
      resultado_no_registrado: resultado,
      finalizado_en: fin,
      error_mensaje: mensaje,
      evidencia_fresca: { ...evidencia, error: mensaje },
      ...extras
    });

  return {
    nombre: resultado,
    documentos: { intento, evento },
    esperado: { propuesta: esperadoPropuesta(ctx, tipoEvento, t), evento, intento, historial: null, destino: null },
    cuerpo: async (session) => {
      await casPropuesta(ctx, tipoEvento, t, session, deps);
      await deps.insertarIntento(intento, session);
      await deps.insertarEvento(evento, session);
    },
    resultadoConfirmado: (causa) =>
      resultadoDesdeIntento(ctx, intento, { estadoNuevo: TRANSICIONES[tipoEvento].hacia, eventoId: ctx.evento_id, causaRelectura: causa }),
    docAbortado: abortado,
    docCasNoCoincide: (leido, fin) =>
      abortado(
        `La propuesta cambió antes de registrar ${resultado} (CAS sin coincidencia; estado actual ${JSON.stringify(leido.propuesta?.estado ?? null)}); no se registró la transición.`,
        fin
      )
  };
}

async function registrarTransicion(ctx, resultado, etapa, extras, evidencia, motivo, t, deps) {
  const plan = planTransicion(ctx, resultado, etapa, extras, evidencia, motivo, t, deps);
  await deps.validarIntento(plan.documentos.intento);
  await deps.validarEvento(plan.documentos.evento);
  return escribirConConfirmacion(ctx, plan, deps);
}

// ------------------------------------------------------------------
// Servicio
// ------------------------------------------------------------------

async function aplicarPropuesta(entrada, deps = crearDependenciasMongoose()) {
  validarEntrada(entrada);
  const operadores = deps.operadoresAutorizados();
  const resolucion = resolverActor(await deps.usuariosAutenticados(), operadores);
  await deps.verificarIndices();

  // Una sola vez: todo reintento reutiliza exactamente estos valores.
  const intentoId = deps.uuid();
  const eventoId = deps.uuid();
  const historialId = deps.uuid();
  const revalidacionId = deps.uuid();
  const iniciadoEn = deps.ahora();
  const generados = [intentoId, eventoId, historialId, revalidacionId];
  if (!generados.every((u) => typeof u === 'string' && UUID.test(u))) throw new Error('deps.uuid() no devolvió un UUID.');
  if (new Set(generados).size !== generados.length) throw new Error('deps.uuid() devolvió UUIDs repetidos.');
  if (!esFechaValida(iniciadoEn)) throw new Error('deps.ahora() no devolvió un Date válido.');

  // ---- Etapa 0 (solo lectura) ----
  const propuesta = await deps.leerPropuesta(entrada.propuesta_id);
  if (!propuesta) throw new ErrorPropuestaNoEncontrada(`aplicarPropuesta: no existe la propuesta ${entrada.propuesta_id}. No se escribe nada.`);
  const ids = convertirIdsDestino(propuesta);
  if (!CAMPOS_APLICABLES.includes(propuesta.campo) || propuesta.payload.campo !== propuesta.campo) {
    throw new ErrorPropuestaNoSoportada(`aplicarPropuesta: campo ${JSON.stringify(propuesta.campo)} no aplicable. No se escribe nada.`);
  }
  const adaptador = deps.elegirAdaptador(propuesta);
  const decision = typeof propuesta.decision_aprobacion_id === 'string' ? propuesta.decision_aprobacion_id : null;
  const eventoAprobacion = decision ? await deps.leerEvento(decision) : null;
  const fallas = verificarPrecondicionesPropuesta(entrada, propuesta, eventoAprobacion);

  const ctx = {
    propuesta_id: entrada.propuesta_id,
    hash_esperado: entrada.payload_hash_esperado,
    version_esperada: entrada.version_coordinacion_esperada,
    hash_leido: propuesta.payload_hash,
    decision_aprobacion_id: decision,
    intento_id: intentoId,
    evento_id: eventoId,
    historial_id: historialId,
    revalidacion_id: revalidacionId,
    iniciado_en: iniciadoEn,
    operador: resolucion.actor,
    identidad_operador: resolucion.identidad_operador,
    adaptador: { nombre: adaptador.nombre, version: adaptador.version },
    validarIdentidad: adaptador.validarIdentidad,
    ids,
    campo: propuesta.campo,
    valor_anterior: propuesta.payload.valor_anterior,
    valor_nuevo: propuesta.payload.valor_propuesto?.valor
  };

  const inicio = construirInicio(ctx, deps.contextoProceso());
  await deps.validarInicio(inicio);
  await deps.insertarInicio(inicio);

  if (fallas.length > 0) {
    const doc = construirIntento(ctx, {
      resultado: 'propuesta_no_aplicable',
      etapa_fallo: 'precondiciones_propuesta',
      finalizado_en: deps.ahora(),
      error_mensaje: `La propuesta no es aplicable (${fallas.map((f) => f.codigo).join(', ')}); no se consultó la fuente.`,
      evidencia_fresca: { precondiciones: fallas }
    });
    const r = await registrarFueraDeTransaccion(ctx, doc, deps);
    return resultadoDesdeIntento(ctx, r.doc);
  }

  // ---- Etapa 1: revalidación externa, sin transacción abierta ----
  const respuesta = await adaptador.revalidar(propuesta, { ahora: deps.ahora });
  const clasificacion = clasificarRevalidacion(propuesta, respuesta, revalidacionId);
  const evidenciaBase = { revalidacion_externa: respuesta };

  if (clasificacion.resultado === 'fuente_temporalmente_no_disponible') {
    const doc = construirIntento(ctx, {
      resultado: 'fuente_temporalmente_no_disponible',
      etapa_fallo: 'revalidacion_externa',
      finalizado_en: deps.ahora(),
      error_mensaje: `La fuente no está disponible (${clasificacion.motivo}); se puede reintentar.`,
      evidencia_fresca: evidenciaBase
    });
    const r = await registrarFueraDeTransaccion(ctx, doc, deps);
    return resultadoDesdeIntento(ctx, r.doc);
  }

  // Después de la revalidación, inmediatamente antes de abrir la transacción.
  const t = deps.ahora();
  if (!esFechaValida(t)) throw new Error('deps.ahora() no devolvió un Date válido.');

  if (clasificacion.resultado === 'extraccion_ambigua') {
    const motivo = `La fuente respondió sin un valor inequívoco (${clasificacion.motivo}); requiere revisión humana.`;
    return registrarTransicion(ctx, 'extraccion_ambigua', 'revalidacion_externa', {}, evidenciaBase, motivo, t, deps);
  }
  const { revalidacion } = clasificacion;
  if (clasificacion.resultado === 'fuente_cambio') {
    return registrarTransicion(ctx, 'fuente_cambio', 'revalidacion_externa', { revalidacion }, evidenciaBase, clasificacion.motivo, t, deps);
  }

  // ---- Ventana (solo antes de escribir en destinos) ----
  const vigencia = revalidacionVigente(revalidacion.revalidada_en, t);
  const evidencia = {
    ...evidenciaBase,
    ventana: { revalidada_en: revalidacion.revalidada_en, t, edad_ms: vigencia.edad_ms, ventana_ms: vigencia.ventana_ms }
  };
  if (!vigencia.vigente) {
    const doc = construirIntento(ctx, {
      resultado: 'revalidacion_vencida',
      etapa_fallo: 'escritura_aplicacion',
      finalizado_en: t,
      error_mensaje: `La revalidación tiene ${vigencia.edad_ms} ms respecto de t (ventana [0, ${vigencia.ventana_ms}]); no se escribe.`,
      evidencia_fresca: evidencia,
      revalidacion
    });
    const r = await registrarFueraDeTransaccion(ctx, doc, deps);
    return resultadoDesdeIntento(ctx, r.doc);
  }

  // ---- Etapa 2: transacción de escritura ----
  const plan = planExito(ctx, revalidacion, evidencia, t, deps);
  await deps.validarHistorial(plan.documentos.historial);
  await deps.validarIntento(plan.documentos.intento);
  await deps.validarEvento(plan.documentos.evento);
  try {
    return await escribirConConfirmacion(ctx, plan, deps);
  } catch (err) {
    if (!(err instanceof ErrorFalloSemantico)) throw err;
    return registrarTransicion(
      ctx,
      err.resultado,
      'escritura_aplicacion',
      { revalidacion, ...err.extras },
      { ...evidencia, ...err.evidencia },
      err.motivo,
      t,
      deps
    );
  }
}

// ------------------------------------------------------------------
// Dependencias reales
// ------------------------------------------------------------------

const MODELO_POR_COLECCION = {
  propuestas_cambio: PropuestaCambio,
  eventos_propuesta: EventoPropuesta,
  intentos_aplicacion: IntentoAplicacion,
  historial_cambios: HistorialCambio,
  inicios_intento_aplicacion: InicioIntentoAplicacion
};

async function listarIndices(Model) {
  try {
    return await Model.collection.indexes();
  } catch (err) {
    if (err.code === 26) return []; // NamespaceNotFound: la colección no existe
    throw err;
  }
}

// Pura. listados: { [coleccion]: listIndexes() }.
function verificarListadoIndices(listados) {
  verificarConjuntoIndices(INDICES_REQUERIDOS, listados);
}

// listIndexes no puede correr dentro de una transacción: se llama antes.
async function verificarIndices() {
  const colecciones = coleccionesDe(INDICES_REQUERIDOS);
  const listas = await Promise.all(colecciones.map((c) => listarIndices(MODELO_POR_COLECCION[c])));
  verificarListadoIndices(Object.fromEntries(colecciones.map((c, i) => [c, listas[i]])));
}

function crearDependenciasMongoose(conexion = mongoose.connection, { operadoresJson = process.env.OPERADORES_AUTORIZADOS_JSON } = {}) {
  const mayoria = { writeConcern: { w: 'majority' } };
  return {
    uuid: () => crypto.randomUUID(),
    ahora: () => new Date(),
    contextoProceso: () => ({ host: os.hostname(), pid: process.pid }),
    operadoresAutorizados: () => cargarOperadoresAutorizados(operadoresJson),
    usuariosAutenticados: () => usuariosAutenticadosDe(conexion),
    verificarIndices,
    elegirAdaptador: (propuesta) => elegirAdaptador(propuesta),
    leerPropuesta: (propuestaId) => PropuestaCambio.findOne({ propuesta_id: propuestaId }).lean(),
    leerEvento: (eventoId) => EventoPropuesta.findOne({ evento_id: eventoId }).lean(),
    leerIntento: (intentoId) => IntentoAplicacion.findOne({ intento_id: intentoId }).lean(),
    leerHistorial: (historialId) => HistorialCambio.findOne({ historial_id: historialId }).lean(),
    // Driver nativo: el filtro llega tal cual (ObjectId de BSON), sin casting.
    leerDestino: (filtro, session) => Destino.collection.findOne(filtro, session ? { session } : {}),
    validarInicio: (doc) => new InicioIntentoAplicacion(doc).validate(),
    validarIntento: (doc) => new IntentoAplicacion(doc).validate(),
    validarHistorial: (doc) => new HistorialCambio(doc).validate(),
    validarEvento: (doc) => new EventoPropuesta(doc).validate(),
    insertarInicio: (doc) => new InicioIntentoAplicacion(doc).save(mayoria),
    insertarIntentoIndependiente: (doc) => new IntentoAplicacion(doc).save(mayoria),
    ejecutarTransaccion: (fn) =>
      conexion.transaction(fn, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } }),
    actualizarPropuestaCas: (filtro, update, session) =>
      PropuestaCambio.updateOne(filtro, update, { session, timestamps: false, strict: 'throw', runValidators: true }),
    actualizarDestino: (filtro, update, session) => Destino.collection.updateOne(filtro, update, { session }),
    insertarHistorial: (doc, session) => new HistorialCambio(doc).save({ session }),
    insertarIntento: (doc, session) => new IntentoAplicacion(doc).save({ session }),
    insertarEvento: (doc, session) => new EventoPropuesta(doc).save({ session })
  };
}

module.exports = {
  INDICES_REQUERIDOS,
  PROCESO_APLICADOR,
  ACTOR_SISTEMA,
  CAMPOS_APLICABLES,
  ErrorEntradaInvalida,
  ErrorInconsistencia,
  ErrorPropuestaNoEncontrada,
  ErrorPropuestaNoSoportada,
  ErrorEscrituraAbortada,
  ErrorResultadoIncierto,
  ErrorConfiguracionOperadores,
  ErrorActorNoAutorizado,
  ErrorPrecondicionIndices,
  ErrorSinAdaptador,
  validarEntrada,
  sanearMensaje,
  sanearTextosError,
  CLAVES_TEXTO_ERROR,
  aObjectId,
  convertirIdsDestino,
  verificarPrecondicionesPropuesta,
  clasificarRevalidacion,
  revalidacionVigente,
  condicionValor,
  filtroLecturaDestino,
  filtroDestino,
  updateDestino,
  observarValor,
  mismoValorConPresencia,
  filtroCasPropuesta,
  updateCasPropuesta,
  construirInicio,
  construirIntento,
  construirHistorial,
  construirEvento,
  normalizarBson,
  diferenciasEscrituraConfirmada,
  quedoRastroParcial,
  indiceDuplicado,
  verificarListadoIndices,
  verificarIndices,
  aplicarPropuesta,
  crearDependenciasMongoose
};
