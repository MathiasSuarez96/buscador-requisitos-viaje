/**
 * Ciclo de revalidación 2.0, reutilizable por país y requisito (el perfil decide qué cubre).
 *
 *  clasificar(requisito, lectura, perfil, { hoy })  Pura. Qué haría el ciclo con una lectura:
 *    sin_cambio | cambio_aplicable | revision_humana | fuente_no_disponible, más el estado de la
 *    fecha de verificación, informado POR SEPARADO (renovarla no es «sin cambio»).
 *  ejecutarCicloV2(objetivo, perfil, contexto)  Una corrida con escritura: si hay un cambio
 *    aplicable, genera la propuesta 2.0, registra la aprobación (identidad del contexto) y aplica
 *    con H3.3 (aplicarConRevalidacionV2), que vuelve a leer la ficha, inicia el intento, hace el
 *    CAS, la transacción y la auditoría. Sin cambio, revisión o fuente caída: no escribe nada.
 *  crearDepsAplicacion(conexion, { fetch, ahora, uuid })  Dependencias de H3.3 sobre una conexión.
 *  evaluarReintento(...)  Pura. ¿Una propuesta YA aprobada, cuya aplicación falló por una caída
 *    transitoria de la fuente, puede reintentarse sola? Ver REINTENTO más abajo.
 *
 * El contexto trae las identidades: el piloto pasa las suyas (solo Mongo efímero) y la ejecución
 * real las resuelve con config-ciclo-real.js. El ciclo no conoce ninguna identidad propia.
 */
// Antes de cualquier modelo: autoCreate y autoIndex apagados (aborta si llegó tarde).
require('../../../config/mongoose');
const { ObjectId } = require('mongodb');
const PropuestaCambio = require('../../../models/propuestas/PropuestaCambio.model');
const Destino = require('../../../models/Destino.model');
const D = require('../decidir-propuesta');
const V2 = require('../aplicar-propuesta-v2');
const { aplicarConRevalidacionV2 } = require('../orquestar-aplicacion-v2');
const { crearPersistenciaV2 } = require('../persistencia-aplicacion-v2');
const { crearSobreRequisitoV2, advertenciasRequeridas, validarSobreRequisitoV2 } = require('../payload-requisito-v2');
const { capturarIdentidadEInstantanea, aplicarCambiosAInstantanea } = require('../contrato-requisito-v2');
const { ESTADOS_ACTIVOS } = require('../contrato-propuestas');
const { fechaMontevideo } = require('../plan-aplicacion-requisito-v2');
const { canonicalizarValor } = require('../canonicalizacion-propuestas');
const { elegirAdaptadorV2, ErrorSinAdaptadorV2 } = require('../adaptadores/v2');

const ACCIONES = Object.freeze(['sin_cambio', 'cambio_aplicable', 'revision_humana', 'fuente_no_disponible']);
const DIA_MS = 24 * 60 * 60 * 1000;

const esDelPerfil = (requisito, perfil) => requisito?.tipo === perfil.requisito.tipo && requisito?.nombre === perfil.requisito.nombre;
const camposPendientes = lectura => Object.entries(lectura.campos).filter(([, c]) => c.estado !== 'ok')
  .map(([campo, c]) => ({ campo, motivo: String(c.motivo).split(':')[0], evidencia: [...c.evidencia] }));

function fechaComoTexto(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  return null;
}

// Pura. Fecha de verificación, separada de la decisión sobre los valores.
function evaluarFecha(requisito, accion, perfil, hoy, conHechos = false) {
  const actual = fechaComoTexto(requisito?.fecha_verificacion);
  const dias = actual ? Math.floor((Date.parse(`${hoy}T00:00:00Z`) - Date.parse(`${actual}T00:00:00Z`)) / DIA_MS) : null;
  const base = { actual, hoy, dias_desde_verificacion: dias };
  if (accion === 'cambio_aplicable') {
    return { ...base, efecto: 'se_fija_al_aplicar', detalle: `Aplicar el cambio fija fecha_verificacion=${hoy} (fecha de Montevideo) junto con el valor nuevo.` };
  }
  if (accion === 'sin_cambio') {
    return { ...base, efecto: 'no_se_renueva', renovacion_soportada: false,
      detalle: `Los valores no cambian. Renovar la fecha no está soportado en esta versión: la fuente confirma la obligatoriedad, pero no ${perfil.campos_sin_evidencia.join(', ')}.` };
  }
  if (conHechos) return { ...base, efecto: 'no_se_renueva', renovacion_soportada: false, detalle: 'Hay hechos confirmados, pero el caso va a revisión humana: la fecha no se toca hasta resolverla.' };
  return { ...base, efecto: 'sin_efecto', detalle: 'Sin hechos confirmados no se toca la fecha.' };
}

