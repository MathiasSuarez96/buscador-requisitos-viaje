/**
 * H3.3: registra el cierre de un intento 2.0 cuando la revalidación externa NO termina en la
 * escritura del destino. Nunca escribe en destinos. Reutiliza las piezas del núcleo
 * (aplicar-propuesta-v2.js): el mismo inicio exacto, el CAS de la propuesta, la confirmación por
 * relectura y el registro independiente.
 *
 * registro = { resultado, lecturas, motivo }:
 *  - fuente_temporalmente_no_disponible: intento independiente (sin cambio de estado; la propuesta
 *    sigue aprobada y se puede reintentar).
 *  - extraccion_ambigua: transacción con intento + CAS aprobada → revision_requerida + evento
 *    entrada_revision. La propuesta queda para revisión humana.
 *  - fuente_cambio: SOLO con dos lecturas con hechos, el mismo hechos_hash, distinto del aprobado,
 *    y las dos vigentes (0 ≤ t − revalidada_en ≤ ventana) al registrar. Transacción con intento +
 *    CAS aprobada → obsoleta + evento obsolescencia. Si alguna lectura ya no está vigente, se
 *    registra revalidacion_vencida y la propuesta sigue aprobada.
 *  - revalidacion_vencida: intento independiente (sin cambio de estado).
 *
 * Antes de registrar se verifican el inicio exacto y las precondiciones de la propuesta (estado,
 * hash, versión y aprobación vigente). Si fallan, el intento cierra como propuesta_no_aplicable.
 * Las lecturas son las del orquestador; sus url y fuente_nombre deben ser las del payload aprobado.
 */
const { VENTANA_REVALIDACION_MS, TRANSICIONES, TRANSICION_POR_RESULTADO } = require('./contrato-propuestas');
const { validarEntrada, convertirIdsDestino, ErrorEntradaInvalida, ErrorPropuestaNoEncontrada } = require('./aplicar-propuesta');
const { validarSobreRequisitoV2 } = require('./payload-requisito-v2');
const V2 = require('./aplicar-propuesta-v2');

const N = V2.interno;
const RESULTADOS_REVALIDACION_V2 = Object.freeze(['fuente_temporalmente_no_disponible', 'extraccion_ambigua', 'fuente_cambio', 'revalidacion_vencida']);
const esObjeto = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const vigente = (l, t) => { const edad = t.getTime() - l.revalidada_en.getTime(); return edad >= 0 && edad <= VENTANA_REVALIDACION_MS; };

function validarRegistro(registro, fuente) {
  if (!esObjeto(registro) || Object.keys(registro).sort().join(',') !== 'lecturas,motivo,resultado') throw new ErrorEntradaInvalida('registrarRevalidacionV2: registro debe tener solo resultado, lecturas y motivo.');
  if (!RESULTADOS_REVALIDACION_V2.includes(registro.resultado)) throw new ErrorEntradaInvalida('registrarRevalidacionV2: resultado no admitido.');
  if (typeof registro.motivo !== 'string' || registro.motivo.trim() === '' || registro.motivo.length > 500) throw new ErrorEntradaInvalida('registrarRevalidacionV2: motivo inválido.');
  const ls = registro.lecturas;
  if (!Array.isArray(ls) || ls.length < 1 || ls.length > 2 || !ls.every(esObjeto)) throw new ErrorEntradaInvalida('registrarRevalidacionV2: una o dos lecturas.');
  // Los textos de la fuente salen del payload aprobado: una lectura de otra fuente no se acepta.
  if (ls.some(l => l.url !== fuente.url || l.fuente_nombre !== fuente.nombre)) throw new ErrorEntradaInvalida('registrarRevalidacionV2: lectura de una fuente que no es la del payload aprobado.');
  return structuredClone(ls);
}

