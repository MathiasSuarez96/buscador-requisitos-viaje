/**
 * Adaptador 2.0 de solo lectura para la «Staatenliste zur Visumpflicht» del Auswärtiges Amt (fila
 * Uruguay). Lo usan el alta de Alemania y, una vez creada, su mantenimiento.
 * Ver ../../fuentes/auswaertiges-amt-visumpflicht.js.
 */
const F = require('../../fuentes/auswaertiges-amt-visumpflicht');
const { crearAdaptadorHechosV2 } = require('./fabrica-adaptador-hechos');

module.exports = crearAdaptadorHechosV2({
  nombre: 'auswaertiges-amt-visumpflicht', version: '1', fuenteNombre: F.FUENTE_NOMBRE, url: F.URL_LISTA, esquema: F.ESQUEMA_HECHOS,
  campos: F.CAMPOS, leerPagina: F.leerLista, extraer: F.extraer, normalizarHechos: F.normalizarHechos
});
