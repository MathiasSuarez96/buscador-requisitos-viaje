/**
 * PILOTO de solo lectura: extraer el costo del UK ETA desde la fuente
 * oficial gov.uk, como prueba de concepto para la Fase 2.
 *
 * Fuente: https://www.gov.uk/api/content/eta (Content API de GOV.UK,
 * licencia Open Government Licence). Investigación de la licencia ya
 * cerrada, no se repite en detalle acá; en resumen cubre: uso comercial
 * permitido con atribución, exención de datos personales (la OGL no
 * aplica a datos personales que pudieran aparecer en el contenido) y
 * verificación de que el contenido de la página no incluye material de
 * terceros con licencia distinta.
 *
 * El costo NO viene en un campo estructurado del JSON: está embebido
 * como texto dentro del HTML de details.parts[], en las partes con
 * slug "overview" y slug "apply". Alcance de este piloto: el dato real
 * es un entero simple ("£20"), así que el patrón /£(\d+)/ NO soporta
 * separadores de miles ni decimales — si aparece algo con forma
 * decimal ("£20.50" o "£20,50") se trata como formato inesperado, no
 * como un costo con centavos.
 *
 * extraerCosto() valida en este orden (a propósito, no al revés):
 *  1. Cuenta cuántas veces aparece el símbolo "£" en el texto CRUDO,
 *     antes de mirar el formato de ningún número. Si no hay
 *     exactamente uno, se marca sospechoso de inmediato, sin evaluar
 *     formato. Esto evita un caso que un chequeo "solo de formato"
 *     dejaría pasar: "£20 y £30abc" tiene dos símbolos £, pero si
 *     "£30abc" se descarta primero por formato inválido, queda un
 *     solo importe "válido" (20) y se aceptaría sin señalar que había
 *     dos precios distintos en el texto.
 *  2. Solo si hay exactamente un "£", se evalúa el formato del número
 *     que lo sigue: se descarta (sospechoso) si queda pegado a un
 *     carácter alfanumérico (ej. "£20m") o seguido de un punto o coma
 *     y luego otro dígito (ej. "£20.50", "£20,50", "£20.50.75").
 *
 * Luego compara el importe de "overview" contra el de "apply": si no
 * coinciden, si alguno no matcheó, o si hay slugs duplicados, se
 * loguea como sospechoso y NO se asume ningún valor como válido.
 *
 * Paso adicional (SOLO LECTURA en Mongo): una vez que el costo de
 * GOV.UK quedó confirmado (overview === apply, sin ambigüedad), se lee
 * — nunca se escribe — el requisito exacto de Reino Unido en Mongo
 * (destino codigo_iso "GB", requisito con tipo === "formulario_digital"
 * Y nombre === "UK ETA"; es el único requisito de ese destino que
 * corresponde al eTA en sí, a diferencia del requisito "visa" que solo
 * lo menciona en su descripción). Se parsea el texto libre de su campo
 * `costo` (String opcional, sin contrato de formato en el schema — ver
 * Destino.model.js) para separar importe y moneda, y se compara contra
 * el importe/moneda de GOV.UK (moneda siempre "GBP", porque el patrón
 * busca literalmente el símbolo "£"). El valor original de Mongo se
 * conserva tal cual se imprime (nunca se reescribe).
 *
 * parsearCostoMongo() SOLO acepta formatos completos y simples —
 * exige que el texto ENTERO (recortado) sea exactamente uno de:
 * "£20", "GBP 20", "20 GBP", "$20" o "20$". No busca esos patrones
 * como subcadena dentro de un texto más largo: eso es lo que antes
 * dejaba pasar basura como "20.50 GBP" matcheando "50 GBP" (el "50"
 * es en realidad la parte decimal de "20.50", no un importe propio).
 * Al exigir que el string completo matchee, ese caso ya no matchea
 * ningún patrón y cae directo en "ambiguo".
 *
 * El símbolo "$" NO identifica una moneda con certeza (podría ser
 * USD, pero también otras) — se guarda como moneda 'AMBIGUA', nunca
 * como 'USD' por defecto. compararConMongo() siempre chequea la
 * moneda ANTES del importe: si la moneda es 'AMBIGUA' o distinta de
 * la de GOV.UK, no se llega a comparar el número — "25 USD" vs
 * "20 GBP" (o incluso "20 USD" vs "20 GBP") no es una comparación de
 * precio válida aunque el número coincida por casualidad.
 *
 * Categorías de compararConMongo() (cada una con un flag `ambiguo`
 * explícito, usado para decidir el código de salida — ver más abajo):
 *  - SIN_COSTO_PREVIO_EN_MONGO (ambiguo: false): el campo es
 *    undefined, null, string vacío, o el placeholder "verificar"
 *    (visto hoy en otros destinos). No hay nada que comparar; la
 *    lectura fue limpia, simplemente no hay dato todavía.
 *  - VALOR_INESPERADO_EN_MONGO (ambiguo: true): el campo EXISTE pero
 *    no es un string (ej. quedó guardado un Number u Object por fuera
 *    del schema) — un caso muy distinto de "no hay dato todavía", y
 *    señal real de que algo escribió mal el documento.
 *  - FORMATO_AMBIGUO_EN_MONGO (ambiguo: true): es un string no vacío
 *    que no matchea ninguno de los formatos exactos soportados.
 *  - MONEDA_AMBIGUA (ambiguo: true): matcheó "$20"/"20$" — hay un
 *    importe pero la moneda no se puede confirmar.
 *  - MONEDA_DISTINTA (ambiguo: false): moneda identificada con
 *    certeza y distinta de la de GOV.UK — lectura limpia, hallazgo
 *    real, no una falla del script.
 *  - IMPORTE_NO_COINCIDE (ambiguo: false): misma moneda (GBP), pero
 *    los números no son iguales — también un hallazgo limpio.
 *  - COINCIDE (ambiguo: false): misma moneda y mismo importe.
 * IMPORTANTE: esta comparación es de COSTO ÚNICAMENTE. Que el costo
 * coincida no implica que todo el requisito esté verificado (fuente,
 * obligatoriedad, vigencia del link, etc. no se tocan ni se
 * re-evalúan acá) — por eso este script jamás escribe `estado` ni
 * `fecha_verificacion`.
 *
 * Advertencia de diseño: hoy, en las 27 destinos de la base, el ÚNICO
 * requisito con `costo` no vacío en TODA la colección es el string
 * literal "verificar" (Aruba, ED Card) — no existe ningún ejemplo real
 * de texto con importe+moneda para calibrar parsearCostoMongo(). El
 * formato soportado es deliberadamente mínimo (solo GBP con certeza,
 * "$" marcado como ambiguo, nada más) y NO probado contra datos
 * reales; ampliarlo en cuanto aparezca el primer caso real.
 *
 * Alcance de HOY, estrictamente:
 *  - Fetch de solo lectura a la API pública de GOV.UK (con timeout que
 *    cubre tanto la request como la lectura completa del body).
 *  - Lectura de solo lectura en Mongo (mongoose.connect + Destino.find,
 *    sin updateOne/save/create/delete de ningún tipo) del único
 *    requisito de Reino Unido identificado arriba.
 *  - NO escribe nada en Mongo: no toca costo, no toca estado, no toca
 *    fecha_verificacion, no toca ningún otro campo del destino de
 *    Reino Unido ni de ningún otro destino.
 *  - NO guarda fecha_verificacion: las fechas del JSON de GOV.UK
 *    (first_published_at, public_updated_at, updated_at) se imprimen
 *    solo para inspección, no se persisten. Este piloto verifica un
 *    costo puntual, no el requisito completo (fuente, descripción,
 *    obligatoriedad, etc.) — la fecha_verificacion la define nuestra
 *    propia corrida de migración cuando se verifique el requisito
 *    completo, no el sitio fuente ni este piloto.
 *
 * No hay modo DRY_RUN porque no hay ninguna escritura que simular.
 *
 * Código de salida: process.exitCode = 1 SOLO cuando algo impidió
 * llegar a una conclusión confiable — sospechoso del lado de GOV.UK,
 * requisito de Mongo no identificable sin ambigüedad, un error real
 * (fetch, parseo, conexión a Mongo), o una categoría de
 * compararConMongo() con `ambiguo: true`. Una comparación que se
 * completó bien y encontró una diferencia real (importe distinto,
 * moneda distinta) o simplemente que no hay costo previo en Mongo NO
 * es un fallo del script, así que esos casos salen con código 0. En
 * ningún camino se usa process.exit() directo, para no cortar el
 * output de consola en curso.
 *
 * Salida adicional (con DATOS REALES de la corrida, no ilustrativos):
 *  - Cada corrida genera un `run_id` propio (crypto.randomUUID()) al
 *    empezar. Ese mismo run_id aparece en el registro de ejecución
 *    (campo `run_id`) y en la propuesta de cambio (campo
 *    `run_id_origen`), para poder conectarlos.
 *  - `fecha_ejecucion` se captura apenas llega la respuesta de GOV.UK
 *    (justo después del fetch), NO después de comparar contra Mongo —
 *    así el timestamp refleja el momento real en que se obtuvo la
 *    evidencia, sin la duración variable de la parte de Mongo.
 *  - "registro de ejecución": se imprime SIEMPRE, tanto si la corrida
 *    llega a un resultado (`resultado_general: 'ok'`) como si algo
 *    falla en el camino (`resultado_general: 'fallo'`). En el caso de
 *    fallo incluye `etapa_fallo` (en qué paso se rompió: fetch_govuk,
 *    parseo_govuk, comparacion_govuk, conexion_mongo,
 *    identificacion_requisito_mongo, o desconocida), el mensaje de
 *    `error`, y `datos_obtenidos` con lo que sí se llegó a conseguir
 *    antes de fallar (puede ser null/vacío si falló en el primer
 *    fetch). Los dos casos explícitos que SIEMPRE producen un registro
 *    de fallo son: GOV.UK sospechoso (overview/apply no coinciden), y
 *    el requisito de Mongo no identificable sin ambigüedad. En ningún
 *    caso de fallo se genera una propuesta.
 *  - Con fecha real, el _id real del destino en Mongo, el estado
 *    ESTRUCTURAL real del campo `costo` (ausente/nulo_explicito
 *    /presente — ver determinarEstadoValorCosto, que usa
 *    Object.hasOwn() para distinguir "la clave no existe" de
 *    "compararla contra undefined"), y los fragmentos de HTML
 *    realmente recibidos de GOV.UK alrededor del match (no todo el
 *    body, solo una ventana de contexto — ver extraerFragmento).
 *    NO incluye requisito_id: ese identificador no existe hoy, porque
 *    requisitoSchema declara `{ _id: false }` (los subdocumentos de
 *    requisitos[] no tienen _id propio en Mongo). En su lugar se deja
 *    explícito el criterio real usado para identificar el requisito:
 *    tipo + nombre, exigiendo coincidencia única (buscarRequisitoEtaEnMongo).
 *  - "propuesta de cambio": SOLO se genera si la categoría es
 *    SIN_COSTO_PREVIO_EN_MONGO o IMPORTE_NO_COINCIDE (ver
 *    debeGenerarPropuesta — hay algo real que proponer). Si la
 *    categoría es COINCIDE, no se genera nada (no hay cambio que
 *    proponer). Si es una categoría ambigua (FORMATO_AMBIGUO_EN_MONGO,
 *    MONEDA_AMBIGUA, VALOR_INESPERADO_EN_MONGO) tampoco se genera
 *    propuesta — solo se informa por consola que no se propone ningún
 *    valor, y sigue habiendo que revisar a mano. La condición futura
 *    de escritura atómica que documenta la propuesta describe
 *    condiciones REALES sobre el documento de Mongo (que la clave
 *    costo no exista, sea null, o sea exactamente igual al valor
 *    leído), no la etiqueta `estado_valor` en sí — esa etiqueta es
 *    solo una forma de presentarlo en este JSON.
 *  - Este script NUNCA genera un "historial" como si un cambio ya se
 *    hubiera aplicado — eso sigue siendo comportamiento futuro y NO
 *    se simula acá, ni siquiera cuando hay una propuesta.
 */

