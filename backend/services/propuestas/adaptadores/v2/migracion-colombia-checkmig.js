/**
 * Adaptador 2.0 de SOLO LECTURA para la ficha oficial de CheckMig (H3.2). No está integrado:
 * ningún servicio, ruta, CLI ni el aplicador 2.0 lo llaman todavía.
 *
 * compatibilidad(propuesta) -> {compatible:true} | {compatible:false, codigo}. Pura. Exige una
 *   propuesta 2.0 de campo 'requisito' con EXACTAMENTE una fuente: la ficha (URL_FICHA, nombre
 *   FUENTE_NOMBRE), con algoritmo sha256-toc-hechos-v1 y hechos canónicos 'checkmig-hechos-v1'.
 * revalidar(propuesta, {fetch, ahora, timeoutMs}) -> Promise de UNO de:
 *   {tipo:'incompatible', codigo}                     sin consultar la fuente
 *   {tipo:'no_disponible', motivo, url, fuente_nombre, diagnostico}       fallo HTTP o de transporte
 *   {tipo:'ambiguo', motivo, url, fuente_nombre, revalidada_en, campos, diagnostico}
 *   {tipo:'hechos', url, fuente_nombre, algoritmo_hechos_hash, revalidada_en, hechos, hechos_hash,
 *     evidencia, diagnostico}                         solo con evidencia suficiente en los 3 campos
 *   Una lectura por invocación. Nunca lanza por la fuente y nunca compara contra la propuesta: la
 *   comparación (fuente_cambio) la hace verificarRevalidaciones (plan-aplicacion-requisito-v2.js).
 * proyectarRevalidacion(r) -> la forma que espera el plan: solo para tipo 'hechos'.
 *
 * El hash del HTML (diagnostico.contenido_sha256) nunca entra en hechos. Contrato y pendientes de
 * la orquestación (segunda lectura antes de marcar obsoleta): backend/docs/adaptador-checkmig-v2.md.
 */
const { ALGORITMO_HECHOS_HASH, hashHechos } = require('../../payload-requisito-v2');
const { VERSION_CONTRATO, CAMPO_EXTERNO } = require('../../contrato-requisito-v2');
const { URL_FICHA, ESQUEMA_HECHOS, CAMPOS, extraer, normalizarHechos, leerFicha } = require('../../fuentes/migracion-colombia-checkmig');

const NOMBRE = 'migracion-colombia-checkmig';
const VERSION = '1';
const FUENTE_NOMBRE = 'Migración Colombia';
const CODIGOS_INCOMPATIBILIDAD = Object.freeze([
  'propuesta_invalida', 'version_contrato_no_soportada', 'campo_no_soportado', 'sin_fuentes', 'varias_fuentes',
  'fuente_no_soportada', 'algoritmo_hechos_no_soportado', 'esquema_hechos_no_soportado', 'hechos_guardados_no_canonicos'
]);

const esObjeto = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const clavesExactas = (o, claves) => esObjeto(o) && Object.keys(o).sort().join(',') === [...claves].sort().join(',');

// Pura. Los hechos guardados deben ser exactamente los que normalizarHechos produciría: si no, una
// diferencia de forma (listas sin ordenar, claves de más) se leería como un cambio de la fuente.
function hechosCanonicos(h) {
  if (!clavesExactas(h, ['esquema', 'obligatoriedad', 'alcance', 'ventana_horas_antes'])) return false;
  if (!clavesExactas(h.alcance, ['viajeros', 'sentidos'])) return false;
  if (!clavesExactas(h.ventana_horas_antes, ['maximo_horas_antes', 'minimo_horas_antes'])) return false;
  const n = normalizarHechos(h);
  if (!n.ok) return false;
  // jsonEstricto ordena las claves pero no las listas: el hash solo coincide si ya venían ordenadas.
  try { return hashHechos(n.hechos) === hashHechos(h); }
  catch { return false; }
}

