const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');

function ejecutar(suites) {
  const raiz = mkdtempSync(join(tmpdir(), 'prueba-runner-backend-'));
  const scripts = join(raiz, 'scripts');
  mkdirSync(scripts);
  for (const n of ['ejecutar-pruebas-backend.js', 'preload-solo-loopback.js']) copyFileSync(join(__dirname, n), join(scripts, n));
  for (const [nombre, contenido] of Object.entries(suites)) writeFileSync(join(scripts, nombre), contenido);
  return spawnSync(process.execPath, [join(scripts, 'ejecutar-pruebas-backend.js')], {
    encoding: 'utf8', timeout: 15000
  });
}
const vacio = ejecutar({});
assert.equal(vacio.status, 1);
assert.match(vacio.stderr, /No se encontraron suites/);
const bien = ejecutar({ 'test-a.js': 'process.exit(0)', 'no-es-suite.js': 'process.exit(9)' });
assert.equal(bien.status, 0);
assert.match(bien.stdout, /1\/1 OK; 0 rojas/);
assert.doesNotMatch(bien.stdout, /no-es-suite\.js/);
const mal = ejecutar({ 'test-a.js': 'process.exit(7)', 'test-z.js': 'process.exit(0)' });
assert.equal(mal.status, 1);
assert.match(mal.stdout, /FALLÓ test-a\.js \(exit 7\)/);
assert.match(mal.stdout, /OK test-z\.js \(exit 0\)/, 'continúa después de una suite roja');
assert.match(mal.stdout, /1\/2 OK; 1 rojas/);
console.log('Runner: cero suites falla; descubre por nombre; informa exit original; continúa y devuelve fallo global: OK');
