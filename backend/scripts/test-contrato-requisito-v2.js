const assert = require('node:assert/strict');
const {
  VERSION_CONTRATO, TIPO_PROPUESTA, CAMPO_EXTERNO, POLITICA_FECHA,
  CAMPOS_INSTANTANEA, CAMPOS_MODIFICABLES, TIPOS_REQUISITO,
  capturarInstantanea, capturarIdentidadEInstantanea, aplicarCambiosAInstantanea
} = require('../services/propuestas/contrato-requisito-v2');

const requisito = {
  _id: 'id-simulado', tipo: 'formulario_digital', nombre: 'Check-Mig',
  obligatorio: 'si', descripcion: 'Texto anterior', fuente: 'IATA Travel Centre',
  link: 'https://viejo.invalid/', costo: 'Gratis',
  fecha_verificacion: '2026-08-18', estado: 'confirmado'
};
const valor = (v) => ({ presente: true, bson_tipo: v === null ? 'null' : 'string', valor: v });
const ausente = () => ({ presente: false, bson_tipo: 'ausente', valor: null });

assert.deepEqual(
  [VERSION_CONTRATO, TIPO_PROPUESTA, CAMPO_EXTERNO, POLITICA_FECHA],
  ['2.0', 'actualizacion_requisito', 'requisito', 'fecha_revalidacion_yyyy_mm_dd']
);
assert.deepEqual(CAMPOS_MODIFICABLES, ['obligatorio', 'recomendado', 'descripcion', 'fuente', 'link', 'plazo_antes_del_vuelo', 'estado']);

const foto = capturarInstantanea(requisito);
const conjunto = capturarIdentidadEInstantanea(requisito);
assert.deepStrictEqual(conjunto.identidad_requisito, { tipo: 'formulario_digital', nombre: valor('Check-Mig') });
assert.deepStrictEqual(conjunto.instantanea_anterior, foto);
assert.ok(Object.isFrozen(conjunto) && Object.isFrozen(conjunto.identidad_requisito) && Object.isFrozen(conjunto.instantanea_anterior));
assert.deepStrictEqual(TIPOS_REQUISITO, ['visa', 'formulario_digital', 'vacuna', 'validez_pasaporte', 'documentacion_menor', 'tasa_aeropuerto', 'seguro_medico']);
for (const nombre of [{}, { nombre: null }, { nombre: '' }, { nombre: 'X' }]) {
  const requisitoNombre = { ...requisito };
  delete requisitoNombre.nombre;
  if (Object.hasOwn(nombre, 'nombre')) requisitoNombre.nombre = nombre.nombre;
  const capturado = capturarIdentidadEInstantanea(requisitoNombre);
  const esperado = Object.hasOwn(nombre, 'nombre') ? valor(nombre.nombre) : ausente();
  assert.deepStrictEqual(capturado.identidad_requisito.nombre, esperado);
}
assert.throws(() => capturarIdentidadEInstantanea({ ...requisito, tipo: 'otro' }), /pertenece al/);
const entradaConjunta = { ...requisito };
const conjuntaAislada = capturarIdentidadEInstantanea(entradaConjunta);
entradaConjunta.tipo = 'visa'; entradaConjunta.nombre = 'cambiado'; entradaConjunta.descripcion = 'cambiado';
assert.deepStrictEqual(conjuntaAislada.identidad_requisito.tipo, 'formulario_digital');
assert.deepStrictEqual(conjuntaAislada.instantanea_anterior.descripcion, valor('Texto anterior'));
assert.deepEqual(Object.keys(foto), CAMPOS_INSTANTANEA);
assert.deepEqual(foto.recomendado, ausente());
assert.deepEqual(foto.fecha_verificacion, valor('2026-08-18'));
assert.deepEqual(foto.plazo_antes_del_vuelo, ausente());

const nueva = aplicarCambiosAInstantanea(foto, [
  { campo: 'obligatorio', propuesto: valor('no') },
  { campo: 'recomendado', propuesto: valor('si') },
  { campo: 'link', propuesto: valor('https://apps.migracioncolombia.gov.co/pre-registro/') }
]);
assert.equal(nueva.obligatorio.valor, 'no');
assert.equal(nueva.recomendado.valor, 'si');
assert.equal(foto.obligatorio.valor, 'si', 'la instantánea original no se muta');
assert.deepEqual(nueva.fecha_verificacion, foto.fecha_verificacion, 'la fecha no la propone el detector');

