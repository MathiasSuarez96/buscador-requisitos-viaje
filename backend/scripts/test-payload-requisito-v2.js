const assert = require('node:assert/strict');
const { hashSobreCanonico } = require('../services/propuestas/canonicalizacion-propuestas');
const { capturarInstantanea } = require('../services/propuestas/contrato-requisito-v2');
const { ALGORITMO_HECHOS_HASH, hashHechos, crearSobreRequisitoV2 } = require('../services/propuestas/payload-requisito-v2');

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
assert.equal(sobre.payload_hash, '073775ab2126dc73c8763f7255a56a709c8180add3f05d6c91626e238de6fd1b', 'vector fijo 2.0');

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

const payloadV1 = { version_contrato: '1.0', tipo_propuesta: 'actualizacion_campo_requisito', campo: 'costo' };
const hashV1Antes = hashSobreCanonico(payloadV1, 'toc-v1', 'sha256');
crearSobreRequisitoV2(base);
assert.equal(hashSobreCanonico(payloadV1, 'toc-v1', 'sha256'), hashV1Antes, 'construir 2.0 no altera hash 1.0');

console.log('1) Payload 2.0 exacto, normalizado y hasheado con toc-v1: OK');
console.log('2) Orden de cambios y fuentes no altera el hash: OK');
console.log('3) Evidencia, duplicados, fechas e IDs inválidos se rechazan: OK');
console.log('4) El hash de payloads 1.0 permanece intacto: OK');
