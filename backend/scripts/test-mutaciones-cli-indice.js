// Mutación EN DISCO de copias de los CLI, para alcanzar el proceso hijo real.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const prueba = path.join(__dirname, 'test-cli-indice-transversal.js');
const ancla = "if (r.estado !== 'confirmado' || r.codigo) process.exitCode = 1;";
const mutaciones = [
  ['creación ignora resultado no confirmado', 'crear-indice-transversal.js', ancla, 'void 0;'],
  ['reversión ignora resultado no confirmado', 'revertir-indice-transversal.js', ancla, 'void 0;'],
  ['generador no falla ante excepción', 'generar-plan-indice-transversal.js',
    "console.error(e instanceof ErrorOperacionIndice ? e.codigo : 'generacion_abortada_sin_detalles_externos'); process.exitCode = 1;",
    "console.error(e instanceof ErrorOperacionIndice ? e.codigo : 'generacion_abortada_sin_detalles_externos');"]
];
function correr(m) {
  const copia = fs.mkdtempSync(path.join(tmpdir(), 'mutacion-cli-indice-'));
  fs.mkdirSync(path.join(copia, 'lib'));
  fs.copyFileSync(path.join(__dirname, 'lib/operacion-indice-transversal.js'), path.join(copia, 'lib/operacion-indice-transversal.js'));
  for (const nombre of ['crear-indice-transversal.js', 'revertir-indice-transversal.js', 'generar-plan-indice-transversal.js']) {
    let s = fs.readFileSync(path.join(__dirname, nombre), 'utf8');
    if (m && m[1] === nombre) {
      assert.equal(s.split(m[2]).length, 2, `Ancla única: ${m[0]}`);
      s = s.replace(m[2], m[3]);
    }
    fs.writeFileSync(path.join(copia, nombre), s);
  }
  return spawnSync(process.execPath, ['--require', path.join(__dirname, 'preload-solo-loopback.js'), prueba], {
    env: { ...process.env, CLI_RAIZ_PRUEBA: copia }, encoding: 'utf8', timeout: 30000
  });
}
const base = correr(null);
assert.equal(base.status, 0, `${base.stdout}\n${base.stderr}`);
for (const m of mutaciones) {
  const r = correr(m);
  assert.ok(!r.error && r.status !== null, 'Sin fallo de infraestructura');
  assert.equal(r.status, 1, `Sobrevive ${m[0]}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /AssertionError/);
  assert.doesNotMatch(r.stderr, /TypeError|ReferenceError|SyntaxError|MODULE_NOT_FOUND|SOLO-LOOPBACK BLOQUEADO/);
  console.log(`Detectada por AssertionError en copia en disco: ${m[0]}`);
}
console.log(`${mutaciones.length}/${mutaciones.length} mutaciones de CLI detectadas.`);
