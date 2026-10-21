'use strict';
const assert = require('node:assert/strict');
const { hashSobreCanonico } = require('../services/propuestas/canonicalizacion-propuestas');
const { capturarInstantanea } = require('../services/propuestas/contrato-requisito-v2');
const { ALGORITMO_HECHOS_HASH, hashHechos, crearSobreRequisitoV2, validarSobreRequisitoV2 } = require('../services/propuestas/payload-requisito-v2');

const valor = (v) => ({ presente: true, bson_tipo: 'string', valor: v });
const foto = capturarInstantanea({
  _id: '6aaddd0e9f54309f9d82727b', tipo: 'formulario_digital', nombre: 'Check-Mig',
  obligatorio: 'si', descripcion: 'Anterior', fuente: 'IATA Travel Centre', link: 'https://viejo.example/',
  fecha_verificacion: '2026-08-18', estado: 'confirmado'
});
const hechos1 = { obligatorio: 'no', recomendado: 'si', ventana: { abre_horas_antes: 72, cierra_horas_antes: 1 } };
const hechos2 = { gratuito: true, obligatorio: 'no' };
const base = {
  fecha_propuesta: '2026-10-15T20:30:00.000Z',
  destino_id: '6a87828da8282a4aa6ddfbce', requisito_id: '6aaddd0e9f54309f9d82727b',
  run_id_origen: '11111111-1111-4111-8111-111111111111', propuesta_id: '22222222-2222-4222-8222-222222222222',
  identidad_requisito: { tipo: 'formulario_digital', nombre: valor('Check-Mig') },
  instantanea_anterior: foto,
  cambios: [
    { campo: 'recomendado', propuesto: valor('si') },
    { campo: 'obligatorio', propuesto: valor('no') }
  ],
  fuentes: [
    { nombre: 'Migración Colombia', url: 'https://www.migracioncolombia.gov.co/pagina-b', capturado_en: '2026-10-15T20:29:00.000Z', hechos: hechos2, algoritmo_hechos_hash: ALGORITMO_HECHOS_HASH, hechos_hash: hashHechos(hechos2) },
    { nombre: 'Migración Colombia', url: 'https://www.migracioncolombia.gov.co/pagina-a', capturado_en: '2026-10-15T20:28:00.000Z', hechos: hechos1, algoritmo_hechos_hash: ALGORITMO_HECHOS_HASH, hechos_hash: hashHechos(hechos1) }
  ],
  advertencias: ['quita_obligatoriedad']
};

const sobre = crearSobreRequisitoV2(base);
assert.equal(sobre.payload.version_contrato, '2.0');
assert.equal(sobre.payload.tipo_propuesta, 'actualizacion_requisito');
assert.equal(sobre.payload.campo, 'requisito');
assert.deepEqual(sobre.payload.cambios.map((c) => c.campo), ['obligatorio', 'recomendado']);
assert.deepEqual(sobre.payload.fuentes.map((f) => f.url), [
  'https://www.migracioncolombia.gov.co/pagina-a',
  'https://www.migracioncolombia.gov.co/pagina-b'
]);
assert.equal(sobre.payload_hash, hashSobreCanonico(sobre.payload, 'toc-v1', 'sha256'));
assert.equal(sobre.payload_hash, '0970cc514303767000796a7e0a58da69e70a92eb02b3ea74825ed511df0eb7cd', 'vector fijo 2.0');

const reordenado = crearSobreRequisitoV2({ ...base, cambios: [...base.cambios].reverse(), fuentes: [...base.fuentes].reverse() });
assert.equal(reordenado.payload_hash, sobre.payload_hash, 'orden de cambios/fuentes no altera el hash');

