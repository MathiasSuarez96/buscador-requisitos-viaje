/**
 * Lote AR/BR/CL: migra de IATA a fuentes oficiales del DESTINO cuatro requisitos confirmados, cada uno
 * con su política propia (alcance: ese requisito de ese destino).
 *
 *  argentina-ar-visa         AR visa · argentina.gob.ar «Extranjeros» › Turismo › Mercosur (ciudadanos
 *                            uruguayos, turismo, hasta N días). Política argentina-gob-ar-visa-uy@1.
 *  migraciones-ar-documento  AR validez_pasaporte · Migraciones «Documentación para ingresar al país como
 *                            turista»: pasaporte vigente, cédula vigente o documento de viaje hábil vigente
 *                            de Uruguay. Política migraciones-ar-documento-uy@1.
 *  itamaraty-br-visa         BR visa · Itamaraty QGRV: Uruguai, VIVIS «4 #» (dispensa de visto de visita
 *                            con pasaporte común por hasta N días; ingreso con cédula de identidad civil).
 *                            Política itamaraty-br-visa-uy@1.
 *  consulado-cl-visa         CL visa · tabla de la Red Consular de Chile: URUGUAY, visa NO, plazo máximo
 *                            de estadía N días, con el texto de sus notas 1, 2 y 17 (permanencia
 *                            transitoria de una o varias entradas; «salvo excepciones» en la de varias).
 *                            Política consulado-chile-cl-visa-uy@1.
 *
 * Cédula: el tipo validez_pasaporte se muestra como «Validez de pasaporte». Cuando la fuente permite
 * ingresar con cédula, el pasaporte NO es obligatorio: el canónico fija obligatorio 'no' (advertencia
 * quita_obligatoriedad, aceptada por la política) y la descripción nombra todas las alternativas con su
 * vigencia. Así el contrato existente lo representa sin decir que hace falta pasaporte.
 *
 * Las descripciones son redacción propia y solo repiten lo que la fuente dice (nacionalidad o país del
 * documento, documento, motivo, duración). Lo que la fuente no dice deja de publicarse.
 */
const { crearPerfilProcedencia } = require('./perfil-procedencia');
const adArVisa = require('../adaptadores/v2/argentina-extranjeros-turismo');
const adArDoc = require('../adaptadores/v2/argentina-migraciones-documentacion-turista');
const adBrVisa = require('../adaptadores/v2/itamaraty-qgrv');
const adClVisa = require('../adaptadores/v2/consulado-chile-visas');
const FAr = require('../fuentes/argentina-extranjeros-turismo');
const FArDoc = require('../fuentes/argentina-migraciones-documentacion-turista');
const FBr = require('../fuentes/itamaraty-qgrv');
const FCl = require('../fuentes/consulado-chile-visas');

// Pura. Descripciones canónicas (también las usan las pruebas).
const descripcionArVisa = h => `Los ciudadanos uruguayos pueden ingresar a la Argentina como turistas sin visa, por hasta ${h.estancia_dias_max} días. Para trabajar, estudiar u otros motivos, consultar la fuente oficial.`;
const DESCRIPCION_AR_DOCUMENTO = 'Para ingresar a la Argentina como turista no se exige pasaporte: con documentos de Uruguay se acepta el pasaporte vigente, la cédula de identidad vigente o un documento de viaje hábil vigente. Para otros motivos de viaje, consultar la fuente oficial.';
const descripcionBrVisa = h => `Según el cuadro de visas de Itamaraty, los nacionales de Uruguay con pasaporte común no necesitan visa de visita: la dispensa es por hasta ${h.dispensa_dias_max} días. El mismo cuadro permite el ingreso con cédula de identidad civil. Para trabajo, estudio o residencia, consultar la fuente oficial.`;
const descripcionClVisa = h => `Según la tabla de visas de la Red Consular de Chile, los nacionales de Uruguay no requieren visa de permanencia transitoria para ingresar a Chile. La tabla indica un plazo máximo de estadía de ${h.plazo_maximo_estadia_dias} días, para una entrada o para varias; para varias entradas aclara «salvo excepciones». Para residir o trabajar en Chile, consultar la fuente oficial.`;

const arVisa = crearPerfilProcedencia({
  nombre: 'argentina-ar-visa', politica: { nombre: 'argentina-gob-ar-visa-uy', version: '1' }, adaptador: adArVisa,
  destino: { codigo_iso: 'AR' }, requisito: { tipo: 'visa', nombre: undefined },
  contexto_viajero: { nacionalidad: 'UY (ciudadano)', documento: 'no lo indica esta fuente', motivo: 'turismo', duracion: 'según la fuente (días)' },
  campo_evidencia: 'visa',
  canonico: h => ({ obligatorio: 'no', descripcion: descripcionArVisa(h), fuente: FAr.URL_PAGINA })
});

const arDocumento = crearPerfilProcedencia({
  nombre: 'migraciones-ar-documento', politica: { nombre: 'migraciones-ar-documento-uy', version: '1' }, adaptador: adArDoc,
  destino: { codigo_iso: 'AR' }, requisito: { tipo: 'validez_pasaporte', nombre: undefined },
  contexto_viajero: { nacionalidad: 'UY (país de origen del documento)', documento: 'pasaporte, cédula o documento de viaje hábil, vigentes', motivo: 'turismo', duracion: 'no aplica' },
  campo_evidencia: 'documento',
  canonico: () => ({ obligatorio: 'no', descripcion: DESCRIPCION_AR_DOCUMENTO, fuente: FArDoc.URL_PAGINA })
});

const brVisa = crearPerfilProcedencia({
  nombre: 'itamaraty-br-visa', politica: { nombre: 'itamaraty-br-visa-uy', version: '1' }, adaptador: adBrVisa,
  destino: { codigo_iso: 'BR' }, requisito: { tipo: 'visa', nombre: undefined },
  contexto_viajero: { nacionalidad: 'UY', documento: 'pasaporte común (o cédula de identidad civil)', motivo: 'visita', duracion: 'según la fuente (días)' },
  campo_evidencia: 'visa',
  canonico: h => ({ obligatorio: 'no', descripcion: descripcionBrVisa(h), fuente: FBr.URL_PAGINA })
});

const clVisa = crearPerfilProcedencia({
  nombre: 'consulado-cl-visa', politica: { nombre: 'consulado-chile-cl-visa-uy', version: '1' }, adaptador: adClVisa,
  destino: { codigo_iso: 'CL' }, requisito: { tipo: 'visa', nombre: undefined },
  contexto_viajero: { nacionalidad: 'UY', documento: 'no lo indica esta fuente', motivo: 'permanencia transitoria (notas 1 y 2 de la tabla)', duracion: 'plazo máximo según la fuente (días), una o varias entradas' },
  campo_evidencia: 'visa',
  canonico: h => ({ obligatorio: 'no', descripcion: descripcionClVisa(h), fuente: FCl.URL_PAGINA })
});

module.exports = { arVisa, arDocumento, brVisa, clVisa, PERFILES_AR_BR_CL: Object.freeze([arVisa, arDocumento, brVisa, clVisa]),
  descripcionArVisa, DESCRIPCION_AR_DOCUMENTO, descripcionBrVisa, descripcionClVisa };
