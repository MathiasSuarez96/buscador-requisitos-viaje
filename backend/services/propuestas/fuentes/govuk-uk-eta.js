/**
 * Fuente GOV.UK del UK ETA: fetch con timeout y extracción del costo.
 * Módulo COMPARTIDO entre el piloto de lectura
 * (scripts/piloto-lectura-uk-eta.js) y el adaptador de revalidación
 * (services/propuestas/adaptadores/govuk-uk-eta.js). No sabe nada de
 * propuestas ni de Mongo: no importa Mongoose ni modelos.
 *
 * Las funciones de extracción se movieron TAL CUAL desde el piloto (ver
 * la cabecera del piloto para el razonamiento completo del orden de
 * validación de extraerCosto). Dos cambios, ninguno visible para el
 * piloto:
 *  - `avisar` inyectable en extraerCosto y seleccionarParteUnica. Por
 *    defecto sigue siendo console.warn (resuelto en cada llamada, así
 *    una consola reemplazada en pruebas también lo recibe). El
 *    adaptador lo usa para juntar los avisos en la evidencia en vez de
 *    imprimirlos.
 *  - fetchJsonConTimeout lanza ErrorFuenteGovUk con el MISMO mensaje que
 *    antes y además `causa` ('http' | 'timeout' | 'red' | 'json_invalido')
 *    y `status` (solo en 'http'), para que el adaptador distinga una
 *    falla transitoria de una fuente que cambió. El error original, si
 *    lo hay, queda en `cause`.
 *
 * extraerCostoEta(json) encapsula la decisión overview/apply que el
 * piloto hace inline en main(): devuelve 'ok' solo si ambas secciones
 * existen una sola vez, cada una tiene exactamente un "£" con un entero
 * simple, y los dos importes coinciden. Cualquier otra cosa es
 * 'ambiguo' (con los motivos), nunca un valor elegido.
 * scripts/test-fuente-govuk-uk-eta.js verifica contra el main() real
 * del piloto que ambas decisiones coinciden.
 */

const URL_ETA = 'https://www.gov.uk/api/content/eta';
const FUENTE_NOMBRE = 'GOV.UK';
const MONEDA = 'GBP';
const TIMEOUT_MS = 8000;
const PATRON_COSTO_GLOBAL = /£(\d+)/g;
const VENTANA_FRAGMENTO = 40; // caracteres de contexto a cada lado del match, para el fragmento real de evidencia

// Identidad esperada del requisito en Mongo (ver buscarRequisitoEtaEnMongo
// en el piloto y validarIdentidad en el adaptador).
const CODIGO_ISO_UK = 'GB';
const REQUISITO_ID_ETA = '6aaddd0e9f54309f9d8272dc';
const TIPO_REQUISITO_ETA = 'formulario_digital';
const NOMBRE_REQUISITO_ETA = 'UK ETA';

const avisarPorConsola = (mensaje) => console.warn(mensaje);

class ErrorFuenteGovUk extends Error {
  constructor(mensaje, { causa, status = null, cause } = {}) {
    super(mensaje, cause === undefined ? undefined : { cause });
    this.name = 'ErrorFuenteGovUk';
    this.causa = causa;
    this.status = status;
  }
}

// Recorta un fragmento REAL del HTML recibido, alrededor del match
// (no todo el body, que puede ser muy largo) — esto es evidencia
// verificable, no una interpretación: permite releer si el patrón de
// extracción entendió bien el texto real de GOV.UK.
function extraerFragmento(html, indexInicio, indexFin) {
  const desde = Math.max(0, indexInicio - VENTANA_FRAGMENTO);
  const hasta = Math.min(html.length, indexFin + VENTANA_FRAGMENTO);
  return html.slice(desde, hasta);
}

