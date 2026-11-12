/**
 * H3.3 — Flujo interno de aplicación 2.0 con revalidación externa (sin HTTP, CLI ni panel).
 * Conecta el adaptador 2.0 (adaptadores/v2) con el núcleo (aplicar-propuesta-v2.js) y con el
 * registro de resultados de revalidación (registrar-revalidacion-v2.js).
 *
 * Orden (cada paso solo si el anterior terminó):
 *  1. Entrada cerrada del 1.0 y PERMISO del aplicador, resuelto en el servidor desde la credencial:
 *     panel = operador resuelto (resolverOperadorPanel) con permiso 'aplicar' y request_id;
 *     comando = usuarios de connectionStatus contra la allowlist (resolverActor). Sin permiso no se
 *     lee ni se escribe nada.
 *  2. Índices, propuesta y ADAPTADOR elegido en el servidor (elegirAdaptadorV2). Incompatible →
 *     se devuelve su código cerrado sin consultar la fuente ni escribir nada (sin adaptador no hay
 *     intento que registrar).
 *  3. Aprobación vigente (precondiciones del núcleo) y payload 2.0 válido.
 *  4. Inicio durable: construirInicioV2 + registrarInicioV2, confirmado ANTES de la primera
 *     consulta. El mismo intento (ids e iniciado_en) se usa hasta el cierre. Si la aprobación no
 *     está vigente, el núcleo cierra el intento como propuesta_no_aplicable sin consultar la fuente.
 *  5. Primera lectura (una invocación del adaptador = una consulta):
 *     - no_disponible → fuente_temporalmente_no_disponible (propuesta sigue aprobada);
 *     - ambiguo → extraccion_ambigua (revision_requerida), con los campos sin confirmar;
 *     - hechos iguales a los aprobados → el núcleo existente aplica (CAS, transacción y
 *       confirmación por relectura). Si la revalidación vence antes de escribir, revalidacion_vencida;
 *     - hechos distintos → segunda lectura.
 *  6. Segunda lectura: solo si devuelve los MISMOS hechos nuevos se registra fuente_cambio (y el
 *     registro exige que las dos sigan vigentes). Si falla → fuente_temporalmente_no_disponible;
 *     si es ambigua o da otros hechos (incluidos los aprobados) → extraccion_ambigua
 *     (cambio no confirmado, revisión humana). Nunca se escribe en destinos.
 *
 * El hash del HTML (contenido_sha256) se guarda en cada lectura solo como diagnóstico.
 */
const { validarEntrada, ErrorPropuestaNoEncontrada, ErrorInconsistencia } = require('./aplicar-propuesta');
const { validarAuditoria } = require('./auditoria-aplicacion');
const { resolverActor } = require('./operadores-autorizados');
const { COMANDO_PANEL } = require('../panel/operadores-panel');
const { validarSobreRequisitoV2 } = require('./payload-requisito-v2');
const { verificarRevalidaciones } = require('./plan-aplicacion-requisito-v2');
const V2 = require('./aplicar-propuesta-v2');
const { registrarRevalidacionV2 } = require('./registrar-revalidacion-v2');
const { ADAPTADORES_V2, elegirAdaptadorV2, ErrorSinAdaptadorV2 } = require('./adaptadores/v2');