// Pura. Qué haría el ciclo con esta lectura sobre este requisito.
function clasificar(requisito, lectura, perfil, { hoy }) {
  const conHechos = lectura?.tipo === 'hechos';
  const informe = accion => (extra = {}) => ({ accion, ...extra, fecha_verificacion: evaluarFecha(requisito, accion, perfil, hoy, conHechos) });
  if (!esDelPerfil(requisito, perfil)) return informe('revision_humana')({ motivo: 'requisito_fuera_de_perfil' });
  if (lectura?.tipo === 'no_disponible') return informe('fuente_no_disponible')({ motivo: lectura.motivo, pendiente: { tipo: 'reintentar', motivo: lectura.motivo } });
  if (lectura?.tipo === 'ambiguo') return informe('revision_humana')({ motivo: 'lectura_ambigua', pendiente: { tipo: 'revision_humana', url: lectura.url, campos: camposPendientes(lectura) } });
  // El perfil dice qué campo de la lectura sostiene su decisión (CheckMig: obligatoriedad).
  const campoEvidencia = perfil.campo_evidencia ?? 'obligatoriedad';
  if (lectura?.tipo !== 'hechos' || lectura.fuente_nombre !== perfil.adaptador.FUENTE_NOMBRE || !(lectura.evidencia?.[campoEvidencia]?.length > 0)) {
    return informe('revision_humana')({ motivo: 'sin_evidencia_confirmada' });
  }
  const ev = perfil.evaluar(requisito, lectura.hechos);
  const comun = { esperado: ev.esperado, guardado: requisito.obligatorio, observaciones: ev.observaciones, hechos_hash: lectura.hechos_hash,
    ...(ev.tipo_cambio ? { tipo_cambio: ev.tipo_cambio } : {}) };
  if (ev.decision === 'revision_humana') return informe('revision_humana')({ ...comun, motivo: ev.motivo, detalle: ev.detalle, pendiente: { tipo: 'revision_humana', motivo: ev.motivo } });
  if (ev.decision === 'sin_cambio') return informe('sin_cambio')(comun);
  if (ev.cambios.some(c => !perfil.campos_autorizados.includes(c.campo))) return informe('revision_humana')({ ...comun, motivo: 'campo_no_autorizado' });
  return informe('cambio_aplicable')({ ...comun, cambios: ev.cambios });
}

// Cuándo y cómo se consultó la fuente en esta corrida (para el registro de ejecución).
function resumenLectura(lectura) {
  const d = lectura?.diagnostico ?? {};
  return { url: lectura?.url ?? null, tipo: lectura?.tipo ?? null, consultado_en: d.consultado_en ?? null, http_status: d.http_status ?? null,
    hechos_hash: lectura?.hechos_hash ?? null, contenido_sha256: d.contenido_sha256 ?? null, motivo: lectura?.tipo === 'no_disponible' ? lectura.motivo ?? null : null };
}

// Misma fecha de calendario que fija el núcleo al aplicar (America/Montevideo).
const hoyMontevideo = ahora => fechaMontevideo(ahora);

