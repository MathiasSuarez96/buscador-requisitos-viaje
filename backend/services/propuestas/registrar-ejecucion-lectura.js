/**
 * Registra una corrida de lectura (hoy: piloto UK ETA) como
 * EjecucionLectura y, si corresponde, una PropuestaCambio en
 * pendiente_aprobacion. Sobre ejecuciones_lectura y propuestas_cambio
 * solo INSERTA, nunca actualiza (ver nota append-only en
 * EjecucionLectura.model.js).
 *
 * Categorías que generan propuesta: SIN_COSTO_PREVIO_EN_MONGO e
 * IMPORTE_NO_COINCIDE (con ambiguo: false). El resto (COINCIDE,
 * MONEDA_DISTINTA y las ambiguas) solo registran la ejecución.
 *
 * La unicidad de propuesta activa la garantiza el índice único parcial
 * uniq_propuesta_activa_por_destino_requisito_campo; la búsqueda previa
 * dentro de la transacción solo evita el E11000 en el caso común, no
 * alcanza sola ante dos corridas concurrentes. Por eso
 * verificarIndices() exige ese índice (tal cual está declarado en el
 * schema) antes de escribir nada.
 *
 * E11000 sobre ese índice (reconocido por código, nombre de índice Y
 * keyPattern): la transacción revierte completa — ni la propuesta ni la
 * ejecución quedan — y se reintenta el flujo entero; el reintento
 * encuentra la propuesta ganadora y vincula la ejecución con
 * propuesta_fue_creada_por_esta_ejecucion: false. Una propuesta activa
 * que propone otro valor NO se marca obsoleta: se persiste
 * valor_normalizado_coincide: false en propuesta_referencia.
 *
 * Contenido inmutable del payload: además de los datos de negocio,
 * version_contrato '1.0', tipo_propuesta 'actualizacion_campo_requisito'
 * y fecha_propuesta (ISO UTC), todos cubiertos por el hash.
 * propuesta_id y fecha_propuesta se generan UNA sola vez, fuera del
 * callback transaccional, para que todo reintento (TransientTransaction
 * o colisión E11000) reutilice exactamente el mismo payload y hash.
 * version_coordinacion arranca en 0 (ver PropuestaCambio.model.js).
 *
 * No se emite EventoPropuesta al crear: el enum de tipo_evento no tiene
 * "creacion" y el modelo exige estado_anterior !== estado_nuevo. La
 * evidencia de creación es la propia EjecucionLectura.
 *
 * Las dependencias de Mongo se inyectan (crearDependenciasMongoose) para
 * poder probar el flujo completo sin conexión — ver
 * scripts/test-servicio-ejecucion-lectura.js.
 */

const crypto = require('crypto');
const mongoose = require('mongoose');
const EjecucionLectura = require('../../models/propuestas/EjecucionLectura.model');
const PropuestaCambio = require('../../models/propuestas/PropuestaCambio.model');
const {
  ALGORITMO_CANONICALIZACION,
  ALGORITMO_HASH,
  VERSION_CONTRATO_PROPUESTA,
  TIPO_PROPUESTA,
  esFechaIsoUtcExacta,
  canonicalizarValor,
  hashSobreCanonico
} = require('./canonicalizacion-propuestas');

const CATEGORIAS_QUE_GENERAN_PROPUESTA = ['SIN_COSTO_PREVIO_EN_MONGO', 'IMPORTE_NO_COINCIDE'];

// Duplicado a propósito desde PropuestaCambio.model.js (el modelo solo
// exporta el Model); test-servicio-ejecucion-lectura.js verifica que
// coincida con el partialFilterExpression declarado en el schema.
const ESTADOS_ACTIVOS = ['pendiente_aprobacion', 'aprobada', 'revision_requerida'];
const INDICE_PROPUESTA_ACTIVA = 'uniq_propuesta_activa_por_destino_requisito_campo';
const CLAVE_INDICE_PROPUESTA_ACTIVA = { destino_id: 1, requisito_id: 1, campo: 1 };
const MAX_INTENTOS = 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class ErrorEntradaInvalida extends Error {}
class ErrorPrecondicionIndices extends Error {}
class ErrorEjecucionDuplicada extends Error {}

