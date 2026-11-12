/**
 * H1 — Servicio AISLADO de aplicación 2.0 (requisito completo). NO es un flujo
 * operativo: no está conectado a rutas, CLI ni panel, y el registro 2.0 sigue
 * cerrado. Sigue el patrón revisado del 1.0 (aplicar-propuesta.js), que no se
 * modifica: entrada cerrada, precondiciones contra la propuesta GUARDADA, una
 * transacción con CAS de la propuesta + escritura nativa del destino +
 * auditoría, y relectura ante error o respuesta incierta.
 *
 * H2.1: intento e historial se escriben con version_contrato '2.0' y se
 * validan con los modelos existentes (persistencia-aplicacion-v2.js). Los
 * persistidores se INYECTAN y comparten la sesión de la transacción.
 * H2.2: el detalle del evento sigue el contrato 2.0 de EventoPropuesta
 * (auditoría del aplicador, proceso, adaptador y referencia a la aprobación).
 *
 * Fuera de H1 (dependencias explícitas, no simuladas aquí):
 *  - H3: autenticación y permiso del operador (panel: token + permiso
 *    'aplicar'; CLI: connectionStatus + allowlist), orquestación que persiste
 *    el inicio antes de revalidar (H3.1 deja construirInicioV2/registrarInicioV2
 *    y exige el inicio exacto antes de toda escritura), adaptador 2.0 que
 *    produce `revalidaciones` y el registro de intentos por revalidación
 *    vencida o fuente cambiada.
 *    H1 recibe una auditoría ya resuelta por esa capa y solo valida su forma;
 *    nunca toma identidades del cuerpo HTTP.
 *
 * Ninguna consulta externa ocurre dentro del callback de la transacción.
 * Los identificadores e instantes se generan UNA vez, antes de la
 * transacción, y se reutilizan en cada reintento del callback.
 */
const { ObjectId } = require('bson');
const { canonicalizarValor } = require('./canonicalizacion-propuestas');
const { TRANSICIONES, TRANSICION_POR_RESULTADO } = require('./contrato-propuestas');
const { INDICES_APLICACION, verificarConjuntoIndices } = require('./indices-propuestas');
const { validarAuditoria } = require('./auditoria-aplicacion');
const { VERSION_CONTRATO, TIPO_PROPUESTA, CAMPO_EXTERNO, CLAVES_REQUISITO_CONOCIDAS, CAMPOS_INSTANTANEA,
  capturarIdentidadEInstantanea, aplicarCambiosAInstantanea } = require('./contrato-requisito-v2');
const { validarSobreRequisitoV2 } = require('./payload-requisito-v2');
const { construirPlan } = require('./plan-aplicacion-requisito-v2');
const { SPEC: INDICE_TRANSVERSAL } = require('../../scripts/preparar-indice-transversal');
const {
  ErrorEntradaInvalida, ErrorInconsistencia, ErrorResultadoIncierto, ErrorPropuestaNoEncontrada,
  validarEntrada, verificarPrecondicionesPropuesta, convertirIdsDestino,
  filtroCasPropuesta, updateCasPropuesta, quedoRastroParcial, normalizarBson, indiceDuplicado, sanearMensaje
} = require('./aplicar-propuesta');

const PROCESO_APLICADOR_V2 = Object.freeze({ nombre: 'aplicar-propuesta-v2', version: '1' });
const ACTOR_SISTEMA_V2 = Object.freeze({ tipo: 'sistema', identificador: PROCESO_APLICADOR_V2.nombre });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Nombre técnico cerrado: el adaptador nunca es texto libre del llamador.
const NOMBRE_TECNICO = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MENSAJE_ABORTADA = 'La escritura del aplicador 2.0 se abortó sin cambios en destinos; ver error_externo.';
const CODIGOS_REVALIDACION = ['revalidaciones_incompletas', 'revalidacion_no_unica', 'revalidacion_invalida',
  'fecha_revalidacion_invalida', 'revalidacion_vencida', 'fuente_cambio'];

// La revalidación no permite escribir. H3 registrará el intento con la evidencia del adaptador.
class ErrorRevalidacionV2 extends Error {
  constructor(codigo, causa) {
    super(`aplicarPropuestaV2: revalidación no utilizable (${codigo}); no se escribe nada.`, { cause: causa });
    this.codigo = codigo;
  }
}
// Error inesperado: la transacción no dejó nada y se registró escritura_abortada.
class ErrorEscrituraAbortadaV2 extends Error {
  constructor(ctx, intento, causa) {
    super(`aplicarPropuestaV2: escritura abortada (intento ${ctx.intento_id}, etapa ${intento.etapa_fallo}); registrada como escritura_abortada. Causa: ${sanearMensaje(causa?.message ?? causa)}`, { cause: causa });
    this.intento_id = ctx.intento_id;
    this.propuesta_id = ctx.propuesta_id;
    this.resultado = 'escritura_abortada';
  }
}
// H3.1: sin el inicio persistido que corresponde a este intento no se escribe nada.
// Mensaje fijo: nunca incluye la auditoría ni el documento leído.
class ErrorInicioV2 extends Error {
  constructor(codigo, ctx) {
    super(`aplicarPropuestaV2: ${codigo === 'inicio_ausente' ? 'no existe el inicio del intento' : 'el inicio persistido no corresponde a este intento'} ${ctx.intento_id}; no se escribe nada.`);
    this.codigo = codigo;
    this.intento_id = ctx.intento_id;
    this.propuesta_id = ctx.propuesta_id;
  }
}
// H3.1: no se pudo confirmar que el inicio quedó persistido; no continuar hacia fuentes ni escrituras.
class ErrorInicioInciertoV2 extends Error {
  constructor(inicio, causa, extras = {}) {
    super(`registrarInicioV2: no se puede confirmar el inicio del intento ${inicio.intento_id} (propuesta ${inicio.propuesta_id}); no continuar ni reintentar con otro id.`, { cause: causa });
    this.intento_id = inicio.intento_id;
    this.propuesta_id = inicio.propuesta_id;
    Object.assign(this, extras);
  }
}
// Centinelas internos: el callback los lanza y la transacción aborta con certeza.
class ErrorNoAplicableV2 extends Error { constructor(fallas) { super('propuesta_no_aplicable'); this.fallas = fallas; } }
class ErrorConflictoV2 extends Error { constructor(c) { super(c.resultado); this.clasificacion = c; } }
class ErrorCasPropuestaV2 extends Error {}

