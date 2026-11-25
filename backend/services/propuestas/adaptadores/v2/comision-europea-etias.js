/**
 * Adaptador 2.0 de solo lectura para la página ETIAS de la Comisión Europea. Lo usan los perfiles
 * «ETIAS (Schengen)» de los destinos del catálogo. Ver ../../fuentes/comision-europea-etias.js.
 */
const F = require('../../fuentes/comision-europea-etias');
const { crearAdaptadorHechosV2 } = require('./fabrica-adaptador-hechos');

module.exports = crearAdaptadorHechosV2({
  nombre: 'comision-europea-etias', version: '1', fuenteNombre: F.FUENTE_NOMBRE, url: F.URL_PAGINA, esquema: F.ESQUEMA_HECHOS,
  campos: F.CAMPOS, leerPagina: F.leerPagina, extraer: F.extraer, normalizarHechos: F.normalizarHechos
});