function debeGenerarPropuesta(categoria) {
  return CATEGORIAS_QUE_GENERAN_PROPUESTA.includes(categoria);
}

// Mismo conjunto de claves (sin importar orden) — keyPattern viene del
// servidor, no conviene depender del orden de sus claves.
function mismasClaves(a, b) {
  if (a == null || typeof a !== 'object') return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
}

// Exige código 11000, el nombre del índice en el mensaje Y un keyPattern
// con exactamente destino_id + requisito_id + campo. Si el driver no
// trajera keyPattern, NO se trata como colisión: cae en el camino de
// fallo registrado (conservador — nunca se vincula a una "ganadora" por
// un E11000 que no se pudo atribuir con certeza a este índice).
function esColisionPropuestaActiva(err) {
  return (
    err?.code === 11000 &&
    String(err.message).includes(INDICE_PROPUESTA_ACTIVA) &&
    mismasClaves(err.keyPattern, CLAVE_INDICE_PROPUESTA_ACTIVA)
  );
}

function esDuplicadoRunId(err) {
  return err?.code === 11000 && mismasClaves(err.keyPattern, { run_id: 1 });
}

function validarEntrada(e) {
  const falla = (m) => {
    throw new ErrorEntradaInvalida(`registrarEjecucionLectura: ${m}`);
  };
  if (e === null || typeof e !== 'object') falla('la entrada debe ser un objeto.');
  if (typeof e.run_id !== 'string' || !UUID.test(e.run_id)) falla('run_id debe ser un UUID.');
  if (!(e.iniciado_en instanceof Date) || Number.isNaN(e.iniciado_en.getTime())) {
    falla('iniciado_en debe ser un Date válido.');
  }
  if (e.campo !== 'costo') falla('el MVP solo soporta campo "costo".');
  if (!e.fuente?.nombre || !e.fuente?.url) falla('fuente.nombre y fuente.url son obligatorios.');
  if (e.fuente.capturado_en != null && !esFechaIsoUtcExacta(e.fuente.capturado_en)) {
    falla(`fuente.capturado_en debe ser una fecha ISO válida (Date#toISOString), recibido ${JSON.stringify(e.fuente.capturado_en)}.`);
  }
  if (e.evidencia === null || typeof e.evidencia !== 'object' || Array.isArray(e.evidencia)) {
    falla('evidencia debe ser un objeto.');
  }
  // Rechaza undefined en la evidencia antes de cualquier escritura (se
  // copia al payload hasheado).
  try {
    canonicalizarValor(e.evidencia);
  } catch (err) {
    falla(`evidencia inválida: ${err.message}`);
  }

  if (e.estado_ejecucion === 'fallo') {
    if (!e.etapa_fallo || !e.error_mensaje) falla('un fallo exige etapa_fallo y error_mensaje.');
    return;
  }
  if (e.estado_ejecucion !== 'ok') falla('estado_ejecucion debe ser "ok" o "fallo".');
  if (!mongoose.isObjectIdOrHexString(e.destino_id) || !mongoose.isObjectIdOrHexString(e.requisito_id)) {
    falla('destino_id y requisito_id deben ser ObjectId válidos.');
  }
  const previo = e.valor_previo_en_mongo;
  if (previo === null || typeof previo !== 'object' || typeof previo.presente !== 'boolean' || !('valor' in previo)) {
    falla('valor_previo_en_mongo debe ser {presente, valor}.');
  }
  if (!previo.presente && previo.valor !== null) {
    falla('valor_previo_en_mongo: si presente es false, valor debe ser null.');
  }
  const { categoria, ambiguo } = e.resultado_comparacion ?? {};
  if (typeof categoria !== 'string' || typeof ambiguo !== 'boolean') {
    falla('resultado_comparacion debe ser {categoria, ambiguo}.');
  }

  if (debeGenerarPropuesta(categoria)) {
    if (ambiguo) falla(`la categoría ${categoria} no puede generar propuesta con ambiguo: true.`);
    if (e.fuente.capturado_en == null) falla('fuente.capturado_en es obligatorio para proponer.');
    const vp = e.valor_propuesto;
    if (
      typeof vp?.valor !== 'string' ||
      vp.valor === '' ||
      !Number.isInteger(vp.valor_normalizado?.importe) ||
      vp.valor_normalizado.importe < 0 ||
      typeof vp.valor_normalizado.moneda !== 'string' ||
      vp.valor_normalizado.moneda === ''
    ) {
      falla('valor_propuesto debe ser {valor: string, valor_normalizado: {importe: entero >= 0, moneda: string}}.');
    }
  } else if (e.valor_propuesto !== undefined) {
    falla(`la categoría ${categoria} no genera propuesta; no debe traer valor_propuesto.`);
  }
}