const esObjeto = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const RED = ['MongoNetworkError', 'MongoNetworkTimeoutError', 'MongoServerSelectionError', 'MongoNotConnectedError'];
// Pura. Código cerrado (IntentoAplicacion.CODIGOS_ERROR_EXTERNO) para persistir un error externo.
function codigoErrorExterno(err) {
  if (err instanceof ErrorInconsistencia) return 'inconsistencia';
  if (err?.code === 11000) return 'clave_duplicada';
  if (RED.includes(err?.name)) return 'red';
  if (typeof err?.name === 'string' && err.name.startsWith('Mongo')) return 'servidor';
  return 'desconocido';
}
const esObjectId = v => v instanceof ObjectId || (v != null && v._bsontype === 'ObjectId');
const canonico = v => JSON.stringify(canonicalizarValor(v ?? null));
const instante = v => (v instanceof Date ? v.getTime() : v == null ? null : new Date(v).getTime());

// Pura. Los índices de aplicación del 1.0 más el transversal; falta uno → no se escribe.
function verificarIndicesV2(listados) {
  verificarConjuntoIndices([...INDICES_APLICACION, INDICE_TRANSVERSAL], listados);
}

// Pura. [] = aplicable. Reutiliza las precondiciones del 1.0 y suma las del contrato 2.0.
function verificarPrecondicionesV2(entrada, propuesta, evento) {
  const fallas = verificarPrecondicionesPropuesta(entrada, propuesta, evento);
  const p = propuesta?.payload;
  if (propuesta?.campo !== CAMPO_EXTERNO || p?.campo !== CAMPO_EXTERNO || p?.version_contrato !== VERSION_CONTRATO || p?.tipo_propuesta !== TIPO_PROPUESTA) {
    fallas.push({ codigo: 'contrato_no_2_0', detalle: { campo: propuesta?.campo ?? null, version_contrato: p?.version_contrato ?? null } });
  }
  const d = evento?.detalle;
  if (!esObjeto(d) || d.version_contrato !== VERSION_CONTRATO || !Array.isArray(d.advertencias_aceptadas)
    || !Array.isArray(p?.advertencias) || canonico(d.advertencias_aceptadas) !== canonico(p.advertencias)) {
    fallas.push({ codigo: 'advertencias_no_aceptadas', detalle: { aceptadas: Array.isArray(d?.advertencias_aceptadas) ? [...d.advertencias_aceptadas] : null,
      requeridas: Array.isArray(p?.advertencias) ? [...p.advertencias] : null } });
  }
  return fallas;
}

const sobreGuardado = p => ({ algoritmo_canonicalizacion: p.algoritmo_canonicalizacion, algoritmo_hash: p.algoritmo_hash, payload: p.payload, payload_hash: p.payload_hash });

// Pura. Valida el sobre guardado y construye el plan con el núcleo revisado.
function planDesdePropuesta(propuesta, revalidaciones, t) {
  let sobre;
  try { sobre = validarSobreRequisitoV2(sobreGuardado(propuesta)); }
  catch (err) { throw new ErrorNoAplicableV2([{ codigo: 'payload_2_0_invalido', detalle: { mensaje: sanearMensaje(err?.message ?? err) } }]); }
  try { return { payload: sobre.payload, plan: construirPlan(sobreGuardado(propuesta), revalidaciones, t) }; }
  catch (err) {
    if (CODIGOS_REVALIDACION.includes(err?.message)) throw new ErrorRevalidacionV2(err.message, err);
    if (err?.message === 'Instante inválido') throw new ErrorRevalidacionV2('instante_invalido', err);
    throw err;
  }
}

// Pura. Clasifica el requisito leído DENTRO de la transacción. Solo un _id
// BSON ObjectId cuenta como identidad; claves fuera del contrato → conflicto.
function clasificarRequisitoV2(destino, ids, payload) {
  const conflicto = (resultado, categoria, detalle = {}) => ({ ok: false, resultado, categoria, detalle });
  if (!destino) return conflicto('identidad_requisito_cambio', 'destino_no_encontrado');
  if (!Array.isArray(destino.requisitos)) return conflicto('identidad_requisito_cambio', 'requisito_id_no_encontrado', { requisitos_no_es_lista: true });
  const mismos = destino.requisitos.filter(r => esObjeto(r) && esObjectId(r._id) && r._id.equals(ids.requisito_id));
  const ambiguos = destino.requisitos.filter(r => esObjeto(r) && !esObjectId(r._id) && r._id != null && String(r._id) === ids.requisito_hex).length;
  if (mismos.length > 1 || (mismos.length === 1 && ambiguos > 0)) return conflicto('identidad_requisito_cambio', 'requisito_id_duplicado', { cantidad: mismos.length + ambiguos });
  if (mismos.length === 0) return conflicto('identidad_requisito_cambio', 'requisito_id_no_encontrado', { sin_object_id: destino.requisitos.filter(r => !esObjectId(r?._id)).length });
  const requisito = mismos[0];
  const desconocidas = Object.keys(requisito).filter(k => !CLAVES_REQUISITO_CONOCIDAS.includes(k)).sort();
  if (desconocidas.length) return conflicto('valor_actual_cambio', 'claves_desconocidas', { claves: desconocidas });
  let actual;
  try { actual = capturarIdentidadEInstantanea(requisito); }
  catch { return conflicto('valor_actual_cambio', 'valor_no_capturable'); }
  if (canonico(actual.identidad_requisito) !== canonico(payload.identidad_requisito)) return conflicto('identidad_requisito_cambio', 'identidad_semantica_no_coincide');
  const distintos = CAMPOS_INSTANTANEA.filter(c => canonico(actual.instantanea_anterior[c]) !== canonico(payload.instantanea_anterior[c]));
  if (distintos.length) return conflicto('valor_actual_cambio', 'instantanea_no_coincide', { campos: distintos });
  return { ok: true, requisito };
}

