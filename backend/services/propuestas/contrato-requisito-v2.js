/** Primitivas puras del contrato 2.0 atómico por requisito. */

const VERSION_CONTRATO = '2.0';
const TIPO_PROPUESTA = 'actualizacion_requisito';
const CAMPO_EXTERNO = 'requisito';
const POLITICA_FECHA = 'fecha_revalidacion_yyyy_mm_dd';

const CLAVES_REQUISITO_CONOCIDAS = Object.freeze([
  '_id', 'tipo', 'nombre', 'obligatorio', 'recomendado', 'descripcion',
  'fuente', 'link', 'plazo_antes_del_vuelo', 'costo',
  'fecha_verificacion', 'estado'
]);
const CAMPOS_INSTANTANEA = Object.freeze([
  'obligatorio', 'recomendado', 'descripcion', 'fuente', 'link',
  'plazo_antes_del_vuelo', 'costo', 'fecha_verificacion', 'estado'
]);
const CAMPOS_MODIFICABLES = Object.freeze([
  'obligatorio', 'recomendado', 'descripcion', 'fuente', 'link',
  'plazo_antes_del_vuelo', 'estado'
]);

class ErrorContratoRequisitoV2 extends TypeError {
  constructor(mensaje) {
    super(`contrato 2.0: ${mensaje}`);
    this.codigo = 'contrato_requisito_2_invalido';
  }
}

function falla(mensaje) {
  throw new ErrorContratoRequisitoV2(mensaje);
}

function esFechaCalendario(valor) {
  if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(valor)) return false;
  const fecha = new Date(`${valor}T00:00:00.000Z`);
  return !Number.isNaN(fecha.getTime()) && fecha.toISOString().slice(0, 10) === valor;
}

function validarClavesConocidas(requisito) {
  if (requisito === null || typeof requisito !== 'object' || Array.isArray(requisito)) falla('requisito debe ser objeto.');
  const desconocidas = Object.keys(requisito).filter((k) => !CLAVES_REQUISITO_CONOCIDAS.includes(k));
  if (desconocidas.length) falla(`claves desconocidas en requisito: ${desconocidas.sort().join(', ')}.`);
}

function capturarValor(requisito, campo) {
  const presente = Object.prototype.hasOwnProperty.call(requisito, campo);
  if (!presente) return Object.freeze({ presente: false, bson_tipo: 'ausente', valor: null });
  const valor = requisito[campo];
  if (valor === null) return Object.freeze({ presente: true, bson_tipo: 'null', valor: null });
  if (typeof valor === 'string') return Object.freeze({ presente: true, bson_tipo: 'string', valor });
  falla(`${campo} tiene tipo no soportado: ${valor instanceof Date ? 'date' : typeof valor}.`);
}

function capturarInstantanea(requisito) {
  validarClavesConocidas(requisito);
  const foto = Object.fromEntries(CAMPOS_INSTANTANEA.map((campo) => [campo, capturarValor(requisito, campo)]));
  const fecha = foto.fecha_verificacion;
  if (fecha.bson_tipo === 'string' && !esFechaCalendario(fecha.valor)) falla('fecha_verificacion no es YYYY-MM-DD válido.');
  return Object.freeze(foto);
}

function validarInstantanea(instantanea) {
  if (instantanea === null || typeof instantanea !== 'object' || Array.isArray(instantanea)) falla('instantánea debe ser objeto.');
  const recibidas = Object.keys(instantanea).sort();
  const esperadas = [...CAMPOS_INSTANTANEA].sort();
  if (recibidas.join(',') !== esperadas.join(',')) falla('instantánea no contiene exactamente los campos esperados.');
  for (const campo of CAMPOS_INSTANTANEA) validarValorCapturado(instantanea[campo], `instantanea.${campo}`);
  const fecha = instantanea.fecha_verificacion;
  if (fecha.bson_tipo === 'string' && !esFechaCalendario(fecha.valor)) falla('instantanea.fecha_verificacion no es YYYY-MM-DD válido.');
}

function presenteStringNoVacio(campo, nombre) {
  if (!campo.presente || campo.bson_tipo !== 'string' || campo.valor.trim() === '') falla(`${nombre} resultante debe ser string no vacío.`);
}

function esHttps(valor) {
  try {
    const url = new URL(valor);
    return url.protocol === 'https:' && url.username === '' && url.password === '';
  } catch { return false; }
}