require('dotenv').config();
const crypto = require('crypto');
const mongoose = require('mongoose');
const Destino = require('../models/Destino.model');

const DB_ESPERADA = 'buscador_requisitos';
const CODIGO_ISO_UK = 'GB';
const TIPO_REQUISITO_ETA = 'formulario_digital';
const NOMBRE_REQUISITO_ETA = 'UK ETA';

const URL_ETA = 'https://www.gov.uk/api/content/eta';
const PATRON_COSTO_GLOBAL = /£(\d+)/g;
const TIMEOUT_MS = 8000;
const VENTANA_FRAGMENTO = 40; // caracteres de contexto a cada lado del match, para el fragmento real de evidencia

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
//    "20,50" como si fueran el entero 20 — este piloto solo soporta
//    enteros simples).
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

// Orden de validación deliberado (ver comentario arriba de la clase de
// archivo): primero cuenta los símbolos "£" en crudo, y solo si hay
// exactamente uno pasa a evaluar el formato del número que lo sigue.
function extraerCosto(html) {
  if (typeof html !== 'string') return { costo: null, sospechoso: false, fragmento: null };

  const totalSimbolos = (html.match(/£/g) || []).length;

  if (totalSimbolos === 0) {
    return { costo: null, sospechoso: false, fragmento: null };
  }
  if (totalSimbolos > 1) {
    console.warn(`SOSPECHOSO: se encontraron ${totalSimbolos} símbolos "£" en la misma sección (se esperaba exactamente uno).`);
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
    console.warn('SOSPECHOSO: el único "£" de la sección tiene un formato inesperado (ej. decimal o alfanumérico pegado).');
    return { costo: null, sospechoso: true, fragmento: null };
  }

  return {
    costo: parseInt(match[1], 10),
    sospechoso: false,
    fragmento: extraerFragmento(html, match.index, indexFinal)
  };
}

