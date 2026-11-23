/**
 * Perfiles del ciclo 2.0 para el Reino Unido (GB), con el resultado oficial de GOV.UK «Check if you
 * need a UK visa» para el contexto del buscador: pasaporte uruguayo, sin doble ciudadanía británica o
 * irlandesa, turismo (la página no distingue duración; el ETA cubre visitas de hasta 6 meses).
 *
 * Política automática (solo si una autorización vigente la nombra, ver config-ciclo-real.js):
 *   govuk-reino-unido-turismo-uy@1 — en los requisitos «visa» y «UK ETA» de GB corrige
 *   ÚNICAMENTE `obligatorio`, y junto con ese cambio, `fuente` = URL del resultado oficial que lo
 *   respalda. Nunca cambia solo la fuente (eso renovaría la fecha sin un valor nuevo confirmado).
 *
 *   visa:    'eta_o_visa' → obligatorio 'no' (alcanza el ETA; la visa es una alternativa, no un
 *            requisito); 'visa' → obligatorio 'si'.
 *   UK ETA:  'eta_o_visa' → obligatorio 'si' (sin visa, el ETA es obligatorio; tener una visa es
 *            una condición particular que no se generaliza); 'visa' → revisión humana (el ETA no
 *            aplicaría y la descripción publicada lo presenta como obligatorio).
 *
 * Va a revisión humana: descripción publicada que contradice el valor nuevo o que afirma y niega a
 * la vez, un obligatorio que exigiría cambiar `recomendado`, lectura ambigua o sin evidencia.
 */
const adaptador = require('../adaptadores/v2/govuk-check-uk-visa');
const { URL_RESULTADO } = require('../fuentes/govuk-check-uk-visa');
const { afirmacionesDescripcion } = require('./perfil-checkmig-colombia');

const sinTildes = t => String(t ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const valor = v => ({ presente: true, bson_tipo: 'string', valor: v });
const POLITICA = Object.freeze({ nombre: 'govuk-reino-unido-turismo-uy', version: '1' });
const NIEGA_VISA = /\b(?:no\s+(?:se\s+)?(?:requiere|necesita|exige)n?|sin(?:\s+necesidad\s+de)?|exent[oa]s?\s+de(?:\s+la)?)\s+visas?\b/g;
const AFIRMA_VISA = /\b(?:requiere|necesita|exige)n?\s+(?:una\s+)?visas?\b|\bvisas?\s+(?:es\s+)?obligatori[oa]\b/;

// Pura. ¿La descripción afirma que se necesita visa, que no, o las dos cosas?
function afirmacionesVisa(descripcion) {
  const d = sinTildes(descripcion);
  const niega = new RegExp(NIEGA_VISA.source).test(d);
  const afirma = AFIRMA_VISA.test(d.replace(NIEGA_VISA, ' '));
  return { afirma, niega };
}

function crearEvaluar({ esperadoPara, afirmaciones, revisionPara = {} }) {
  return function evaluar(requisito, hechos) {
    const observaciones = [];
    const fuenteOficial = requisito.fuente === URL_RESULTADO;
    if (!fuenteOficial) observaciones.push({ codigo: 'fuente_no_es_la_oficial', detalle: 'El campo fuente no es el resultado oficial de GOV.UK; se corrige solo junto con un valor confirmado.' });
    if (Object.hasOwn(revisionPara, hechos.resultado)) {
      return { decision: 'revision_humana', motivo: revisionPara[hechos.resultado], esperado: null, observaciones,
        detalle: `GOV.UK responde «${hechos.resultado}» y la política no cubre ese caso.` };
    }
    const esperado = esperadoPara[hechos.resultado];
    const { afirma, niega } = afirmaciones(requisito.descripcion);
    if (afirma && niega) return { decision: 'revision_humana', motivo: 'descripcion_ambigua', esperado, observaciones, detalle: 'La descripción publicada afirma y niega a la vez.' };
    const contradice = esperado === 'no' ? afirma : niega;
    if (requisito.obligatorio === esperado) {
      if (contradice) observaciones.push({ codigo: 'descripcion_contradice_el_valor', detalle: 'El valor coincide con GOV.UK, pero la descripción publicada afirma lo contrario.' });
      return { decision: 'sin_cambio', esperado, observaciones };
    }
    if (contradice) {
      return { decision: 'revision_humana', motivo: 'descripcion_contradice', esperado, observaciones,
        detalle: `GOV.UK confirma obligatorio="${esperado}", pero la descripción publicada afirma lo contrario; la política no cambia descripciones.` };
    }
    if (esperado === 'si' && ['si', 'verificar'].includes(requisito.recomendado)) {
      return { decision: 'revision_humana', motivo: 'requiere_cambiar_recomendado', esperado, observaciones, detalle: 'Volverlo obligatorio exige cambiar recomendado.' };
    }
    const cambios = [{ campo: 'obligatorio', propuesto: valor(esperado) }];
    if (!fuenteOficial) cambios.push({ campo: 'fuente', propuesto: valor(URL_RESULTADO) });
    return { decision: 'cambio_aplicable', esperado, observaciones, cambios };
  };
}

const comun = {
  version: '1', politica: POLITICA, adaptador, destino: Object.freeze({ codigo_iso: 'GB' }),
  contexto_viajero: Object.freeze({ nacionalidad: 'UY', documento: 'pasaporte', motivo: 'turismo', duracion: 'hasta 6 meses (ETA)' }),
  campo_evidencia: 'resultado',
  campos_autorizados: Object.freeze(['obligatorio', 'fuente']),
  campos_sin_evidencia: Object.freeze(['descripcion', 'link', 'plazo_antes_del_vuelo', 'costo'])
};

const visa = Object.freeze({
  ...comun, nombre: 'govuk-gb-visa',
  requisito: Object.freeze({ tipo: 'visa', nombre: undefined }),
  afirmacionesDescripcion: afirmacionesVisa,
  evaluar: crearEvaluar({ esperadoPara: { eta_o_visa: 'no', visa: 'si' }, afirmaciones: afirmacionesVisa })
});

const eta = Object.freeze({
  ...comun, nombre: 'govuk-gb-eta',
  requisito: Object.freeze({ tipo: 'formulario_digital', nombre: 'UK ETA' }),
  afirmacionesDescripcion,
  evaluar: crearEvaluar({ esperadoPara: { eta_o_visa: 'si' }, afirmaciones: afirmacionesDescripcion, revisionPara: { visa: 'eta_no_aplicaria' } })
});

module.exports = { POLITICA, visa, eta, afirmacionesVisa };
