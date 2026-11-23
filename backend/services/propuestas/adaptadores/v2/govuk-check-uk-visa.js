/**
 * Adaptador 2.0 de solo lectura para el resultado oficial de «Check if you need a UK visa»
 * (Uruguay, sin doble ciudadanía, turismo). Ver ../../fuentes/govuk-check-uk-visa.js.
 */
const F = require('../../fuentes/govuk-check-uk-visa');
const { crearAdaptadorHechosV2 } = require('./fabrica-adaptador-hechos');

module.exports = crearAdaptadorHechosV2({
  nombre: 'govuk-check-uk-visa', version: '1', fuenteNombre: F.FUENTE_NOMBRE, url: F.URL_RESULTADO, esquema: F.ESQUEMA_HECHOS,
  campos: F.CAMPOS, leerPagina: F.leerResultado, extraer: F.extraer, normalizarHechos: F.normalizarHechos
});