function compatibilidad(propuesta) {
  const no = codigo => ({ compatible: false, codigo });
  const p = propuesta?.payload;
  if (!esObjeto(p)) return no('propuesta_invalida');
  if (p.version_contrato !== VERSION_CONTRATO) return no('version_contrato_no_soportada');
  if (p.campo !== CAMPO_EXTERNO) return no('campo_no_soportado');
  if (!Array.isArray(p.fuentes) || p.fuentes.length === 0) return no('sin_fuentes');
  // El verificador exige una revalidación por cada URL; este adaptador lee una sola.
  if (p.fuentes.length > 1) return no('varias_fuentes');
  const [f] = p.fuentes;
  if (!esObjeto(f) || f.url !== URL_FICHA || f.nombre !== FUENTE_NOMBRE) return no('fuente_no_soportada');
  if (f.algoritmo_hechos_hash !== ALGORITMO_HECHOS_HASH) return no('algoritmo_hechos_no_soportado');
  if (!esObjeto(f.hechos) || f.hechos.esquema !== ESQUEMA_HECHOS) return no('esquema_hechos_no_soportado');
  if (!hechosCanonicos(f.hechos)) return no('hechos_guardados_no_canonicos');
  return { compatible: true };
}

const soporta = propuesta => compatibilidad(propuesta).compatible;
const codigoMotivo = m => String(m).split(':')[0];

async function revalidar(propuesta, { fetch, ahora = () => new Date(), timeoutMs } = {}) {
  const c = compatibilidad(propuesta);
  if (!c.compatible) return { tipo: 'incompatible', codigo: c.codigo };
  return leer({ fetch, ahora, timeoutMs });
}

// Una lectura de la ficha sin propuesta: mismos resultados que revalidar() salvo 'incompatible'.
// La usa el piloto para comparar los hechos con el requisito guardado ANTES de proponer.
async function leer({ fetch, ahora = () => new Date(), timeoutMs } = {}) {
  const fuente = { url: URL_FICHA, fuente_nombre: FUENTE_NOMBRE };

  const lectura = await leerFicha({ fetch, ahora, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  if (lectura.tipo === 'fallo') return { tipo: 'no_disponible', motivo: lectura.motivo, ...fuente, diagnostico: lectura.diagnostico };

  const ex = extraer(lectura.html, {});
  const diagnostico = { ...lectura.diagnostico, contenido_sha256: ex.fuente.contenido_sha256 };
  const evidencia = Object.fromEntries(CAMPOS.map(k => [k, [...ex.campos[k].evidencia]]));
  const ambiguo = (motivo, campos) => ({ tipo: 'ambiguo', motivo, ...fuente, revalidada_en: lectura.recibida_en, campos, diagnostico });
  const camposAmbiguos = Object.fromEntries(CAMPOS.map(k => {
    const campo = ex.campos[k];
    return [k, { estado: campo.estado, ...(campo.estado === 'ok' ? {} : { motivo: campo.motivo }), evidencia: evidencia[k] }];
  }));

  if (ex.estado !== 'ok') {
    const motivo = CAMPOS.filter(k => ex.campos[k].estado !== 'ok').map(k => `${k}:${codigoMotivo(ex.campos[k].motivo)}`).join(',');
    return ambiguo(motivo, camposAmbiguos);
  }
  const n = normalizarHechos(Object.fromEntries(CAMPOS.map(k => [k, ex.campos[k].valor])));
  if (!n.ok) {
    camposAmbiguos[n.campo] = { estado: 'ambiguo', motivo: 'fuera_de_dominio: el valor leído no entra en checkmig-hechos-v1', evidencia: evidencia[n.campo] };
    return ambiguo(`${n.campo}:fuera_de_dominio`, camposAmbiguos);
  }
  return {
    tipo: 'hechos', ...fuente, algoritmo_hechos_hash: ALGORITMO_HECHOS_HASH, revalidada_en: lectura.recibida_en,
    hechos: n.hechos, hechos_hash: hashHechos(n.hechos), evidencia, diagnostico
  };
}

// La orquestación pasa al aplicador SOLO esta proyección; evidencia y diagnóstico van al intento.
function proyectarRevalidacion(r) {
  if (r?.tipo !== 'hechos') throw new TypeError(`proyectarRevalidacion: solo un resultado 'hechos' llega al verificador (recibido ${JSON.stringify(r?.tipo)}).`);
  return {
    tipo: 'hechos', url: r.url, fuente_nombre: r.fuente_nombre, algoritmo_hechos_hash: r.algoritmo_hechos_hash,
    revalidada_en: new Date(r.revalidada_en.getTime()), hechos: structuredClone(r.hechos)
  };
}

module.exports = Object.freeze({
  nombre: NOMBRE,
  version: VERSION,
  FUENTE_NOMBRE,
  CODIGOS_INCOMPATIBILIDAD,
  compatibilidad,
  soporta,
  revalidar,
  leer,
  proyectarRevalidacion
});