// Pura. Resumen de revalidaciones YA validadas por construirPlan: los textos salen de las
// fuentes del payload aprobado; del llamador solo se toma la fecha, ya verificada como Date.
function resumirRevalidaciones(payload, revalidaciones) {
  return payload.fuentes.map(f => {
    const r = revalidaciones.find(x => x.url === f.url);
    return { url: f.url, fuente_nombre: f.nombre, hechos_hash: f.hechos_hash, revalidada_en: new Date(r.revalidada_en.getTime()) };
  });
}

// Pura. Estado completo que debe quedar en el requisito tras aplicar.
function resultadoEsperado(payload, fecha) {
  const r = aplicarCambiosAInstantanea(payload.instantanea_anterior, payload.cambios);
  return { ...r, fecha_verificacion: { presente: true, bson_tipo: 'string', valor: fecha } };
}

// ------------------------------------------------------------------
// Documentos (provisionales hasta H2)
// ------------------------------------------------------------------

function base(ctx) {
  return {
    propuesta_id: ctx.propuesta_id, version_contrato: VERSION_CONTRATO,
    operador: { ...ctx.operador }, identidad_operador: { ...ctx.identidad_operador }, auditoria: ctx.auditoria,
    aprobacion: ctx.aprobacion, proceso_aplicador: { ...PROCESO_APLICADOR_V2 }, adaptador: { ...ctx.adaptador }
  };
}

// Pura. El inicio 2.0 que corresponde a este intento (InicioIntentoAplicacion con
// version_contrato '2.0'): reserva los tres ids y fija todo el contexto de escritura.
function inicioDesdeCtx(ctx) {
  return {
    version_contrato: VERSION_CONTRATO, intento_id: ctx.intento_id, evento_id: ctx.evento_id, historial_id: ctx.historial_id,
    propuesta_id: ctx.propuesta_id, hash_contenido_referenciado: ctx.hash_esperado, version_coordinacion_esperada: ctx.version_esperada,
    decision_aprobacion_id_esperado: ctx.decision_aprobacion_id_esperado, operador: { ...ctx.operador }, auditoria: ctx.auditoria,
    proceso_aplicador: { ...PROCESO_APLICADOR_V2 }, adaptador: { ...ctx.adaptador }, iniciado_en: new Date(ctx.iniciado_en.getTime())
  };
}

// Pura. Firma que conserva el tipo BSON de cada hoja: un Date no equivale a su texto ISO, un
// ObjectId no equivale a su hex y un número no equivale a su texto. Claves ordenadas (el orden
// de Mongo no importa); undefined no es representable y se rechaza, como en canonico.
function firmaBson(v) {
  if (v === undefined) throw new TypeError('firmaBson: undefined no es un valor BSON.');
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number') return `Number(${String(v)})`;
  if (typeof v !== 'object') return `${typeof v}(${String(v)})`;
  if (v instanceof Date) return `Date(${v.getTime()})`;
  if (esObjectId(v)) return `ObjectId(${v.toHexString()})`;
  if (typeof v._bsontype === 'string') return `${v._bsontype}(${typeof v.toJSON === 'function' ? JSON.stringify(v.toJSON()) : String(v)})`;
  if (Array.isArray(v)) return `[${v.map(firmaBson).join(',')}]`;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return `${v.constructor?.name ?? 'Objeto'}(${String(v)})`;
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${firmaBson(v[k])}`).join(',')}}`;
}
// Registro, verificación previa a escrituras y confirmación del cierre usan esta misma comparación.
const coincideInicio = (leido, esperado) => firmaBson(sinMetadatos(leido)) === firmaBson(esperado);

// Antes de CUALQUIER escritura (con la sesión de la transacción dentro de ella).
async function verificarInicioV2(ctx, session, deps) {
  const leido = await deps.leerInicio(ctx.intento_id, session);
  if (!leido) throw new ErrorInicioV2('inicio_ausente', ctx);
  if (!coincideInicio(leido, ctx.inicio_esperado)) throw new ErrorInicioV2('inicio_discrepante', ctx);
}

function construirIntentoV2(ctx, r) {
  const doc = {
    intento_id: ctx.intento_id, ...base(ctx),
    hash_contenido_referenciado: ctx.hash_esperado, version_coordinacion_esperada: ctx.version_esperada,
    decision_aprobacion_id: ctx.decision_aprobacion_id_esperado,
    iniciado_en: ctx.iniciado_en, finalizado_en: r.finalizado_en, resultado: r.resultado,
    // Solo existe tras validar las revalidaciones; un rechazo temprano no persiste datos del llamador.
    ...(ctx.revalidaciones_resumen ? { revalidaciones: ctx.revalidaciones_resumen } : {})
  };
  for (const campo of ['etapa_fallo', 'resultado_no_registrado', 'historial_id', 'conflicto', 'precondiciones', 'fecha_verificacion', 'error_externo', 'lecturas_fuente']) if (r[campo] !== undefined) doc[campo] = r[campo];
  if (r.error_mensaje !== undefined) doc.error_mensaje = sanearMensaje(r.error_mensaje);
  return doc;
}