function planTransicionRevalidacionV2(ctx, resultado, extras, motivo, deps) {
  const tipoEvento = TRANSICION_POR_RESULTADO[resultado];
  const intento = V2.construirIntentoV2(ctx, { resultado, etapa_fallo: 'revalidacion_externa', finalizado_en: ctx.t, ...extras, error_mensaje: motivo });
  const evento = V2.construirEventoV2(ctx, tipoEvento, resultado, motivo);
  return {
    nombre: resultado,
    esperado: { inicio: ctx.inicio_esperado, propuesta: N.esperadoPropuesta(ctx, tipoEvento), evento, intento, historial: null, requisito: null },
    documentos: [['validarIntento', intento], ['validarEvento', evento]],
    cuerpo: async session => {
      await N.verificarInicioV2(ctx, session, deps);
      await N.casPropuesta(ctx, tipoEvento, session, deps);
      await deps.insertarIntento(structuredClone(intento), session);
      await deps.insertarEvento(structuredClone(evento), session);
    },
    confirmado: causa => N.resultado(ctx, resultado, { evento_id: ctx.evento_id, estado_propuesta_nuevo: TRANSICIONES[tipoEvento].hacia,
      confirmado_por_relectura: causa !== null, causa_relectura: causa }),
    docAbortado: (codigo, fin) => V2.construirIntentoV2(ctx, { resultado: 'escritura_abortada', etapa_fallo: 'transicion_por_fallo', resultado_no_registrado: resultado,
      finalizado_en: fin, error_externo: codigo, error_mensaje: N.MENSAJE_ABORTADA, ...extras })
  };
}

async function registrarIndependienteV2(ctx, campos, deps) {
  const doc = V2.construirIntentoV2(ctx, { finalizado_en: ctx.t, ...campos });
  await N.validarDocumentos({ documentos: [['validarIntento', doc]] }, deps);
  await N.registrarIndependiente(ctx, doc, deps, null);
  return N.resultado(ctx, campos.resultado);
}

