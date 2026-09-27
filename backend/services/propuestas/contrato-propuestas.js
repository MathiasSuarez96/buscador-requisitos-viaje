/**
 * Contrato COMPARTIDO del ciclo de vida de una propuesta: estados, tipos
 * de evento, matriz de transiciones permitidas, resultados y etapas de
 * un intento de aplicación, y qué transición dispara cada fallo.
 *
 * Única fuente de verdad (antes estaban duplicados a propósito en
 * PropuestaCambio.model.js, EventoPropuesta.model.js y el servicio de
 * registro): los modelos validan contra estas constantes y los
 * servicios filtran sus CAS con ellas. Módulo puro, sin Mongoose.
 *
 * TRANSICIONES: cada tipo_evento declara desde qué estado(s) parte, a
 * qué estado llega y qué tipo de actor lo produce. EventoPropuesta
 * rechaza cualquier otra combinación. Todo tipo de TIPOS_EVENTO tiene al
 * menos una transición (no hay tipos que siempre resulten inválidos).
 *
 * TRES ROLES SEPARADOS en una aplicación:
 *  - aprobador: el humano del evento "aprobacion" (referenciado por
 *    PropuestaCambio.decision_aprobacion_id).
 *  - operador: el humano que lanzó el intento (IntentoAplicacion.operador).
 *  - proceso aplicador: el proceso que escribe (IntentoAplicacion.
 *    proceso_aplicador); es el actor 'sistema' de los eventos
 *    "aplicacion" y de las transiciones automáticas por fallo.
 *
 * PERSISTENCIA DE CADA RESULTADO (la implementa el servicio de aplicación;
 * siempre con el mismo intento_id, único en intentos_aplicacion):
 *  - exito: una transacción con el $set en destinos, el CAS de la
 *    propuesta (aprobada -> aplicada), HistorialCambio, el
 *    IntentoAplicacion "exito" y el EventoPropuesta "aplicacion".
 *  - resultados SEMÁNTICOS (RESULTADOS_CON_TRANSICION: extraccion_ambigua,
 *    fuente_cambio, valor_actual_cambio, identidad_requisito_cambio):
 *    una transacción con el IntentoAplicacion de ese resultado, el CAS de
 *    la propuesta (aprobada -> estado de TRANSICION_POR_RESULTADO) y el
 *    EventoPropuesta correspondiente. Intento, estado y evento quedan
 *    juntos o no queda ninguno.
 *  - resultados que NO cambian el estado (fuente_temporalmente_no_disponible,
 *    propuesta_no_aplicable, revalidacion_vencida, escritura_abortada):
 *    insert independiente del intento terminado, FUERA de toda
 *    transacción (nunca dentro de una transacción que pueda abortar).
 *  - si falla la transacción de exito o la de un resultado semántico: NO
 *    se afirma que ese resultado quedó registrado. Se inserta, fuera de
 *    toda transacción, un intento "escritura_abortada" con el mismo
 *    intento_id (etapa_fallo escritura_aplicacion o transicion_por_fallo;
 *    en este último caso con resultado_no_registrado). Si ese insert
 *    choca con el índice único de intento_id, ya existe un resultado
 *    confirmado (el commit sí ocurrió): se relee y se informa ese, sin
 *    sobrescribirlo.
 *
 * ETAPAS (IntentoAplicacion.etapa_fallo): dónde se detectó el fallo.
 *  - precondiciones_propuesta: antes de revalidar (estado, versión,
 *    hash, decisión o evento de aprobación inválidos).
 *  - revalidacion_externa: consulta/extracción de la fuente.
 *  - escritura_aplicacion: transacción de escritura, con la revalidación
 *    externa ya terminada correctamente.
 *  - transicion_por_fallo: transacción que registra un resultado semántico.
 * ETAPAS_POR_RESULTADO fija qué etapas admite cada resultado.
 */

const ESTADOS_PROPUESTA = [
  'pendiente_aprobacion',
  'aprobada',
  'rechazada',
  'obsoleta',
  'revision_requerida',
  'conflicto',
  'cancelada',
  'aplicada'
];

// Estados cubiertos por el índice único parcial
// uniq_propuesta_activa_por_destino_requisito_campo.
const ESTADOS_ACTIVOS = ['pendiente_aprobacion', 'aprobada', 'revision_requerida'];

const TIPOS_EVENTO = ['aprobacion', 'rechazo', 'cancelacion', 'obsolescencia', 'conflicto', 'entrada_revision', 'aplicacion'];

const TIPOS_ACTOR = ['humano', 'sistema'];

const TIPOS_QUE_REQUIEREN_MOTIVO = ['rechazo', 'cancelacion', 'conflicto', 'obsolescencia'];

