// Mutaciones aisladas del cierre que impide registrar contratos 2.0.
// Cada proceso hijo carga en memoria el servicio mutado y ejecuta la suite
// real; no modifica archivos ni abre conexiones.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const archivo = path.resolve(__dirname, '../services/propuestas/registrar-ejecucion-lectura.js');
const prueba = path.join(__dirname, 'test-servicio-ejecucion-lectura.js');
const preload = path.join(__dirname, 'preload-solo-loopback.js');
const bloque = `  const versionDeclarada = e.version_contrato;
  if (versionDeclarada !== undefined && versionDeclarada !== VERSION_CONTRATO_REGISTRO) {
    throw new ErrorVersionContratoNoSoportada();
  }`;
const bloqueEnRegistro = bloque.replace('e.version_contrato', 'entrada.version_contrato');

const mutaciones = [
  ['quita el cierre', [[bloque, '']]],
  ['usa coercion ==', [['versionDeclarada !== VERSION_CONTRATO_REGISTRO', 'versionDeclarada != VERSION_CONTRATO_REGISTRO']]],
  ['acepta null', [['versionDeclarada !== undefined && versionDeclarada !== VERSION_CONTRATO_REGISTRO', 'versionDeclarada !== undefined && versionDeclarada !== null && versionDeclarada !== VERSION_CONTRATO_REGISTRO']]],
  ['acepta 2.0', [['versionDeclarada !== VERSION_CONTRATO_REGISTRO', "versionDeclarada !== VERSION_CONTRATO_REGISTRO && versionDeclarada !== '2.0'"]]],
  ['mueve el cierre despues de verificar indices', [[bloque, ''], ['  await deps.verificarIndices();', `  await deps.verificarIndices();\n${bloqueEnRegistro}`]]]
];

function ejecutar(mutacion) {
  const codigo = `
    const fs = require('node:fs');
    const Module = require('node:module');
    const path = require('node:path');
    const archivo = ${JSON.stringify(archivo)};
    let fuente = fs.readFileSync(archivo, 'utf8');
    const mutacion = ${JSON.stringify(mutacion)};
    if (mutacion) {
      for (const [antes, despues] of mutacion[1]) {
        if (fuente.split(antes).length !== 2) throw new Error('ANCLA NO UNICA: ' + mutacion[0]);
        fuente = fuente.replace(antes, despues);
      }
      const modulo = new Module(archivo, module);
      modulo.filename = archivo;
      modulo.paths = Module._nodeModulePaths(path.dirname(archivo));
      require.cache[archivo] = modulo;
      modulo._compile(fuente, archivo);
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
  assert.doesNotMatch(r.stderr, /SyntaxError|ReferenceError|TypeError|MODULE_NOT_FOUND|SOLO-LOOPBACK BLOQUEADO|ANCLA NO UNICA/);
  console.log(`Detectada: ${mutacion[0]}`);
}
console.log(`${mutaciones.length}/${mutaciones.length} mutaciones del cierre 2.0 detectadas por aserciones.`);
