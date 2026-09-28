/**
 * Registro de adaptadores de revalidación externa y elección del que
 * corresponde a una propuesta.
 *
 * INTERFAZ de un adaptador (objeto congelado):
 *  - nombre, version: strings no vacíos. Se guardan como `adaptador`
 *    en InicioIntentoAplicacion e IntentoAplicacion.
 *  - soporta(propuesta) -> boolean. Pura.
 *  - validarIdentidad(requisitoLeido) -> { ok: true }
 *      | { ok: false, categoria: 'identidad_semantica_no_coincide', detalle }.
 *    Pura. Solo la identidad SEMÁNTICA; destino/_id ausente o
 *    duplicado lo clasifica el servicio.
 *  - revalidar(propuesta, { timeoutMs, ahora, fetchImpl? }) -> Promise de:
 *      { tipo: 'valor', valor: { valor, valor_normalizado }, revalidada_en,
 *        fuente_nombre, url, evidencia }
 *      { tipo: 'no_disponible', motivo, evidencia }
 *      { tipo: 'ambiguo', motivo, revalidada_en, fuente_nombre, url, evidencia }
 *    Nunca lanza por una falla de la fuente; nunca toca Mongo. La
 *    comparación con la propuesta la hace el servicio de aplicación.
 *
 * elegirAdaptador exige que EXACTAMENTE un adaptador soporte la
 * propuesta. Si ninguno o más de uno, lanza ErrorSinAdaptador: sin un
 * adaptador único no hay `adaptador` para registrar el intento, así que
 * el servicio aborta sin persistir nada.
 */

const govukUkEta = require('./govuk-uk-eta');

class ErrorSinAdaptador extends Error {}

const METODOS = ['soporta', 'validarIdentidad', 'revalidar'];

function validarAdaptador(a) {
  const falla = (m) => {
    throw new TypeError(`Adaptador inválido: ${m}`);
  };
  if (a === null || typeof a !== 'object') falla('no es un objeto.');
  for (const campo of ['nombre', 'version']) {
    if (typeof a[campo] !== 'string' || a[campo].trim() === '') falla(`"${campo}" debe ser un string no vacío.`);
  }
  for (const m of METODOS) if (typeof a[m] !== 'function') falla(`${a.nombre}: falta el método ${m}().`);
  if (!Object.isFrozen(a)) falla(`${a.nombre}: debe estar congelado.`);
  return a;
}

const ADAPTADORES = Object.freeze([govukUkEta].map(validarAdaptador));

function elegirAdaptador(propuesta, adaptadores = ADAPTADORES) {
  const candidatos = adaptadores.map(validarAdaptador).filter((a) => a.soporta(propuesta) === true);
  const id = propuesta?.propuesta_id ?? '(sin propuesta_id)';
  if (candidatos.length === 0) throw new ErrorSinAdaptador(`Ningún adaptador de revalidación soporta la propuesta ${id}.`);
  if (candidatos.length > 1) {
    throw new ErrorSinAdaptador(
      `La propuesta ${id} la soportan ${candidatos.length} adaptadores (${candidatos.map((a) => a.nombre).join(', ')}); debe ser exactamente uno.`
    );
  }
  return candidatos[0];
}

module.exports = {
  ADAPTADORES,
  ErrorSinAdaptador,
  validarAdaptador,
  elegirAdaptador
};