const TRANSICIONES = {
  aprobacion: { desde: ['pendiente_aprobacion'], hacia: 'aprobada', actores: ['humano'] },
  rechazo: { desde: ['pendiente_aprobacion'], hacia: 'rechazada', actores: ['humano'] },
  cancelacion: { desde: ['aprobada', 'revision_requerida'], hacia: 'cancelada', actores: ['humano'] },
  aplicacion: { desde: ['aprobada'], hacia: 'aplicada', actores: ['sistema'] },
  entrada_revision: { desde: ['aprobada'], hacia: 'revision_requerida', actores: ['sistema'] },
  obsolescencia: { desde: ['aprobada'], hacia: 'obsoleta', actores: ['sistema'] },
  conflicto: { desde: ['aprobada'], hacia: 'conflicto', actores: ['sistema'] }
};

const RESULTADOS_INTENTO = [
  'exito',
  'fuente_temporalmente_no_disponible',
  'extraccion_ambigua',
  'fuente_cambio',
  'valor_actual_cambio',
  'identidad_requisito_cambio',
  'propuesta_no_aplicable',
  'revalidacion_vencida',
  'escritura_abortada'
];

const TRANSICION_POR_RESULTADO = {
  extraccion_ambigua: 'entrada_revision',
  fuente_cambio: 'obsolescencia',
  valor_actual_cambio: 'conflicto',
  identidad_requisito_cambio: 'conflicto'
};

const RESULTADOS_CON_TRANSICION = Object.keys(TRANSICION_POR_RESULTADO);

// Eventos que en el MVP solo nacen de un IntentoAplicacion: exigen
// intento_aplicacion_id para poder auditar qué intento los causó.
const TIPOS_EVENTO_CON_INTENTO = ['aplicacion', ...new Set(Object.values(TRANSICION_POR_RESULTADO))];

const ETAPAS_INTENTO = ['precondiciones_propuesta', 'revalidacion_externa', 'escritura_aplicacion', 'transicion_por_fallo'];

// exito no tiene etapa_fallo.
const ETAPAS_POR_RESULTADO = {
  fuente_temporalmente_no_disponible: ['revalidacion_externa'],
  extraccion_ambigua: ['revalidacion_externa'],
  fuente_cambio: ['revalidacion_externa'],
  valor_actual_cambio: ['escritura_aplicacion'],
  identidad_requisito_cambio: ['escritura_aplicacion'],
  propuesta_no_aplicable: ['precondiciones_propuesta', 'escritura_aplicacion'],
  revalidacion_vencida: ['escritura_aplicacion'],
  escritura_abortada: ['escritura_aplicacion', 'transicion_por_fallo']
};

// Mismas categorías de identidad que el piloto de lectura
// (piloto-lectura-uk-eta.js).
const CATEGORIAS_IDENTIDAD_NO_COINCIDE = [
  'destino_no_encontrado',
  'requisito_id_no_encontrado',
  'requisito_id_duplicado',
  'identidad_semantica_no_coincide'
];

const VENTANA_REVALIDACION_MS = 15 * 60 * 1000;

// Devuelve null si la transición es válida, o un mensaje con el motivo.
function motivoTransicionInvalida(tipoEvento, estadoAnterior, estadoNuevo, tipoActor) {
  const regla = TRANSICIONES[tipoEvento];
  if (!regla) return `tipo_evento "${tipoEvento}" no tiene ninguna transición permitida.`;
  if (!regla.desde.includes(estadoAnterior)) {
    return `"${tipoEvento}" solo parte de ${regla.desde.join(', ')} (recibido estado_anterior "${estadoAnterior}").`;
  }
  if (estadoNuevo !== regla.hacia) {
    return `"${tipoEvento}" debe llegar a "${regla.hacia}" (recibido estado_nuevo "${estadoNuevo}").`;
  }
  if (!regla.actores.includes(tipoActor)) {
    return `"${tipoEvento}" exige actor.tipo en [${regla.actores.join(', ')}] (recibido "${tipoActor}").`;
  }
  return null;
}

module.exports = {
  ESTADOS_PROPUESTA,
  ESTADOS_ACTIVOS,
  TIPOS_EVENTO,
  TIPOS_ACTOR,
  TIPOS_QUE_REQUIEREN_MOTIVO,
  TRANSICIONES,
  RESULTADOS_INTENTO,
  TRANSICION_POR_RESULTADO,
  RESULTADOS_CON_TRANSICION,
  TIPOS_EVENTO_CON_INTENTO,
  ETAPAS_INTENTO,
  ETAPAS_POR_RESULTADO,
  CATEGORIAS_IDENTIDAD_NO_COINCIDE,
  VENTANA_REVALIDACION_MS,
  motivoTransicionInvalida
};