assert.throws(() => crearSobreRequisitoV2({ ...base, fuentes: [{ ...base.fuentes[0], hechos_hash: '0'.repeat(64) }] }), /hechos_hash no coincide/);
assert.throws(() => crearSobreRequisitoV2({ ...base, fuentes: [base.fuentes[0], base.fuentes[0]] }), /URL repetida/);
assert.throws(() => crearSobreRequisitoV2({ ...base, advertencias: ['quita_obligatoriedad', 'quita_obligatoriedad'] }), /duplicados/);
assert.throws(() => crearSobreRequisitoV2({ ...base, advertencias: [] }), /derivadas.*quita_obligatoriedad/);
assert.throws(() => crearSobreRequisitoV2({ ...base, advertencias: ['quita_obligatorieda'] }), /código desconocido/);
assert.throws(() => crearSobreRequisitoV2({ ...base, cambios: [] }), /lista no vacía/);
assert.throws(() => crearSobreRequisitoV2({ ...base, fecha_propuesta: '2026-10-15' }), /ISO UTC exacta/);
assert.throws(() => hashHechos({ x: NaN }), /número no JSON/);
assert.throws(() => hashHechos({ x: -0 }), /número no JSON/);
assert.throws(() => hashHechos({ x: new Map() }), /JSON estricto/);
assert.throws(() => hashHechos({ x: 1n }), /JSON estricto/);
assert.throws(() => crearSobreRequisitoV2({ ...base, fuentes: [{ ...base.fuentes[0], url: 'https://X.gov/a#s' }] }), /canónica/);
assert.throws(() => crearSobreRequisitoV2({ ...base, fuentes: [{ ...base.fuentes[0], capturado_en: '2026-10-15T20:31:00.000Z' }] }), /después/);
const conLinkHttp = structuredClone(sobre);
conLinkHttp.payload.instantanea_anterior.link.valor = 'http://viejo.example/';
conLinkHttp.payload.cambios.push({ campo: 'link', propuesto: valor('https://viejo.example/') });
conLinkHttp.payload.cambios.sort((a, b) => a.campo < b.campo ? -1 : a.campo > b.campo ? 1 : 0);
conLinkHttp.payload_hash = hashSobreCanonico(conLinkHttp.payload, 'toc-v1', 'sha256');
assert.throws(() => validarSobreRequisitoV2(conLinkHttp), /instantanea\.link debe ser URL https/);
const conLinkAnteriorInvalido = structuredClone(sobre);
conLinkAnteriorInvalido.payload.instantanea_anterior.link.valor = 'no-es-url';
conLinkAnteriorInvalido.payload.cambios.push({ campo: 'link', propuesto: valor('https://www.migracioncolombia.gov.co/pre-registro/') });
conLinkAnteriorInvalido.payload.cambios.sort((a, b) => a.campo < b.campo ? -1 : a.campo > b.campo ? 1 : 0);
conLinkAnteriorInvalido.payload.advertencias.push('cambia_dominio_link');
conLinkAnteriorInvalido.payload.advertencias.sort();
conLinkAnteriorInvalido.payload_hash = hashSobreCanonico(conLinkAnteriorInvalido.payload, 'toc-v1', 'sha256');
assert.throws(() => validarSobreRequisitoV2(conLinkAnteriorInvalido), /instantanea\.link debe ser URL https/);

const payloadV1 = { version_contrato: '1.0', tipo_propuesta: 'actualizacion_campo_requisito', campo: 'costo' };
const hashV1Antes = hashSobreCanonico(payloadV1, 'toc-v1', 'sha256');
crearSobreRequisitoV2(base);
assert.equal(hashSobreCanonico(payloadV1, 'toc-v1', 'sha256'), hashV1Antes, 'construir 2.0 no altera hash 1.0');

console.log('1) Payload 2.0 exacto, normalizado y hasheado con toc-v1: OK');
console.log('2) Orden de cambios y fuentes no altera el hash: OK');
console.log('3) Evidencia, duplicados, fechas e IDs inválidos se rechazan: OK');
console.log('4) El hash de payloads 1.0 permanece intacto: OK');

// Identidad capturada, hash e integridad de sobres transportados como JSON.
const copia = (x) => JSON.parse(JSON.stringify(x));
const ausente = { presente: false, bson_tipo: 'ausente', valor: null };
const nulo = { presente: true, bson_tipo: 'null', valor: null };
const identidad = base.identidad_requisito;
const conIdentidad = (i) => crearSobreRequisitoV2({ ...base, identidad_requisito: i });
assert.deepEqual(sobre.payload.identidad_requisito, identidad);
assert.deepEqual(validarSobreRequisitoV2(copia(sobre)), sobre);
const hashesNombres = [ausente, nulo, valor(''), valor('Check-Mig'), valor('Otro'), valor(' Check-Mig ')].map(nombre => conIdentidad({ ...identidad, nombre }).payload_hash);
assert.equal(new Set(hashesNombres).size, hashesNombres.length, 'ausencia, null y strings exactos tienen identidades diferentes');
assert.notEqual(conIdentidad({ ...identidad, tipo: 'visa' }).payload_hash, sobre.payload_hash, 'tipo participa en el hash');
for (const tipo of ['visa', 'formulario_digital', 'vacuna', 'validez_pasaporte', 'documentacion_menor', 'tasa_aeropuerto', 'seguro_medico']) {
  assert.equal(conIdentidad({ ...identidad, tipo }).payload.identidad_requisito.tipo, tipo);
}
for (const tipo of [undefined, null, 1, true, [], {}, new String('visa'), '', 'otro', ' visa']) {
  assert.throws(() => conIdentidad({ ...identidad, tipo }), /identidad_requisito.tipo/);
}
for (const i of [null, [], {}, { tipo: 'visa' }, { nombre: valor('A') }, { ...identidad, extra: true }]) {
  assert.throws(() => conIdentidad(i), /identidad_requisito/);
}
for (const nombre of [undefined, null, 'A', [], {}, { ...valor('A'), extra: true },
  { presente: true, valor: 'A' }, { bson_tipo: 'string', valor: 'A' }, { presente: true, bson_tipo: 'string' },
  { ...ausente, valor: 'A' }, { ...ausente, bson_tipo: 'null' }, { ...nulo, bson_tipo: 'string' },
  { ...valor('A'), presente: 'true' }, { ...valor('A'), valor: 1 }, { ...valor('A'), valor: undefined }]) {
  assert.throws(() => conIdentidad({ ...identidad, nombre }), /identidad_requisito.nombre/);
}
const sinIdentidad = { ...base }; delete sinIdentidad.identidad_requisito;
assert.throws(() => crearSobreRequisitoV2(sinIdentidad), /entrada/);
assert.throws(() => crearSobreRequisitoV2({ ...base, tipo: 'visa' }), /entrada/);
for (const campo of ['tipo', 'nombre', 'identidad_requisito']) {
  assert.throws(() => crearSobreRequisitoV2({ ...base, cambios: [{ campo, propuesto: valor('Otro') }] }), /campo no modificable/);
}
const invertir = x => Array.isArray(x) ? x.map(invertir) : x && typeof x === 'object'
  ? Object.fromEntries(Object.entries(x).reverse().map(([k, v]) => [k, invertir(v)])) : x;