function construirPayloadPropuesta(e, propuestaId, fechaPropuesta) {
  if (!esFechaIsoUtcExacta(fechaPropuesta)) {
    throw new ErrorEntradaInvalida(
      `registrarEjecucionLectura: fecha_propuesta debe ser una fecha ISO UTC exacta, recibido ${JSON.stringify(fechaPropuesta)}.`
    );
  }
  return {
    version_contrato: VERSION_CONTRATO_PROPUESTA,
    tipo_propuesta: TIPO_PROPUESTA,
    fecha_propuesta: fechaPropuesta,
    destino_id: String(e.destino_id),
    requisito_id: String(e.requisito_id),
    campo: e.campo,
    run_id_origen: e.run_id,
    propuesta_id: propuestaId,
    valor_anterior: { presente: e.valor_previo_en_mongo.presente, valor: e.valor_previo_en_mongo.valor },
    valor_propuesto: {
      valor: e.valor_propuesto.valor,
      valor_normalizado: {
        importe: e.valor_propuesto.valor_normalizado.importe,
        moneda: e.valor_propuesto.valor_normalizado.moneda
      },
      evidencia: e.evidencia
    },
    fuente: { nombre: e.fuente.nombre, url: e.fuente.url, capturado_en: e.fuente.capturado_en }
  };
}

function construirPropuesta(e, propuestaId, fechaPropuesta) {
  const payload = construirPayloadPropuesta(e, propuestaId, fechaPropuesta);
  return {
    propuesta_id: propuestaId,
    destino_id: payload.destino_id,
    requisito_id: payload.requisito_id,
    campo: payload.campo,
    run_id_origen: payload.run_id_origen,
    algoritmo_canonicalizacion: ALGORITMO_CANONICALIZACION,
    algoritmo_hash: ALGORITMO_HASH,
    payload,
    payload_hash: hashSobreCanonico(payload, ALGORITMO_CANONICALIZACION, ALGORITMO_HASH),
    estado: 'pendiente_aprobacion',
    version_coordinacion: 0
  };
}

function construirEjecucion(e, propuestaReferencia, finalizadoEn) {
  const doc = {
    run_id: e.run_id,
    estado_ejecucion: e.estado_ejecucion,
    iniciado_en: e.iniciado_en,
    finalizado_en: finalizadoEn,
    destino_id: e.destino_id ?? null,
    requisito_id: e.requisito_id ?? null,
    campo: e.campo,
    fuente_nombre: e.fuente.nombre,
    fuente_url: e.fuente.url,
    evidencia: e.evidencia
  };
  if (e.estado_ejecucion === 'fallo') {
    doc.etapa_fallo = e.etapa_fallo;
    doc.error_mensaje = e.error_mensaje;
  }
  if (e.resultado_comparacion) {
    doc.resultado_comparacion = { categoria: e.resultado_comparacion.categoria, ambiguo: e.resultado_comparacion.ambiguo };
  }
  if (e.valor_previo_en_mongo) {
    doc.valor_previo_en_mongo = { presente: e.valor_previo_en_mongo.presente, valor: e.valor_previo_en_mongo.valor };
  }
  if (propuestaReferencia) doc.propuesta_referencia = propuestaReferencia;
  return doc;
}

function valorNormalizadoCanonico(propuesta) {
  return JSON.stringify(canonicalizarValor(propuesta.payload?.valor_propuesto?.valor_normalizado ?? null));
}