function construirHistorialV2(ctx, payload, plan) {
  return {
    historial_id: ctx.historial_id, destino_id: ctx.ids.destino_hex, requisito_id: ctx.ids.requisito_hex,
    version_contrato: VERSION_CONTRATO, campo: CAMPO_EXTERNO,
    cambios: payload.cambios.map(c => ({ campo: c.campo, anterior: { ...payload.instantanea_anterior[c.campo] }, nuevo: { ...c.propuesto } })),
    fecha_verificacion: { anterior: { ...payload.instantanea_anterior.fecha_verificacion }, nueva: { presente: true, bson_tipo: 'string', valor: plan.fecha_verificacion } },
    aplicado_en: ctx.t, propuesta_id: ctx.propuesta_id, decision_aprobacion_id: ctx.decision_aprobacion_id_esperado,
    intento_aplicacion_id: ctx.intento_id
  };
}

function construirEventoV2(ctx, tipoEvento, resultado, motivo) {
  const evento = {
    evento_id: ctx.evento_id, propuesta_id: ctx.propuesta_id, tipo_evento: tipoEvento,
    estado_anterior: 'aprobada', estado_nuevo: TRANSICIONES[tipoEvento].hacia,
    hash_contenido_referenciado: ctx.hash_esperado, version_coordinacion_nueva: ctx.version_esperada + 1,
    ocurrido_en: ctx.t, actor: { ...ACTOR_SISTEMA_V2 },
    // H2.2: aplicador en auditoria (su origen distingue panel de comando; sin auditoria_panel) y
    // aprobador por referencia a su evento, sin copiar identidades del intento.
    detalle: { version_contrato: VERSION_CONTRATO, resultado, auditoria: ctx.auditoria, proceso_aplicador: { ...PROCESO_APLICADOR_V2 },
      adaptador: { ...ctx.adaptador }, decision_aprobacion_id: ctx.decision_aprobacion_id_esperado },
    intento_aplicacion_id: ctx.intento_id
  };
  if (motivo != null) evento.motivo = sanearMensaje(motivo);
  return evento;
}

// ------------------------------------------------------------------
// Relectura y confirmación
// ------------------------------------------------------------------

const sinMetadatos = ({ _id, __v, ...resto }) => resto;
function compararDocumento(diffs, nombre, leido, esperado) {
  if (esperado === null) { if (leido) diffs.push(`${nombre} existe y no debería`); return; }
  if (!leido) { diffs.push(`${nombre} no existe`); return; }
  if (canonico(normalizarBson(sinMetadatos(leido))) !== canonico(normalizarBson(esperado))) diffs.push(`${nombre} distinto del esperado`);
}

// Pura. [] = la escritura del plan quedó confirmada. Exige propuesta, evento,
// intento e historial completos; el requisito con los valores esperados NO basta.
function diferenciasConfirmadaV2(esperado, leido, ids) {
  const diffs = [];
  const p = leido.propuesta, e = esperado.propuesta;
  if (!p) diffs.push('la propuesta no existe');
  else for (const [campo, valor] of Object.entries(e)) {
    const real = campo === 'updatedAt' ? instante(p.updatedAt) : p[campo] ?? null;
    const ideal = campo === 'updatedAt' ? instante(valor) : valor;
    if (real !== ideal) diffs.push(`propuesta.${campo}=${JSON.stringify(real)} (esperado ${JSON.stringify(ideal)})`);
  }
  // H3.1: la confirmación exige también el inicio exacto del mismo intento.
  if (esperado.inicio !== undefined) {
    if (!leido.inicio) diffs.push('inicio no existe');
    else if (!coincideInicio(leido.inicio, esperado.inicio)) diffs.push('inicio distinto del esperado');
  }
  compararDocumento(diffs, 'evento', leido.evento, esperado.evento);
  compararDocumento(diffs, 'intento', leido.intento, esperado.intento);
  compararDocumento(diffs, 'historial', leido.historial, esperado.historial);
  if (esperado.requisito) {
    const mismos = (leido.destino?.requisitos ?? []).filter(r => esObjeto(r) && esObjectId(r._id) && r._id.equals(ids.requisito_id));
    let actual = null;
    try { actual = mismos.length === 1 ? capturarIdentidadEInstantanea(mismos[0]).instantanea_anterior : null; } catch { actual = null; }
    if (!actual) diffs.push('destino: no hay exactamente un requisito válido con el _id esperado');
    else if (canonico(actual) !== canonico(esperado.requisito)) diffs.push('destino: el requisito no tiene el resultado esperado');
    if (instante(leido.destino?.updatedAt) !== instante(esperado.destino_updatedAt)) diffs.push('destino.updatedAt distinto');
  }
  return diffs;
}

async function releer(ctx, deps) {
  const [propuesta, evento, intento, historial, destino, inicio] = await Promise.all([
    deps.leerPropuesta(ctx.propuesta_id, null), deps.leerEvento(ctx.evento_id, null), deps.leerIntento(ctx.intento_id),
    deps.leerHistorial(ctx.historial_id), deps.leerDestino({ _id: ctx.ids.destino_id }, null), deps.leerInicio(ctx.intento_id, null)
  ]);
  return { propuesta, evento, intento, historial, destino, inicio };
}