/*
 * REINTENTO de una propuesta aprobada. La corrida siguiente vuelve a aplicar la MISMA propuesta
 * (sin otra propuesta ni otra aprobación) con H3.3, que registra un intento nuevo, revalida la
 * fuente y escribe solo si los hechos siguen siendo los aprobados (CAS de versión, transacción,
 * índice de un único éxito por propuesta). Se admite SOLO si:
 *  - la propuesta está 'aprobada' y corresponde al objetivo (destino y requisito), al requisito del
 *    perfil, a su adaptador (el que H3.3 elegiría) y a sus campos autorizados;
 *  - está íntegra: hash recalculado, aprobación coherente (precondiciones del núcleo), sobre 2.0
 *    válido e identidad del requisito igual a la del payload;
 *  - la aprobación se registró por la política automática con EXACTAMENTE la autorización vigente
 *    hoy para este perfil (misma política, autorizante, autorizada_en y vence_en), sin vencer;
 *  - no hay ningún intento en curso (inicio sin intento terminado) ni un éxito;
 *  - el último intento terminó en fuente_temporalmente_no_disponible y TODAS sus lecturas fallidas
 *    son transitorias (red, tiempo agotado, HTTP 5xx, 408 o 429). Una redirección fuera del sitio,
 *    un 404 o un cuerpo ilegible no son caídas: quedan para revisión humana;
 *  - quedan reintentos: como máximo MAX_REINTENTOS_AUTOMATICOS (3) intentos automáticos DESPUÉS del
 *    intento inicial. Se cuentan con los registros existentes: todo intento terminado de la propuesta
 *    en intentos_aplicacion (el primero es el inicial). Agotados, no se vuelve a aplicar sola: la
 *    corrida devuelve revisión humana con el motivo cerrado 'reintentos_agotados' (exit 3, aviso de
 *    fallo del workflow). No se persiste ningún estado nuevo: la propuesta sigue 'aprobada' y una
 *    persona decide (cancelarla o aplicarla a mano).
 * Pendiente, en revisión, rechazada, cancelada, obsoleta o aplicada nunca llegan acá: solo 'aprobada'.
 * La evaluación solo lee (find); con la política ausente o vencida se informa y no se escribe.
 */
const CODIGOS_TRANSITORIOS = Object.freeze(['red', 'tiempo_agotado']);
const HTTP_TRANSITORIOS = Object.freeze([408, 429]);
const MAX_REINTENTOS_AUTOMATICOS = 3;
const lecturaTransitoria = l => l?.tipo === 'no_disponible' && (CODIGOS_TRANSITORIOS.includes(l.codigo_fallo)
  || (l.codigo_fallo === 'http' && Number.isInteger(l.http_status) && (HTTP_TRANSITORIOS.includes(l.http_status) || (l.http_status >= 500 && l.http_status <= 599))));
const MOTIVOS_REINTENTO = Object.freeze(['politica_no_habilitada', 'objetivo_no_coincide', 'requisito_fuera_de_perfil', 'propuesta_no_integra', 'identidad_no_coincide',
  'campo_no_autorizado', 'adaptador_no_coincide', 'aprobacion_fuera_de_la_autorizacion_vigente', 'autorizacion_vencida', 'intento_en_curso', 'ya_aplicada',
  'sin_intento_previo', 'fallo_no_admitido', 'reintentos_agotados']);
const igualCanonico = (a, b) => { try { return JSON.stringify(canonicalizarValor(a)) === JSON.stringify(canonicalizarValor(b)); } catch { return false; } };
const instante = v => (v instanceof Date ? v.getTime() : Number.NaN);

