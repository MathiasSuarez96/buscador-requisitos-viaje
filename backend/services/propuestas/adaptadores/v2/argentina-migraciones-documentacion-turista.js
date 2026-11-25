/**
 * Adaptador 2.0 de solo lectura: documento para ingresar como turista. Ver ../../fuentes/argentina-migraciones-documentacion-turista.js.
 */
const F = require('../../fuentes/argentina-migraciones-documentacion-turista');
const { crearAdaptadorHechosV2 } = require('./fabrica-adaptador-hechos');

module.exports = crearAdaptadorHechosV2({
  nombre: 'argentina-migraciones-documentacion-turista', version: '1', fuenteNombre: F.FUENTE_NOMBRE, url: F.URL_TABLA ?? F.URL_PAGINA, esquema: F.ESQUEMA_HECHOS,
  campos: F.CAMPOS, leerPagina: F.leerPagina, extraer: F.extraer, normalizarHechos: F.normalizarHechos
});
