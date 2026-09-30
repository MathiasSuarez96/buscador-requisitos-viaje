/**
 * Clasificación de la IDENTIDAD de un requisito dentro de un destino ya
 * leído, con las mismas cuatro categorías que el piloto de lectura
 * (CATEGORIAS_IDENTIDAD_NO_COINCIDE en contrato-propuestas.js):
 *  - destino_no_encontrado: el destino no existe.
 *  - requisito_id_no_encontrado: ningún requisitos[] tiene ese _id.
 *  - requisito_id_duplicado: más de uno lo tiene (el _id debería ser único).
 *  - identidad_semantica_no_coincide: hay exactamente uno, pero el
 *    adaptador dice que no es el requisito esperado (tipo, nombre...).
 *
 * La existencia y unicidad del _id las decide esta función; la identidad
 * SEMÁNTICA la decide el adaptador (validarIdentidad, ver
 * adaptadores/index.js). Pura: sin I/O, no modifica el destino.
 *
 * `requisitoId` es el string hex de 24 caracteres del contrato (el de
 * payload.requisito_id). Se compara contra String(r._id), así que sirve
 * tanto si el subdocumento trae un ObjectId de BSON como un string.
 * Todo `detalle` devuelto es canonicalizable (ids como string, sin
 * undefined): termina en IntentoAplicacion.identidad_esperada_no_coincide.
 */

const OBJECT_ID_HEX = /^[0-9a-f]{24}$/;

function clasificarIdentidadRequisito(destino, requisitoId, validarIdentidad) {
  if (typeof requisitoId !== 'string' || !OBJECT_ID_HEX.test(requisitoId)) {
    throw new TypeError(`clasificarIdentidadRequisito: requisitoId debe ser un string hex de 24 caracteres (recibido ${JSON.stringify(requisitoId)}).`);
  }
  if (typeof validarIdentidad !== 'function') {
    throw new TypeError('clasificarIdentidadRequisito: validarIdentidad debe ser una función.');
  }

  if (destino === null || destino === undefined) {
    return { ok: false, categoria: 'destino_no_encontrado', detalle: { requisito_id: requisitoId } };
  }

  const destinoId = destino._id != null ? String(destino._id) : null;
  const requisitos = Array.isArray(destino.requisitos) ? destino.requisitos : [];
  const coincidencias = requisitos.filter(
    (r) => r !== null && typeof r === 'object' && Object.hasOwn(r, '_id') && r._id != null && String(r._id) === requisitoId
  );

  if (coincidencias.length === 0) {
    return {
      ok: false,
      categoria: 'requisito_id_no_encontrado',
      detalle: { destino_id: destinoId, requisito_id: requisitoId, cantidad: 0 }
    };
  }
  if (coincidencias.length > 1) {
    return {
      ok: false,
      categoria: 'requisito_id_duplicado',
      detalle: { destino_id: destinoId, requisito_id: requisitoId, cantidad: coincidencias.length }
    };
  }

  const requisito = coincidencias[0];
  const r = validarIdentidad(requisito);
  if (r !== null && typeof r === 'object' && r.ok === true) return { ok: true, requisito };
  if (r !== null && typeof r === 'object' && r.ok === false && r.categoria === 'identidad_semantica_no_coincide') {
    return {
      ok: false,
      categoria: 'identidad_semantica_no_coincide',
      detalle: { destino_id: destinoId, requisito_id: requisitoId, ...(r.detalle !== undefined ? { adaptador: r.detalle } : {}) }
    };
  }
  throw new TypeError(
    `clasificarIdentidadRequisito: validarIdentidad devolvió una forma fuera del contrato del adaptador: ${JSON.stringify(r)}.`
  );
}

module.exports = { clasificarIdentidadRequisito };