// Pura. Devuelve { admitido: true, entrada, payload, intento_previo_id, intentos_previos } o { admitido: false, motivo, detalle }.
function evaluarReintento({ propuesta, evento, intentos, inicios, requisito, objetivo, perfil, identidadDecision, ahora }) {
  const no = (motivo, detalle = null) => ({ admitido: false, motivo, detalle });
  if (propuesta?.estado !== 'aprobada') return no('fallo_no_admitido', { estado: propuesta?.estado ?? null });
  if (!(propuesta.destino_id instanceof ObjectId) || !propuesta.destino_id.equals(objetivo.destinoId)
    || !(propuesta.requisito_id instanceof ObjectId) || !propuesta.requisito_id.equals(objetivo.requisitoId)) return no('objetivo_no_coincide');
  if (!esDelPerfil(requisito, perfil)) return no('requisito_fuera_de_perfil');
  const entrada = { propuesta_id: propuesta.propuesta_id, estado_esperado: 'aprobada', payload_hash_esperado: propuesta.payload_hash,
    version_coordinacion_esperada: propuesta.version_coordinacion, decision_aprobacion_id_esperado: propuesta.decision_aprobacion_id ?? null };
  const fallas = V2.verificarPrecondicionesV2(entrada, propuesta, evento);
  if (fallas.length) return no('propuesta_no_integra', { codigos: fallas.map(f => f.codigo) });
  let payload;
  try { payload = validarSobreRequisitoV2(V2.interno.sobreGuardado(propuesta)).payload; } catch { return no('propuesta_no_integra', { codigos: ['payload_2_0_invalido'] }); }
  let identidadActual = null;
  try { identidadActual = capturarIdentidadEInstantanea(requisito).identidad_requisito; } catch { /* no capturable: no coincide */ }
  if (identidadActual === null || !igualCanonico(identidadActual, payload.identidad_requisito)) return no('identidad_no_coincide');
  const fuera = payload.cambios.map(x => x.campo).filter(k => !perfil.campos_autorizados.includes(k));
  if (fuera.length) return no('campo_no_autorizado', { campos: fuera });
  let adaptador = null;
  try { adaptador = elegirAdaptadorV2(propuesta); } catch (e) { if (!(e instanceof ErrorSinAdaptadorV2)) throw e; }
  if (adaptador !== perfil.adaptador) return no('adaptador_no_coincide');

  if (!identidadDecision) return no('politica_no_habilitada');
  const aprobada = evento?.detalle?.identidad_operador, vigente = identidadDecision.identidad_operador;
  if (aprobada?.metodo !== 'politica_automatica' || evento?.actor?.identificador !== identidadDecision.actor.identificador
    || ['politica', 'autorizada_en', 'vence_en'].some(k => aprobada?.[k] !== vigente[k])) return no('aprobacion_fuera_de_la_autorizacion_vigente');
  if (!(ahora.getTime() < Date.parse(vigente.vence_en))) return no('autorizacion_vencida');

  const terminados = new Set(intentos.map(i => i.intento_id));
  const enCurso = inicios.filter(i => !terminados.has(i.intento_id)).map(i => i.intento_id);
  if (enCurso.length) return no('intento_en_curso', { intentos: enCurso });
  if (intentos.some(i => i.resultado === 'exito')) return no('ya_aplicada');
  if (!intentos.length) return no('sin_intento_previo');
  const ultimo = [...intentos].sort((a, b) => instante(a.finalizado_en) - instante(b.finalizado_en)).at(-1);
  const fallidas = (Array.isArray(ultimo.lecturas_fuente) ? ultimo.lecturas_fuente : []).filter(l => l?.tipo !== 'hechos');
  if (ultimo.resultado !== 'fuente_temporalmente_no_disponible' || fallidas.length === 0 || !fallidas.every(lecturaTransitoria)) {
    return no('fallo_no_admitido', { resultado: ultimo.resultado ?? null, codigos: fallidas.map(l => l?.codigo_fallo ?? l?.tipo ?? null) });
  }
  const reintentosHechos = intentos.length - 1;
  if (reintentosHechos >= MAX_REINTENTOS_AUTOMATICOS) return no('reintentos_agotados', { reintentos: reintentosHechos, maximo: MAX_REINTENTOS_AUTOMATICOS });
  return { admitido: true, entrada, payload, intento_previo_id: ultimo.intento_id, intentos_previos: intentos.length, numero: reintentosHechos + 1 };
}

// Pura. Valor de obligatorio que queda publicado si el payload se aplica.
function obligatorioResultante(payload) {
  const cambio = payload.cambios.find(x => x.campo === 'obligatorio');
  return cambio ? cambio.propuesto.valor : payload.instantanea_anterior.obligatorio?.valor ?? null;
}

