/**
 * Lectura HTTP de una página oficial, común a las fuentes nuevas (GOV.UK, Auswärtiges Amt).
 * Mismo comportamiento que leerFicha() de CheckMig (que no se tocó para no alterar Colombia):
 *
 *  - UNA consulta GET por invocación; redirecciones manuales, cada destino validado ANTES de
 *    seguirlo (HTTPS, host de la lista oficial, sin credenciales ni puerto), máximo 3.
 *  - Tiempo máximo para todo (consulta y cuerpo) y cuerpo leído por partes, cortado al superar
 *    el máximo de bytes.
 *  - Nunca lanza: {tipo:'respuesta', html, recibida_en, diagnostico} o
 *    {tipo:'fallo', motivo, diagnostico}. Motivos cerrados (los de CODIGOS_FALLO de H3.3):
 *    red:<codigo>, tiempo_agotado, http_<status>, redireccion_fuera_del_sitio,
 *    redireccion_sin_destino, demasiadas_redirecciones, no_html, cuerpo_ilegible, demasiado_grande.
 *
 * Sin Mongo, sin modelos y sin escrituras.
 */
const REDIRECCIONES = [301, 302, 303, 307, 308];
const MAX_REDIRECCIONES = 3;

const sinFragmento = u => { const c = new URL(u.href); c.hash = ''; return c.href; };

function motivoTransporte(e) {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'tiempo_agotado';
  const codigo = String(e?.cause?.code ?? e?.code ?? e?.name ?? 'desconocido');
  return `red:${/^[A-Za-z0-9_]{1,40}$/.test(codigo) ? codigo : 'desconocido'}`;
}

async function descartar(res) {
  try { await res.body?.cancel(); } catch { /* el cuerpo ya no importa */ }
}

async function leerCuerpoLimitado(res, maximo) {
  if (!res.body) return { bytes: Buffer.alloc(0) };
  const lector = res.body.getReader();
  const partes = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await lector.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximo) {
        try { await lector.cancel(); } catch { /* ya se corta */ }
        return { error: 'demasiado_grande' };
      }
      partes.push(value);
    }
  } catch (e) {
    return { error: e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'tiempo_agotado' : 'cuerpo_ilegible' };
  }
  return { bytes: Buffer.concat(partes) };
}

/**
 * opciones: { url, hosts (lista de hosts oficiales), agente, timeoutMs, bytesMaximos, fetch, ahora, contenido }
 * contenido: 'html' (por defecto, como siempre), 'json' o 'pdf'. Cada uno exige SU content-type; si no
 * coincide, el motivo sigue siendo 'no_html' (código cerrado de H3.3: «no es el contenido esperado»).
 * El PDF se devuelve en latin1 (un carácter por byte: no se pierde ningún byte del original).
 */
const CONTENIDOS = Object.freeze({
  html: { accept: 'text/html', tipo: /^text\/html\b/i, decodificar: b => new TextDecoder('utf-8').decode(b) },
  json: { accept: 'application/json', tipo: /^application\/json\b/i, decodificar: b => new TextDecoder('utf-8').decode(b) },
  pdf: { accept: 'application/pdf', tipo: /^application\/pdf\b/i, decodificar: b => Buffer.from(b).toString('latin1') }
});
async function leerPaginaOficial({ url: inicial, hosts, agente, timeoutMs = 20000, bytesMaximos = 3 * 1024 * 1024,
  fetch: f = globalThis.fetch, ahora = () => new Date(), contenido = 'html' }) {
  const c = CONTENIDOS[contenido];
  if (!c) throw new TypeError(`leerPaginaOficial: contenido desconocido ${JSON.stringify(contenido)}.`);
  const oficial = u => u !== null && u.protocol === 'https:' && hosts.includes(u.hostname) && !u.username && !u.password && u.port === '';
  const consultadoEn = ahora().toISOString();
  const signal = AbortSignal.timeout(timeoutMs);
  const redirecciones = [];
  let url = inicial;
  const diagnostico = extra => ({ consultado_en: consultadoEn, url_final: url, redirecciones: redirecciones.map(r => ({ ...r })), ...extra });
  const fallo = (motivo, extra = {}) => ({ tipo: 'fallo', motivo, diagnostico: diagnostico(extra) });

  for (let saltos = 0; ; saltos++) {
    let res;
    try {
      res = await f(url, { method: 'GET', redirect: 'manual', signal, headers: { 'user-agent': agente, accept: c.accept } });
    } catch (e) {
      return fallo(motivoTransporte(e));
    }
    const status = res.status;
    if (REDIRECCIONES.includes(status)) {
      const location = res.headers.get('location');
      await descartar(res);
      if (!location) return fallo('redireccion_sin_destino', { http_status: status });
      let destino;
      try { destino = new URL(location, url); } catch { destino = null; }
      if (!oficial(destino)) {
        return fallo('redireccion_fuera_del_sitio', { http_status: status, redireccion_rechazada: destino ? `${destino.protocol}//${destino.host}${destino.pathname}` : null });
      }
      if (saltos >= MAX_REDIRECCIONES) return fallo('demasiadas_redirecciones', { http_status: status });
      redirecciones.push({ http_status: status, hacia: sinFragmento(destino) });
      url = sinFragmento(destino);
      continue;
    }
    if (status !== 200) {
      await descartar(res);
      return fallo(`http_${status}`, { http_status: status });
    }
    if (!c.tipo.test(res.headers.get('content-type') ?? '')) {
      await descartar(res);
      return fallo('no_html', { http_status: status });
    }
    const declarado = Number(res.headers.get('content-length') ?? 0);
    if (Number.isFinite(declarado) && declarado > bytesMaximos) {
      await descartar(res);
      return fallo('demasiado_grande', { http_status: status });
    }
    const cuerpo = await leerCuerpoLimitado(res, bytesMaximos);
    if (cuerpo.error) return fallo(cuerpo.error, { http_status: status });
    const html = c.decodificar(cuerpo.bytes);
    return { tipo: 'respuesta', html, recibida_en: ahora(), diagnostico: diagnostico({ http_status: status, bytes: cuerpo.bytes.length }) };
  }
}

