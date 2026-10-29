/**
 * H1 — Servicio AISLADO de aplicación 2.0 (requisito completo). NO es un flujo
 * operativo: no está conectado a rutas, CLI ni panel, y el registro 2.0 sigue
 * cerrado. Sigue el patrón revisado del 1.0 (aplicar-propuesta.js), que no se
 * modifica: entrada cerrada, precondiciones contra la propuesta GUARDADA, una
 * transacción con CAS de la propuesta + escritura nativa del destino +
 * auditoría, y relectura ante error o respuesta incierta.
 *
 * Fuera de H1 (dependencias explícitas, no simuladas aquí):
 *  - H2: esquemas/modelos de intento e historial 2.0. Los documentos que se
 *    construyen aquí son provisionales; los persistidores se INYECTAN y
 *    comparten la sesión de la transacción.
 *  - H3: autenticación y permiso del operador (panel: token + permiso
 *    'aplicar'; CLI: connectionStatus + allowlist), InicioIntento persistido
 *    antes de revalidar, adaptador 2.0 que produce `revalidaciones` y el
 *    registro de intentos por revalidación vencida o fuente cambiada.
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
// Centinelas internos: el callback los lanza y la transacción aborta con certeza.
class ErrorNoAplicableV2 extends Error { constructor(fallas) { super('propuesta_no_aplicable'); this.fallas = fallas; } }
class ErrorConflictoV2 extends Error { constructor(c) { super(c.resultado); this.clasificacion = c; } }
class ErrorCasPropuestaV2 extends Error {}

const esObjeto = v => v !== null && typeof v === 'object' && !Array.isArray(v);
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
    aprobacion: ctx.aprobacion, proceso_aplicador: { ...PROCESO_APLICADOR_V2 }
  };
}

function construirIntentoV2(ctx, r) {
  const doc = {
    intento_id: ctx.intento_id, ...base(ctx),
    hash_contenido_referenciado: ctx.hash_esperado, version_coordinacion_esperada: ctx.version_esperada,
    decision_aprobacion_id: ctx.decision_aprobacion_id_esperado,
    iniciado_en: ctx.iniciado_en, finalizado_en: r.finalizado_en, resultado: r.resultado,
    revalidaciones: ctx.revalidaciones_resumen
  };
  for (const campo of ['etapa_fallo', 'historial_id', 'conflicto', 'precondiciones', 'fecha_verificacion']) if (r[campo] !== undefined) doc[campo] = r[campo];
  if (r.error_mensaje !== undefined) doc.error_mensaje = sanearMensaje(r.error_mensaje);
  return doc;
}

function construirHistorialV2(ctx, payload, plan) {
  return {
    historial_id: ctx.historial_id, destino_id: ctx.ids.destino_hex, requisito_id: ctx.ids.requisito_hex,
    version_contrato: VERSION_CONTRATO,
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
    detalle: { resultado, ...base(ctx) },
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
  const [propuesta, evento, intento, historial, destino] = await Promise.all([
    deps.leerPropuesta(ctx.propuesta_id, null), deps.leerEvento(ctx.evento_id, null), deps.leerIntento(ctx.intento_id),
    deps.leerHistorial(ctx.historial_id), deps.leerDestino({ _id: ctx.ids.destino_id }, null)
  ]);
  return { propuesta, evento, intento, historial, destino };
}

const esDuplicadoIntento = err => { const d = indiceDuplicado(err); return d !== null && d.coleccion === 'intentos_aplicacion' && d.indice === 'intento_id_1'; };

// Insert independiente de un intento terminado (fuera de transacción).
// E11000 de intento_id con plan: el commit del plan pudo ocurrir → se relee.
async function registrarIndependiente(ctx, doc, deps, plan, errOriginal = null) {
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

async function escribirConConfirmacionV2(ctx, plan, deps) {
  let err;
  try {
    await deps.ejecutarTransaccion(session => plan.cuerpo(session));
    return plan.confirmado(null);
  } catch (e) { err = e; }

  // Lanzados por el callback: la transacción abortó con certeza.
  if (err instanceof ErrorNoAplicableV2 || err instanceof ErrorConflictoV2 || err instanceof ErrorRevalidacionV2) throw err;
  if (err instanceof ErrorInconsistencia) {
    err.intento_id = ctx.intento_id;
    await registrarIndependiente(ctx, plan.docAbortado(`Inconsistencia: ${err.message}`, deps.ahora()), deps, plan, err);
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
  const r = await registrarIndependiente(ctx, plan.docAbortado(`La transacción falló y no quedó nada escrito: ${err?.message ?? err}`, fin), deps, plan, err);
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
    esperado: { propuesta: esperadoPropuesta(ctx, 'aplicacion'), evento, intento, historial,
      requisito: resultadoEsperado(payload, plan.fecha_verificacion), destino_updatedAt: ctx.t },
    cuerpo: async session => {
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
    docAbortado: (mensaje, fin) => construirIntentoV2(ctx, { resultado: 'escritura_abortada', etapa_fallo: 'escritura_aplicacion', finalizado_en: fin, error_mensaje: mensaje })
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
    esperado: { propuesta: esperadoPropuesta(ctx, tipoEvento), evento, intento, historial: null, requisito: null },
    cuerpo: async session => {
      await casPropuesta(ctx, tipoEvento, session, deps);
      await deps.insertarIntento(structuredClone(intento), session);
      await deps.insertarEvento(structuredClone(evento), session);
    },
    confirmado: causa => resultado(ctx, clasificacion.resultado, { evento_id: ctx.evento_id, estado_propuesta_nuevo: TRANSICIONES[tipoEvento].hacia,
      conflicto, confirmado_por_relectura: causa !== null, causa_relectura: causa }),
    docAbortado: (mensaje, fin) => construirIntentoV2(ctx, { resultado: 'escritura_abortada', etapa_fallo: 'transicion_por_fallo', finalizado_en: fin, error_mensaje: mensaje, conflicto })
  };
}

// ------------------------------------------------------------------
// Servicio
// ------------------------------------------------------------------

/**
 * entrada: los 5 campos del 1.0 (nunca payload ni identidades).
 * contexto.auditoria: resuelta por la capa autenticada (H3); aquí solo se valida su forma.
 * contexto.revalidaciones: producidas por el adaptador 2.0 (H3) ANTES de llamar.
 */