assert.throws(() => capturarInstantanea({ ...requisito, sorpresa: true }), /claves desconocidas.*sorpresa/);
assert.throws(() => capturarInstantanea({ ...requisito, fecha_verificacion: new Date() }), /fecha_verificacion.*date/);
assert.throws(() => capturarInstantanea({ ...requisito, fecha_verificacion: '2026-02-30' }), /YYYY-MM-DD válido/);
assert.throws(() => aplicarCambiosAInstantanea(foto, [{ campo: 'costo', propuesto: valor('0') }]), /campo no modificable: costo/);
assert.throws(() => aplicarCambiosAInstantanea(foto, [
  { campo: 'obligatorio', propuesto: valor('no') },
  { campo: 'obligatorio', propuesto: valor('verificar') }
]), /campo repetido/);
assert.throws(() => aplicarCambiosAInstantanea(foto, [
  { campo: 'recomendado', propuesto: valor('si') }
]), /obligatorio.*no puede quedar recomendado/);
assert.throws(() => aplicarCambiosAInstantanea(foto, [
  { campo: 'obligatorio', propuesto: { presente: false, bson_tipo: 'string', valor: null } }
]), /bson_tipo no coincide/);
assert.throws(() => aplicarCambiosAInstantanea({}, [{ campo: 'estado', propuesto: valor('confirmado') }]), /instantánea no contiene exactamente/);
assert.throws(() => aplicarCambiosAInstantanea(foto, [{ campo: 'descripcion', propuesto: ausente() }]), /descripcion resultante/);
assert.throws(() => aplicarCambiosAInstantanea(foto, [{ campo: 'descripcion', propuesto: valor('') }]), /descripcion resultante/);
assert.throws(() => aplicarCambiosAInstantanea(foto, [{ campo: 'estado', propuesto: valor('cualquiera') }]), /estado resultante inválido/);
assert.throws(() => aplicarCambiosAInstantanea(foto, [{ campo: 'fuente', propuesto: ausente() }]), /fuente resultante/);
assert.throws(() => aplicarCambiosAInstantanea(foto, [{ campo: 'link', propuesto: valor('javascript:alert(1)') }]), /debe usar https/);
assert.throws(() => aplicarCambiosAInstantanea(foto, [{ campo: 'link', propuesto: valor('https://usuario:clave@ejemplo.com/') }]), /no incluir credenciales/);
assert.throws(() => aplicarCambiosAInstantanea(foto, [{ campo: 'link', propuesto: valor(' https://ejemplo.com/') }]), /espacios externos/);
assert.throws(() => aplicarCambiosAInstantanea(foto, [{ campo: 'link', propuesto: valor(requisito.link) }]), /cambio sin efecto/);
assert.throws(() => aplicarCambiosAInstantanea(foto, [{
  campo: 'link', propuesto: { valor: requisito.link, bson_tipo: 'string', presente: true }
}]), /cambio sin efecto/);

const conPlazo = aplicarCambiosAInstantanea(foto, [{ campo: 'plazo_antes_del_vuelo', propuesto: valor('Desde 72 horas y hasta 1 hora antes') }]);
assert.equal(conPlazo.plazo_antes_del_vuelo.valor, 'Desde 72 horas y hasta 1 hora antes');

const TEXTO_COLOMBIA = 'Pre-registro migratorio digital y gratuito. Migración Colombia lo describe como opcional y recomienda completarlo para agilizar el control migratorio. Puede realizarse desde 72 horas y hasta 1 hora antes del viaje. Confirmá los requisitos operativos con tu aerolínea.';
const colombia = aplicarCambiosAInstantanea(foto, [
  { campo: 'obligatorio', propuesto: valor('no') },
  { campo: 'recomendado', propuesto: valor('si') },
  { campo: 'descripcion', propuesto: valor(TEXTO_COLOMBIA) },
  { campo: 'fuente', propuesto: valor('Migración Colombia') },
  { campo: 'link', propuesto: valor('https://apps.migracioncolombia.gov.co/pre-registro/') },
  { campo: 'plazo_antes_del_vuelo', propuesto: valor('Desde 72 horas y hasta 1 hora antes') }
]);
assert.equal(colombia.descripcion.valor, TEXTO_COLOMBIA);

const sinRecomendacion = aplicarCambiosAInstantanea(
  nueva,
  [{ campo: 'recomendado', propuesto: ausente() }]
);
assert.deepEqual(sinRecomendacion.recomendado, ausente());

console.log('1) Contrato 2.0 y allowlists cerradas: OK');
console.log('2) Instantánea distingue texto, null y ausencia sin casts: OK');
console.log('3) Cambios atómicos no mutan la foto ni pueden tocar fecha/costo: OK');
console.log('5) Captura conjunta de identidad e instantanea: OK');
console.log('4) Claves desconocidas, duplicados y combinaciones contradictorias se rechazan: OK');