// ------------------------------------------------------------------
// Utilidades puras de texto HTML (deterministas, sin dependencias)
// ------------------------------------------------------------------

const ENTIDADES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', uuml: 'ü', auml: 'ä', ouml: 'ö', szlig: 'ß',
  Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', ndash: '–', mdash: '—', bdquo: '„'
};
function decodificar(t) {
  return String(t).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return Object.hasOwn(ENTIDADES, e) ? ENTIDADES[e] : m;
  });
}

// Marcado del único <main>, sin comentarios ni scripts; null si no hay exactamente uno.
function marcadoPrincipal(html) {
  const sinRuido = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  if ((sinRuido.match(/<main\b/gi) ?? []).length !== 1) return null;
  const inicio = sinRuido.search(/<main\b/i), fin = sinRuido.search(/<\/main\s*>/i);
  if (fin < inicio) return null;
  return sinRuido.slice(inicio, fin);
}
const texto = marcado => decodificar(String(marcado).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const LARGO_EVIDENCIA = 240;
const recortar = t => (t.length > LARGO_EVIDENCIA ? `${t.slice(0, LARGO_EVIDENCIA - 1)}…` : t);

// Todo el texto de un marcado, partido en segmentos por CUALQUIER límite de bloque (párrafos, listas,
// contenedores, títulos, tablas, saltos). Ningún texto queda afuera por su etiqueta: lo que no está en
// un <p> también es un segmento.
const LIMITE_BLOQUE = /<\/?(?:p|li|ul|ol|dl|dt|dd|div|section|article|aside|header|footer|nav|h[1-6]|table|thead|tbody|tfoot|tr|td|th|caption|br|hr|blockquote|details|summary|figure|figcaption|form|fieldset|pre|address|main)\b[^>]*>/gi;
function segmentosTexto(marcado) {
  return String(marcado).split(LIMITE_BLOQUE).map(texto).filter(Boolean);
}

// Marcado interior del <div> que se abre en `inicio` (índice del '<'), contando el anidamiento de <div>.
// null si el div no cierra (estructura que no se puede delimitar con confianza).
function interiorDiv(marcado, inicio) {
  const apertura = marcado.slice(inicio).match(/^<div\b[^>]*>/i);
  if (!apertura) return null;
  const desde = inicio + apertura[0].length;
  const etiqueta = /<(\/?)div\b[^>]*>/gi;
  etiqueta.lastIndex = desde;
  let profundidad = 1;
  for (let m; (m = etiqueta.exec(marcado)) !== null;) {
    profundidad += m[1] ? -1 : 1;
    if (profundidad === 0) return marcado.slice(desde, m.index);
  }
  return null;
}

module.exports = { leerPaginaOficial, marcadoPrincipal, decodificar, texto, recortar, segmentosTexto, interiorDiv, MAX_REDIRECCIONES };