// --- Comparación de solo lectura contra el requisito de Mongo ---

// Formatos EXACTOS y completos que se aceptan (el texto recortado
// tiene que matchear ENTERO, no como subcadena — ver comentario de
// cabecera). "$"/"20$" quedan con moneda 'AMBIGUA' a propósito: el
// símbolo "$" no identifica una moneda concreta con certeza.
const PATRONES_COSTO_MONGO = [
  { regex: /^£(\d+)$/, moneda: 'GBP' },
  { regex: /^GBP\s(\d+)$/i, moneda: 'GBP' },
  { regex: /^(\d+)\sGBP$/i, moneda: 'GBP' },
  { regex: /^\$(\d+)$/, moneda: 'AMBIGUA' },
  { regex: /^(\d+)\$$/, moneda: 'AMBIGUA' }
];

// Parsea el campo `costo` de Mongo (String opcional, sin contrato de
// formato en el schema) distinguiendo TRES motivos distintos para no
// tener un importe usable, en vez de una sola categoría "no hay dato":
//  - 'sin_dato': undefined, null, string vacío, o el placeholder
//    "verificar" — la lectura fue limpia, simplemente no hay costo
//    guardado todavía.
//  - 'tipo_inesperado': el campo EXISTE pero no es un string (ej. un
//    Number u Object que se coló por fuera del schema) — señal real
//    de un documento mal escrito, muy distinto de "no hay dato".
//  - 'ambiguo': es un string no vacío que no matchea ENTERO ninguno
//    de los formatos exactos soportados (incluye cosas como
//    "20.50 GBP", donde el texto completo no es igual a ninguno de
//    los patrones aunque contenga un fragmento parecido).
//  - 'ok': matcheó un formato exacto — importe y moneda ya resueltos.
function parsearCostoMongo(valor) {
  if (valor === undefined || valor === null) {
    return { estado: 'sin_dato', importe: null, moneda: null };
  }
  if (typeof valor !== 'string') {
    return { estado: 'tipo_inesperado', importe: null, moneda: null };
  }

  const texto = valor.trim();
  if (texto === '' || texto.toLowerCase() === 'verificar') {
    return { estado: 'sin_dato', importe: null, moneda: null };
  }

  for (const patron of PATRONES_COSTO_MONGO) {
    const match = texto.match(patron.regex);
    if (match) {
      return { estado: 'ok', importe: parseInt(match[1], 10), moneda: patron.moneda };
    }
  }

  return { estado: 'ambiguo', importe: null, moneda: null };
}