// Un importe es válido solo si termina en un límite aceptable:
//  - fin de texto, o
//  - un carácter que no sea letra/dígito Y que, si es un punto o una
//    coma, no esté seguido de otro dígito (para no aceptar "20.50" o
//    "20,50" como si fueran el entero 20 — solo se soportan enteros
//    simples).
function esLimiteValido(html, indexFinal) {
  if (indexFinal >= html.length) return true;
  const siguiente = html[indexFinal];
  if (/[0-9a-zA-Z]/.test(siguiente)) return false;
  if (siguiente === '.' || siguiente === ',') {
    const siguienteSiguiente = html[indexFinal + 1];
    if (siguienteSiguiente !== undefined && /\d/.test(siguienteSiguiente)) return false;
  }
  return true;
}

// Orden de validación deliberado (ver cabecera del piloto): primero
// cuenta los símbolos "£" en crudo, y solo si hay exactamente uno pasa
// a evaluar el formato del número que lo sigue.
function extraerCosto(html, { avisar = avisarPorConsola } = {}) {
  if (typeof html !== 'string') return { costo: null, sospechoso: false, fragmento: null };

  const totalSimbolos = (html.match(/£/g) || []).length;

  if (totalSimbolos === 0) {
    return { costo: null, sospechoso: false, fragmento: null };
  }
  if (totalSimbolos > 1) {
    avisar(`SOSPECHOSO: se encontraron ${totalSimbolos} símbolos "£" en la misma sección (se esperaba exactamente uno).`);
    return { costo: null, sospechoso: true, fragmento: null };
  }

  // Hay exactamente un "£": ahora sí se evalúa el formato del número
  // que lo sigue.
  const coincidencias = [...html.matchAll(PATRON_COSTO_GLOBAL)];
  if (coincidencias.length === 0) {
    return { costo: null, sospechoso: false, fragmento: null };
  }

  const match = coincidencias[0];
  const indexFinal = match.index + match[0].length;
  if (!esLimiteValido(html, indexFinal)) {
    avisar('SOSPECHOSO: el único "£" de la sección tiene un formato inesperado (ej. decimal o alfanumérico pegado).');
    return { costo: null, sospechoso: true, fragmento: null };
  }

  return {
    costo: parseInt(match[1], 10),
    sospechoso: false,
    fragmento: extraerFragmento(html, match.index, indexFinal)
  };
}

// Devuelve la parte única con ese slug. Si hay más de una, o ninguna,
// no elige nada y marca por qué (duplicado vs. ausente son casos
// distintos, pero ambos son motivo para no confiar en el dato).
function seleccionarParteUnica(parts, slug, { avisar = avisarPorConsola } = {}) {
  const coincidencias = parts.filter((p) => p.slug === slug);

  if (coincidencias.length > 1) {
    avisar(`SOSPECHOSO: hay ${coincidencias.length} partes con slug "${slug}" (se esperaba una sola).`);
    return { parte: null, sospechoso: true };
  }

  if (coincidencias.length === 0) {
    avisar(`No se encontró la parte con slug "${slug}".`);
    return { parte: null, sospechoso: false };
  }

  return { parte: coincidencias[0], sospechoso: false };
}

// Fetch + parseo de JSON bajo un único deadline: el timeout cubre la
// request Y la lectura completa del body (res.json()), no solo el
// fetch() inicial — si el timer dispara mientras se está leyendo el
// body, el abort también corta esa lectura porque comparte el mismo
// signal. `fetchImpl` se resuelve en cada llamada (por defecto el
// fetch global), así un espía instalado en pruebas lo intercepta.
async function fetchJsonConTimeout(url, timeoutMs, { fetchImpl = globalThis.fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetchImpl(url, { signal: controller.signal });
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new ErrorFuenteGovUk(`Timeout de ${timeoutMs}ms haciendo fetch/lectura a ${url}.`, { causa: 'timeout', cause: err });
      }
      throw new ErrorFuenteGovUk(String(err?.message ?? err), { causa: 'red', cause: err });
    }
    if (!res.ok) {
      throw new ErrorFuenteGovUk(`La API de GOV.UK respondió ${res.status} ${res.statusText}.`, { causa: 'http', status: res.status });
    }
    try {
      return await res.json();
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new ErrorFuenteGovUk(`Timeout de ${timeoutMs}ms haciendo fetch/lectura a ${url}.`, { causa: 'timeout', cause: err });
      }
      // Un body que no es JSON es un SyntaxError; cualquier otro error
      // leyendo el body (conexión cortada a mitad) es de red.
      const causa = err instanceof SyntaxError ? 'json_invalido' : 'red';
      throw new ErrorFuenteGovUk(String(err?.message ?? err), { causa, cause: err });
    }
  } finally {
    clearTimeout(timer);
  }
}

