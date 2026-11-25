/**
 * Registro de perfiles del ciclo 2.0. Un perfil = un requisito de un destino, su adaptador y su
 * política automática. El workflow elige cuáles corre (--perfil); cada uno se habilita solo con
 * una autorización vigente de SU política (config-ciclo-real.js).
 */
const checkmig = require('./perfil-checkmig-colombia');
const gb = require('./perfil-govuk-reino-unido');
const alemania = require('./perfil-auswaertiges-amt-alemania');
const procedencia = require('./perfiles-procedencia-gb-it');
const { PERFILES_ETIAS } = require('./perfiles-etias-schengen');
const { PERFILES_AR_BR_CL } = require('./perfiles-ar-br-cl');

const PERFILES = Object.freeze([checkmig, gb.visa, gb.eta, alemania, procedencia.gbPasaporte, procedencia.itVisa, procedencia.itPasaporte, ...PERFILES_ETIAS, ...PERFILES_AR_BR_CL]);
const clavePolitica = p => `${p.politica.nombre}@${p.politica.version}`;

if (new Set(PERFILES.map(p => p.nombre)).size !== PERFILES.length) throw new Error('perfiles: nombres repetidos.');
// Un requisito, un perfil: dos perfiles sobre el mismo requisito podrían proponer cambios opuestos.
if (new Set(PERFILES.map(p => `${p.destino.codigo_iso}/${p.requisito.tipo}/${p.requisito.nombre ?? ''}`)).size !== PERFILES.length) throw new Error('perfiles: requisito cubierto dos veces.');

function perfilPorNombre(nombre, perfiles = PERFILES) {
  const p = perfiles.find(x => x.nombre === nombre);
  if (!p) throw new TypeError(`perfil desconocido: ${JSON.stringify(String(nombre)).slice(0, 80)}`);
  return p;
}

module.exports = { PERFILES, PERFIL_POR_DEFECTO: checkmig.nombre, clavePolitica, perfilPorNombre };
