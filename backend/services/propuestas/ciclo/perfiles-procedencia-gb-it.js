/**
 * Lote de procedencia (IATA → fuente oficial) de tres requisitos confirmados. Cada uno tiene su
 * política propia (alcance: ese requisito de ese destino); ninguna reutiliza otra autorización.
 *
 *  govuk-gb-pasaporte     GB validez_pasaporte · GOV.UK, resultado de «Check if you need a UK visa»
 *                         (Uruguay, sin doble ciudadanía, turismo), sección de la frontera.
 *                         Política govuk-gb-pasaporte-uy@1.
 *  embajada-it-visa       IT visa · Embajada de Italia en Montevideo (uruguayos naturales residentes,
 *                         turismo, hasta N días). Política embajada-italia-it-visa-uy@1.
 *  embajada-it-pasaporte  IT validez_pasaporte · misma página (vigencia de M meses tras la salida
 *                         prevista del espacio Schengen). Política embajada-italia-it-pasaporte-uy@1.
 *
 * Las descripciones son redacción propia y repiten TODAS las condiciones que la fuente expresa; lo
 * que la fuente no menciona no se publica (ver perfil-procedencia.js).
 */
const { crearPerfilProcedencia } = require('./perfil-procedencia');
const govukFrontera = require('../adaptadores/v2/govuk-check-uk-visa-frontera');
const embajadaItalia = require('../adaptadores/v2/embajada-italia-montevideo');
const { URL_RESULTADO } = require('../fuentes/govuk-check-uk-visa-frontera');
const { URL_PAGINA } = require('../fuentes/embajada-italia-montevideo-visas');

// Pura. Descripciones canónicas (también las usan las pruebas).
const DESCRIPCION_GB_PASAPORTE = 'Con pasaporte uruguayo, viajando por turismo y sin doble ciudadanía británica o irlandesa: el pasaporte o documento de viaje debe ser válido durante toda la estadía en el Reino Unido.';
const descripcionItVisa = h => `Los uruguayos naturales residentes en Uruguay no necesitan visa para viajar a Italia (espacio Schengen) por turismo, por hasta ${h.estancia_dias_max} días. Los ciudadanos legales uruguayos pueden necesitar visa según su nacionalidad de origen. Para otros motivos o estadías más largas, consultar la fuente oficial.`;
const descripcionItPasaporte = h => `Para uruguayos naturales residentes en Uruguay que viajan por turismo: el pasaporte debe tener una vigencia de al menos ${h.pasaporte_meses_tras_salida} meses posteriores a la fecha prevista de salida del espacio Schengen.`;

const gbPasaporte = crearPerfilProcedencia({
  nombre: 'govuk-gb-pasaporte',
  politica: { nombre: 'govuk-gb-pasaporte-uy', version: '1' },
  adaptador: govukFrontera,
  destino: { codigo_iso: 'GB' },
  requisito: { tipo: 'validez_pasaporte', nombre: undefined },
  contexto_viajero: { nacionalidad: 'UY', documento: 'pasaporte', motivo: 'turismo', duracion: 'toda la estadía' },
  campo_evidencia: 'pasaporte',
  canonico: () => ({ obligatorio: 'si', descripcion: DESCRIPCION_GB_PASAPORTE, fuente: URL_RESULTADO })
});

const comunItalia = {
  adaptador: embajadaItalia,
  destino: { codigo_iso: 'IT' },
  contexto_viajero: { nacionalidad: 'UY (natural, residente en Uruguay)', documento: 'pasaporte', motivo: 'turismo', duracion: 'según la fuente (días)' }
};

const itVisa = crearPerfilProcedencia({
  ...comunItalia,
  nombre: 'embajada-it-visa',
  politica: { nombre: 'embajada-italia-it-visa-uy', version: '1' },
  requisito: { tipo: 'visa', nombre: undefined },
  campo_evidencia: 'visa',
  canonico: h => ({ obligatorio: 'no', descripcion: descripcionItVisa(h), fuente: URL_PAGINA })
});

const itPasaporte = crearPerfilProcedencia({
  ...comunItalia,
  nombre: 'embajada-it-pasaporte',
  politica: { nombre: 'embajada-italia-it-pasaporte-uy', version: '1' },
  requisito: { tipo: 'validez_pasaporte', nombre: undefined },
  campo_evidencia: 'pasaporte',
  canonico: h => ({ obligatorio: 'si', descripcion: descripcionItPasaporte(h), fuente: URL_PAGINA })
});

module.exports = { gbPasaporte, itVisa, itPasaporte, DESCRIPCION_GB_PASAPORTE, descripcionItVisa, descripcionItPasaporte };