// Clasifica la comparación en categorías separadas — nunca decide un
// valor nuevo, solo describe qué encontró. `costoOriginalMongo` se
// devuelve tal cual estaba en Mongo, sin modificarlo. Cada categoría
// trae su propio flag `ambiguo` (ver main() para cómo se usa en el
// código de salida): la moneda se chequea SIEMPRE antes del importe,
// para no comparar números de monedas distintas (o inciertas) como si
// fuera una comparación de precio válida.
function compararConMongo(costoGovUk, monedaGovUk, costoOriginalMongo) {
  const parseado = parsearCostoMongo(costoOriginalMongo);

  if (parseado.estado === 'tipo_inesperado') {
    return { categoria: 'VALOR_INESPERADO_EN_MONGO', ambiguo: true, costoOriginalMongo };
  }
  if (parseado.estado === 'sin_dato') {
    return { categoria: 'SIN_COSTO_PREVIO_EN_MONGO', ambiguo: false, costoOriginalMongo };
  }
  if (parseado.estado === 'ambiguo') {
    return { categoria: 'FORMATO_AMBIGUO_EN_MONGO', ambiguo: true, costoOriginalMongo };
  }

  if (parseado.moneda === 'AMBIGUA') {
    return { categoria: 'MONEDA_AMBIGUA', ambiguo: true, costoOriginalMongo, importeMongo: parseado.importe };
  }
  if (parseado.moneda !== monedaGovUk) {
    return {
      categoria: 'MONEDA_DISTINTA',
      ambiguo: false,
      costoOriginalMongo,
      monedaMongo: parseado.moneda,
      monedaGovUk
    };
  }
  if (parseado.importe !== costoGovUk) {
    return {
      categoria: 'IMPORTE_NO_COINCIDE',
      ambiguo: false,
      costoOriginalMongo,
      importeMongo: parseado.importe,
      importeGovUk: costoGovUk
    };
  }
  return { categoria: 'COINCIDE', ambiguo: false, costoOriginalMongo };
}

