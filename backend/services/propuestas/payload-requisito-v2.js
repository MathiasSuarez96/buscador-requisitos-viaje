const crypto = require('node:crypto');
const {
  ALGORITMO_CANONICALIZACION,
  ALGORITMO_HASH,
  canonicalizarValor,
  esFechaIsoUtcExacta,
  hashSobreCanonico
} = require('./canonicalizacion-propuestas');
const {
  VERSION_CONTRATO,
  TIPO_PROPUESTA,
  CAMPO_EXTERNO,
  POLITICA_FECHA,
  CAMPOS_INSTANTANEA,
  aplicarCambiosAInstantanea,
  validarInstantanea,
  validarValorCapturado,
  ErrorContratoRequisitoV2
} = require('./contrato-requisito-v2');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OBJECT_ID = /^[0-9a-f]{24}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const ALGORITMO_HECHOS_HASH = 'sha256-toc-hechos-v1';
const ADVERTENCIAS = Object.freeze(['quita_obligatoriedad', 'degrada_estado_verificacion', 'cambia_dominio_link']);
const compararCodigo = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function falla(mensaje) { throw new ErrorContratoRequisitoV2(`payload: ${mensaje}`); }
function clavesExactas(objeto, claves, nombre) {
  if (objeto === null || typeof objeto !== 'object' || Array.isArray(objeto)) falla(`${nombre} debe ser objeto.`);
  if (Object.keys(objeto).sort().join(',') !== [...claves].sort().join(',')) falla(`${nombre} tiene claves inesperadas o ausentes.`);
}
function urlHttps(valor, nombre) {
  if (typeof valor !== 'string' || valor !== valor.trim()) falla(`${nombre} debe ser URL HTTPS sin espacios externos.`);
  try {
    const url = new URL(valor);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.href !== valor) {
      falla(`${nombre} debe ser URL HTTPS canónica, sin credenciales ni fragmento.`);
    }
    return valor;
  } catch (error) {
    if (error instanceof ErrorContratoRequisitoV2) throw error;
    falla(`${nombre} debe ser URL HTTPS válida.`);
  }
}

function jsonEstricto(valor, profundidad = 0) {
  if (profundidad > 20) falla('hechos supera la profundidad máxima de 20.');
  if (valor === null || typeof valor === 'string' || typeof valor === 'boolean') return valor;
  if (typeof valor === 'number') {
    if (!Number.isFinite(valor) || Object.is(valor, -0)) falla('hechos contiene un número no JSON estricto.');
    return valor;
  }
  if (Array.isArray(valor)) return valor.map((v) => jsonEstricto(v, profundidad + 1));
  if (typeof valor !== 'object' || (Object.getPrototypeOf(valor) !== Object.prototype && Object.getPrototypeOf(valor) !== null)) {
    falla('hechos solo admite JSON estricto.');
  }
  const salida = {};
  for (const clave of Object.keys(valor).sort(compararCodigo)) {
    if (clave === '__proto__') falla('hechos no admite la clave __proto__.');
    salida[clave] = jsonEstricto(valor[clave], profundidad + 1);
  }
  return salida;
}

function hashHechos(hechos) {
  const normalizados = jsonEstricto(hechos);
  const serializado = JSON.stringify(normalizados);
  if (Buffer.byteLength(serializado, 'utf8') > 100_000) falla('hechos supera 100000 bytes.');
  return crypto.createHash('sha256').update(`${ALGORITMO_HECHOS_HASH}\0${serializado}`, 'utf8').digest('hex');
}

function normalizarFuente(fuente, indice) {
  clavesExactas(fuente, ['nombre', 'url', 'capturado_en', 'hechos', 'algoritmo_hechos_hash', 'hechos_hash'], `fuentes[${indice}]`);
  if (typeof fuente.nombre !== 'string' || fuente.nombre.trim() === '') falla(`fuentes[${indice}].nombre debe ser texto no vacío.`);
  urlHttps(fuente.url, `fuentes[${indice}].url`);
  if (!esFechaIsoUtcExacta(fuente.capturado_en)) falla(`fuentes[${indice}].capturado_en debe ser ISO UTC exacta.`);
  if (fuente.hechos === null || typeof fuente.hechos !== 'object' || Array.isArray(fuente.hechos)) falla(`fuentes[${indice}].hechos debe ser objeto.`);
  const hechos = jsonEstricto(fuente.hechos);
  if (fuente.algoritmo_hechos_hash !== ALGORITMO_HECHOS_HASH) falla(`fuentes[${indice}].algoritmo_hechos_hash inválido.`);
  const calculado = hashHechos(hechos);
  if (!SHA256.test(fuente.hechos_hash) || fuente.hechos_hash !== calculado) falla(`fuentes[${indice}].hechos_hash no coincide.`);
  return Object.freeze({ nombre: fuente.nombre, url: fuente.url, capturado_en: fuente.capturado_en, hechos, algoritmo_hechos_hash: ALGORITMO_HECHOS_HASH, hechos_hash: calculado });
}