assert.equal(crearSobreRequisitoV2(invertir(base)).payload_hash, sobre.payload_hash);
let sobreReordenadoValidado;
assert.doesNotThrow(() => { sobreReordenadoValidado = validarSobreRequisitoV2(invertir(copia(sobre))); }, 'orden recursivo de claves debe validar');
assert.equal(sobreReordenadoValidado.payload_hash, sobre.payload_hash, 'orden recursivo de claves no altera identidad');
for (const mutar of [
  p => { p.identidad_requisito.tipo = 'visa'; },
  p => { p.identidad_requisito.nombre = ausente; },
  p => { p.identidad_requisito.nombre = nulo; },
  p => { p.identidad_requisito.nombre.valor = 'Otro'; },
  p => { delete p.identidad_requisito; },
  p => { delete p.identidad_requisito.nombre; },
  p => { delete p.identidad_requisito.tipo; },
  p => { p.identidad_requisito.extra = true; },
  p => { p.identidad_requisito.tipo = 1; },
  p => { p.identidad_requisito.nombre.valor = 1; },
  p => { p.version_contrato = '1.0'; },
  p => { p.extra = true; }
]) {
  const adulterado = copia(sobre); mutar(adulterado.payload);
  assert.throws(() => validarSobreRequisitoV2(adulterado), /contrato 2.0/);
}
for (const nombre of [ausente, nulo]) {
  const adulterado = copia(conIdentidad({ ...identidad, nombre }));
  adulterado.payload.identidad_requisito.nombre = valor('Agregado');
  assert.throws(() => validarSobreRequisitoV2(adulterado), /payload_hash/);
}
// Incluso con hash recalculado se rechaza una estructura o version invalida.
for (const mutar of [p => { delete p.identidad_requisito.nombre; }, p => { p.version_contrato = '1.0'; }]) {
  const adulterado = copia(sobre); mutar(adulterado.payload);
  adulterado.payload_hash = hashSobreCanonico(adulterado.payload, 'toc-v1', 'sha256');
  assert.throws(() => validarSobreRequisitoV2(adulterado), /contrato 2.0/);
}
for (const mutar of [s => { s.payload_hash = '0'.repeat(64); }, s => { s.algoritmo_hash = 'md5'; },
  s => { s.algoritmo_canonicalizacion = 'otro'; }, s => { s.extra = true; }, s => { delete s.payload_hash; }]) {
  const adulterado = copia(sobre); mutar(adulterado);
  assert.throws(() => validarSobreRequisitoV2(adulterado), /contrato 2.0/);
}
const entradaMutable = copia(base);
const aislado = crearSobreRequisitoV2(entradaMutable);
entradaMutable.identidad_requisito.tipo = 'visa';
entradaMutable.identidad_requisito.nombre.valor = 'Otro';
assert.deepEqual(aislado.payload.identidad_requisito, identidad, 'copia aislada de entrada');
for (const objeto of [aislado, aislado.payload, aislado.payload.identidad_requisito, aislado.payload.identidad_requisito.nombre]) assert.ok(Object.isFrozen(objeto));
assert.throws(() => { aislado.payload.identidad_requisito.tipo = 'visa'; }, TypeError);
assert.throws(() => { aislado.payload.identidad_requisito.nombre.valor = 'Otro'; }, TypeError);
assert.throws(() => { delete aislado.payload.identidad_requisito.nombre; }, TypeError);
assert.throws(() => { aislado.payload.identidad_requisito = identidad; }, TypeError);
console.log('5) Identidad estricta, inmutable, canonica y protegida por hash: OK');