// SOLO estas dos categorías representan "hay algo real que proponer".
// COINCIDE no necesita propuesta (no hay cambio), y las categorías
// ambiguas no tienen un valor confiable para proponer.
const CATEGORIAS_QUE_GENERAN_PROPUESTA = ['SIN_COSTO_PREVIO_EN_MONGO', 'IMPORTE_NO_COINCIDE'];

function debeGenerarPropuesta(categoria) {
  return CATEGORIAS_QUE_GENERAN_PROPUESTA.includes(categoria);
}

// Estado ESTRUCTURAL real del campo `costo` en el documento — no una
// interpretación. Usa Object.hasOwn() para comprobar la EXISTENCIA de
// la clave antes de mirar su valor (en vez de comparar costo contra
// undefined, que no distingue "la clave no está" de "está pero es
// undefined"). "ausente" (la clave no existe) y "nulo_explicito"
// (existe pero es null) son hechos de estructura únicamente: no
// implican por sí solos que "nunca se completó" o que "no está
// verificado" (pudo borrarse, pudo quedar así por un default), y
// ninguno de los dos se interpreta como costo cero/gratuito.
function determinarEstadoValorCosto(requisito) {
  if (!Object.hasOwn(requisito, 'costo')) return 'ausente';
  if (requisito.costo === null) return 'nulo_explicito';
  return 'presente';
}

// Identifica el requisito SIN usar un requisito_id: ese identificador
// no existe hoy, porque requisitoSchema declara `{ _id: false }` (los
// subdocumentos de requisitos[] no tienen _id propio en Mongo). El
// criterio real es tipo + nombre, exigiendo coincidencia única (el
// requisito "visa" del mismo destino solo MENCIONA el eTA en su
// descripción, no es el mismo requisito). Si no hay exactamente uno,
// no se elige ninguno. También devuelve el _id REAL del destino (ese
// sí existe hoy en Mongo).
async function buscarRequisitoEtaEnMongo() {
  const destino = await Destino.findOne({ codigo_iso: CODIGO_ISO_UK }).lean();
  if (!destino) {
    return { requisito: null, destinoId: null, motivo: `No se encontró destino con codigo_iso "${CODIGO_ISO_UK}".` };
  }

  const coincidencias = (destino.requisitos || []).filter(
    (r) => r.tipo === TIPO_REQUISITO_ETA && r.nombre === NOMBRE_REQUISITO_ETA
  );

  if (coincidencias.length === 0) {
    return { requisito: null, destinoId: destino._id, motivo: `No se encontró ningún requisito con tipo "${TIPO_REQUISITO_ETA}" y nombre "${NOMBRE_REQUISITO_ETA}" en ${destino.pais}.` };
  }
  if (coincidencias.length > 1) {
    return { requisito: null, destinoId: destino._id, motivo: `Se encontraron ${coincidencias.length} requisitos con tipo "${TIPO_REQUISITO_ETA}" y nombre "${NOMBRE_REQUISITO_ETA}" en ${destino.pais} (se esperaba uno solo).` };
  }

  return { requisito: coincidencias[0], destinoId: destino._id, motivo: null };
}

// Devuelve la parte única con ese slug. Si hay más de una, o ninguna,
// no elige nada y marca por qué (duplicado vs. ausente son casos
// distintos, pero ambos son motivo para no confiar en el dato).
function seleccionarParteUnica(parts, slug) {
  const coincidencias = parts.filter((p) => p.slug === slug);

  if (coincidencias.length > 1) {
    console.warn(`SOSPECHOSO: hay ${coincidencias.length} partes con slug "${slug}" (se esperaba una sola).`);
    return { parte: null, sospechoso: true };
  }

  if (coincidencias.length === 0) {
    console.warn(`No se encontró la parte con slug "${slug}".`);
    return { parte: null, sospechoso: false };
  }

  return { parte: coincidencias[0], sospechoso: false };
}

