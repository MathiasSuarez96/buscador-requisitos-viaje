/**
 * Registro de adaptadores 2.0 (H3.2). Separado del registro 1.0 (../index.js) para que
 * elegirAdaptador de 1.0 nunca los vea. Sin callers: la orquestación de H3 lo usará después.
 *
 * INTERFAZ (objeto congelado): nombre y version (texto técnico), compatibilidad(propuesta) pura,
 * soporta(propuesta) pura, revalidar(propuesta, opciones) y proyectarRevalidacion(resultado).
 * elegirAdaptadorV2 exige que EXACTAMENTE uno sea compatible; si no, ErrorSinAdaptadorV2.
 */
const checkmig = require('./migracion-colombia-checkmig');

class ErrorSinAdaptadorV2 extends Error {
  constructor(mensaje, incompatibilidades) {
    super(mensaje);
    this.incompatibilidades = incompatibilidades;
  }
}

const NOMBRE_TECNICO = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const METODOS = ['compatibilidad', 'soporta', 'revalidar', 'proyectarRevalidacion'];

function validarAdaptadorV2(a) {
  if (a === null || typeof a !== 'object') throw new TypeError('Adaptador 2.0 inválido: no es un objeto.');
  if (!NOMBRE_TECNICO.test(a.nombre ?? '') || !NOMBRE_TECNICO.test(a.version ?? '')) throw new TypeError('Adaptador 2.0 inválido: nombre o version.');
  for (const m of METODOS) if (typeof a[m] !== 'function') throw new TypeError(`Adaptador 2.0 ${a.nombre}: falta ${m}().`);
  if (!Object.isFrozen(a)) throw new TypeError(`Adaptador 2.0 ${a.nombre}: debe estar congelado.`);
  return a;
}

const ADAPTADORES_V2 = Object.freeze([checkmig].map(validarAdaptadorV2));

function elegirAdaptadorV2(propuesta, adaptadores = ADAPTADORES_V2) {
  const evaluados = adaptadores.map(validarAdaptadorV2).map(a => ({ a, c: a.compatibilidad(propuesta) }));
  const compatibles = evaluados.filter(e => e.c.compatible === true);
  const incompatibilidades = evaluados.filter(e => !e.c.compatible).map(e => ({ adaptador: e.a.nombre, codigo: e.c.codigo }));
  if (compatibles.length !== 1) {
    throw new ErrorSinAdaptadorV2(`La propuesta debe ser compatible con exactamente un adaptador 2.0 (compatibles: ${compatibles.length}).`, incompatibilidades);
  }
  return compatibles[0].a;
}

module.exports = { ADAPTADORES_V2, ErrorSinAdaptadorV2, validarAdaptadorV2, elegirAdaptadorV2 };