function resumenFuenteGovUk(json) {
  if (!json) return null;
  return {
    url: URL_ETA,
    // ?? null: si GOV.UK no manda alguna fecha, no debe llegar
    // undefined a la evidencia (la canonicalización toc-v1 lo rechaza).
    first_published_at: json.first_published_at ?? null,
    public_updated_at: json.public_updated_at ?? null,
    updated_at: json.updated_at ?? null
  };
}

function resumenEvidencia(resultadoOverview, resultadoApply) {
  return {
    overview: { costo_extraido: resultadoOverview.costo, moneda: MONEDA, fragmento_html: resultadoOverview.fragmento },
    apply: { costo_extraido: resultadoApply.costo, moneda: MONEDA, fragmento_html: resultadoApply.fragmento }
  };
}

const SIN_EXTRACCION = Object.freeze({ costo: null, sospechoso: false, fragmento: null });

// Pura (salvo `avisar`). Misma decisión que el piloto en main(): 'ok'
// solo con overview y apply únicos, sin sospecha y con el mismo
// importe. `motivos` enumera TODO lo que falló, no solo lo primero.
function extraerCostoEta(json, { avisar = avisarPorConsola } = {}) {
  const fuente_govuk = resumenFuenteGovUk(json);
  const parts = json?.details?.parts;
  if (!Array.isArray(parts)) {
    return {
      estado: 'ambiguo',
      motivos: ['sin_details_parts'],
      costo: null,
      moneda: null,
      evidencia: { fuente_govuk, extraccion: null }
    };
  }

  const overview = seleccionarParteUnica(parts, 'overview', { avisar });
  const apply = seleccionarParteUnica(parts, 'apply', { avisar });
  const resultadoOverview = overview.parte ? extraerCosto(overview.parte.body, { avisar }) : SIN_EXTRACCION;
  const resultadoApply = apply.parte ? extraerCosto(apply.parte.body, { avisar }) : SIN_EXTRACCION;

  const motivos = [];
  for (const [slug, seleccion, resultado] of [
    ['overview', overview, resultadoOverview],
    ['apply', apply, resultadoApply]
  ]) {
    if (seleccion.sospechoso) motivos.push(`${slug}_duplicado`);
    else if (!seleccion.parte) motivos.push(`${slug}_ausente`);
    else if (resultado.sospechoso) motivos.push(`${slug}_formato_sospechoso`);
    else if (resultado.costo === null) motivos.push(`${slug}_sin_costo`);
  }
  if (motivos.length === 0 && resultadoOverview.costo !== resultadoApply.costo) motivos.push('overview_apply_distintos');

  const evidencia = { fuente_govuk, extraccion: resumenEvidencia(resultadoOverview, resultadoApply) };
  if (motivos.length > 0) {
    return { estado: 'ambiguo', motivos, costo: null, moneda: null, evidencia };
  }
  evidencia.comparacion_govuk = {
    coincide_entre_secciones: true,
    costo_extraido_consistente: resultadoOverview.costo,
    moneda: MONEDA
  };
  return { estado: 'ok', motivos: [], costo: resultadoOverview.costo, moneda: MONEDA, evidencia };
}

module.exports = {
  URL_ETA,
  FUENTE_NOMBRE,
  MONEDA,
  TIMEOUT_MS,
  PATRON_COSTO_GLOBAL,
  VENTANA_FRAGMENTO,
  CODIGO_ISO_UK,
  REQUISITO_ID_ETA,
  TIPO_REQUISITO_ETA,
  NOMBRE_REQUISITO_ETA,
  ErrorFuenteGovUk,
  extraerFragmento,
  esLimiteValido,
  extraerCosto,
  seleccionarParteUnica,
  fetchJsonConTimeout,
  resumenFuenteGovUk,
  resumenEvidencia,
  extraerCostoEta
};