// Fetch + parseo de JSON bajo un único deadline: el timeout cubre la
// request Y la lectura completa del body (res.json()), no solo el
// fetch() inicial — si el timer dispara mientras se está leyendo el
// body, el abort también corta esa lectura porque comparte el mismo
// signal.
async function fetchJsonConTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`La API de GOV.UK respondió ${res.status} ${res.statusText}.`);
    }
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Timeout de ${timeoutMs}ms haciendo fetch/lectura a ${url}.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// --- Construcción de la salida de consola (registro / propuesta) ---

function resumenFuenteGovUk(json) {
  if (!json) return null;
  return {
    url: URL_ETA,
    first_published_at: json.first_published_at,
    public_updated_at: json.public_updated_at,
    updated_at: json.updated_at
  };
}

function resumenEvidencia(resultadoOverview, resultadoApply) {
  return {
    overview: { costo_extraido: resultadoOverview.costo, moneda: 'GBP', fragmento_html: resultadoOverview.fragmento },
    apply: { costo_extraido: resultadoApply.costo, moneda: 'GBP', fragmento_html: resultadoApply.fragmento }
  };
}

// Registro de ejecución para el camino de FALLO: se imprime siempre
// que algo impidió llegar a una conclusión (GOV.UK sospechoso,
// requisito de Mongo no identificable, o un error real en cualquier
// etapa). NUNCA acompañado de una propuesta.
function imprimirRegistroFallo({ runId, fechaEjecucion, etapaFallo, error, datosObtenidos }) {
  const registro = {
    tipo_registro: 'ejecucion_lectura',
    run_id: runId,
    resultado_general: 'fallo',
    fecha_ejecucion: fechaEjecucion,
    etapa_fallo: etapaFallo,
    error,
    datos_obtenidos: datosObtenidos,
    escritura_realizada: false
  };
  console.log('\n=== REGISTRO DE EJECUCIÓN (FALLO) ===');
  console.log(JSON.stringify(registro, null, 2));
}

