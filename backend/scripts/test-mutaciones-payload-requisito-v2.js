// Mutaciones aisladas en memoria de procesos hijos; no modifica fuentes ni conecta.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const archivo = path.resolve(__dirname, '../services/propuestas/payload-requisito-v2.js');
const prueba = path.join(__dirname, 'test-payload-requisito-v2.js');
const preload = path.join(__dirname, 'preload-solo-loopback.js');
const mutaciones = [
  ['omite identidad del payload', '    identidad_requisito: identidad,', ''],
  ['omite tipo del hash', 'tipo: identidad.tipo, nombre', "tipo: 'visa', nombre"],
  ['colapsa nombre a ausencia', "const nombre = validarValorCapturado(identidad.nombre, 'identidad_requisito.nombre');", "const nombre = Object.freeze({ presente: false, bson_tipo: 'ausente', valor: null });"],
  ['tipo sin enum ni validacion', "if (typeof identidad.tipo !== 'string' || !TIPOS_REQUISITO.includes(identidad.tipo))", 'if (false)'],
  ['identidad permite claves extra o ausentes', "clavesExactas(identidad, ['tipo', 'nombre'], 'identidad_requisito');", ''],
  ['nombre sin validacion ni copia', "validarValorCapturado(identidad.nombre, 'identidad_requisito.nombre')", 'identidad.nombre'],
  ['nombre pierde congelamiento', "validarValorCapturado(identidad.nombre, 'identidad_requisito.nombre')", "{ ...validarValorCapturado(identidad.nombre, 'identidad_requisito.nombre') }"],
  ['identidad pierde congelamiento', 'return Object.freeze({ tipo: identidad.tipo, nombre });', 'return { tipo: identidad.tipo, nombre };'],
  ['sobre permite claves extra', "clavesExactas(sobre, ['algoritmo_canonicalizacion', 'algoritmo_hash', 'payload', 'payload_hash'], 'sobre');", ''],
  ['omite comprobacion del hash', "if (typeof sobre.payload_hash !== 'string' || sobre.payload_hash !== esperado.payload_hash)", 'if (false)'],
  ['omite comprobacion del contrato', 'if (JSON.stringify(canonicalizarValor(sobre.payload)) !== JSON.stringify(canonicalizarValor(esperado.payload)))', 'if (false)'],
  ['omite validacion algoritmos', 'if (sobre.algoritmo_canonicalizacion !== ALGORITMO_CANONICALIZACION || sobre.algoritmo_hash !== ALGORITMO_HASH)', 'if (false)'],
  ['comparacion depende del orden de claves', 'JSON.stringify(canonicalizarValor(sobre.payload)) !== JSON.stringify(canonicalizarValor(esperado.payload))', 'JSON.stringify(sobre.payload) !== JSON.stringify(esperado.payload)']
];
function ejecutar(mutacion) {
  const codigo = `
    const fs = require('node:fs');
    const Module = require('node:module');
    const assert = require('node:assert/strict');
    const archivo = ${JSON.stringify(archivo)};
    const mutacion = ${JSON.stringify(mutacion)};
    if (mutacion) {
      const original = fs.readFileSync(archivo, 'utf8');
      const [nombre, antes, despues] = mutacion;
      if (original.split(antes).length !== 2) throw new Error('ANCLA NO UNICA: ' + nombre);
      const modulo = new Module(archivo, module);
      modulo.filename = archivo;
      modulo.paths = Module._nodeModulePaths(require('node:path').dirname(archivo));
      require.cache[archivo] = modulo;
      modulo._compile(original.replace(antes, despues), archivo);
    }
    require(${JSON.stringify(prueba)});
  `;
  return spawnSync(process.execPath, ['--require', preload, '-e', codigo], { encoding: 'utf8', timeout: 30000 });
}
const base = ejecutar(null);
assert.equal(base.status, 0, `Base: ${base.stdout}\n${base.stderr}`);
for (const mutacion of mutaciones) {
  const r = ejecutar(mutacion);
  assert.ok(!r.error && r.status !== null, `Infraestructura: ${mutacion[0]}: ${r.error}`);
  assert.equal(r.status, 1, `Sobrevivio: ${mutacion[0]}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /AssertionError/, `Sin asercion: ${mutacion[0]}\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, /SyntaxError|MODULE_NOT_FOUND|SOLO-LOOPBACK BLOQUEADO|ANCLA NO UNICA/);
  console.log(`Detectada: ${mutacion[0]}`);
}
console.log(`${mutaciones.length}/${mutaciones.length} mutaciones dirigidas detectadas por aserciones.`);