const esDuplicadoIntento = err => { const d = indiceDuplicado(err); return d !== null && d.coleccion === 'intentos_aplicacion' && d.indice === 'intento_id_1'; };

// Insert independiente de un intento terminado (fuera de transacción).
// E11000 de intento_id con plan: el commit del plan pudo ocurrir → se relee.
async function registrarIndependiente(ctx, doc, deps, plan, errOriginal = null) {
  try { await verificarInicioV2(ctx, null, deps); }
  catch (err) {
    if (err instanceof ErrorInicioV2) throw err;
    throw new ErrorResultadoIncierto(ctx, `no se pudo verificar el inicio antes de registrar ${doc.resultado}.`, errOriginal ?? err, { error_relectura: err });
  }
  try { await deps.insertarIntentoIndependiente(doc); return { doc }; }
  catch (err) {
    if (esDuplicadoIntento(err) && !plan) throw new ErrorInconsistencia(`E11000 al registrar ${doc.resultado}: ya existe otro intento con el intento_id ${ctx.intento_id}.`);
    if (esDuplicadoIntento(err)) {
      let leido;
      try { leido = await releer(ctx, deps); }
      catch (errRelectura) { throw new ErrorResultadoIncierto(ctx, `el registro de ${doc.resultado} chocó con intento_id_1 y falló la relectura.`, err, { error_relectura: errRelectura }); }
      if (diferenciasConfirmadaV2(plan.esperado, leido, ctx.ids).length === 0) return { confirmado: true };
      throw new ErrorInconsistencia(`E11000 al registrar ${doc.resultado} sin que "${plan.nombre}" esté confirmado.`);
    }
    if (err instanceof ErrorInconsistencia || err instanceof ErrorResultadoIncierto) throw err;
    throw new ErrorResultadoIncierto(ctx, `falló el registro independiente de ${doc.resultado} (${err?.message ?? err}).`, errOriginal ?? err, { error_registro: err });
  }
}

function resultado(ctx, r, extra = {}) {
  return { resultado: r, propuesta_id: ctx.propuesta_id, intento_id: ctx.intento_id, evento_id: null, historial_id: null,
    estado_propuesta_nuevo: null, confirmado_por_relectura: false, causa_relectura: null, ...extra };
}

// Valida con los modelos reales antes de abrir la transacción; solo se informan las rutas.
async function validarDocumentos(plan, deps) {
  for (const [validar, doc] of plan.documentos) {
    try { await deps[validar](doc); }
    catch (e) { throw new ErrorInconsistencia(`Documento de auditoría 2.0 inválido (${validar}): ${Object.keys(e?.errors ?? {}).join(', ') || e?.name}.`); }
  }
}

async function escribirConConfirmacionV2(ctx, plan, deps) {
  await validarDocumentos(plan, deps);
  let err;
  try {
    await deps.ejecutarTransaccion(session => plan.cuerpo(session));
    return plan.confirmado(null);
  } catch (e) { err = e; }

  // Lanzados por el callback: la transacción abortó con certeza.
  if (err instanceof ErrorNoAplicableV2 || err instanceof ErrorConflictoV2 || err instanceof ErrorRevalidacionV2 || err instanceof ErrorInicioV2) throw err;
  if (err instanceof ErrorInconsistencia) {
    err.intento_id = ctx.intento_id;
    await registrarIndependiente(ctx, plan.docAbortado('inconsistencia', deps.ahora()), deps, plan, err);
    throw err;
  }

  const casNoCoincide = err instanceof ErrorCasPropuestaV2, duplicado = err?.code === 11000;
  let leido;
  try { leido = await releer(ctx, deps); }
  catch (errRelectura) {
    // No se sabe si hubo commit: no se registra nada más ni se reintenta.
    throw new ErrorResultadoIncierto(ctx, `falló "${plan.nombre}" (${err?.message ?? err}) y también la relectura de confirmación; verificar el evento ${ctx.evento_id}.`, err, { error_relectura: errRelectura });
  }
  if (diferenciasConfirmadaV2(plan.esperado, leido, ctx.ids).length === 0) return plan.confirmado(casNoCoincide ? 'cas_no_coincide' : duplicado ? 'duplicado' : 'error_transaccion');
  if (duplicado) throw new ErrorInconsistencia(`E11000 sin que "${plan.nombre}" esté confirmado.`);
  if (quedoRastroParcial(leido, ctx)) throw new ErrorInconsistencia(`Rastro parcial de "${plan.nombre}" sin confirmación completa.`);
  const fin = deps.ahora();
  if (casNoCoincide) {
    const r = await registrarIndependiente(ctx, construirIntentoV2(ctx, { resultado: 'propuesta_no_aplicable', etapa_fallo: 'escritura_aplicacion', finalizado_en: fin,
      error_mensaje: 'La propuesta cambió entre la etapa 0 y la escritura (CAS sin coincidencia); no se escribió nada.' }), deps, plan);
    if (r.confirmado) return plan.confirmado('duplicado_intento_id');
    return resultado(ctx, 'propuesta_no_aplicable');
  }
  const r = await registrarIndependiente(ctx, plan.docAbortado(codigoErrorExterno(err), fin), deps, plan, err);
  if (r.confirmado) return plan.confirmado('duplicado_intento_id');
  throw new ErrorEscrituraAbortadaV2(ctx, r.doc, err);
}

// ------------------------------------------------------------------
// Planes de escritura
// ------------------------------------------------------------------

async function casPropuesta(ctx, tipoEvento, session, deps) {
  const r = await deps.actualizarPropuestaCas(filtroCasPropuesta(ctx), updateCasPropuesta(tipoEvento, ctx.evento_id, ctx.t), session);
  if (r.matchedCount !== 1) throw new ErrorCasPropuestaV2('la propuesta ya no está como se leyó');
  if (r.modifiedCount !== 1) throw new ErrorInconsistencia(`El CAS de la propuesta encontró el documento pero modifiedCount=${r.modifiedCount}.`);
}