function construirReferencia(referenciada, propia, creadaPorEstaEjecucion) {
  return {
    propuesta_id_referenciada: referenciada.propuesta_id,
    propuesta_fue_creada_por_esta_ejecucion: creadaPorEstaEjecucion,
    valor_normalizado_coincide: valorNormalizadoCanonico(referenciada) === valorNormalizadoCanonico(propia)
  };
}

function resumenPropuesta(p, referencia) {
  return {
    propuesta_id: p.propuesta_id,
    payload_hash: p.payload_hash,
    estado: p.estado,
    creada_por_esta_ejecucion: referencia.propuesta_fue_creada_por_esta_ejecucion,
    valor_normalizado_coincide: referencia.valor_normalizado_coincide
  };
}

async function insertarEjecucionSinSesion(doc, deps) {
  try {
    await deps.insertarEjecucion(doc, null);
  } catch (err) {
    if (esDuplicadoRunId(err)) throw new ErrorEjecucionDuplicada(`run_id ${doc.run_id} ya estaba registrado.`);
    throw err;
  }
}

async function registrarEjecucionLectura(entrada, deps = crearDependenciasMongoose()) {
  validarEntrada(entrada);
  await deps.verificarIndices();

  const generaPropuesta =
    entrada.estado_ejecucion === 'ok' && debeGenerarPropuesta(entrada.resultado_comparacion.categoria);

  if (!generaPropuesta) {
    await insertarEjecucionSinSesion(construirEjecucion(entrada, null, deps.ahora()), deps);
    return {
      run_id: entrada.run_id,
      estado_ejecucion: entrada.estado_ejecucion,
      accion: entrada.estado_ejecucion === 'fallo' ? 'fallo_registrado' : 'sin_propuesta',
      propuesta: null,
      colisiones: 0
    };
  }

  // Fuera del callback: si withTransaction reintenta por
  // TransientTransactionError, o el bucle reintenta tras un E11000, se
  // reusan el mismo propuesta_id, fecha_propuesta y payload_hash.
  const propuesta = construirPropuesta(entrada, deps.uuid(), deps.ahora().toISOString());
  const clave = { destino_id: propuesta.destino_id, requisito_id: propuesta.requisito_id, campo: propuesta.campo };
  let colisiones = 0;
  let etapa = 'deteccion_propuesta_existente';
  let ultimoError = null;

  for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
    try {
      const resultado = await deps.ejecutarTransaccion(async (session) => {
        etapa = 'deteccion_propuesta_existente';
        const activa = await deps.buscarPropuestaActiva(clave, session);
        if (activa) {
          const referencia = construirReferencia(activa, propuesta, false);
          await deps.insertarEjecucion(construirEjecucion(entrada, referencia, deps.ahora()), session);
          return { accion: 'vinculada_a_propuesta_activa', propuesta: resumenPropuesta(activa, referencia) };
        }

        etapa = 'creacion_propuesta';
        await deps.insertarPropuesta(propuesta, session);
        const referencia = construirReferencia(propuesta, propuesta, true);
        await deps.insertarEjecucion(construirEjecucion(entrada, referencia, deps.ahora()), session);
        return { accion: 'propuesta_creada', propuesta: resumenPropuesta(propuesta, referencia) };
      });
      return { run_id: entrada.run_id, estado_ejecucion: 'ok', ...resultado, colisiones };
    } catch (err) {
      if (esDuplicadoRunId(err)) throw new ErrorEjecucionDuplicada(`run_id ${entrada.run_id} ya estaba registrado.`);
      ultimoError = err;
      if (!esColisionPropuestaActiva(err)) break;
      // Perdió la carrera: la transacción revirtió completa. El próximo
      // intento debería encontrar la propuesta ganadora.
      colisiones++;
      etapa = 'deteccion_propuesta_existente';
    }
  }

  const mensaje =
    colisiones === MAX_INTENTOS
      ? `${MAX_INTENTOS} colisiones E11000 sobre ${INDICE_PROPUESTA_ACTIVA} sin encontrar la propuesta activa ganadora.`
      : String(ultimoError?.message ?? ultimoError);
  const entradaFallo = { ...entrada, estado_ejecucion: 'fallo', etapa_fallo: etapa, error_mensaje: mensaje };
  try {
    await insertarEjecucionSinSesion(construirEjecucion(entradaFallo, null, deps.ahora()), deps);
  } catch (errRegistro) {
    throw new Error(
      `No se pudo crear/vincular la propuesta (${mensaje}) y tampoco registrar la ejecución como fallo (${errRegistro.message}).`
    );
  }
  return {
    run_id: entrada.run_id,
    estado_ejecucion: 'fallo',
    accion: 'fallo_registrado',
    etapa_fallo: etapa,
    error_mensaje: mensaje,
    propuesta: null,
    colisiones
  };
}

