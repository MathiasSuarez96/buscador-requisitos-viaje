/**
 * Perfil de ALTA de Alemania (DE) desde la lista oficial del Auswärtiges Amt.
 *
 * Qué publica el alta (contrato y campos obligatorios actuales del Destino, los seis tipos del catálogo):
 *  - visa: CONFIRMADO solo con hechos de dos lecturas iguales. Descripción de redacción propia que
 *    repite las condiciones de la fuente (pasaporte nacional uruguayo, hasta N días cada M, sin
 *    actividad remunerada), fuente = URL oficial y fecha_verificacion = día de la lectura.
 *  - formulario_digital, vacuna, validez_pasaporte, tasa_aeropuerto, documentacion_menor: esta fuente
 *    no los cubre → obligatorio 'verificar', estado 'verificar', sin fuente ni fecha de verificación.
 *    Nunca se publican como confirmados ni se infieren de otro país.
 *
 * Política automática: alta-auswaertiges-amt-alemania@1 (solo crea DE; no modifica destinos existentes).
 */
const adaptador = require('../adaptadores/v2/auswaertiges-amt-visumpflicht');
const { URL_LISTA } = require('../fuentes/auswaertiges-amt-visumpflicht');

const PENDIENTE = 'Pendiente de verificar con una fuente oficial para viajeros uruguayos. Todavía no hay un dato confirmado.';
const A_VERIFICAR = Object.freeze(['formulario_digital', 'vacuna', 'validez_pasaporte', 'tasa_aeropuerto', 'documentacion_menor']);

// Pura. Hechos confirmados → requisitos del destino nuevo (sin _id; los asigna el servicio).
function construirRequisitos(hechos, { hoy }) {
  const visa = hechos.visa_requerida === 'no'
    ? { tipo: 'visa', obligatorio: 'no',
        descripcion: `No requiere visa con pasaporte nacional uruguayo para estadías de hasta ${hechos.estancia.dias} días dentro de cualquier período de ${hechos.estancia.periodo_dias} días, sin actividad remunerada (por ejemplo, turismo). Para estadías más largas o para trabajar, consultar la fuente oficial.`,
        fuente: URL_LISTA, fecha_verificacion: hoy, estado: 'confirmado' }
    : { tipo: 'visa', obligatorio: 'si', descripcion: 'Requiere visa para ingresar a Alemania con pasaporte uruguayo, según la lista oficial del Auswärtiges Amt.',
        fuente: URL_LISTA, fecha_verificacion: hoy, estado: 'confirmado' };
  return [visa, ...A_VERIFICAR.map(tipo => ({ tipo, obligatorio: 'verificar', descripcion: PENDIENTE, estado: 'verificar' }))];
}

module.exports = Object.freeze({
  nombre: 'auswaertiges-amt-alemania',
  version: '1',
  politica: Object.freeze({ nombre: 'alta-auswaertiges-amt-alemania', version: '1' }),
  adaptador,
  destino: Object.freeze({ codigo_iso: 'DE', pais: 'Alemania' }),
  contexto_viajero: Object.freeze({ nacionalidad: 'UY', documento: 'pasaporte_nacional', motivo: 'turismo', duracion: 'hasta 90 días cada 180' }),
  campo_evidencia: 'visa',
  requisitos_confirmables: Object.freeze(['visa']),
  requisitos_a_verificar: A_VERIFICAR,
  construirRequisitos
});