const esperadoPropuesta = (ctx, tipoEvento) => ({
  estado: TRANSICIONES[tipoEvento].hacia, version_coordinacion: ctx.version_esperada + 1, ultimo_evento_id: ctx.evento_id,
  payload_hash: ctx.hash_esperado, decision_aprobacion_id: ctx.decision_aprobacion_id_esperado, updatedAt: ctx.t
});

function planExitoV2(ctx, entrada, revalidaciones, payload, plan, deps) {
  const historial = construirHistorialV2(ctx, payload, plan);
  const intento = construirIntentoV2(ctx, { resultado: 'exito', finalizado_en: ctx.t, historial_id: ctx.historial_id, fecha_verificacion: plan.fecha_verificacion });
  const evento = construirEventoV2(ctx, 'aplicacion', 'exito', null);
  return {
    nombre: 'exito',
    esperado: { inicio: ctx.inicio_esperado, propuesta: esperadoPropuesta(ctx, 'aplicacion'), evento, intento, historial,
      requisito: resultadoEsperado(payload, plan.fecha_verificacion), destino_updatedAt: ctx.t },
    documentos: [['validarHistorial', historial], ['validarIntento', intento], ['validarEvento', evento]],
    cuerpo: async session => {
      await verificarInicioV2(ctx, session, deps);
      // Relectura y validación completas dentro de la transacción.
      const p = await deps.leerPropuesta(ctx.propuesta_id, session);
      if (!p) throw new ErrorNoAplicableV2([{ codigo: 'propuesta_inexistente', detalle: {} }]);
      const ev = typeof p.decision_aprobacion_id === 'string' ? await deps.leerEvento(p.decision_aprobacion_id, session) : null;
      const fallas = verificarPrecondicionesV2(entrada, p, ev);
      if (fallas.length) throw new ErrorNoAplicableV2(fallas);
      const vigente = planDesdePropuesta(p, revalidaciones, ctx.t);
      if (canonico(normalizarBson(vigente.plan)) !== canonico(normalizarBson(plan))) throw new ErrorInconsistencia('El plan reconstruido dentro de la transacción difiere del de la etapa 0.');
      await casPropuesta(ctx, 'aplicacion', session, deps);
      const destino = await deps.leerDestino({ _id: ctx.ids.destino_id }, session);
      const c = clasificarRequisitoV2(destino, ctx.ids, payload);
      if (!c.ok) throw new ErrorConflictoV2(c);
      const r = await deps.actualizarDestino(plan.filtro, plan.update, plan.opciones, session);
      if (r?.matchedCount !== 1 || r?.modifiedCount !== 1) {
        throw new ErrorInconsistencia(`El requisito cumplía la precondición en memoria pero el update devolvió matchedCount=${r?.matchedCount} modifiedCount=${r?.modifiedCount}.`);
      }
      // Copias: el driver agrega _id a lo insertado y el callback puede reintentarse.
      await deps.insertarHistorial(structuredClone(historial), session);
      await deps.insertarIntento(structuredClone(intento), session);
      await deps.insertarEvento(structuredClone(evento), session);
    },
    confirmado: causa => resultado(ctx, 'exito', { evento_id: ctx.evento_id, historial_id: ctx.historial_id, estado_propuesta_nuevo: 'aplicada',
      fecha_verificacion: plan.fecha_verificacion, confirmado_por_relectura: causa !== null, causa_relectura: causa }),
    docAbortado: (codigo, fin) => construirIntentoV2(ctx, { resultado: 'escritura_abortada', etapa_fallo: 'escritura_aplicacion', finalizado_en: fin, error_externo: codigo, error_mensaje: MENSAJE_ABORTADA })
  };
}

function planConflictoV2(ctx, clasificacion, deps) {
  const tipoEvento = TRANSICION_POR_RESULTADO[clasificacion.resultado];
  const conflicto = { categoria: clasificacion.categoria, detalle: clasificacion.detalle };
  const motivo = `El requisito ya no coincide con lo aprobado (${clasificacion.categoria}); no se escribe en destinos.`;
  const intento = construirIntentoV2(ctx, { resultado: clasificacion.resultado, etapa_fallo: 'escritura_aplicacion', finalizado_en: ctx.t, conflicto, error_mensaje: motivo });
  const evento = construirEventoV2(ctx, tipoEvento, clasificacion.resultado, motivo);
  return {
    nombre: clasificacion.resultado,
    esperado: { inicio: ctx.inicio_esperado, propuesta: esperadoPropuesta(ctx, tipoEvento), evento, intento, historial: null, requisito: null },
    documentos: [['validarIntento', intento], ['validarEvento', evento]],
    cuerpo: async session => {
      await verificarInicioV2(ctx, session, deps);
      await casPropuesta(ctx, tipoEvento, session, deps);
      await deps.insertarIntento(structuredClone(intento), session);
      await deps.insertarEvento(structuredClone(evento), session);
    },
    confirmado: causa => resultado(ctx, clasificacion.resultado, { evento_id: ctx.evento_id, estado_propuesta_nuevo: TRANSICIONES[tipoEvento].hacia,
      conflicto, confirmado_por_relectura: causa !== null, causa_relectura: causa }),
    docAbortado: (codigo, fin) => construirIntentoV2(ctx, { resultado: 'escritura_abortada', etapa_fallo: 'transicion_por_fallo', resultado_no_registrado: clasificacion.resultado,
      finalizado_en: fin, error_externo: codigo, error_mensaje: MENSAJE_ABORTADA, conflicto })
  };
}

