/**
 * Adaptador 2.0 de solo lectura para la página «Visas» de la Embajada de Italia en Montevideo
 * (uruguayos naturales residentes en Uruguay, turismo). Lo usan los perfiles de visa y de validez
 * del pasaporte de Italia. Ver ../../fuentes/embajada-italia-montevideo-visas.js.
 */
const F = require('../../fuentes/embajada-italia-montevideo-visas');
const { crearAdaptadorHechosV2 } = require('./fabrica-adaptador-hechos');

module.exports = crearAdaptadorHechosV2({
  nombre: 'embajada-italia-montevideo', version: '1', fuenteNombre: F.FUENTE_NOMBRE, url: F.URL_PAGINA, esquema: F.ESQUEMA_HECHOS,
  campos: F.CAMPOS, leerPagina: F.leerPagina, extraer: F.extraer, normalizarHechos: F.normalizarHechos
});
