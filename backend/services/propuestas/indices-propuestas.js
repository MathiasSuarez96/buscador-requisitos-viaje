/**
 * Índices de CORRECCIÓN que cada servicio exige antes de escribir, y el
 * gate puro que los verifica contra listIndexes(). Única fuente de
 * verdad: scripts/crear-indices-propuestas.js crea exactamente estos
 * specs y clasifica con evaluarIndice(), así que el creador y el gate
 * aceptan y rechazan las mismas formas.
 *
 * Solo índices de corrección (unicidad que protege invariantes). Los
 * índices de rendimiento declarados en los schemas NO están acá: su
 * ausencia no pone en riesgo la integridad y ningún servicio se niega a
 * escribir por ellos.
 *
 * Conjuntos:
 *  - INDICES_REGISTRO: servicio de registro de ejecuciones de lectura.
 *  - INDICES_DECISION: aprobar / rechazar / cancelar.
 *  - INDICES_APLICACION: aplicación (incluye los de decisión, porque
 *    también mueve estado e inserta eventos).
 */

const { canonicalizarValor } = require('./canonicalizacion-propuestas');
const { ESTADOS_ACTIVOS } = require('./contrato-propuestas');

class ErrorPrecondicionIndices extends Error {}

const INDICE_PROPUESTA_ACTIVA = 'uniq_propuesta_activa_por_destino_requisito_campo';
const CLAVE_INDICE_PROPUESTA_ACTIVA = { destino_id: 1, requisito_id: 1, campo: 1 };

const unico = (coleccion, nombre, clave, partialFilterExpression = null) => ({
  coleccion,
  nombre,
  clave,
  partialFilterExpression
});

const IDX = {
  ejecucionRunId: unico('ejecuciones_lectura', 'run_id_1', { run_id: 1 }),
  propuestaId: unico('propuestas_cambio', 'propuesta_id_1', { propuesta_id: 1 }),
  propuestaActiva: unico('propuestas_cambio', INDICE_PROPUESTA_ACTIVA, CLAVE_INDICE_PROPUESTA_ACTIVA, {
    estado: { $in: ESTADOS_ACTIVOS }
  }),
  eventoId: unico('eventos_propuesta', 'evento_id_1', { evento_id: 1 }),
  eventoPorVersion: unico('eventos_propuesta', 'uniq_evento_por_propuesta_version', {
    propuesta_id: 1,
    version_coordinacion_nueva: 1
  }),
  intentoId: unico('intentos_aplicacion', 'intento_id_1', { intento_id: 1 }),
  intentoExitoso: unico('intentos_aplicacion', 'uniq_intento_exitoso_por_propuesta', { propuesta_id: 1 }, { resultado: 'exito' }),
  historialId: unico('historial_cambios', 'historial_id_1', { historial_id: 1 }),
  historialPropuesta: unico('historial_cambios', 'propuesta_id_1', { propuesta_id: 1 }),
  historialIntento: unico('historial_cambios', 'intento_aplicacion_id_1', { intento_aplicacion_id: 1 }),
  inicioIntentoId: unico('inicios_intento_aplicacion', 'intento_id_1', { intento_id: 1 })
};

const INDICES_REGISTRO = [IDX.ejecucionRunId, IDX.propuestaId, IDX.propuestaActiva];
const INDICES_DECISION = [IDX.propuestaId, IDX.propuestaActiva, IDX.eventoId, IDX.eventoPorVersion];
const INDICES_APLICACION = [
  ...INDICES_DECISION,
  IDX.intentoId,
  IDX.intentoExitoso,
  IDX.historialId,
  IDX.historialPropuesta,
  IDX.historialIntento,
  IDX.inicioIntentoId
];

const CONJUNTOS_INDICES = {
  registro: INDICES_REGISTRO,
  decision: INDICES_DECISION,
  aplicacion: INDICES_APLICACION
};

