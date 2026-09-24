/**
 * Canonicalización toc-v1 y hash del sobre canónico completo, usados
 * por backend/models/propuestas/PropuestaCambio.model.js y por
 * scripts/test-modelos-propuestas.js. Extraído a módulo compartido
 * (en vez de duplicado, que era la convención hasta ahora en este
 * proyecto para este algoritmo) porque el futuro servicio de creación
 * de propuestas necesita calcular exactamente el mismo payload_hash
 * que el modelo va a validar — cualquier divergencia entre dos copias
 * independientes sería un bug de integridad silencioso.
 *
 * ALGORITMO_CANONICALIZACION / ALGORITMO_HASH: los dos valores que hoy
 * soporta el sobre canónico. Ver PropuestaCambio.model.js para el
 * enum que restringe los campos homónimos del documento a estos
 * valores.
 *
 * canonicalizarValor: UTF-8, claves ordenadas recursivamente, fechas en
 * UTC como ISO string. `undefined` está explícitamente PROHIBIDO: una
 * clave puesta en `undefined` se rechaza en vez de reescribirse en
 * silencio a `null` (eso haría indistinguible "esta clave nunca se
 * puso" de "esta clave se puso en null"). Una clave que simplemente no
 * existe en el objeto de origen ya se comporta bien sin ayuda
 * (Object.keys no la itera, así que no aparece en el canónico).
 *
 * hashSobreCanonico: hashea el SOBRE completo
 * ({algoritmo_canonicalizacion, algoritmo_hash, payload}), no solo el
 * payload — así el hash también protege contra un downgrade silencioso
 * del algoritmo declarado. Valida explícitamente que los algoritmos
 * recibidos sean los únicos soportados hoy (ALGORITMO_CANONICALIZACION/
 * ALGORITMO_HASH) y aborta si no — y usa `algoritmoHash` de verdad para
 * elegir el algoritmo de `crypto.createHash` (antes quedaba
 * hardcodeado a 'sha256' sin importar qué se recibiera, así que el
 * parámetro no tenía ningún efecto real).
 *
 * VERSION_CONTRATO_PROPUESTA / TIPO_PROPUESTA / esFechaIsoUtcExacta:
 * contrato del contenido inmutable del payload (version_contrato,
 * tipo_propuesta, fecha_propuesta). Viven acá por la misma razón que la
 * canonicalización: el modelo los valida y el servicio los produce, y
 * dos copias podrían divergir en silencio.
 */

const crypto = require('crypto');

const ALGORITMO_CANONICALIZACION = 'toc-v1';
const ALGORITMO_HASH = 'sha256';
const SHA256_HEX = /^[0-9a-f]{64}$/;
const VERSION_CONTRATO_PROPUESTA = '1.0';
const TIPO_PROPUESTA = 'actualizacion_campo_requisito';

// ISO 8601 en UTC exactamente como lo produce Date#toISOString(): se
// exige ida y vuelta exacta para no aceptar strings que Date.parse
// tolera pero que canonicalizarían distinto (sin milisegundos, otra
// zona horaria, fechas desbordadas como 30 de febrero).
function esFechaIsoUtcExacta(valor) {
  if (typeof valor !== 'string') return false;
  const fecha = new Date(valor);
  return !Number.isNaN(fecha.getTime()) && fecha.toISOString() === valor;
}

function canonicalizarValor(valor) {
  if (valor === undefined) {
    throw new Error(
      'toc-v1: "undefined" no está permitido en el payload canónico. La ausencia de un valor debe representarse omitiendo la clave o con el shape {presente:false, valor:null}, nunca con undefined.'
    );
  }
  if (valor instanceof Date) return valor.toISOString();
  if (Array.isArray(valor)) return valor.map(canonicalizarValor);
  if (valor !== null && typeof valor === 'object') {
    const claves = Object.keys(valor).sort();
    const obj = {};
    for (const clave of claves) {
      obj[clave] = canonicalizarValor(valor[clave]);
    }
    return obj;
  }
  return valor;
}

function hashSobreCanonico(payload, algoritmoCanonicalizacion, algoritmoHash) {
  if (algoritmoCanonicalizacion !== ALGORITMO_CANONICALIZACION) {
    throw new Error(
      `hashSobreCanonico: algoritmo_canonicalizacion "${algoritmoCanonicalizacion}" no soportado (solo se soporta "${ALGORITMO_CANONICALIZACION}").`
    );
  }
  if (algoritmoHash !== ALGORITMO_HASH) {
    throw new Error(
      `hashSobreCanonico: algoritmo_hash "${algoritmoHash}" no soportado (solo se soporta "${ALGORITMO_HASH}").`
    );
  }

  const sobre = {
    algoritmo_canonicalizacion: algoritmoCanonicalizacion,
    algoritmo_hash: algoritmoHash,
    payload
  };
  return crypto
    .createHash(algoritmoHash)
    .update(JSON.stringify(canonicalizarValor(sobre)), 'utf8')
    .digest('hex');
}

module.exports = {
  ALGORITMO_CANONICALIZACION,
  ALGORITMO_HASH,
  SHA256_HEX,
  VERSION_CONTRATO_PROPUESTA,
  TIPO_PROPUESTA,
  esFechaIsoUtcExacta,
  canonicalizarValor,
  hashSobreCanonico
};