async function aplicarPropuestaV2(entrada, contexto, deps) {
  validarEntrada(entrada);
  if (!esObjeto(contexto) || Object.keys(contexto).sort().join(',') !== 'auditoria,revalidaciones') throw new ErrorEntradaInvalida('aplicarPropuestaV2: contexto debe tener solo auditoria y revalidaciones.');
  let auditoria;
  try { auditoria = validarAuditoria(contexto.auditoria, entrada); }
  catch { throw new ErrorEntradaInvalida('aplicarPropuestaV2: auditoría inválida.'); }
  const revalidaciones = contexto.revalidaciones;
  await deps.verificarIndices();

  // Una sola vez: todo reintento reutiliza exactamente estos valores.
  const generados = [deps.uuid(), deps.uuid(), deps.uuid()];
  if (!generados.every(u => typeof u === 'string' && UUID.test(u)) || new Set(generados).size !== 3) throw new Error('deps.uuid() no devolvió UUIDs distintos.');
  const iniciadoEn = deps.ahora();

  // ---- Etapa 0, solo lectura, fuera de la transacción ----
  const propuesta = await deps.leerPropuesta(entrada.propuesta_id, null);
  if (!propuesta) throw new ErrorPropuestaNoEncontrada(`aplicarPropuestaV2: no existe la propuesta ${entrada.propuesta_id}. No se escribe nada.`);
  const ids = convertirIdsDestino(propuesta);
  const evento = typeof propuesta.decision_aprobacion_id === 'string' ? await deps.leerEvento(propuesta.decision_aprobacion_id, null) : null;
  const t = deps.ahora();
  const ctx = {
    propuesta_id: entrada.propuesta_id, hash_esperado: entrada.payload_hash_esperado, version_esperada: entrada.version_coordinacion_esperada,
    decision_aprobacion_id_esperado: entrada.decision_aprobacion_id_esperado,
    intento_id: generados[0], evento_id: generados[1], historial_id: generados[2], iniciado_en: iniciadoEn, t, ids, auditoria,
    operador: { tipo: 'humano', identificador: auditoria.operador }, identidad_operador: { ...auditoria.identidad },
    // Aprobador y aplicador se conservan por separado aunque sean la misma persona.
    aprobacion: evento ? { evento_id: evento.evento_id ?? null, actor: { ...(evento.actor ?? {}) },
      identidad_operador: esObjeto(evento.detalle?.identidad_operador) ? { ...evento.detalle.identidad_operador } : null,
      ocurrido_en: evento.ocurrido_en ?? null } : null,
    revalidaciones_resumen: Array.isArray(revalidaciones) ? revalidaciones.map(r => ({ url: r?.url ?? null, fuente_nombre: r?.fuente_nombre ?? null,
      revalidada_en: r?.revalidada_en ?? null, algoritmo_hechos_hash: r?.algoritmo_hechos_hash ?? null })) : []
  };
  const fallas = verificarPrecondicionesV2(entrada, propuesta, evento);
  let construido;
  if (!fallas.length) {
    try { construido = planDesdePropuesta(propuesta, revalidaciones, t); }
    catch (err) { if (err instanceof ErrorNoAplicableV2) fallas.push(...err.fallas); else throw err; }
  }
  if (fallas.length) return registrarNoAplicable(ctx, fallas, 'precondiciones_propuesta', deps);

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
  PROCESO_APLICADOR_V2, ACTOR_SISTEMA_V2, ErrorRevalidacionV2, ErrorEscrituraAbortadaV2,
  verificarIndicesV2, verificarPrecondicionesV2, clasificarRequisitoV2, resultadoEsperado, diferenciasConfirmadaV2,
  construirIntentoV2, construirHistorialV2, construirEventoV2, dependenciasDestino, aplicarPropuestaV2,
  INDICE_TRANSVERSAL
};