// Campos que puede traer un índice de listIndexes() para contar como
// forma exacta. Cualquier otro (sparse, collation, hidden, expireAfterSeconds...)
// cambia la semántica y se rechaza.
const CAMPOS_PERMITIDOS_INDICE = ['v', 'key', 'name', 'unique', 'partialFilterExpression', 'ns'];

// La clave se compara SIN canonicalizar: en un índice compuesto el
// orden de los campos es parte de la definición.
const mismaClave = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const mismaForma = (a, b) => JSON.stringify(canonicalizarValor(a ?? null)) === JSON.stringify(canonicalizarValor(b ?? null));

// Pura. Diferencias entre un índice listado y su spec ([] = forma exacta).
function diferenciasIndice(existente, spec) {
  const diffs = [];
  if (existente.name !== spec.nombre) diffs.push(`name=${existente.name} (esperado ${spec.nombre})`);
  if (!mismaClave(existente.key, spec.clave)) {
    diffs.push(`key=${JSON.stringify(existente.key)} (esperado ${JSON.stringify(spec.clave)})`);
  }
  if (existente.unique !== true) diffs.push(`unique=${existente.unique} (esperado true)`);
  if (!mismaForma(existente.partialFilterExpression, spec.partialFilterExpression)) {
    diffs.push(
      `partialFilterExpression=${JSON.stringify(existente.partialFilterExpression ?? null)} (esperado ${JSON.stringify(spec.partialFilterExpression)})`
    );
  }
  for (const campo of Object.keys(existente)) {
    if (!CAMPOS_PERMITIDOS_INDICE.includes(campo)) diffs.push(`${campo}=${JSON.stringify(existente[campo])} (no esperado)`);
  }
  return diffs;
}

// Pura. Clasifica un spec contra el listado de su colección:
//  - 'ya_existe': hay un índice con ese nombre, con forma exacta, y
//    ningún otro índice con la misma clave.
//  - 'crear': no hay ningún índice con ese nombre ni con esa clave.
//  - 'conflicto': cualquier otra cosa (mismo nombre con otra forma, u
//    otro índice con la misma clave).
function evaluarIndice(existentes, spec) {
  const porNombre = existentes.find((i) => i.name === spec.nombre);
  const problemas = existentes
    .filter((i) => i.name !== spec.nombre && mismaClave(i.key, spec.clave))
    .map((i) => `ya existe "${i.name}" con la misma clave ${JSON.stringify(spec.clave)}`);
  if (porNombre) problemas.push(...diferenciasIndice(porNombre, spec));

  if (problemas.length > 0) return { estado: 'conflicto', problemas };
  return { estado: porNombre ? 'ya_existe' : 'crear', problemas: [] };
}

function coleccionesDe(specs) {
  return [...new Set(specs.map((spec) => spec.coleccion))];
}

// Pura. listados: { [coleccion]: índices de listIndexes() } (colección
// ausente = inexistente). Pasa solo si todos los specs dan 'ya_existe'.
function verificarConjuntoIndices(specs, listados) {
  const fallas = [];
  for (const spec of specs) {
    const { estado, problemas } = evaluarIndice(listados[spec.coleccion] ?? [], spec);
    if (estado === 'crear') fallas.push(`falta ${spec.coleccion}.${spec.nombre}`);
    if (estado === 'conflicto') fallas.push(`${spec.coleccion}.${spec.nombre}: ${problemas.join('; ')}`);
  }
  if (fallas.length > 0) {
    throw new ErrorPrecondicionIndices(
      `Índices ausentes o con forma distinta a la exigida. No se escribe nada.\n  - ${fallas.join('\n  - ')}`
    );
  }
}

module.exports = {
  ErrorPrecondicionIndices,
  INDICE_PROPUESTA_ACTIVA,
  CLAVE_INDICE_PROPUESTA_ACTIVA,
  INDICES_REGISTRO,
  INDICES_DECISION,
  INDICES_APLICACION,
  CONJUNTOS_INDICES,
  diferenciasIndice,
  evaluarIndice,
  coleccionesDe,
  verificarConjuntoIndices
};
