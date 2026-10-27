const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const archivo = path.join(__dirname, 'prechequear-indice-transversal-lectura.js');
const prueba = path.join(__dirname, 'test-diagnostico-prechequeo.js');
const mutaciones = [
  ['oculta códigos internos conocidos', '? error.codigo : \'error_no_clasificado\'', '? \'error_no_clasificado\' : \'error_no_clasificado\''],
  ['expone mensaje crudo del driver', '? error.codigo : \'error_no_clasificado\'', '? error.codigo : error.message'],
  ['omite prevalidación antes del cliente', 'const salidaValidada = validarSalida(salida);', 'const salidaValidada = salida;']
];
function correr(m) {
  const codigo = `const fs=require('node:fs');const Module=require('node:module');const path=require('node:path');
  const archivo=${JSON.stringify(archivo)};const m=${JSON.stringify(m)};
  if(m){let s=fs.readFileSync(archivo,'utf8');if(s.split(m[1]).length!==2)throw new Error('ANCLA NO UNICA');
  const mod=new Module(archivo,module);mod.filename=archivo;mod.paths=Module._nodeModulePaths(path.dirname(archivo));
  require.cache[archivo]=mod;mod._compile(s.replace(m[1],m[2]),archivo);}
  require(${JSON.stringify(prueba)});`;
  return spawnSync(process.execPath, ['--require', path.join(__dirname, 'preload-solo-loopback.js'), '-e', codigo], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 45000
  });
}
const base = correr(null);
assert.equal(base.status, 0, `${base.stdout}\n${base.stderr}`);
for (const m of mutaciones) {
  const r = correr(m);
  assert.ok(!r.error && r.status !== null, `Infraestructura: ${m[0]}`);
  assert.equal(r.status, 1, `Sobrevive: ${m[0]}\n${r.stderr}`);
  assert.match(r.stderr, /AssertionError/);
  assert.doesNotMatch(r.stderr, /TypeError|ReferenceError|SyntaxError|MODULE_NOT_FOUND|ANCLA NO UNICA|SOLO-LOOPBACK BLOQUEADO/);
  console.log(`Detectada por AssertionError: ${m[0]}`);
}
console.log(`${mutaciones.length}/${mutaciones.length} mutaciones del diagnóstico detectadas por aserciones.`);