// ------------------------------------------------------------------
// Servicio
// ------------------------------------------------------------------

/**
 * entrada: los 5 campos del 1.0 (nunca payload ni identidades).
 * contexto.auditoria: resuelta por la capa autenticada (H3); aquí solo se valida su forma.
 * contexto.intento: { intento_id, evento_id, historial_id, iniciado_en } generados UNA vez por
 *   el llamador, que ya persistió su inicio (registrarInicioV2) antes de consultar fuentes.
 * contexto.revalidaciones: producidas por el adaptador 2.0 (H3) ANTES de llamar.
 */
// Pura. Valida el contexto interno y devuelve copias defensivas (antes de cualquier await).
function validarContextoV2(entrada, contexto) {
  if (!esObjeto(contexto) || Object.keys(contexto).sort().join(',') !== 'adaptador,auditoria,intento,revalidaciones') {
    throw new ErrorEntradaInvalida('aplicarPropuestaV2: contexto debe tener solo adaptador, auditoria, intento y revalidaciones.');
  }
  // Interno: la selección autenticada del adaptador real es de H3; aquí no hay default.
  const a = contexto.adaptador;
  if (!esObjeto(a) || Object.keys(a).sort().join(',') !== 'nombre,version' || !NOMBRE_TECNICO.test(a.nombre) || !NOMBRE_TECNICO.test(a.version)) {
    throw new ErrorEntradaInvalida('aplicarPropuestaV2: adaptador inválido.');
  }
  let auditoria;
  try { auditoria = validarAuditoria(contexto.auditoria, entrada); }
  catch { throw new ErrorEntradaInvalida('aplicarPropuestaV2: auditoría inválida.'); }
  // Los ids e iniciado_en los fija el llamador una sola vez: nunca se regeneran ni tienen default.
  const i = contexto.intento;
  if (!esObjeto(i) || Object.getPrototypeOf(i) !== Object.prototype || Object.keys(i).sort().join(',') !== 'evento_id,historial_id,iniciado_en,intento_id') {
    throw new ErrorEntradaInvalida('aplicarPropuestaV2: intento debe tener solo intento_id, evento_id, historial_id e iniciado_en.');
  }
  const ids = [i.intento_id, i.evento_id, i.historial_id];
  if (!ids.every(u => typeof u === 'string' && UUID.test(u)) || new Set(ids).size !== 3) throw new ErrorEntradaInvalida('aplicarPropuestaV2: intento con UUIDs inválidos o repetidos.');
  if (!(i.iniciado_en instanceof Date) || Number.isNaN(i.iniciado_en.getTime())) throw new ErrorEntradaInvalida('aplicarPropuestaV2: intento.iniciado_en inválido.');
  return {
    adaptador: { nombre: a.nombre, version: a.version }, auditoria, revalidaciones: contexto.revalidaciones,
    intento: Object.freeze({ intento_id: ids[0], evento_id: ids[1], historial_id: ids[2], iniciado_en: new Date(i.iniciado_en.getTime()) })
  };
}

// Pura. Inicio 2.0 que el llamador debe persistir con registrarInicioV2 antes de consultar fuentes.
function construirInicioV2(entrada, contexto) {
  validarEntrada(entrada);
  const c = validarContextoV2(entrada, contexto);
  return inicioDesdeCtx({
    propuesta_id: entrada.propuesta_id, hash_esperado: entrada.payload_hash_esperado, version_esperada: entrada.version_coordinacion_esperada,
    decision_aprobacion_id_esperado: entrada.decision_aprobacion_id_esperado, ...c.intento, auditoria: c.auditoria,
    operador: { tipo: 'humano', identificador: c.auditoria.operador }, adaptador: c.adaptador
  });
}

const esDuplicadoInicio = err => { const d = indiceDuplicado(err); return d !== null && d.coleccion === 'inicios_intento_aplicacion' && d.indice === 'intento_id_1'; };

/**
 * Inserta el inicio (independiente, majority) y solo lo da por confirmado si se insertó o si
 * la relectura encuentra EXACTAMENTE el mismo documento. Un E11000 por sí solo no confirma:
 * otro inicio con ese id es inconsistencia; sin poder releer o sin encontrarlo, incertidumbre.
 * Nunca sobrescribe, genera otro id ni reintenta.
 */
async function registrarInicioV2(inicio, deps) {
  try { await deps.validarInicio(inicio); }
  catch (e) { throw new ErrorEntradaInvalida(`registrarInicioV2: inicio inválido (${Object.keys(e?.errors ?? {}).join(', ') || e?.name}).`); }
  let errInsertar;
  try { await deps.insertarInicio(structuredClone(inicio)); return { confirmado: true, causa_relectura: null }; }
  catch (e) { errInsertar = e; }
  let leido;
  try { leido = await deps.leerInicio(inicio.intento_id, null); }
  catch (errRelectura) { throw new ErrorInicioInciertoV2(inicio, errInsertar, { error_relectura: errRelectura }); }
  if (leido && coincideInicio(leido, inicio)) return { confirmado: true, causa_relectura: esDuplicadoInicio(errInsertar) ? 'duplicado' : 'error_insercion' };
  if (leido) throw new ErrorInconsistencia(`registrarInicioV2: ya existe otro inicio con el intento_id ${inicio.intento_id}; no se sobrescribe.`);
  throw new ErrorInicioInciertoV2(inicio, errInsertar);
}