// Tras H3.3: estado final de la propuesta y qué queda pendiente (primera aplicación y reintento).
async function cerrarAplicacion(col, propuestaId, r) {
  const propuesta = await col('propuestas_cambio').findOne({ propuesta_id: propuestaId });
  const intento = r.intento_id ? await col('intentos_aplicacion').findOne({ intento_id: r.intento_id }) : null;
  const ultima = intento?.lecturas_fuente?.at(-1);
  const pendiente = propuesta.estado === 'revision_requerida'
    ? { tipo: 'revision_humana', propuesta_id: propuestaId, intento_id: r.intento_id, campos: (ultima?.campos_sin_confirmar ?? []).map(x => ({ ...x })) }
    : propuesta.estado === 'aprobada' && r.resultado !== 'exito' ? { tipo: 'reintentar', propuesta_id: propuestaId, intento_id: r.intento_id, codigo: ultima?.codigo_fallo ?? r.resultado } : null;
  return { propuesta, intento, ultima, pendiente };
}

const isoODefecto = v => (v instanceof Date ? v.toISOString() : null);

async function reintentarAprobada(activa, requisito, objetivo, perfil, c) {
  const col = n => c.conexion.db.collection(n);
  const evento = typeof activa.decision_aprobacion_id === 'string' ? await col('eventos_propuesta').findOne({ evento_id: activa.decision_aprobacion_id }) : null;
  const intentos = await col('intentos_aplicacion').find({ propuesta_id: activa.propuesta_id }).toArray();
  const inicios = await col('inicios_intento_aplicacion').find({ propuesta_id: activa.propuesta_id }).toArray();
  const ev = evaluarReintento({ propuesta: activa, evento, intentos, inicios, requisito, objetivo, perfil,
    identidadDecision: c.politicaHabilitada === true ? c.identidadDecision ?? null : null, ahora: c.ahora() });
  if (!ev.admitido) {
    const tipo = ev.motivo === 'politica_no_habilitada' ? 'autorizacion' : ev.motivo === 'intento_en_curso' ? 'reintentar' : 'revision_humana';
    return { resultado: 'propuesta_activa_existente', motivo: ev.motivo, propuesta_id: activa.propuesta_id, estado_propuesta: activa.estado, lecturas: 0,
      pendiente: { tipo, motivo: ev.motivo, propuesta_id: activa.propuesta_id }, reintento: { admitido: false, motivo: ev.motivo, detalle: ev.detalle } };
  }
  const r = await aplicarConRevalidacionV2(ev.entrada, c.credencialAplicacion, c.depsAplicacion());
  const cierre = await cerrarAplicacion(col, activa.propuesta_id, r);
  const { propuesta, intento, ultima } = cierre;
  // Último reintento admitido y sigue sin aplicarse: no habrá otro automático.
  const agotados = propuesta.estado === 'aprobada' && r.resultado !== 'exito' && ev.numero >= MAX_REINTENTOS_AUTOMATICOS;
  const pendiente = agotados ? { tipo: 'revision_humana', motivo: 'reintentos_agotados', propuesta_id: activa.propuesta_id, intento_id: r.intento_id } : cierre.pendiente;
  const revalidada = intento?.revalidaciones?.[0];
  const fuente = ultima ? { url: ultima.url, tipo: ultima.tipo, consultado_en: isoODefecto(ultima.consultado_en), http_status: ultima.http_status ?? null,
    hechos_hash: ultima.hechos_hash ?? null, contenido_sha256: ultima.contenido_sha256 ?? null, motivo: ultima.codigo_fallo ?? null }
    : revalidada ? { url: revalidada.url, tipo: 'hechos', consultado_en: isoODefecto(revalidada.revalidada_en), http_status: null, hechos_hash: revalidada.hechos_hash, contenido_sha256: null, motivo: null }
      : null;
  const campos = ev.payload.cambios.map(x => x.campo);
  return { resultado: r.resultado, propuesta_id: activa.propuesta_id, decision_evento_id: activa.decision_aprobacion_id, intento_id: r.intento_id,
    estado_propuesta: propuesta.estado, lecturas: r.lecturas ?? 0, valor_aplicado: r.resultado === 'exito' ? obligatorioResultante(ev.payload) : null, pendiente, fuente,
    campos_propuestos: campos, tipo_cambio: perfil.tipo === 'procedencia' ? (campos.includes('obligatorio') ? 'valor' : 'procedencia') : null,
    reintento: { admitido: true, numero: ev.numero, maximo: MAX_REINTENTOS_AUTOMATICOS, agotados, intento_previo_id: ev.intento_previo_id, intentos_previos: ev.intentos_previos } };
}