async function registrarRevalidacionV2(entrada, contexto, registro, deps) {
  validarEntrada(entrada);
  if (!esObjeto(contexto) || Object.keys(contexto).sort().join(',') !== 'adaptador,auditoria,intento') {
    throw new ErrorEntradaInvalida('registrarRevalidacionV2: contexto debe tener solo adaptador, auditoria e intento.');
  }
  const { adaptador: a, auditoria, intento } = N.validarContextoV2(entrada, { ...contexto, revalidaciones: [] });
  await deps.verificarIndices();

  // ---- Etapa 0, solo lectura (igual que el núcleo) ----
  const propuesta = await deps.leerPropuesta(entrada.propuesta_id, null);
  if (!propuesta) throw new ErrorPropuestaNoEncontrada(`registrarRevalidacionV2: no existe la propuesta ${entrada.propuesta_id}. No se escribe nada.`);
  const ids = convertirIdsDestino(propuesta);
  const evento = typeof propuesta.decision_aprobacion_id === 'string' ? await deps.leerEvento(propuesta.decision_aprobacion_id, null) : null;
  const t = deps.ahora();
  const ctx = {
    propuesta_id: entrada.propuesta_id, hash_esperado: entrada.payload_hash_esperado, version_esperada: entrada.version_coordinacion_esperada,
    decision_aprobacion_id_esperado: entrada.decision_aprobacion_id_esperado,
    intento_id: intento.intento_id, evento_id: intento.evento_id, historial_id: intento.historial_id, iniciado_en: intento.iniciado_en, t, ids, auditoria,
    operador: { tipo: 'humano', identificador: auditoria.operador }, identidad_operador: { ...auditoria.identidad },
    adaptador: { nombre: a.nombre, version: a.version },
    aprobacion: evento ? { evento_id: evento.evento_id ?? null, actor: { ...(evento.actor ?? {}) },
      identidad_operador: esObjeto(evento.detalle?.identidad_operador) ? { ...evento.detalle.identidad_operador } : null,
      ocurrido_en: evento.ocurrido_en ?? null } : null,
    revalidaciones_resumen: null
  };
  ctx.inicio_esperado = N.inicioDesdeCtx(ctx);
  await N.verificarInicioV2(ctx, null, deps);
  const fallas = V2.verificarPrecondicionesV2(entrada, propuesta, evento);
  let payload = null;
  if (!fallas.length) {
    try { payload = validarSobreRequisitoV2(N.sobreGuardado(propuesta)).payload; }
    catch { fallas.push({ codigo: 'payload_2_0_invalido', detalle: {} }); }
  }
  if (!fallas.length && payload.fuentes.length !== 1) fallas.push({ codigo: 'fuentes_no_soportadas', detalle: { cantidad: payload.fuentes.length } });
  if (fallas.length) return N.registrarNoAplicable(ctx, fallas, 'precondiciones_propuesta', deps);

  const [fuente] = payload.fuentes;
  const lecturas = validarRegistro(registro, fuente);
  const motivo = registro.motivo;
  const resumen = l => [{ url: fuente.url, fuente_nombre: fuente.nombre, hechos_hash: l.hechos_hash, revalidada_en: new Date(l.revalidada_en.getTime()) }];

  switch (registro.resultado) {
    case 'fuente_temporalmente_no_disponible':
      return registrarIndependienteV2(ctx, { resultado: 'fuente_temporalmente_no_disponible', etapa_fallo: 'revalidacion_externa', lecturas_fuente: lecturas, error_mensaje: motivo }, deps);
    case 'extraccion_ambigua':
      return N.escribirConConfirmacionV2(ctx, planTransicionRevalidacionV2(ctx, 'extraccion_ambigua', { lecturas_fuente: lecturas }, motivo, deps), deps);
    case 'revalidacion_vencida': {
      const l = lecturas[lecturas.length - 1];
      if (l.tipo !== 'hechos') throw new ErrorEntradaInvalida('registrarRevalidacionV2: revalidacion_vencida exige una lectura con hechos.');
      ctx.revalidaciones_resumen = resumen(l);
      return registrarIndependienteV2(ctx, { resultado: 'revalidacion_vencida', etapa_fallo: 'escritura_aplicacion', lecturas_fuente: lecturas, error_mensaje: motivo }, deps);
    }
    case 'fuente_cambio': {
      const [l1, l2] = lecturas;
      // Solo un cambio confirmado: dos lecturas con hechos, los mismos y distintos de los aprobados.
      if (lecturas.length !== 2 || l1.tipo !== 'hechos' || l2.tipo !== 'hechos' || l1.hechos_hash !== l2.hechos_hash || l1.hechos_hash === fuente.hechos_hash) {
        throw new ErrorEntradaInvalida('registrarRevalidacionV2: fuente_cambio exige dos lecturas que confirmen los mismos hechos nuevos.');
      }
      const masAntigua = l1.revalidada_en.getTime() <= l2.revalidada_en.getTime() ? l1 : l2;
      ctx.revalidaciones_resumen = resumen({ hechos_hash: l1.hechos_hash, revalidada_en: masAntigua.revalidada_en });
      // Las dos lecturas deben seguir vigentes al registrar: si no, la propuesta no se vuelve obsoleta.
      if (!lecturas.every(l => vigente(l, t))) {
        return registrarIndependienteV2(ctx, { resultado: 'revalidacion_vencida', etapa_fallo: 'escritura_aplicacion', lecturas_fuente: lecturas,
          error_mensaje: 'El cambio de la fuente se confirmó, pero alguna lectura ya no está vigente; la propuesta no se marca obsoleta.' }, deps);
      }
      return N.escribirConConfirmacionV2(ctx, planTransicionRevalidacionV2(ctx, 'fuente_cambio', { lecturas_fuente: lecturas }, motivo, deps), deps);
    }
    default:
      throw new ErrorEntradaInvalida('registrarRevalidacionV2: resultado no admitido.');
  }
}

module.exports = { RESULTADOS_REVALIDACION_V2, registrarRevalidacionV2 };
