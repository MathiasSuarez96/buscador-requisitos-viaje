/**
 * Fuente de solo lectura: ficha oficial de CheckMig (Migración Colombia).
 *
 * - leerFicha(): UNA consulta GET por invocación. Redirecciones manuales: cada destino se valida
 *   (HTTPS, host oficial, sin credenciales ni puerto) ANTES de seguirlo, con un máximo de 3. El
 *   cuerpo se lee por partes y se corta al superar 3 MiB. Nunca lanza: devuelve
 *   {tipo:'respuesta', html, recibida_en, diagnostico} o {tipo:'fallo', motivo, diagnostico}.
 * - extraer(html): pura. Obligatoriedad, alcance y ventana con evidencia por campo; sin evidencia
 *   suficiente el campo queda 'ambiguo'. El hash del HTML (contenido_sha256) es solo diagnóstico.
 * - normalizarHechos(lectura): pura. Datos canónicos 'checkmig-hechos-v1' con las listas ordenadas;
 *   fuera de dominio → {ok:false}.
 *
 * Sin Mongo, sin modelos y sin escrituras. El parser es específico de CheckMig (la decisión de
 * generalizarlo queda para el segundo adaptador). Contrato: backend/docs/adaptador-checkmig-v2.md.
 */
const { createHash } = require('node:crypto');

const URL_FICHA = 'https://www.migracioncolombia.gov.co/tramites-y-servicios/aplicativos/checkmig';
const HOST_OFICIAL = 'www.migracioncolombia.gov.co';
const AGENTE = 'buscador-requisitos-viaje/adaptador-checkmig';
const TIEMPO_MAXIMO_MS = 20000;
const BYTES_MAXIMOS = 3 * 1024 * 1024;
const MAX_REDIRECCIONES = 3;
const LARGO_EVIDENCIA = 240;
const ESQUEMA_HECHOS = 'checkmig-hechos-v1';

// ------------------------------------------------------------------
// Texto del contenido principal
// ------------------------------------------------------------------

const ENTIDADES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', uuml: 'ü',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', Uuml: 'Ü',
  iquest: '¿', iexcl: '¡', ordm: 'º', ordf: 'ª', laquo: '«', raquo: '»', ndash: '–', mdash: '—'
};
// Una entidad desconocida queda tal cual: el texto no coincidirá y el campo saldrá ambiguo.
function decodificar(t) {
  return t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return Object.hasOwn(ENTIDADES, e) ? ENTIDADES[e] : m;
  });
}

const BLOQUE = /<\/?(p|li|ul|ol|h[1-6]|div|section|article|header|footer|table|tr|td|th|br|hr|dd|dt)\b[^>]*>/gi;

