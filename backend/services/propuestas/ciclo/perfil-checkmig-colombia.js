/**
 * Perfil del ciclo de revalidación 2.0 para CheckMig (Colombia). Un perfil dice QUÉ requisito
 * cubre, con QUÉ adaptador se lee su fuente y QUÉ cambios puede autorizar la política
 * automática. El ciclo (ciclo-revalidacion-v2.js) es el mismo para cualquier país: el siguiente
 * se agrega con otro perfil, sin tocar el ciclo ni H3.3.
 *
 * Política automática (solo si la configuración la habilita, ver config-ciclo-real.js):
 *   checkmig-colombia-obligatoriedad@1 — corrige ÚNICAMENTE `obligatorio` del requisito
 *   «Check-Mig» (formulario_digital) desde una lectura con hechos confirmados.
 * Va a revisión humana todo lo que la política no cubre: un cambio que deja la descripción
 * publicada contradiciendo el valor nuevo, un obligatorio que exigiría cambiar `recomendado`,
 * una lectura ambigua o sin evidencia.
 */
const adaptador = require('../adaptadores/v2/migracion-colombia-checkmig');
const { URL_FICHA } = require('../fuentes/migracion-colombia-checkmig');

const sinTildes = t => String(t ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const valor = v => ({ presente: true, bson_tipo: 'string', valor: v });
const NEGADA = /\bno\s+(?:es\s+|son\s+|sera\s+)?obligatori[oa]s?\b|\bopcional(?:es)?\b|\bvoluntari[oa]s?\b|\bno\s+requerid[oa]\b/g;

// Pura. ¿La descripción afirma «obligatorio» o «no obligatorio»? (texto publicado para el viajero)
function afirmacionesDescripcion(descripcion) {
  const d = sinTildes(descripcion);
  const niega = NEGADA.test(d);
  NEGADA.lastIndex = 0;
  const afirma = /\bobligatori[oa]s?\b/.test(d.replace(NEGADA, ' '));
  NEGADA.lastIndex = 0;
  return { afirma, niega };
}

// Pura. Requisito guardado + hechos confirmados → decisión del perfil.
function evaluar(requisito, hechos) {
  const esperado = hechos.obligatoriedad === 'obligatorio' ? 'si' : 'no';
  const { afirma, niega } = afirmacionesDescripcion(requisito.descripcion);
  const contradice = esperado === 'no' ? afirma : niega;
  const observaciones = [];
  // La ficha informativa es la fuente; el formulario es el enlace que abre el viajero.
  if (requisito.fuente !== adaptador.FUENTE_NOMBRE && requisito.fuente !== URL_FICHA) {
    observaciones.push({ codigo: 'fuente_no_es_la_ficha', detalle: 'El campo fuente del requisito no nombra la ficha informativa; corregirlo excede la política.' });
  }
  if (requisito.obligatorio === esperado) {
    if (contradice) observaciones.push({ codigo: 'descripcion_contradice_el_valor', detalle: 'El valor coincide con la ficha, pero la descripción publicada afirma lo contrario.' });
    return { decision: 'sin_cambio', esperado, observaciones };
  }
  if (contradice) {
    return { decision: 'revision_humana', motivo: 'descripcion_contradice', esperado, observaciones,
      detalle: `La ficha confirma obligatorio="${esperado}", pero la descripción publicada afirma lo contrario; la política solo puede cambiar obligatorio.` };
  }
  if (esperado === 'si' && ['si', 'verificar'].includes(requisito.recomendado)) {
    return { decision: 'revision_humana', motivo: 'requiere_cambiar_recomendado', esperado, observaciones,
      detalle: 'Volverlo obligatorio exige cambiar recomendado, que la política no cubre.' };
  }
  return { decision: 'cambio_aplicable', esperado, observaciones, cambios: [{ campo: 'obligatorio', propuesto: valor(esperado) }] };
}

module.exports = Object.freeze({
  nombre: 'checkmig-colombia',
  version: '1',
  politica: Object.freeze({ nombre: 'checkmig-colombia-obligatoriedad', version: '1' }),
  adaptador,
  destino: Object.freeze({ codigo_iso: 'CO' }),
  requisito: Object.freeze({ tipo: 'formulario_digital', nombre: 'Check-Mig' }),
  campos_autorizados: Object.freeze(['obligatorio']),
  // Campos del requisito que esta fuente NO confirma (impiden renovar la fecha por sí sola).
  campos_sin_evidencia: Object.freeze(['descripcion', 'fuente', 'link', 'plazo_antes_del_vuelo', 'costo']),
  afirmacionesDescripcion,
  evaluar
});