async function listarIndices(Model) {
  try {
    return await Model.collection.indexes();
  } catch (err) {
    if (err.code === 26) return []; // NamespaceNotFound: la colección no existe
    throw err;
  }
}

// Pura (sin I/O) para poder probarla offline con listados armados a mano.
function verificarListadoIndices(indicesPropuestas, indicesEjecuciones) {
  const mismaForma = (a, b) => JSON.stringify(canonicalizarValor(a ?? null)) === JSON.stringify(canonicalizarValor(b));
  const tieneUnico = (indices, clave) =>
    indices.some((i) => i.unique === true && JSON.stringify(i.key) === JSON.stringify(clave));

  const activa = indicesPropuestas.find((i) => i.name === INDICE_PROPUESTA_ACTIVA);
  if (
    !activa ||
    activa.unique !== true ||
    JSON.stringify(activa.key) !== JSON.stringify(CLAVE_INDICE_PROPUESTA_ACTIVA) ||
    !mismaForma(activa.partialFilterExpression, { estado: { $in: ESTADOS_ACTIVOS } })
  ) {
    throw new ErrorPrecondicionIndices(
      `Falta el índice ${INDICE_PROPUESTA_ACTIVA} (o difiere del declarado en el schema). No se escribe nada.`
    );
  }
  if (!tieneUnico(indicesPropuestas, { propuesta_id: 1 })) {
    throw new ErrorPrecondicionIndices('Falta el índice único propuestas_cambio.propuesta_id. No se escribe nada.');
  }
  if (!tieneUnico(indicesEjecuciones, { run_id: 1 })) {
    throw new ErrorPrecondicionIndices('Falta el índice único ejecuciones_lectura.run_id. No se escribe nada.');
  }
}

// listIndexes no puede correr dentro de una transacción: se llama antes.
async function verificarIndices() {
  const [indicesPropuestas, indicesEjecuciones] = await Promise.all([
    listarIndices(PropuestaCambio),
    listarIndices(EjecucionLectura)
  ]);
  verificarListadoIndices(indicesPropuestas, indicesEjecuciones);
}

function crearDependenciasMongoose(conexion = mongoose.connection) {
  return {
    uuid: () => crypto.randomUUID(),
    ahora: () => new Date(),
    verificarIndices,
    ejecutarTransaccion: (fn) =>
      conexion.transaction(fn, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } }),
    buscarPropuestaActiva: (clave, session) =>
      PropuestaCambio.findOne({ ...clave, estado: { $in: ESTADOS_ACTIVOS } }).session(session).lean(),
    insertarPropuesta: (doc, session) => new PropuestaCambio(doc).save({ session }),
    insertarEjecucion: (doc, session) => new EjecucionLectura(doc).save({ session })
  };
}

module.exports = {
  CATEGORIAS_QUE_GENERAN_PROPUESTA,
  ESTADOS_ACTIVOS,
  INDICE_PROPUESTA_ACTIVA,
  CLAVE_INDICE_PROPUESTA_ACTIVA,
  MAX_INTENTOS,
  ErrorEntradaInvalida,
  ErrorPrecondicionIndices,
  ErrorEjecucionDuplicada,
  debeGenerarPropuesta,
  esColisionPropuestaActiva,
  validarEntrada,
  construirPayloadPropuesta,
  construirPropuesta,
  construirEjecucion,
  verificarListadoIndices,
  registrarEjecucionLectura,
  crearDependenciasMongoose
};