// Pura. Marcado del único <main>, sin comentarios ni scripts; null si no hay exactamente uno.
function marcadoPrincipal(html) {
  const sinRuido = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  const aperturas = sinRuido.match(/<main\b/gi) ?? [];
  if (aperturas.length !== 1) return null;
  const inicio = sinRuido.search(/<main\b/i), fin = sinRuido.search(/<\/main\s*>/i);
  if (fin < inicio) return null;
  return sinRuido.slice(inicio, fin);
}
const texto = marcado => decodificar(marcado.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

// Pura. Bloques de texto del único <main>; null si no hay exactamente uno.
function bloquesPrincipales(html) {
  const main = marcadoPrincipal(html);
  if (main === null) return null;
  return decodificar(main.replace(BLOQUE, '\n').replace(/<[^>]*>/g, ' '))
    .split('\n')
    .map(l => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// Pura. Texto del primer <h1> del <main> (el título de la ficha); null si no hay.
function tituloPrincipal(html) {
  const main = marcadoPrincipal(html);
  const h1 = main === null ? null : main.match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i);
  return h1 ? texto(h1[1]) : null;
}

// Oraciones de cada bloque (un bloque puede tener varias; la evidencia es la oración).
const oraciones = bloques => bloques.flatMap(b => b.split(/(?<=[.;!?])\s+(?=[A-ZÁÉÍÓÚÑ¿¡])/u));
const evidencia = t => (t.length > LARGO_EVIDENCIA ? `${t.slice(0, LARGO_EVIDENCIA - 1)}…` : t);
const sinTildes = t => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const ambiguo = (motivo, ev = []) => ({ estado: 'ambiguo', valor: null, evidencia: ev.map(evidencia), motivo });
const definido = (valor, ev) => ({ estado: 'ok', valor, evidencia: ev.map(evidencia) });

// ------------------------------------------------------------------
// Campos
// ------------------------------------------------------------------

// Obligatoriedad: un único valor global, 'no_obligatorio' u 'obligatorio'. Solo cuenta una
// afirmación ATRIBUIBLE al prerregistro, en una de tres redacciones admitidas:
//  A. En la ficha de CheckMig (primer <h1> del <main> = «CheckMig»), una oración que empieza por
//     el servicio y dice «…, de uso (no) obligatorio» («Servicio gratuito y en línea, de uso no
//     obligatorio que permite…»).
//  B. Sujeto explícito justo antes del verbo: «CheckMig (no) es obligatorio», «El uso de CheckMig
//     es voluntario», «El prerregistro en CheckMig no es obligatorio».
//  C. «(No) es obligatorio diligenciar/usar/… CheckMig | el prerregistro | el formulario de CheckMig».
// Una mención cuyo sujeto u objeto es otro documento («El pasaporte es obligatorio para usar
// CheckMig», «Es obligatorio presentar el pasaporte») se ignora. Cualquier otra mención no se
// puede atribuir al prerregistro («El formulario es obligatorio», sujeto elíptico, otra
// redacción): el campo queda ambiguo. Ambas polaridades, un grupo o una excepción → ambiguo.
const CLAVE = /\b(obligatori[oa]s?|opcional(?:es)?|voluntari[oa]s?|requisito\s+indispensable)\b/g;
const CORTE = /[,;:()]|\b(?:pero|sino|aunque|mientras)\b/g;
const PRERREGISTRO = '(?:checkmig|pre-?registro|prerregistro)';
const VERBO = '(?:es|son|sera|resulta)';
const ADMITIDA_A = /^de\s+uso\s+(?:no\s+)?$/;
const INICIO_A = /^(?:el\s+)?(?:servicio|checkmig|prerregistro|pre-?registro|aplicativo)\b/;
const ADMITIDA_B = new RegExp(`^(?:el\\s+|la\\s+)?(?:(?:uso|registro|diligenciamiento)\\s+(?:de|del|en)\\s+(?:el\\s+)?)?(?:${PRERREGISTRO}|(?:formulario|aplicativo|servicio)\\s+(?:de\\s+)?checkmig)(?:\\s+en\\s+checkmig)?\\s+(?:no\\s+)?${VERBO}\\s+(?:no\\s+)?(?:de\\s+(?:uso|caracter)\\s+)?$`);
const ADMITIDA_C_ANTES = new RegExp(`^(?:no\\s+)?${VERBO}\\s+$`);
const ADMITIDA_C_DESPUES = new RegExp(`^\\s+(?:diligenciar|realizar|completar|hacer|usar|utilizar)\\s+(?:el\\s+|la\\s+)?(?:${PRERREGISTRO}|formulario\\s+de\\s+checkmig|registro\\s+en\\s+checkmig)\\b`);
const AJENO = '(?:pasaporte|visa|cedula|documento|tiquete|certificado|vacuna|seguro)s?';
const AJENO_SUELTO = new RegExp(`\\b${AJENO}\\b`);
const AJENA_ANTES = new RegExp(`^(?:el\\s+|la\\s+|los\\s+|las\\s+|su\\s+|sus\\s+)?${AJENO}\\b.*\\b${VERBO}\\s+(?:no\\s+)?$`);
const AJENA_DESPUES = new RegExp(`^\\s+(?:\\p{L}+(?:ar|er|ir)\\s+)?(?:el\\s+|la\\s+|los\\s+|las\\s+|un\\s+|una\\s+|su\\s+|sus\\s+)?${AJENO}\\b`, 'u');
const NEGADA = new RegExp(`\\bno\\s+(?:${VERBO}\\s+)?(?:de\\s+(?:uso|caracter)\\s+)?$`);
// Condición por grupo o excepción: el formato solo admite un valor global.
const CONDICION_TRAS = /^\s*,?\s*(?:para|a)\s+(?:los\s+|las\s+)?(?:viajeros\s+|ciudadanos\s+|personas\s+)?(?:nacionales|extranjer|colombian|residentes|menores|mayores|turistas|ciertos|algunos)/;
const EXCEPCION = /\b(salvo|excepto|excepcion|exceptuando|unicamente|solamente|solo\s+para)\b/;

// Pura. s: oración sin tildes y en minúsculas. Cada mención: atribuible (con polaridad), ajena o no_atribuible.
function clasificarMenciones(s, fichaCheckmig) {
  const res = [];
  for (const m of s.matchAll(CLAVE)) {
    const antes = s.slice(0, m.index), despues = s.slice(m.index + m[0].length);
    let corte = 0;
    for (const c of antes.matchAll(CORTE)) corte = c.index + c[0].length;
    const clausula = antes.slice(corte).trimStart();
    const admitida = (fichaCheckmig && ADMITIDA_A.test(clausula) && INICIO_A.test(s) && !AJENO_SUELTO.test(s.split(',')[0]))
      || ADMITIDA_B.test(clausula)
      || (ADMITIDA_C_ANTES.test(clausula) && ADMITIDA_C_DESPUES.test(despues));
    if (admitida) {
      const formaNegativa = /^(opcional|voluntari)/.test(m[1]);
      res.push({ tipo: 'atribuible', negativa: NEGADA.test(clausula) !== formaNegativa, condicionada: CONDICION_TRAS.test(despues) });
    } else if (AJENA_ANTES.test(clausula) || AJENA_DESPUES.test(despues)) res.push({ tipo: 'ajena' });
    else res.push({ tipo: 'no_atribuible' });
  }
  return res;
}
function obligatoriedad(frases, fichaCheckmig) {
  const neg = [], pos = [], cond = [], sinAtribuir = [];
  for (const f of frases) {
    const s = sinTildes(f);
    const menciones = clasificarMenciones(s, fichaCheckmig);
    if (menciones.some(m => m.tipo === 'no_atribuible')) sinAtribuir.push(f);
    const atribuibles = menciones.filter(m => m.tipo === 'atribuible');
    if (!atribuibles.length) continue;
    // Dos polaridades en la misma oración, o un grupo/excepción: obligatoriedad no global.
    if (new Set(atribuibles.map(m => m.negativa)).size > 1 || atribuibles.some(m => m.condicionada) || EXCEPCION.test(s)) cond.push(f);
    else (atribuibles[0].negativa ? neg : pos).push(f);
  }
  if (cond.length) return ambiguo('condicionada: la obligatoriedad depende del grupo de viajeros y el formato solo admite un valor global', cond);
  if (neg.length && pos.length) return ambiguo('contradiccion: la ficha dice obligatorio y no obligatorio', [...neg, ...pos]);
  if (sinAtribuir.length) return ambiguo('no_atribuible: una mención de obligatoriedad no se puede atribuir al prerregistro', [...new Set([...neg, ...pos, ...sinAtribuir])]);
  if (neg.length) return definido('no_obligatorio', neg);
  if (pos.length) return definido('obligatorio', pos);
  return ambiguo('sin_evidencia: la ficha no afirma la obligatoriedad del prerregistro');
}

// Alcance: el bloque «Dirigido a:». Viajeros (nacionales/extranjeros) y sentidos (ingreso/salida).
function alcance(bloques) {
  const dirigidos = bloques.filter(b => /^dirigido\s+a\s*:/i.test(b));
  if (!dirigidos.length) return ambiguo('sin_evidencia: no hay bloque «Dirigido a:»');
  // Una negación o exclusión («no para los que salgan») no se interpreta: nunca se deduce un
  // viajero o un sentido de una palabra negada, así que el alcance queda ambiguo.
  const EXCLUSION = /\b(no|ni|sin|salvo|excepto|excepcion|exceptuando|excluid[oa]s?|excluye\w*|tampoco|menos)\b/;
  const excluyentes = dirigidos.filter(b => EXCLUSION.test(sinTildes(b)));
  if (excluyentes.length) return ambiguo('exclusion: «Dirigido a:» con una negación o exclusión que el parser no interpreta', excluyentes);
  const leer = b => {
    const s = sinTildes(b.replace(/^dirigido\s+a\s*:\s*/i, ''));
    const viajeros = [/\b(nacionales|colombian[oa]s)\b/.test(s) && 'nacionales', /\bextranjer[oa]s\b/.test(s) && 'extranjeros'].filter(Boolean);
    const sentidos = [/\b(ingres\w*|entr(en|an|ada|ar)\b)/.test(s) && 'ingreso', /\b(salg\w*|salida\w*|salir)\b/.test(s) && 'salida'].filter(Boolean);
    return { viajeros, sentidos, texto: b.replace(/^dirigido\s+a\s*:\s*/i, '') };
  };
  const lecturas = dirigidos.map(leer);
  const clave = l => `${l.viajeros}|${l.sentidos}`;
  if (new Set(lecturas.map(clave)).size > 1) return ambiguo('contradiccion: varios bloques «Dirigido a:» distintos', dirigidos);
  const [l] = lecturas;
  if (!l.viajeros.length || !l.sentidos.length) return ambiguo('sin_evidencia: «Dirigido a:» sin viajeros o sin sentido del viaje', dirigidos);
  return definido({ viajeros: l.viajeros, sentidos: l.sentidos, texto: evidencia(l.texto) }, [dirigidos[0]]);
}

// Ventana: «hasta con N horas de anticipación» (máximo) y «hasta N hora(s) antes» (mínimo).
const NUMEROS = { una: 1, un: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, doce: 12, veinticuatro: 24, 'cuarenta y ocho': 48, 'setenta y dos': 72, 'noventa y seis': 96 };
const CANTIDAD = `(\\d{1,3}|${Object.keys(NUMEROS).sort((a, b) => b.length - a.length).join('|')})`;
const cantidad = t => (/^\d+$/.test(t) ? Number(t) : NUMEROS[t]);
const MAXIMO = new RegExp(`\\b(?:hasta\\s+(?:con\\s+)?|desde\\s+)${CANTIDAD}\\s+horas?\\s+(?:de\\s+anticipacion|antes)`, 'g');
const MINIMO = new RegExp(`\\b(?:o\\s+)?hasta\\s+(?:con\\s+)?${CANTIDAD}\\s+horas?\\s+antes\\s+del?\\s+(?:mismo|viaje|vuelo|embarque)`, 'g');
function ventana(frases) {
  const maximos = new Map(), minimos = new Map();
  for (const f of frases) {
    const s = sinTildes(f);
    for (const m of s.matchAll(MINIMO)) (minimos.get(cantidad(m[1])) ?? minimos.set(cantidad(m[1]), []).get(cantidad(m[1]))).push(f);
    // Un mínimo («hasta una hora antes del mismo») no cuenta como máximo.
    for (const m of s.replace(MINIMO, ' ').matchAll(MAXIMO)) (maximos.get(cantidad(m[1])) ?? maximos.set(cantidad(m[1]), []).get(cantidad(m[1]))).push(f);
  }
  const unicas = (...listas) => [...new Set(listas.flat())];
  if (!maximos.size) return ambiguo('sin_evidencia: la ficha no indica con cuántas horas de anticipación', unicas(...minimos.values()));
  if (maximos.size > 1) return ambiguo(`contradiccion: varias ventanas máximas (${[...maximos.keys()].join(', ')} horas)`, unicas(...maximos.values()));
  if (minimos.size > 1) return ambiguo(`contradiccion: varios mínimos (${[...minimos.keys()].join(', ')} horas)`, unicas(...minimos.values()));
  const [[maximo, evMax]] = maximos, [minimo, evMin] = minimos.size ? [...minimos][0] : [null, []];
  if (minimo !== null && minimo >= maximo) return ambiguo('contradiccion: el mínimo no es menor que el máximo', unicas(evMax, evMin));
  return definido({ maximo_horas_antes: maximo, minimo_horas_antes: minimo }, unicas(evMax, evMin));
}

// ------------------------------------------------------------------
// Extracción y consulta
// ------------------------------------------------------------------

const CAMPOS = ['obligatoriedad', 'alcance', 'ventana_horas_antes'];
const estadoGlobal = campos => (Object.values(campos).every(c => c.estado === 'ok') ? 'ok' : 'ambiguo');

// Pura. Resultado completo a partir del HTML de la ficha y los datos de la consulta.
function extraer(html, fuente) {
  const bloques = bloquesPrincipales(html);
  const campos = bloques === null
    ? Object.fromEntries(CAMPOS.map(c => [c, ambiguo('sin_evidencia: no hay exactamente un <main> en la ficha')]))
    : (() => { const frases = oraciones(bloques); const ficha = sinTildes(tituloPrincipal(html) ?? '') === 'checkmig'; return { obligatoriedad: obligatoriedad(frases, ficha), alcance: alcance(bloques), ventana_horas_antes: ventana(frases) }; })();
  return { estado: estadoGlobal(campos), fuente: { ...fuente, contenido_sha256: createHash('sha256').update(String(html)).digest('hex') }, campos };
}

// ------------------------------------------------------------------
// Datos normalizados (lo único que entra en hechos_hash)
// ------------------------------------------------------------------

const VIAJEROS = Object.freeze(['extranjeros', 'nacionales']);
const SENTIDOS = Object.freeze(['ingreso', 'salida']);
const compararCodigo = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const lista = (xs, dominio) => (Array.isArray(xs) && xs.length > 0 && new Set(xs).size === xs.length && xs.every(x => dominio.includes(x))
  ? [...xs].sort(compararCodigo) : null);

// Pura. lectura: {obligatoriedad, alcance:{viajeros, sentidos}, ventana_horas_antes:{maximo_horas_antes,
// minimo_horas_antes}} (los valores de extraer()). Ignora el resto (p. ej. alcance.texto) y ordena las
// listas, para que el orden del texto de la ficha no cambie el hash. Devuelve {ok:true, hechos} o
// {ok:false, campo} si un valor queda fuera de dominio.
function normalizarHechos(lectura) {
  const o = lectura?.obligatoriedad, a = lectura?.alcance, v = lectura?.ventana_horas_antes;
  if (o !== 'no_obligatorio' && o !== 'obligatorio') return { ok: false, campo: 'obligatoriedad' };
  const viajeros = lista(a?.viajeros, VIAJEROS), sentidos = lista(a?.sentidos, SENTIDOS);
  if (!viajeros || !sentidos) return { ok: false, campo: 'alcance' };
  const max = v?.maximo_horas_antes, min = v?.minimo_horas_antes;
  if (!Number.isInteger(max) || max < 1 || max > 720) return { ok: false, campo: 'ventana_horas_antes' };
  if (!(min === null || (Number.isInteger(min) && min >= 0 && min < max))) return { ok: false, campo: 'ventana_horas_antes' };
  return {
    ok: true,
    hechos: {
      esquema: ESQUEMA_HECHOS,
      obligatoriedad: o,
      alcance: { viajeros, sentidos },
      ventana_horas_antes: { maximo_horas_antes: max, minimo_horas_antes: min }
    }
  };
}

// ------------------------------------------------------------------
// Lectura de la ficha (una consulta por invocación)
// ------------------------------------------------------------------

const REDIRECCIONES = [301, 302, 303, 307, 308];

// Destino admitido: HTTPS, host oficial, sin credenciales ni puerto explícito. Sin fragmento.
function destinoOficial(url) {
  return url !== null && url.protocol === 'https:' && url.hostname === HOST_OFICIAL && !url.username && !url.password && url.port === '';
}
const sinFragmento = u => { const c = new URL(u.href); c.hash = ''; return c.href; };

function motivoTransporte(e) {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'tiempo_agotado';
  const codigo = String(e?.cause?.code ?? e?.code ?? e?.name ?? 'desconocido');
  return `red:${/^[A-Za-z0-9_]{1,40}$/.test(codigo) ? codigo : 'desconocido'}`;
}

async function descartar(res) {
  try { await res.body?.cancel(); } catch { /* el cuerpo ya no importa */ }
}

// Lee el cuerpo por partes y corta en cuanto supera el máximo (no lo acumula entero).
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

// Nunca lanza. Una sola consulta (más, a lo sumo, MAX_REDIRECCIONES saltos validados).
async function leerFicha({ fetch: f = globalThis.fetch, ahora = () => new Date(), timeoutMs = TIEMPO_MAXIMO_MS } = {}) {
  const consultadoEn = ahora().toISOString();
  const signal = AbortSignal.timeout(timeoutMs);
  const redirecciones = [];
  let url = URL_FICHA;
  const diagnostico = extra => ({ consultado_en: consultadoEn, url_final: url, redirecciones: redirecciones.map(r => ({ ...r })), ...extra });
  const fallo = (motivo, extra = {}) => ({ tipo: 'fallo', motivo, diagnostico: diagnostico(extra) });

  for (let saltos = 0; ; saltos++) {
    let res;
    try {
      res = await f(url, { method: 'GET', redirect: 'manual', signal, headers: { 'user-agent': AGENTE, accept: 'text/html' } });
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
      // Se valida ANTES de seguirla: un destino ajeno nunca se consulta.
      if (!destinoOficial(destino)) {
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
    if (!/^text\/html\b/i.test(res.headers.get('content-type') ?? '')) {
      await descartar(res);
      return fallo('no_html', { http_status: status });
    }
    const declarado = Number(res.headers.get('content-length') ?? 0);
    if (Number.isFinite(declarado) && declarado > BYTES_MAXIMOS) {
      await descartar(res);
      return fallo('demasiado_grande', { http_status: status });
    }
    const cuerpo = await leerCuerpoLimitado(res, BYTES_MAXIMOS);
    if (cuerpo.error) return fallo(cuerpo.error, { http_status: status });
    // Igual que Response.text(): UTF-8 con reemplazo, sin BOM.
    const html = new TextDecoder('utf-8').decode(cuerpo.bytes);
    return { tipo: 'respuesta', html, recibida_en: ahora(), diagnostico: diagnostico({ http_status: status, bytes: cuerpo.bytes.length }) };
  }
}

module.exports = {
  URL_FICHA, HOST_OFICIAL, AGENTE, TIEMPO_MAXIMO_MS, BYTES_MAXIMOS, MAX_REDIRECCIONES, ESQUEMA_HECHOS, CAMPOS,
  bloquesPrincipales, tituloPrincipal, extraer, normalizarHechos, leerFicha
};
