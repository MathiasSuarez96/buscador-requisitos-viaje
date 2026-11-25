/**
 * Adaptador 2.0 de solo lectura: ciudadanos uruguayos, turismo (visa). Ver ../../fuentes/argentina-extranjeros-turismo.js.
 */
const F = require('../../fuentes/argentina-extranjeros-turismo');
const { crearAdaptadorHechosV2 } = require('./fabrica-adaptador-hechos');

module.exports = crearAdaptadorHechosV2({
  nombre: 'argentina-extranjeros-turismo', version: '1', fuenteNombre: F.FUENTE_NOMBRE, url: F.URL_TABLA ?? F.URL_PAGINA, esquema: F.ESQUEMA_HECHOS,
  campos: F.CAMPOS, leerPagina: F.leerPagina, extraer: F.extraer, normalizarHechos: F.normalizarHechos
});
