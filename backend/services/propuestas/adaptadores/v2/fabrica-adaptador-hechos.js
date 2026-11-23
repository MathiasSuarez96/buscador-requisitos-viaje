/**
 * Fábrica de adaptadores 2.0 de SOLO LECTURA con la misma interfaz y los mismos resultados que el
 * de CheckMig (migracion-colombia-checkmig.js, que no se modificó): compatibilidad, soporta,
 * revalidar, leer y proyectarRevalidacion. Lo único propio de cada fuente es la lectura HTTP, la
 * extracción por campo y la normalización a hechos canónicos.
 *
 * definicion: { nombre, version, fuenteNombre, url, esquema, campos, leerPagina({fetch, ahora,
 *   timeoutMs}), extraer(html) -> {estado, campos:{[c]:{estado, valor, evidencia, motivo}}, fuente},
 *   normalizarHechos(valores) -> {ok, hechos} | {ok:false, campo} }
 */
const { ALGORITMO_HECHOS_HASH, hashHechos } = require('../../payload-requisito-v2');
const { VERSION_CONTRATO, CAMPO_EXTERNO } = require('../../contrato-requisito-v2');

const esObjeto = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const codigoMotivo = m => String(m).split(':')[0];

function crearAdaptadorHechosV2(def) {
  const { nombre, version, fuenteNombre, url, esquema, campos, leerPagina, extraer, normalizarHechos } = def;

  // Los hechos guardados deben ser exactamente los que produciría normalizarHechos.
  function hechosCanonicos(h) {
    if (!esObjeto(h) || h.esquema !== esquema) return false;
    const n = normalizarHechos(h);
    if (!n.ok) return false;
    try { return hashHechos(n.hechos) === hashHechos(h); } catch { return false; }
  }

  function compatibilidad(propuesta) {
    const no = codigo => ({ compatible: false, codigo });
    const p = propuesta?.payload;
    if (!esObjeto(p)) return no('propuesta_invalida');
    if (p.version_contrato !== VERSION_CONTRATO) return no('version_contrato_no_soportada');
    if (p.campo !== CAMPO_EXTERNO) return no('campo_no_soportado');
    if (!Array.isArray(p.fuentes) || p.fuentes.length === 0) return no('sin_fuentes');
    if (p.fuentes.length > 1) return no('varias_fuentes');
    const [f] = p.fuentes;
    if (!esObjeto(f) || f.url !== url || f.nombre !== fuenteNombre) return no('fuente_no_soportada');
    if (f.algoritmo_hechos_hash !== ALGORITMO_HECHOS_HASH) return no('algoritmo_hechos_no_soportado');
    if (!esObjeto(f.hechos) || f.hechos.esquema !== esquema) return no('esquema_hechos_no_soportado');
    if (!hechosCanonicos(f.hechos)) return no('hechos_guardados_no_canonicos');
    return { compatible: true };
  }

  async function leer({ fetch, ahora = () => new Date(), timeoutMs } = {}) {
    const fuente = { url, fuente_nombre: fuenteNombre };
    const lectura = await leerPagina({ fetch, ahora, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    if (lectura.tipo === 'fallo') return { tipo: 'no_disponible', motivo: lectura.motivo, ...fuente, diagnostico: lectura.diagnostico };
    const ex = extraer(lectura.html, {});
    const diagnostico = { ...lectura.diagnostico, contenido_sha256: ex.fuente.contenido_sha256 };
    const evidencia = Object.fromEntries(campos.map(k => [k, [...ex.campos[k].evidencia]]));
    const camposAmbiguos = Object.fromEntries(campos.map(k => {
      const c = ex.campos[k];
      return [k, { estado: c.estado, ...(c.estado === 'ok' ? {} : { motivo: c.motivo }), evidencia: evidencia[k] }];
    }));
    const ambiguo = motivo => ({ tipo: 'ambiguo', motivo, ...fuente, revalidada_en: lectura.recibida_en, campos: camposAmbiguos, diagnostico });
    if (ex.estado !== 'ok') return ambiguo(campos.filter(k => ex.campos[k].estado !== 'ok').map(k => `${k}:${codigoMotivo(ex.campos[k].motivo)}`).join(','));
    const n = normalizarHechos(Object.fromEntries(campos.map(k => [k, ex.campos[k].valor])));
    if (!n.ok) {
      camposAmbiguos[n.campo] = { estado: 'ambiguo', motivo: `fuera_de_dominio: el valor leído no entra en ${esquema}`, evidencia: evidencia[n.campo] };
      return ambiguo(`${n.campo}:fuera_de_dominio`);
    }
    return { tipo: 'hechos', ...fuente, algoritmo_hechos_hash: ALGORITMO_HECHOS_HASH, revalidada_en: lectura.recibida_en,
      hechos: n.hechos, hechos_hash: hashHechos(n.hechos), evidencia, diagnostico };
  }

  async function revalidar(propuesta, opciones = {}) {
    const c = compatibilidad(propuesta);
    if (!c.compatible) return { tipo: 'incompatible', codigo: c.codigo };
    return leer(opciones);
  }

  function proyectarRevalidacion(r) {
    if (r?.tipo !== 'hechos') throw new TypeError(`proyectarRevalidacion: solo un resultado 'hechos' llega al verificador (recibido ${JSON.stringify(r?.tipo)}).`);
    return { tipo: 'hechos', url: r.url, fuente_nombre: r.fuente_nombre, algoritmo_hechos_hash: r.algoritmo_hechos_hash,
      revalidada_en: new Date(r.revalidada_en.getTime()), hechos: structuredClone(r.hechos) };
  }

  return Object.freeze({ nombre, version, FUENTE_NOMBRE: fuenteNombre, URL: url, ESQUEMA_HECHOS: esquema,
    compatibilidad, soporta: p => compatibilidad(p).compatible, revalidar, leer, proyectarRevalidacion });
}

module.exports = { crearAdaptadorHechosV2 };