function crearDepsAplicacion(conexion, { fetch, ahora, uuid, listados }) {
  const P = crearPersistenciaV2();
  return () => ({
    ahora, uuid, fetch,
    verificarIndices: async () => V2.verificarIndicesV2(await listados()),
    ejecutarTransaccion: fn => conexion.transaction(fn, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } }),
    leerPropuesta: (id, s) => conexion.db.collection('propuestas_cambio').findOne({ propuesta_id: id }, s ? { session: s } : {}),
    leerEvento: (id, s) => conexion.db.collection('eventos_propuesta').findOne({ evento_id: id }, s ? { session: s } : {}),
    ...P,
    ...V2.dependenciasDestino(Destino.collection),
    actualizarPropuestaCas: (f, upd, s) => conexion.db.collection('propuestas_cambio').updateOne(f, upd, { session: s })
  });
}

/**
 * contexto: { conexion, fetch, ahora, uuid, depsAplicacion(), identidadDecision, credencialAplicacion }
 * objetivo: { destinoId, requisitoId } (ObjectId).
 */
async function ejecutarCicloV2({ destinoId, requisitoId }, perfil, c) {
  const col = n => c.conexion.db.collection(n);
  const destino = await col('destinos').findOne({ _id: destinoId });
  const requisito = (destino?.requisitos ?? []).find(r => r?._id instanceof ObjectId && r._id.equals(requisitoId));
  if (!requisito) return { resultado: 'requisito_no_encontrado', lecturas: 0 };

  // Sin duplicar: una propuesta activa para este requisito se informa y no se crea otra. Si está
  // aprobada y su aplicación falló por una caída transitoria, se reintenta ESA misma (REINTENTO).
  const activa = await col('propuestas_cambio').findOne({ destino_id: destinoId, requisito_id: requisitoId, estado: { $in: ESTADOS_ACTIVOS } });
  if (activa?.estado === 'aprobada') return reintentarAprobada(activa, requisito, { destinoId, requisitoId }, perfil, c);
  if (activa) {
    return { resultado: 'propuesta_activa_existente', propuesta_id: activa.propuesta_id, estado_propuesta: activa.estado, lecturas: 0,
      pendiente: activa.estado === 'revision_requerida' ? { tipo: 'revision_humana', propuesta_id: activa.propuesta_id } : null };
  }

  const lectura = await perfil.adaptador.leer({ fetch: c.fetch, ahora: c.ahora });
  const informe = clasificar(requisito, lectura, perfil, { hoy: hoyMontevideo(c.ahora()) });
  const fuente = resumenLectura(lectura);
  if (informe.accion !== 'cambio_aplicable') {
    return { resultado: informe.accion, motivo: informe.motivo ?? null, lecturas: 1, pendiente: informe.pendiente ?? null, informe, fuente };
  }
  // Una decisión humana negativa (rechazo o cancelación) sobre los MISMOS hechos y cambios no se
  // revierte sola: proponer de nuevo sería reintentarla. Hechos nuevos sí generan otra propuesta.
  const previas = await col('propuestas_cambio').find({ destino_id: destinoId, requisito_id: requisitoId, estado: { $in: ['rechazada', 'cancelada'] } }).toArray();
  const descartada = previas.find(p => p.payload?.fuentes?.length === 1 && p.payload.fuentes[0].hechos_hash === lectura.hechos_hash
    && igualCanonico(p.payload.cambios, informe.cambios));
  if (descartada) {
    return { resultado: 'revision_humana', motivo: 'decision_humana_previa', propuesta_id: descartada.propuesta_id, estado_propuesta: descartada.estado, lecturas: 1,
      pendiente: { tipo: 'revision_humana', motivo: 'decision_humana_previa', propuesta_id: descartada.propuesta_id }, informe, fuente };
  }
  // Sin la política habilitada explícitamente, el cambio se informa y no se escribe nada.
  if (c.politicaHabilitada !== true || !c.identidadDecision) {
    return { resultado: 'cambio_aplicable', motivo: 'politica_no_habilitada', lecturas: 1, pendiente: { tipo: 'autorizacion', motivo: 'politica_no_habilitada' }, informe, fuente };
  }

  // Propuesta 2.0 desde la lectura confirmada.
  const captura = capturarIdentidadEInstantanea(requisito);
  const advertencias = advertenciasRequeridas(captura.instantanea_anterior, aplicarCambiosAInstantanea(captura.instantanea_anterior, informe.cambios));
  const propuestaId = c.uuid(), runId = c.uuid();
  const sobre = crearSobreRequisitoV2({
    fecha_propuesta: c.ahora().toISOString(), destino_id: destinoId.toHexString(), requisito_id: requisitoId.toHexString(),
    run_id_origen: runId, propuesta_id: propuestaId, ...captura, cambios: informe.cambios,
    fuentes: [{ nombre: lectura.fuente_nombre, url: lectura.url, capturado_en: lectura.revalidada_en.toISOString(),
      hechos: lectura.hechos, algoritmo_hechos_hash: lectura.algoritmo_hechos_hash, hechos_hash: lectura.hechos_hash }],
    advertencias
  });
  try {
    await new PropuestaCambio({ propuesta_id: propuestaId, destino_id: destinoId, requisito_id: requisitoId, campo: 'requisito', run_id_origen: runId,
      algoritmo_canonicalizacion: sobre.algoritmo_canonicalizacion, algoritmo_hash: sobre.algoritmo_hash, payload: sobre.payload, payload_hash: sobre.payload_hash }).save();
  } catch (err) {
    // Otra propuesta activa ganó la carrera (índice único de propuesta activa): no se duplica.
    if (err?.code === 11000) return { resultado: 'propuesta_activa_existente', lecturas: 1, pendiente: null, informe, fuente };
    throw err;
  }

  // Aprobación con la identidad del contexto (evento real de decisión).
  const decision = await D.decidirPropuesta({ tipo_evento: 'aprobacion', propuesta_id: propuestaId, estado_esperado: 'pendiente_aprobacion',
    payload_hash_esperado: sobre.payload_hash, version_coordinacion_esperada: 0, decision_aprobacion_id_esperado: null,
    version_contrato_esperada: '2.0', advertencias_aceptadas: [...sobre.payload.advertencias] },
  { ...D.crearDependenciasMongoose(c.conexion), uuid: c.uuid, ahora: c.ahora, resolverIdentidad: async () => structuredClone(c.identidadDecision) });
  if (decision?.resultado !== 'decision_registrada') return { resultado: 'decision_no_registrada', propuesta_id: propuestaId, detalle: decision?.resultado ?? null, lecturas: 1, informe, fuente };

  // Aplicación con H3.3 (revalida la ficha y escribe solo si los hechos siguen confirmados).
  const entrada = { propuesta_id: propuestaId, estado_esperado: 'aprobada', payload_hash_esperado: sobre.payload_hash,
    version_coordinacion_esperada: decision.version_coordinacion_nueva, decision_aprobacion_id_esperado: decision.evento_id };
  const r = await aplicarConRevalidacionV2(entrada, c.credencialAplicacion, c.depsAplicacion());
  const { propuesta, pendiente } = await cerrarAplicacion(col, propuestaId, r);
  return { resultado: r.resultado, propuesta_id: propuestaId, decision_evento_id: decision.evento_id, intento_id: r.intento_id,
    estado_propuesta: propuesta.estado, lecturas: 1 + (r.lecturas ?? 0), valor_aplicado: r.resultado === 'exito' ? informe.esperado : null, pendiente, informe, fuente };
}

module.exports = { ACCIONES, clasificar, evaluarFecha, crearDepsAplicacion, ejecutarCicloV2, esDelPerfil, resumenLectura,
  evaluarReintento, lecturaTransitoria, MOTIVOS_REINTENTO, MAX_REINTENTOS_AUTOMATICOS };