async function aplicarPropuestaV2(entrada, contexto, deps) {
  validarEntrada(entrada);
  const { adaptador: a, auditoria, revalidaciones, intento } = validarContextoV2(entrada, contexto);
  await deps.verificarIndices();

  // ---- Etapa 0, solo lectura, fuera de la transacción ----
  const propuesta = await deps.leerPropuesta(entrada.propuesta_id, null);
  if (!propuesta) throw new ErrorPropuestaNoEncontrada(`aplicarPropuestaV2: no existe la propuesta ${entrada.propuesta_id}. No se escribe nada.`);
  const ids = convertirIdsDestino(propuesta);
  const evento = typeof propuesta.decision_aprobacion_id === 'string' ? await deps.leerEvento(propuesta.decision_aprobacion_id, null) : null;
  const t = deps.ahora();
  const ctx = {
    propuesta_id: entrada.propuesta_id, hash_esperado: entrada.payload_hash_esperado, version_esperada: entrada.version_coordinacion_esperada,
    decision_aprobacion_id_esperado: entrada.decision_aprobacion_id_esperado,
    intento_id: intento.intento_id, evento_id: intento.evento_id, historial_id: intento.historial_id, iniciado_en: intento.iniciado_en, t, ids, auditoria,
    operador: { tipo: 'humano', identificador: auditoria.operador }, identidad_operador: { ...auditoria.identidad },
    adaptador: { nombre: a.nombre, version: a.version },
    // Aprobador y aplicador se conservan por separado aunque sean la misma persona.
    aprobacion: evento ? { evento_id: evento.evento_id ?? null, actor: { ...(evento.actor ?? {}) },
      identidad_operador: esObjeto(evento.detalle?.identidad_operador) ? { ...evento.detalle.identidad_operador } : null,
      ocurrido_en: evento.ocurrido_en ?? null } : null,
    revalidaciones_resumen: null
  };
  ctx.inicio_esperado = inicioDesdeCtx(ctx);
  // Antes de cualquier escritura, incluido el rechazo temprano: sin el inicio exacto no se sigue.
  await verificarInicioV2(ctx, null, deps);
  const fallas = verificarPrecondicionesV2(entrada, propuesta, evento);
  let construido;
  if (!fallas.length) {
    try { construido = planDesdePropuesta(propuesta, revalidaciones, t); }
    catch (err) { if (err instanceof ErrorNoAplicableV2) fallas.push(...err.fallas); else throw err; }
  }
  if (fallas.length) return registrarNoAplicable(ctx, fallas, 'precondiciones_propuesta', deps);
  ctx.revalidaciones_resumen = resumirRevalidaciones(construido.payload, revalidaciones);

  try {
    return await escribirConConfirmacionV2(ctx, planExitoV2(ctx, entrada, revalidaciones, construido.payload, construido.plan, deps), deps);
  } catch (err) {
    if (err instanceof ErrorNoAplicableV2) return registrarNoAplicable(ctx, err.fallas, 'escritura_aplicacion', deps);
    if (err instanceof ErrorConflictoV2) return escribirConConfirmacionV2(ctx, planConflictoV2(ctx, err.clasificacion, deps), deps);
    if (err instanceof Error && Object.isExtensible(err) && !err.intento_id) err.intento_id = ctx.intento_id;
    throw err;
  }
}

async function registrarNoAplicable(ctx, fallas, etapa, deps) {
  const doc = construirIntentoV2(ctx, { resultado: 'propuesta_no_aplicable', etapa_fallo: etapa, finalizado_en: deps.ahora(), precondiciones: fallas,
    error_mensaje: `La propuesta no es aplicable (${fallas.map(f => f.codigo).join(', ')}); no se escribe en destinos.` });
  await registrarIndependiente(ctx, doc, deps, null);
  return resultado(ctx, 'propuesta_no_aplicable', { fallas: fallas.map(f => f.codigo) });
}

// Lectura y escritura de destinos SIN casting: recibe Destino.collection
// (colección nativa), nunca el modelo. El esquema declara fecha_verificacion
// como Date y castearía el string YYYY-MM-DD.
function dependenciasDestino(coleccion) {
  // Un modelo Mongoose es una función con schema; Destino.collection es un objeto sin schema.
  if (!coleccion || typeof coleccion !== 'object' || coleccion.schema !== undefined || typeof coleccion.updateOne !== 'function' || typeof coleccion.collectionName !== 'string') {
    throw new TypeError('dependenciasDestino: se exige la colección nativa (Destino.collection), no el modelo.');
  }
  return {
    leerDestino: (filtro, session) => coleccion.findOne(filtro, session ? { session } : {}),
    actualizarDestino: (filtro, update, opciones, session) => coleccion.updateOne(filtro, update, { ...opciones, ...(session ? { session } : {}) })
  };
}

module.exports = {
  PROCESO_APLICADOR_V2, ACTOR_SISTEMA_V2, ErrorRevalidacionV2, ErrorEscrituraAbortadaV2, ErrorInicioV2, ErrorInicioInciertoV2,
  construirInicioV2, registrarInicioV2,
  verificarIndicesV2, verificarPrecondicionesV2, clasificarRequisitoV2, resultadoEsperado, diferenciasConfirmadaV2,
  construirIntentoV2, construirHistorialV2, construirEventoV2, dependenciasDestino, aplicarPropuestaV2,
  INDICE_TRANSVERSAL,
  // H3.3: piezas internas que reutiliza registrar-revalidacion-v2.js (mismo inicio, CAS,
  // confirmación por relectura y registro independiente). No son API pública.
  interno: Object.freeze({ MENSAJE_ABORTADA, validarContextoV2, inicioDesdeCtx, verificarInicioV2, sobreGuardado, casPropuesta,
    esperadoPropuesta, escribirConConfirmacionV2, registrarIndependiente, registrarNoAplicable, validarDocumentos, resultado })
};
