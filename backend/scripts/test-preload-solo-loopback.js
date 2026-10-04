// Pruebas de scripts/preload-solo-loopback.js: en un proceso hijo con el
// preload cargado se intenta cada vía de red. Solo 127.0.0.1/::1 pasan
// (incluido dns.lookup de esos literales, que net.Server#listen necesita);
// todo lo demás se bloquea y se cuenta. Ningún caso sale de la máquina:
// los intentos bloqueados lanzan antes de abrir un socket.
//
// Uso: node scripts/test-preload-solo-loopback.js

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const PRELOAD = path.join(__dirname, 'preload-solo-loopback.js');

const SONDAS = `
const net = require('net');
const dns = require('dns');
const resultados = {};
const probar = (nombre, fn) => { try { fn(); resultados[nombre] = 'permitido'; } catch (e) { resultados[nombre] = e.message; } };
const probarAsync = async (nombre, fn) => { try { await fn(); resultados[nombre] = 'permitido'; } catch (e) { resultados[nombre] = e.message; } };
(async () => {
  probar('net 8.8.8.8:53', () => net.connect(53, '8.8.8.8'));
  probar('net sin host (localhost)', () => net.connect({ port: 27017 }));
  probar('net localhost explícito', () => net.connect(27017, 'localhost'));
  probar('net ipc', () => net.connect({ path: '\\\\\\\\.\\\\pipe\\\\prueba' }));
  probar('dns.lookup example.com', () => dns.lookup('example.com', () => {}));
  probar('dns.lookup localhost', () => dns.lookup('localhost', () => {}));
  probar('dns.resolve4', () => dns.resolve4('example.com', () => {}));
  await probarAsync('dns.promises.lookup', () => dns.promises.lookup('example.com'));
  probar('http.request', () => require('http').request('http://example.com'));
  probar('https.get', () => require('https').get('https://example.com'));
  probar('tls.connect', () => require('tls').connect(443, 'example.com'));
  await probarAsync('fetch', () => fetch('https://example.com'));
  await probarAsync('fetch http localhost', () => fetch('http://localhost:1/'));
  await probarAsync('fetch https 127.0.0.1', () => fetch('https://127.0.0.1:1/'));
  probar('require dotenv', () => require('dotenv'));
  resultados.lookup127 = await new Promise((r) => dns.lookup('127.0.0.1', (err, dir) => r(err ? err.message : dir)));
  // Ida y vuelta real por loopback: listen + connect.
  const servidor = net.createServer((s) => s.end('pong'));
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const { port } = servidor.address();
  resultados.ida_y_vuelta = await new Promise((r, j) => {
    const c = net.connect(port, '127.0.0.1');
    let d = '';
    c.on('data', (x) => (d += x));
    c.on('end', () => r(d));
    c.on('error', j);
  });
  servidor.close();
  // fetch por http a 127.0.0.1 (p. ej. un JWKS local).
  const http = require('http');
  const web = http.createServer((req, res) => res.end('pong-http'));
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  const puertoWeb = web.address().port;
  resultados.fetch_loopback = await (await fetch('http://127.0.0.1:' + puertoWeb + '/', { headers: { connection: 'close' } })).text();
  web.close();
  const e = globalThis.__SOLO_LOOPBACK__;
  resultados.estado = { permitidos: e.permitidos, destinos: [...e.destinos].sort(), bloqueados: e.bloqueados.length, puerto: port, puertoWeb };
  process.stdout.write(JSON.stringify(resultados));
})();
`;

const r = spawnSync(process.execPath, ['--require', PRELOAD, '-e', SONDAS], { encoding: 'utf8', timeout: 60000 });
assert.strictEqual(r.status, 0, r.stderr);
const res = JSON.parse(r.stdout);

const BLOQUEADOS = [
  'net 8.8.8.8:53',
  'net sin host (localhost)',
  'net localhost explícito',
  'net ipc',
  'dns.lookup example.com',
  'dns.lookup localhost',
  'dns.resolve4',
  'dns.promises.lookup',
  'http.request',
  'https.get',
  'tls.connect',
  'fetch',
  'fetch http localhost',
  'fetch https 127.0.0.1',
  'require dotenv'
];
for (const nombre of BLOQUEADOS) {
  assert.match(String(res[nombre]), /^SOLO-LOOPBACK: bloqueado /, `${nombre}: ${res[nombre]}`);
}
console.log(`1) ${BLOQUEADOS.length} vías bloqueadas (hosts externos, localhost por nombre, IPC, DNS, http/https/tls, fetch externo, fetch a localhost o por https, dotenv): OK`);

assert.strictEqual(res.lookup127, '127.0.0.1', 'dns.lookup del literal 127.0.0.1 se resuelve localmente');
assert.strictEqual(res.ida_y_vuelta, 'pong', 'listen + connect por 127.0.0.1');
assert.strictEqual(res.fetch_loopback, 'pong-http', 'fetch por http a 127.0.0.1');
const destinosEsperados = [`127.0.0.1:${res.estado.puerto}`, `127.0.0.1:${res.estado.puertoWeb}`].sort();
assert.strictEqual(res.estado.permitidos, 2, 'solo las 2 conexiones a 127.0.0.1 cuentan como permitidas');
assert.deepStrictEqual(res.estado.destinos, destinosEsperados, 'el fetch también pasó por el control de sockets');
assert.strictEqual(res.estado.bloqueados, BLOQUEADOS.length);
console.log('2) loopback permitido: dns.lookup("127.0.0.1"), listen/connect y fetch http a 127.0.0.1 (2 conexiones contadas): OK');

assert.match(r.stderr, new RegExp(`SOLO-LOOPBACK permitidos=2 destinos=\\[[^\\]]*\\] bloqueados=${BLOQUEADOS.length} `));
console.log('3) resumen en stderr al salir con los contadores correctos: OK');

console.log('\nTodas las pruebas del preload de solo loopback pasaron.');
