/**
 * Adaptador de revalidación para propuestas de costo del UK ETA contra
 * GOV.UK (Content API). Implementa la interfaz de adaptadores descrita
 * en ./index.js. Toda la lógica de fetch y extracción vive en
 * ../fuentes/govuk-uk-eta.js (la misma que usa el piloto de lectura).
 *
 * revalidar() NUNCA lanza por una falla de la fuente: la devuelve
 * clasificada. Solo lanza ante un error de programación (llamarlo con
 * una propuesta que este adaptador no soporta). Clasificación:
 *  - no_disponible (transitorio, reintentable; la propuesta no cambia
 *    de estado): timeout, error de red, HTTP 408/425/429/5xx, cualquier
 *    otro status no-OK fuera de 4xx, y un body que no es JSON.
 *  - ambiguo (la fuente respondió pero no da un valor inequívoco;
 *    requiere revisión humana): HTTP 404/410 y demás 4xx (la página se
 *    movió o cambió), JSON sin details.parts, secciones overview/apply
 *    ausentes o duplicadas, cero o más de un "£" en una sección, formato
 *    decimal o alfanumérico, u overview ≠ apply. "Ningún £" es ambiguo y
 *    no un cambio de valor: podría significar "ahora es gratis", pero no
 *    es un valor inequívoco.
 *  - valor: overview y apply con el mismo entero. El adaptador NO
 *    compara contra la propuesta; eso lo hace el servicio de aplicación.
 *
 * `revalidada_en` es el instante en que llegó la respuesta (del reloj
 * inyectado), igual que fecha_ejecucion en el piloto. Solo existe si
 * hubo respuesta: no_disponible no la trae (el intento no guarda una
 * revalidación que no terminó).
 *
 * Los avisos de la extracción no se imprimen: quedan en
 * evidencia.avisos. Todo lo que devuelve es canonicalizable (sin
 * undefined), porque termina en IntentoAplicacion.evidencia_fresca.
 */

const {
  URL_ETA,
  FUENTE_NOMBRE,
  MONEDA,
  TIMEOUT_MS,
  REQUISITO_ID_ETA,
  TIPO_REQUISITO_ETA,
  NOMBRE_REQUISITO_ETA,
  ErrorFuenteGovUk,
  fetchJsonConTimeout,
  extraerCostoEta
} = require('../fuentes/govuk-uk-eta');
const { TIPO_PROPUESTA } = require('../canonicalizacion-propuestas');

const NOMBRE = 'govuk-uk-eta';
const VERSION = '1';

// 4xx que describen una falla transitoria y no una fuente que cambió.
const STATUS_4XX_TRANSITORIOS = [408, 425, 429];

function esObjeto(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Pura. Solo propuestas de costo del requisito UK ETA con fuente GOV.UK
// y valor en GBP. Se miran el campo externo y el del payload (el modelo
// exige que coincidan, pero acá no se asume).
function soporta(propuesta) {
  const payload = propuesta?.payload;
  if (!esObjeto(propuesta) || !esObjeto(payload)) return false;
  return (
    propuesta.campo === 'costo' &&
    payload.campo === 'costo' &&
    payload.tipo_propuesta === TIPO_PROPUESTA &&
    propuesta.requisito_id != null &&
    String(propuesta.requisito_id) === REQUISITO_ID_ETA &&
    payload.requisito_id === REQUISITO_ID_ETA &&
    payload.fuente?.nombre === FUENTE_NOMBRE &&
    payload.fuente?.url === URL_ETA &&
    payload.valor_propuesto?.valor_normalizado?.moneda === MONEDA
  );
}

// Pura. requisitoLeido: el subdocumento de destinos.requisitos[] ya
// encontrado por _id. La existencia/unicidad del _id la clasifica el
// servicio; acá solo la identidad semántica (tipo y nombre).
function validarIdentidad(requisitoLeido) {
  const encontrado = {
    tipo: esObjeto(requisitoLeido) ? (requisitoLeido.tipo ?? null) : null,
    nombre: esObjeto(requisitoLeido) ? (requisitoLeido.nombre ?? null) : null
  };
  if (encontrado.tipo === TIPO_REQUISITO_ETA && encontrado.nombre === NOMBRE_REQUISITO_ETA) return { ok: true };
  return {
    ok: false,
    categoria: 'identidad_semantica_no_coincide',
    detalle: { esperado: { tipo: TIPO_REQUISITO_ETA, nombre: NOMBRE_REQUISITO_ETA }, encontrado }
  };
}

function clasificarErrorFuente(err) {
  if (err instanceof ErrorFuenteGovUk && err.causa === 'http') {
    const esAmbiguo = err.status >= 400 && err.status < 500 && !STATUS_4XX_TRANSITORIOS.includes(err.status);
    return { tipo: esAmbiguo ? 'ambiguo' : 'no_disponible', causa: 'http', status: err.status };
  }
  if (err instanceof ErrorFuenteGovUk) return { tipo: 'no_disponible', causa: err.causa, status: null };
  return { tipo: 'no_disponible', causa: 'desconocida', status: null };
}

async function revalidar(propuesta, { timeoutMs = TIMEOUT_MS, ahora = () => new Date(), fetchImpl } = {}) {
  if (!soporta(propuesta)) {
    throw new TypeError(`Adaptador ${NOMBRE}: revalidar() recibió una propuesta que no soporta (error de programación).`);
  }
  const fuente = { fuente_nombre: FUENTE_NOMBRE, url: URL_ETA };

  let json;
  try {
    json = await fetchJsonConTimeout(URL_ETA, timeoutMs, fetchImpl ? { fetchImpl } : {});
  } catch (err) {
    const { tipo, causa, status } = clasificarErrorFuente(err);
    const evidencia = { causa, status, mensaje: String(err?.message ?? err), timeout_ms: timeoutMs };
    if (tipo === 'ambiguo') {
      return { tipo, motivo: `http_${status}`, revalidada_en: ahora(), ...fuente, evidencia };
    }
    return { tipo, motivo: causa === 'http' ? `http_${status}` : causa, evidencia };
  }
  const revalidadaEn = ahora();

  const avisos = [];
  let extraccion;
  try {
    extraccion = extraerCostoEta(json, { avisar: (m) => avisos.push(m) });
  } catch (err) {
    // JSON con una forma que la extracción no contempla (p. ej. un
    // elemento null en details.parts): la fuente respondió, pero no se
    // puede leer un valor. Es ambiguo, no una falla transitoria.
    const evidencia = { error_extraccion: String(err?.message ?? err), avisos };
    return { tipo: 'ambiguo', motivo: 'estructura_inesperada', revalidada_en: revalidadaEn, ...fuente, evidencia };
  }
  const evidencia = { ...extraccion.evidencia, avisos };
  if (extraccion.estado !== 'ok') {
    return { tipo: 'ambiguo', motivo: extraccion.motivos.join(','), revalidada_en: revalidadaEn, ...fuente, evidencia };
  }
  return {
    tipo: 'valor',
    valor: { valor: `£${extraccion.costo}`, valor_normalizado: { importe: extraccion.costo, moneda: extraccion.moneda } },
    revalidada_en: revalidadaEn,
    ...fuente,
    evidencia
  };
}

module.exports = Object.freeze({
  nombre: NOMBRE,
  version: VERSION,
  soporta,
  validarIdentidad,
  revalidar
});