class ErrorPermisoAplicacionV2 extends Error {
  constructor(codigo) { super(`aplicación 2.0: sin permiso para aplicar (${codigo}); no se lee ni se escribe nada.`); this.codigo = codigo; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CODIGOS_FALLO = ['red', 'tiempo_agotado', 'http', 'redireccion_fuera_del_sitio', 'redireccion_sin_destino', 'demasiadas_redirecciones', 'no_html', 'cuerpo_ilegible', 'demasiado_grande'];
const esObjeto = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// Permiso y auditoría resueltos en el servidor. Nunca se toman identidades del cuerpo.
function resolverAuditoria(credencial, entrada) {
  if (!esObjeto(credencial)) throw new ErrorPermisoAplicacionV2('credencial_ausente');
  if (credencial.origen === 'panel') {
    const op = credencial.operador;
    if (!esObjeto(op) || !Array.isArray(op.permisos) || !op.permisos.includes('aplicar')) throw new ErrorPermisoAplicacionV2('permiso_ausente');
    if (typeof op.identificador !== 'string' || !esObjeto(op.identidad_operador) || typeof credencial.request_id !== 'string' || !UUID.test(credencial.request_id)) {
      throw new ErrorPermisoAplicacionV2('identidad_incompleta');
    }
    try {
      return validarAuditoria({ origen: 'panel', request_id: credencial.request_id, operador: op.identificador,
        identidad: { metodo: op.identidad_operador.metodo, sub: op.identidad_operador.sub }, comando: { ...COMANDO_PANEL }, instantanea: { ...entrada } }, entrada, true);
    } catch { throw new ErrorPermisoAplicacionV2('identidad_incompleta'); }
  }
  if (credencial.origen === 'comando_administrativo') {
    // La allowlist del comando es el permiso (como en el 1.0): resolverActor lanza si no está.
    const { actor, identidad_operador: id } = resolverActor(credencial.usuarios_autenticados, credencial.operadores_autorizados);
    return validarAuditoria({ origen: 'comando_administrativo', operador: actor.identificador,
      identidad: { metodo: 'connection_status', usuario_atlas: id.usuario_atlas, db_autenticacion: id.db_autenticacion },
      comando: { nombre: 'aplicar-propuesta', version: '1' } }, entrada);
  }
  throw new ErrorPermisoAplicacionV2('origen_desconocido');
}

// Pura. Resultado del adaptador → lectura persistible (códigos cerrados, sin HTML ni error crudo).
function lecturaDesdeResultado(r, orden) {
  const consultado = new Date(r?.diagnostico?.consultado_en);
  const base = { orden, tipo: r.tipo, url: r.url, fuente_nombre: r.fuente_nombre, consultado_en: consultado };
  if (r.tipo === 'no_disponible') {
    const motivo = String(r.motivo);
    const codigo = motivo.startsWith('red:') ? 'red' : /^http_\d{3}$/.test(motivo) ? 'http' : motivo;
    if (!CODIGOS_FALLO.includes(codigo)) throw new ErrorInconsistencia('aplicación 2.0: el adaptador devolvió un fallo fuera de la lista cerrada.');
    const status = r.diagnostico?.http_status;
    return { ...base, codigo_fallo: codigo, ...(Number.isInteger(status) ? { http_status: status } : {}) };
  }
  const conRespuesta = { ...base, revalidada_en: new Date(r.revalidada_en.getTime()),
    ...(typeof r.diagnostico?.contenido_sha256 === 'string' ? { contenido_sha256: r.diagnostico.contenido_sha256 } : {}) };
  if (r.tipo === 'hechos') {
    return { ...conRespuesta, hechos_hash: r.hechos_hash, evidencia: Object.fromEntries(Object.entries(r.evidencia).map(([k, v]) => [k, [...v]])) };
  }
  if (r.tipo === 'ambiguo') {
    const campos = Object.entries(r.campos);
    return { ...conRespuesta,
      campos_sin_confirmar: campos.filter(([, c]) => c.estado !== 'ok').map(([campo, c]) => ({ campo, motivo: String(c.motivo).split(':')[0] })),
      evidencia: Object.fromEntries(campos.map(([k, c]) => [k, [...c.evidencia]])) };
  }
  throw new ErrorInconsistencia('aplicación 2.0: el adaptador devolvió un tipo fuera de contrato.');
}

const describirAmbiguo = l => l.campos_sin_confirmar.map(c => `${c.campo}:${c.motivo}`).join(',');

// Pura. ¿La lectura con hechos coincide con lo aprobado? Usa el único punto de comparación
// (verificarRevalidaciones). Con t = revalidada_en la ventana no interviene.
function coincideConAprobado(payload, proyectada) {
  try { verificarRevalidaciones(payload, [proyectada], proyectada.revalidada_en); return true; }
  catch (e) { if (e?.message === 'fuente_cambio') return false; throw e; }
}

async function aplicarConRevalidacionV2(entrada, credencial, deps) {
  validarEntrada(entrada);
  const auditoria = resolverAuditoria(credencial, entrada);
  await deps.verificarIndices();

  const propuesta = await deps.leerPropuesta(entrada.propuesta_id, null);
  if (!propuesta) throw new ErrorPropuestaNoEncontrada(`aplicación 2.0: no existe la propuesta ${entrada.propuesta_id}. No se escribe nada.`);
  let adaptador;
  try { adaptador = elegirAdaptadorV2(propuesta, deps.adaptadores ?? ADAPTADORES_V2); }
  catch (e) {
    if (!(e instanceof ErrorSinAdaptadorV2)) throw e;
    // Sin adaptador único no hay intento: nada se consulta ni se escribe.
    return { resultado: 'adaptador_incompatible', propuesta_id: entrada.propuesta_id, intento_id: null, lecturas: 0,
      codigo: e.incompatibilidades.length === 1 ? e.incompatibilidades[0].codigo : 'sin_adaptador_unico', incompatibilidades: e.incompatibilidades };
  }

  const evento = typeof propuesta.decision_aprobacion_id === 'string' ? await deps.leerEvento(propuesta.decision_aprobacion_id, null) : null;
  const aplicable = V2.verificarPrecondicionesV2(entrada, propuesta, evento).length === 0;
  let payload = null;
  if (aplicable) { try { payload = validarSobreRequisitoV2(V2.interno.sobreGuardado(propuesta)).payload; } catch { payload = null; } }

  // Un solo intento: ids e iniciado_en fijos hasta el cierre.
  const intento = Object.freeze({ intento_id: deps.uuid(), evento_id: deps.uuid(), historial_id: deps.uuid(), iniciado_en: deps.ahora() });
  const nombreVersion = { nombre: adaptador.nombre, version: adaptador.version };
  const contextoNucleo = revalidaciones => ({ adaptador: { ...nombreVersion }, auditoria, intento, revalidaciones });
  const contextoRegistro = () => ({ adaptador: { ...nombreVersion }, auditoria, intento });
  await V2.registrarInicioV2(V2.construirInicioV2(entrada, contextoNucleo([])), deps);

  // Aprobación no vigente o payload inválido: el núcleo cierra el intento sin consultar la fuente.
  if (!aplicable || !payload) return { ...(await V2.aplicarPropuestaV2(entrada, contextoNucleo([]), deps)), lecturas: 0 };

  const leer = () => adaptador.revalidar(propuesta, { fetch: deps.fetch, ahora: deps.ahora });
  const registrar = async (resultado, lecturas, motivo) => ({
    ...(await registrarRevalidacionV2(entrada, contextoRegistro(), { resultado, lecturas, motivo }, deps)), lecturas: lecturas.length
  });

  const r1 = await leer();
  const l1 = lecturaDesdeResultado(r1, 1);
  if (r1.tipo === 'no_disponible') return registrar('fuente_temporalmente_no_disponible', [l1], `La fuente no estuvo disponible (${l1.codigo_fallo}); la propuesta sigue aprobada.`);
  if (r1.tipo === 'ambiguo') return registrar('extraccion_ambigua', [l1], `Lectura ambigua de la fuente (${describirAmbiguo(l1)}); requiere revisión humana.`);

  const p1 = adaptador.proyectarRevalidacion(r1);
  if (coincideConAprobado(payload, p1)) {
    try { return { ...(await V2.aplicarPropuestaV2(entrada, contextoNucleo([p1]), deps)), lecturas: 1 }; }
    catch (e) {
      if (e instanceof V2.ErrorRevalidacionV2 && e.codigo === 'revalidacion_vencida') {
        return registrar('revalidacion_vencida', [l1], 'La lectura coincidía con lo aprobado pero venció antes de escribir; la propuesta sigue aprobada.');
      }
      throw e;
    }
  }

  // Cambio detectado: una segunda lectura válida debe confirmar los mismos hechos nuevos.
  const r2 = await leer();
  const l2 = lecturaDesdeResultado(r2, 2);
  if (r2.tipo === 'no_disponible') return registrar('fuente_temporalmente_no_disponible', [l1, l2], `Cambio sin confirmar: la segunda lectura falló (${l2.codigo_fallo}); la propuesta sigue aprobada.`);
  if (r2.tipo === 'ambiguo') return registrar('extraccion_ambigua', [l1, l2], `Cambio sin confirmar: la segunda lectura es ambigua (${describirAmbiguo(l2)}); requiere revisión humana.`);
  if (r2.hechos_hash !== r1.hechos_hash) return registrar('extraccion_ambigua', [l1, l2], 'cambio_no_confirmado: las dos lecturas dieron hechos distintos; requiere revisión humana.');
  return registrar('fuente_cambio', [l1, l2], 'La fuente cambió: dos lecturas vigentes confirmaron los mismos hechos nuevos.');
}

module.exports = { ErrorPermisoAplicacionV2, resolverAuditoria, lecturaDesdeResultado, aplicarConRevalidacionV2 };
