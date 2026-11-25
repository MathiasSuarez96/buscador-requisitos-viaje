/**
 * Adaptador 2.0 de solo lectura: visa de visita (pasaporte común) y cédula. Ver ../../fuentes/itamaraty-qgrv.js.
 */
const F = require('../../fuentes/itamaraty-qgrv');
const { crearAdaptadorHechosV2 } = require('./fabrica-adaptador-hechos');

module.exports = crearAdaptadorHechosV2({
  nombre: 'itamaraty-qgrv', version: '1', fuenteNombre: F.FUENTE_NOMBRE, url: F.URL_TABLA ?? F.URL_PAGINA, esquema: F.ESQUEMA_HECHOS,
  campos: F.CAMPOS, leerPagina: F.leerPagina, extraer: F.extraer, normalizarHechos: F.normalizarHechos
});