function validarValorCapturado(valor, nombre) {
  if (valor === null || typeof valor !== 'object' || Array.isArray(valor)) falla(`${nombre} debe ser objeto.`);
  const claves = Object.keys(valor).sort();
  if (claves.join(',') !== 'bson_tipo,presente,valor') falla(`${nombre} debe contener solo presente, bson_tipo y valor.`);
  if (typeof valor.presente !== 'boolean') falla(`${nombre}.presente debe ser boolean.`);
  const esperado = valor.presente ? (valor.valor === null ? 'null' : 'string') : 'ausente';
  if (valor.bson_tipo !== esperado) falla(`${nombre}.bson_tipo no coincide con presencia/valor.`);
  if (!valor.presente && valor.valor !== null) falla(`${nombre} ausente debe usar valor null.`);
  if (valor.valor !== null && typeof valor.valor !== 'string') falla(`${nombre}.valor debe ser string o null.`);
  return Object.freeze({ presente: valor.presente, bson_tipo: valor.bson_tipo, valor: valor.valor });
}

const mismoValorCapturado = (a, b) =>
  a.presente === b.presente && a.bson_tipo === b.bson_tipo && a.valor === b.valor;

function validarEstadoResultante(campos) {
  const obligatorio = campos.obligatorio;
  const recomendado = campos.recomendado;
  presenteStringNoVacio(obligatorio, 'obligatorio');
  presenteStringNoVacio(campos.descripcion, 'descripcion');
  presenteStringNoVacio(campos.estado, 'estado');
  if (!['si', 'no', 'verificar'].includes(obligatorio.valor)) falla('obligatorio resultante inválido.');
  if (!['confirmado', 'verificar'].includes(campos.estado.valor)) falla('estado resultante inválido.');
  if (recomendado.presente && !['si', 'no', 'verificar'].includes(recomendado.valor)) falla('recomendado resultante inválido.');
  if (obligatorio.valor === 'si' && recomendado.presente && ['si', 'verificar'].includes(recomendado.valor)) {
    falla('un requisito obligatorio no puede quedar recomendado o con recomendación a verificar.');
  }
  if (campos.estado.valor === 'confirmado') presenteStringNoVacio(campos.fuente, 'fuente');
  for (const opcional of ['recomendado', 'fuente', 'link', 'plazo_antes_del_vuelo']) {
    const dato = campos[opcional];
    if (dato.presente && (dato.bson_tipo !== 'string' || dato.valor.trim() === '')) falla(`${opcional} resultante debe ser ausente o string no vacío.`);
  }
  if (campos.link.presente && campos.link.valor !== campos.link.valor.trim()) falla('link resultante no admite espacios externos.');
  if (campos.link.presente && !esHttps(campos.link.valor)) falla('link resultante debe usar https y no incluir credenciales.');
}

function aplicarCambiosAInstantanea(instantanea, cambios) {
  validarInstantanea(instantanea);
  if (!Array.isArray(cambios) || cambios.length === 0) falla('cambios debe ser una lista no vacía.');
  const resultado = { ...instantanea };
  const vistos = new Set();
  for (const cambio of cambios) {
    if (cambio === null || typeof cambio !== 'object' || Array.isArray(cambio)) falla('cada cambio debe ser objeto.');
    if (Object.keys(cambio).sort().join(',') !== 'campo,propuesto') falla('cada cambio debe contener solo campo y propuesto.');
    if (!CAMPOS_MODIFICABLES.includes(cambio.campo)) falla(`campo no modificable: ${String(cambio.campo)}.`);
    if (vistos.has(cambio.campo)) falla(`campo repetido: ${cambio.campo}.`);
    vistos.add(cambio.campo);
    const propuesto = validarValorCapturado(cambio.propuesto, `cambios.${cambio.campo}.propuesto`);
    if (mismoValorCapturado(instantanea[cambio.campo], propuesto)) falla(`cambio sin efecto: ${cambio.campo}.`);
    resultado[cambio.campo] = propuesto;
  }
  validarEstadoResultante(resultado);
  return Object.freeze(resultado);
}

module.exports = {
  VERSION_CONTRATO,
  TIPO_PROPUESTA,
  CAMPO_EXTERNO,
  POLITICA_FECHA,
  CLAVES_REQUISITO_CONOCIDAS,
  CAMPOS_INSTANTANEA,
  CAMPOS_MODIFICABLES,
  ErrorContratoRequisitoV2,
  esFechaCalendario,
  capturarValor,
  capturarInstantanea,
  validarValorCapturado,
  mismoValorCapturado,
  validarInstantanea,
  aplicarCambiosAInstantanea
};