async function main() {
  const runId = crypto.randomUUID();
  let etapaActual = 'fetch_govuk';
  let fechaEjecucion = null;
  let json = null;
  let resultadoOverview = { costo: null, sospechoso: false, fragmento: null };
  let resultadoApply = { costo: null, sospechoso: false, fragmento: null };
  let destinoId = null;

  try {
    console.log(`Fetch de solo lectura a: ${URL_ETA} (timeout ${TIMEOUT_MS}ms, cubre request + lectura de body)\n`);

    json = await fetchJsonConTimeout(URL_ETA, TIMEOUT_MS);
    // fecha_ejecucion se captura apenas llega la respuesta de GOV.UK,
    // no después de comparar contra Mongo.
    fechaEjecucion = new Date().toISOString();

    etapaActual = 'parseo_govuk';
    const parts = json?.details?.parts;
    if (!Array.isArray(parts)) {
      throw new Error('No se encontró details.parts[] en la respuesta.');
    }

    etapaActual = 'comparacion_govuk';
    const overview = seleccionarParteUnica(parts, 'overview');
    const apply = seleccionarParteUnica(parts, 'apply');

    resultadoOverview = overview.parte ? extraerCosto(overview.parte.body) : { costo: null, sospechoso: false, fragmento: null };
    resultadoApply = apply.parte ? extraerCosto(apply.parte.body) : { costo: null, sospechoso: false, fragmento: null };

    const costoOverview = resultadoOverview.costo;
    const costoApply = resultadoApply.costo;

    console.log(`Costo extraído de "overview": ${costoOverview === null ? 'NO MATCHEÓ' : `£${costoOverview}`}`);
    console.log(`Costo extraído de "apply": ${costoApply === null ? 'NO MATCHEÓ' : `£${costoApply}`}\n`);

    const esSospechoso =
      overview.sospechoso ||
      apply.sospechoso ||
      resultadoOverview.sospechoso ||
      resultadoApply.sospechoso ||
      costoOverview === null ||
      costoApply === null ||
      costoOverview !== costoApply;

    if (esSospechoso) {
      console.warn('SOSPECHOSO: los costos no coinciden, falta alguno de los dos, o hubo ambigüedad en la extracción. No se lo considera un dato válido.');
      imprimirRegistroFallo({
        runId,
        fechaEjecucion,
        etapaFallo: etapaActual,
        error: 'Los costos de "overview" y "apply" no coinciden, falta alguno de los dos, o hubo ambigüedad en la extracción.',
        datosObtenidos: {
          fuente_govuk: resumenFuenteGovUk(json),
          evidencia: resumenEvidencia(resultadoOverview, resultadoApply)
        }
      });
      process.exitCode = 1;
      return;
    }

    console.log(`Costo extraído consistente entre secciones: £${costoOverview}\n`);
    console.log('Fechas del JSON (solo para inspección, no se persisten):');
    console.log(`  first_published_at: ${json.first_published_at}`);
    console.log(`  public_updated_at: ${json.public_updated_at}`);
    console.log(`  updated_at: ${json.updated_at}\n`);

    etapaActual = 'conexion_mongo';
    // --- A partir de acá, TODO es lectura contra Mongo. Ningún camino
    // de esta sección hace un write. ---
    await mongoose.connect(process.env.MONGODB_URI);
    const dbName = mongoose.connection.db.databaseName;
    if (dbName !== DB_ESPERADA) {
      throw new Error(`Base de datos inesperada: "${dbName}" (se esperaba "${DB_ESPERADA}").`);
    }

    etapaActual = 'identificacion_requisito_mongo';
    const resultadoBusqueda = await buscarRequisitoEtaEnMongo();
    const requisito = resultadoBusqueda.requisito;
    destinoId = resultadoBusqueda.destinoId;

    if (!requisito) {
      console.warn(`SOSPECHOSO: no se pudo identificar sin ambigüedad el requisito de Mongo. ${resultadoBusqueda.motivo}`);
      imprimirRegistroFallo({
        runId,
        fechaEjecucion,
        etapaFallo: etapaActual,
        error: resultadoBusqueda.motivo,
        datosObtenidos: {
          fuente_govuk: resumenFuenteGovUk(json),
          evidencia: resumenEvidencia(resultadoOverview, resultadoApply),
          comparacion_govuk: { coincide_entre_secciones: true, costo_extraido_consistente: costoOverview, moneda: 'GBP' },
          destino_id: destinoId ? String(destinoId) : null
        }
      });
      process.exitCode = 1;
      return;
    }

    console.log(`Requisito de Mongo identificado: tipo="${requisito.tipo}", nombre="${requisito.nombre}"`);
    console.log(`  costo (valor original, sin modificar): ${JSON.stringify(requisito.costo ?? null)}\n`);

    etapaActual = 'construccion_salida';
    const resultado = compararConMongo(costoOverview, 'GBP', requisito.costo);

    // Solo las categorías ambiguas cuentan como fallo de código de
    // salida — SIN_COSTO_PREVIO_EN_MONGO, IMPORTE_NO_COINCIDE y
    // MONEDA_DISTINTA son lecturas limpias con un hallazgo real, no una
    // falla del script.
    if (resultado.ambiguo) {
      process.exitCode = 1;
    }

    // No hay requisito_id: se deja explícito el criterio real usado en
    // su lugar (ver comentario de buscarRequisitoEtaEnMongo).
    const identificacionRequisito = {
      criterio: 'tipo + nombre (coincidencia única exigida)',
      tipo: TIPO_REQUISITO_ETA,
      nombre: NOMBRE_REQUISITO_ETA,
      nota_requisito_id:
        'requisito_id NO existe: requisitoSchema declara { _id: false }, los subdocumentos de requisitos[] no tienen _id propio en Mongo hoy. Se identifica por (tipo, nombre) exigiendo exactamente una coincidencia.'
    };

    const valorActual = {
      estado_valor: determinarEstadoValorCosto(requisito),
      valor: Object.hasOwn(requisito, 'costo') ? requisito.costo : null
    };

    const registroEjecucion = {
      tipo_registro: 'ejecucion_lectura',
      run_id: runId,
      resultado_general: 'ok',
      fecha_ejecucion: fechaEjecucion,
      fuente_govuk: resumenFuenteGovUk(json),
      evidencia: resumenEvidencia(resultadoOverview, resultadoApply),
      comparacion_govuk: {
        coincide_entre_secciones: true,
        costo_extraido_consistente: costoOverview,
        moneda: 'GBP'
      },
      requisito_mongo: {
        destino_id: String(destinoId),
        destino_codigo_iso: CODIGO_ISO_UK,
        identificacion_requisito: identificacionRequisito,
        campo: 'costo',
        costo_actual: valorActual
      },
      resultado_comparacion: { categoria: resultado.categoria, ambiguo: resultado.ambiguo },
      escritura_realizada: false
    };

    console.log('\n=== REGISTRO DE EJECUCIÓN (datos reales de esta corrida) ===');
    console.log(JSON.stringify(registroEjecucion, null, 2));

    if (resultado.categoria === 'COINCIDE') {
      console.log('\nCategoría COINCIDE: no hay ningún cambio que proponer.');
    } else if (debeGenerarPropuesta(resultado.categoria)) {
      const propuesta = {
        tipo_registro: 'propuesta_cambio',
        run_id_origen: runId,
        fecha_propuesta: fechaEjecucion,
        destino_id: String(destinoId),
        destino_codigo_iso: CODIGO_ISO_UK,
        identificacion_requisito: identificacionRequisito,
        campo: 'costo',
        valor_actual: valorActual,
        valor_propuesto: {
          estado_valor: 'presente',
          valor: `£${costoOverview}`,
          moneda: 'GBP',
          evidencia: resumenEvidencia(resultadoOverview, resultadoApply),
          fuente_govuk: resumenFuenteGovUk(json)
        },
        condicion_atomica_de_escritura_futura: {
          comportamiento_futuro: true,
          implementado_hoy: false,
          regla:
            'La comprobación de que el valor anterior sigue igual NO es un paso de lectura separado antes de escribir. Es una condición dentro de la MISMA operación de escritura, sobre el documento real (no sobre la etiqueta "estado_valor", que es solo una forma de presentarlo acá): si valor_actual.estado_valor es "ausente", la condición real es que la clave costo siga sin existir en el documento; si es "nulo_explicito", que costo siga siendo exactamente null; si es "presente", que costo siga siendo exactamente igual a valor_actual.valor. Si al ejecutar el update el documento ya no cumple esa condición sobre el campo real, la operación no modifica nada — no hay una lectura previa que pueda quedar desincronizada de la escritura por una condición de carrera.',
          por_que:
            'un chequeo previo separado deja una ventana entre la lectura y la escritura donde otro proceso puede modificar el mismo campo; empaquetar la condición dentro del update mismo elimina esa ventana.'
        },
        garantia_historial_atomico: {
          comportamiento_futuro: true,
          implementado_hoy: false,
          regla:
            'Al aplicar una propuesta, el nuevo valor de costo y la entrada de historial correspondiente se guardarían en la MISMA operación. Nunca debe quedar un cambio de costo sin su historial, ni un historial sin el cambio real aplicado. Este script NO genera ningún historial hoy — es comportamiento futuro, no simulado.'
        },
        campos_que_esta_propuesta_NO_toca: ['estado', 'fecha_verificacion', 'fuente', 'descripcion', 'obligatorio'],
        estado_propuesta: 'pendiente_aprobacion'
      };

      console.log(`\n=== PROPUESTA DE CAMBIO (categoría: ${resultado.categoria}) ===`);
      console.log(JSON.stringify(propuesta, null, 2));
    } else {
      console.warn(
        `\nCategoría ambigua (${resultado.categoria}): no se genera ninguna propuesta de valor. Hay que revisar a mano el campo "costo" de Mongo antes de asumir nada.`
      );
    }

    console.log(
      '\nRecordatorio: esta comparación es de COSTO únicamente. Que coincida NO implica que el' +
        ' requisito completo esté verificado — no se tocó estado ni fecha_verificacion. Tampoco se' +
        ' generó ningún historial de cambio aplicado: eso sigue siendo comportamiento futuro, no' +
        ' simulado hoy.'
    );
  } catch (err) {
    console.error('Error en el piloto de lectura:', err.message);
    imprimirRegistroFallo({
      runId,
      fechaEjecucion,
      etapaFallo: etapaActual,
      error: err.message,
      datosObtenidos: {
        fuente_govuk: resumenFuenteGovUk(json),
        evidencia: resumenEvidencia(resultadoOverview, resultadoApply),
        destino_id: destinoId ? String(destinoId) : null
      }
    });
    process.exitCode = 1;
  } finally {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  }
}

main().catch((err) => {
  console.error('Error fatal no manejado en el piloto:', err.message);
  process.exitCode = 1;
});
