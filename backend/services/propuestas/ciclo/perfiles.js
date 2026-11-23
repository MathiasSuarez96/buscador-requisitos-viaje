/**
 * Registro de perfiles del ciclo 2.0. Un perfil = un requisito de un destino, su adaptador y su
 * política automática. El workflow elige cuáles corre (--perfil); cada uno se habilita solo con
 * una autorización vigente de SU política (config-ciclo-real.js).
 */
const checkmig = require('./perfil-checkmig-colombia');
const gb = require('./perfil-govuk-reino-unido');

const PERFILES = Object.freeze([checkmig, gb.visa, gb.eta]);
const clavePolitica = p => `${p.politica.nombre}@${p.politica.version}`;

if (new Set(PERFILES.map(p => p.nombre)).size !== PERFILES.length) throw new Error('perfiles: nombres repetidos.');

function perfilPorNombre(nombre, perfiles = PERFILES) {
  const p = perfiles.find(x => x.nombre === nombre);
  if (!p) throw new TypeError(`perfil desconocido: ${JSON.stringify(String(nombre)).slice(0, 80)}`);
  return p;
}

module.exports = { PERFILES, PERFIL_POR_DEFECTO: checkmig.nombre, clavePolitica, perfilPorNombre };
