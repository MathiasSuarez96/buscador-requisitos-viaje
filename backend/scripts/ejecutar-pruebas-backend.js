// Un único inventario automático: todas las suites scripts/test-*.js.
// Cada proceso usa el cerrojo de red local; no se carga .env ni Atlas.
const { readdirSync, mkdtempSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const raiz = resolve(__dirname, '..');
const archivos = readdirSync(__dirname).filter(n => /^test-.*\.js$/.test(n)).sort();
if (!archivos.length) throw new Error('No se encontraron suites');
const logs = mkdtempSync(join(tmpdir(), 'buscador-suites-'));
console.log(`Inventario automático scripts/test-*.js: ${archivos.length} suites. Logs: ${logs}`);
const resultados = [];
for (const archivo of archivos) {
  const r = spawnSync(process.execPath, ['--require', join(__dirname, 'preload-solo-loopback.js'), join(__dirname, archivo)], {
    cwd: raiz, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024
  });
  writeFileSync(join(logs, archivo + '.log'), `${r.stdout ?? ''}\n${r.stderr ?? ''}\n${r.error?.message ?? ''}`);
  const ok = !r.error && r.status === 0;
  resultados.push({ archivo, ok, exit: r.status, error: r.error?.code ?? null });
  console.log(`${ok ? 'OK' : 'FALLÓ'} ${archivo} (exit ${r.status}${r.error ? ', ' + r.error.code : ''})`);
}
const fallidas = resultados.filter(r => !r.ok);
writeFileSync(join(logs, 'resumen.json'), JSON.stringify(resultados, null, 2));
console.log(`${resultados.length - fallidas.length}/${resultados.length} OK; ${fallidas.length} rojas.`);
if (fallidas.length) console.log(JSON.stringify(fallidas, null, 2));
process.exitCode = fallidas.length ? 1 : 0;
