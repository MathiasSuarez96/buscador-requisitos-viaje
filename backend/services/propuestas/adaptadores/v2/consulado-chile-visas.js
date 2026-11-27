/**
 * Adaptador 2.0 de solo lectura: visa por nacionalidad (tabla JSON y texto de sus notas). Ver ../../fuentes/consulado-chile-visas.js.
 * Versión 2: los hechos incluyen el texto de las notas referenciadas (esquema consulado-chile-visas-hechos-v2).
 */
const F = require('../../fuentes/consulado-chile-visas');
const { crearAdaptadorHechosV2 } = require('./fabrica-adaptador-hechos');

module.exports = crearAdaptadorHechosV2({
  nombre: 'consulado-chile-visas', version: '2', fuenteNombre: F.FUENTE_NOMBRE, url: F.URL_TABLA ?? F.URL_PAGINA, esquema: F.ESQUEMA_HECHOS,
  campos: F.CAMPOS, leerPagina: F.leerPagina, extraer: F.extraer, normalizarHechos: F.normalizarHechos
});
