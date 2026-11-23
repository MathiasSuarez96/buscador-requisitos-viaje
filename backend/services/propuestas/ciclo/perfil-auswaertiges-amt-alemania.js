/**
 * Perfil de MANTENIMIENTO del requisito «visa» de Alemania (DE) con la lista oficial del Auswärtiges
 * Amt, para el contexto del buscador (pasaporte nacional uruguayo, turismo). Sirve al destino que crea
 * el alta (services/propuestas/altas): el mismo adaptador alimenta el alta y el mantenimiento.
 *
 * Política automática: auswaertiges-amt-alemania-visa@1 — corrige ÚNICAMENTE `obligatorio` (y, junto
 * con ese cambio, `fuente` = URL oficial). visa_requerida 'no' → 'no'; 'si' → 'si'. Revisión humana
 * en los mismos casos que el perfil de GB (descripción contradictoria o ambigua, lectura dudosa).
 */
const adaptador = require('../adaptadores/v2/auswaertiges-amt-visumpflicht');
const { URL_LISTA } = require('../fuentes/auswaertiges-amt-visumpflicht');
const { afirmacionesVisa } = require('./perfil-govuk-reino-unido');

const valor = v => ({ presente: true, bson_tipo: 'string', valor: v });

function evaluar(requisito, hechos) {
  const esperado = hechos.visa_requerida;
  const observaciones = [];
  const oficial = requisito.fuente === URL_LISTA;
  if (!oficial) observaciones.push({ codigo: 'fuente_no_es_la_oficial', detalle: 'El campo fuente no es la lista oficial; se corrige solo junto con un valor confirmado.' });
  const { afirma, niega } = afirmacionesVisa(requisito.descripcion);
  if (afirma && niega) return { decision: 'revision_humana', motivo: 'descripcion_ambigua', esperado, observaciones, detalle: 'La descripción publicada afirma y niega a la vez.' };
  const contradice = esperado === 'no' ? afirma : niega;
  if (requisito.obligatorio === esperado) {
    if (contradice) observaciones.push({ codigo: 'descripcion_contradice_el_valor', detalle: 'El valor coincide con la fuente, pero la descripción afirma lo contrario.' });
    return { decision: 'sin_cambio', esperado, observaciones };
  }
  if (contradice) return { decision: 'revision_humana', motivo: 'descripcion_contradice', esperado, observaciones,
    detalle: `La lista oficial confirma obligatorio="${esperado}", pero la descripción publicada afirma lo contrario.` };
  if (esperado === 'si' && ['si', 'verificar'].includes(requisito.recomendado)) return { decision: 'revision_humana', motivo: 'requiere_cambiar_recomendado', esperado, observaciones };
  return { decision: 'cambio_aplicable', esperado, observaciones,
    cambios: [{ campo: 'obligatorio', propuesto: valor(esperado) }, ...(oficial ? [] : [{ campo: 'fuente', propuesto: valor(URL_LISTA) }])] };
}

module.exports = Object.freeze({
  nombre: 'auswaertiges-amt-de-visa',
  version: '1',
  politica: Object.freeze({ nombre: 'auswaertiges-amt-alemania-visa', version: '1' }),
  adaptador,
  destino: Object.freeze({ codigo_iso: 'DE' }),
  requisito: Object.freeze({ tipo: 'visa', nombre: undefined }),
  contexto_viajero: Object.freeze({ nacionalidad: 'UY', documento: 'pasaporte_nacional', motivo: 'turismo', duracion: 'hasta 90 días cada 180' }),
  campo_evidencia: 'visa',
  campos_autorizados: Object.freeze(['obligatorio', 'fuente']),
  campos_sin_evidencia: Object.freeze(['descripcion', 'link', 'plazo_antes_del_vuelo', 'costo']),
  afirmacionesDescripcion: afirmacionesVisa,
  evaluar
});