function normalizarInstantanea(foto) {
  validarInstantanea(foto);
  return Object.freeze(Object.fromEntries(CAMPOS_INSTANTANEA.map((campo) => [campo, validarValorCapturado(foto[campo], `instantanea_anterior.${campo}`)])));
}

function normalizarCambios(cambios) {
  if (!Array.isArray(cambios)) falla('cambios debe ser lista.');
  return Object.freeze(cambios.map((cambio) => {
    clavesExactas(cambio, ['campo', 'propuesto'], 'cambio');
    if (typeof cambio.campo !== 'string') falla('cambio.campo debe ser string.');
    return Object.freeze({ campo: cambio.campo, propuesto: validarValorCapturado(cambio.propuesto, `cambios.${cambio.campo}.propuesto`) });
  }).sort((a, b) => compararCodigo(a.campo, b.campo)));
}

function advertenciasRequeridas(foto, resultado) {
  const requeridas = [];
  if (foto.obligatorio.valor === 'si' && resultado.obligatorio.valor !== 'si') requeridas.push('quita_obligatoriedad');
  if (foto.estado.valor === 'confirmado' && resultado.estado.valor === 'verificar') requeridas.push('degrada_estado_verificacion');
  if (foto.link.presente && resultado.link.presente) {
    const antes = new URL(foto.link.valor).hostname;
    const despues = new URL(resultado.link.valor).hostname;
    if (antes !== despues) requeridas.push('cambia_dominio_link');
  }
  return requeridas.sort(compararCodigo);
}

function crearPayloadRequisitoV2(entrada) {
  clavesExactas(entrada, [
    'fecha_propuesta', 'destino_id', 'requisito_id', 'run_id_origen', 'propuesta_id',
    'instantanea_anterior', 'cambios', 'fuentes', 'advertencias'
  ], 'entrada');
  if (!esFechaIsoUtcExacta(entrada.fecha_propuesta)) falla('fecha_propuesta debe ser ISO UTC exacta.');
  for (const campo of ['destino_id', 'requisito_id']) if (!OBJECT_ID.test(entrada[campo])) falla(`${campo} debe ser ObjectId hex minúsculo.`);
  for (const campo of ['run_id_origen', 'propuesta_id']) if (!UUID.test(entrada[campo])) falla(`${campo} debe ser UUID.`);

  const foto = normalizarInstantanea(entrada.instantanea_anterior);
  const cambios = normalizarCambios(entrada.cambios);
  const resultado = aplicarCambiosAInstantanea(foto, cambios);

  if (!Array.isArray(entrada.fuentes) || entrada.fuentes.length === 0) falla('fuentes debe ser lista no vacía.');
  const fuentes = entrada.fuentes.map(normalizarFuente).sort((a, b) => compararCodigo(a.url, b.url));
  if (fuentes.some((f) => new Date(f.capturado_en) > new Date(entrada.fecha_propuesta))) falla('una fuente fue capturada después de fecha_propuesta.');
  if (new Set(fuentes.map((f) => f.url)).size !== fuentes.length) falla('fuentes contiene URL repetida.');

  if (!Array.isArray(entrada.advertencias) || entrada.advertencias.some((a) => typeof a !== 'string' || a.trim() === '')) falla('advertencias debe ser lista de códigos no vacíos.');
  if (entrada.advertencias.some((a) => !ADVERTENCIAS.includes(a))) falla('advertencias contiene un código desconocido.');
  const advertencias = [...new Set(entrada.advertencias)].sort(compararCodigo);
  if (advertencias.length !== entrada.advertencias.length) falla('advertencias contiene duplicados.');
  const requeridas = advertenciasRequeridas(foto, resultado);
  if (advertencias.join(',') !== requeridas.join(',')) falla(`advertencias debe coincidir con las derivadas: ${requeridas.join(',')}.`);

  return Object.freeze({
    version_contrato: VERSION_CONTRATO,
    tipo_propuesta: TIPO_PROPUESTA,
    fecha_propuesta: entrada.fecha_propuesta,
    destino_id: entrada.destino_id,
    requisito_id: entrada.requisito_id,
    campo: CAMPO_EXTERNO,
    run_id_origen: entrada.run_id_origen,
    propuesta_id: entrada.propuesta_id,
    politica_fecha_verificacion: POLITICA_FECHA,
    instantanea_anterior: foto,
    cambios,
    fuentes: Object.freeze(fuentes),
    advertencias: Object.freeze(advertencias)
  });
}

function crearSobreRequisitoV2(entrada) {
  const payload = crearPayloadRequisitoV2(entrada);
  return Object.freeze({
    algoritmo_canonicalizacion: ALGORITMO_CANONICALIZACION,
    algoritmo_hash: ALGORITMO_HASH,
    payload,
    payload_hash: hashSobreCanonico(payload, ALGORITMO_CANONICALIZACION, ALGORITMO_HASH)
  });
}

module.exports = { ALGORITMO_HECHOS_HASH, ADVERTENCIAS, compararCodigo, jsonEstricto, hashHechos, advertenciasRequeridas, crearPayloadRequisitoV2, crearSobreRequisitoV2 };
