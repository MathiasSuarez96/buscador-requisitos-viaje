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
const { crearSobreRequisitoV2, advertenciasRequeridas } = require('../payload-requisito-v2');
const { capturarIdentidadEInstantanea, aplicarCambiosAInstantanea } = require('../contrato-requisito-v2');
const { ESTADOS_ACTIVOS } = require('../contrato-propuestas');
const { fechaMontevideo } = require('../plan-aplicacion-requisito-v2');

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
      detalle: `Los valores no cambian. Renovar la fecha no está soportado en esta versión: la ficha confirma la obligatoriedad, pero no ${perfil.campos_sin_evidencia.join(', ')}.` };
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
  if (lectura?.tipo !== 'hechos' || lectura.fuente_nombre !== perfil.adaptador.FUENTE_NOMBRE || !(lectura.evidencia?.obligatoriedad?.length > 0)) {
    return informe('revision_humana')({ motivo: 'sin_evidencia_confirmada' });
  }
  const ev = perfil.evaluar(requisito, lectura.hechos);
  const comun = { esperado: ev.esperado, guardado: requisito.obligatorio, observaciones: ev.observaciones, hechos_hash: lectura.hechos_hash };
  if (ev.decision === 'revision_humana') return informe('revision_humana')({ ...comun, motivo: ev.motivo, detalle: ev.detalle, pendiente: { tipo: 'revision_humana', motivo: ev.motivo } });
  if (ev.decision === 'sin_cambio') return informe('sin_cambio')(comun);
  if (ev.cambios.some(c => !perfil.campos_autorizados.includes(c.campo))) return informe('revision_humana')({ ...comun, motivo: 'campo_no_autorizado' });
  return informe('cambio_aplicable')({ ...comun, cambios: ev.cambios });
}

// Misma fecha de calendario que fija el núcleo al aplicar (America/Montevideo).
const hoyMontevideo = ahora => fechaMontevideo(ahora);

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

  // Sin duplicar: una propuesta activa para este requisito se informa y no se crea otra.
  const activa = await col('propuestas_cambio').findOne({ destino_id: destinoId, requisito_id: requisitoId, estado: { $in: ESTADOS_ACTIVOS } });
  if (activa) {
    return { resultado: 'propuesta_activa_existente', propuesta_id: activa.propuesta_id, estado_propuesta: activa.estado, lecturas: 0,
      pendiente: activa.estado === 'revision_requerida' ? { tipo: 'revision_humana', propuesta_id: activa.propuesta_id } : null };
  }

  const lectura = await perfil.adaptador.leer({ fetch: c.fetch, ahora: c.ahora });
  const informe = clasificar(requisito, lectura, perfil, { hoy: hoyMontevideo(c.ahora()) });
  if (informe.accion !== 'cambio_aplicable') {
    return { resultado: informe.accion, motivo: informe.motivo ?? null, lecturas: 1, pendiente: informe.pendiente ?? null, informe };
  }
  // Sin la política habilitada explícitamente, el cambio se informa y no se escribe nada.
  if (c.politicaHabilitada !== true || !c.identidadDecision) {
    return { resultado: 'cambio_aplicable', motivo: 'politica_no_habilitada', lecturas: 1, pendiente: { tipo: 'autorizacion', motivo: 'politica_no_habilitada' }, informe };
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
    if (err?.code === 11000) return { resultado: 'propuesta_activa_existente', lecturas: 1, pendiente: null, informe };
    throw err;
  }

  // Aprobación con la identidad del contexto (evento real de decisión).
  const decision = await D.decidirPropuesta({ tipo_evento: 'aprobacion', propuesta_id: propuestaId, estado_esperado: 'pendiente_aprobacion',
    payload_hash_esperado: sobre.payload_hash, version_coordinacion_esperada: 0, decision_aprobacion_id_esperado: null,
    version_contrato_esperada: '2.0', advertencias_aceptadas: [...sobre.payload.advertencias] },
  { ...D.crearDependenciasMongoose(c.conexion), uuid: c.uuid, ahora: c.ahora, resolverIdentidad: async () => structuredClone(c.identidadDecision) });
  if (decision?.resultado !== 'decision_registrada') return { resultado: 'decision_no_registrada', propuesta_id: propuestaId, detalle: decision?.resultado ?? null, lecturas: 1, informe };

  // Aplicación con H3.3 (revalida la ficha y escribe solo si los hechos siguen confirmados).
  const entrada = { propuesta_id: propuestaId, estado_esperado: 'aprobada', payload_hash_esperado: sobre.payload_hash,
    version_coordinacion_esperada: decision.version_coordinacion_nueva, decision_aprobacion_id_esperado: decision.evento_id };
  const r = await aplicarConRevalidacionV2(entrada, c.credencialAplicacion, c.depsAplicacion());
  const propuesta = await col('propuestas_cambio').findOne({ propuesta_id: propuestaId });
  const intento = r.intento_id ? await col('intentos_aplicacion').findOne({ intento_id: r.intento_id }) : null;
  const ultima = intento?.lecturas_fuente?.at(-1);
  const pendiente = propuesta.estado === 'revision_requerida'
    ? { tipo: 'revision_humana', propuesta_id: propuestaId, intento_id: r.intento_id, campos: (ultima?.campos_sin_confirmar ?? []).map(x => ({ ...x })) }
    : propuesta.estado === 'aprobada' && r.resultado !== 'exito' ? { tipo: 'reintentar', propuesta_id: propuestaId, intento_id: r.intento_id, codigo: ultima?.codigo_fallo ?? r.resultado } : null;
  return { resultado: r.resultado, propuesta_id: propuestaId, decision_evento_id: decision.evento_id, intento_id: r.intento_id,
    estado_propuesta: propuesta.estado, lecturas: 1 + (r.lecturas ?? 0), valor_aplicado: r.resultado === 'exito' ? informe.esperado : null, pendiente, informe };
}

module.exports = { ACCIONES, clasificar, evaluarFecha, crearDepsAplicacion, ejecutarCicloV2, esDelPerfil };
