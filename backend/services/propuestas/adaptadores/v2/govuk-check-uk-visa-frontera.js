/**
 * Adaptador 2.0 de solo lectura para la sección «What you need at the UK border» del resultado
 * oficial de GOV.UK (Uruguay, sin doble ciudadanía, turismo). Misma URL que govuk-check-uk-visa,
 * esquema propio: cada propuesta es compatible con uno solo de los dos.
 * Ver ../../fuentes/govuk-check-uk-visa-frontera.js.
 */
const F = require('../../fuentes/govuk-check-uk-visa-frontera');
const { crearAdaptadorHechosV2 } = require('./fabrica-adaptador-hechos');

module.exports = crearAdaptadorHechosV2({
  nombre: 'govuk-check-uk-visa-frontera', version: '1', fuenteNombre: F.FUENTE_NOMBRE, url: F.URL_RESULTADO, esquema: F.ESQUEMA_HECHOS,
  campos: F.CAMPOS, leerPagina: F.leerPagina, extraer: F.extraer, normalizarHechos: F.normalizarHechos
});
