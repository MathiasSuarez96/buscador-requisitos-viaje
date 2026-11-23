/**
 * Registro de perfiles de alta (sin modelos ni Mongo). Lo leen el servicio de alta y la configuración
 * del ciclo, para que una misma CICLO_V2_AUTORIZACION_JSON pueda listar políticas de ambos.
 */
const alemania = require('./perfil-alta-alemania');

const PERFILES_ALTA = Object.freeze([alemania]);
const clavePolitica = p => `${p.politica.nombre}@${p.politica.version}`;

module.exports = { PERFILES_ALTA, clavePolitica, POLITICAS_ALTA: Object.freeze(PERFILES_ALTA.map(clavePolitica)) };
