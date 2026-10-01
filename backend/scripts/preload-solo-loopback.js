/**
 * Preload (node --require) para pruebas de integración con un Mongo
 * efímero local: SOLO se permiten conexiones TCP a loopback (127.0.0.1,
 * ::1). Se bloquean y cuentan:
 *  - sockets a cualquier otro host, a "localhost" (evita la resolución
 *    DNS) y a rutas IPC;
 *  - TLS, DNS, http/https y fetch (sin excepciones);
 *  - require('dotenv') (ningún .env se carga).
 * child_process queda permitido: mongodb-memory-server lanza mongod.
 *
 * Deja el estado en globalThis.__SOLO_LOOPBACK__ (la prueba verifica que
 * el preload esté cargado) y al salir imprime en stderr:
 *   SOLO-LOOPBACK permitidos=<n> destinos=[...] bloqueados=<m> [...]
 */

const net = require('net');
const tls = require('tls');
const dns = require('dns');
const http = require('http');
const https = require('https');
const Module = require('module');

const HOSTS_PERMITIDOS = new Set(['127.0.0.1', '::1']);
const estado = { permitidos: 0, destinos: new Set(), bloqueados: [] };
globalThis.__SOLO_LOOPBACK__ = estado;

function bloquear(nombre) {
  estado.bloqueados.push(nombre);
  throw new Error(`SOLO-LOOPBACK: bloqueado ${nombre}`);
}

// Destino de Socket#connect en cualquiera de sus formas (incluida la ya
// normalizada por net.connect: un array cuyo primer elemento son las opciones).
function destinoDe(args) {
  let a = args;
  if (Array.isArray(a[0])) a = a[0];
  const [primero, segundo] = a;
  if (primero !== null && typeof primero === 'object') {
    return { host: primero.host ?? 'localhost', port: primero.port, path: primero.path };
  }
  if (typeof primero === 'number' || (typeof primero === 'string' && /^\d+$/.test(primero))) {
    return { host: typeof segundo === 'string' ? segundo : 'localhost', port: Number(primero) };
  }
  return { host: null, port: null, path: primero };
}

const conectarOriginal = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const { host, port, path } = destinoDe(args);
  if (path != null) bloquear(`net.connect(ipc:${path})`);
  if (!HOSTS_PERMITIDOS.has(host)) bloquear(`net.connect(${host}:${port})`);
  estado.permitidos++;
  estado.destinos.add(`${host}:${port}`);
  return conectarOriginal.apply(this, args);
};

tls.connect = () => bloquear('tls.connect');
for (const f of ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveSrv', 'resolveTxt', 'resolveAny']) {
  if (typeof dns[f] === 'function') dns[f] = () => bloquear(`dns.${f}`);
  if (dns.promises && typeof dns.promises[f] === 'function') dns.promises[f] = async () => bloquear(`dns.promises.${f}`);
}
http.request = () => bloquear('http.request');
http.get = () => bloquear('http.get');
https.request = () => bloquear('https.request');
https.get = () => bloquear('https.get');
globalThis.fetch = async () => bloquear('fetch');

const cargarOriginal = Module._load;
Module._load = function (pedido, ...resto) {
  if (pedido === 'dotenv' || pedido.startsWith('dotenv/')) bloquear(`require(${pedido})`);
  return cargarOriginal.call(this, pedido, ...resto);
};

process.on('exit', () => {
  const b = estado.bloqueados;
  process.stderr.write(
    `SOLO-LOOPBACK permitidos=${estado.permitidos} destinos=[${[...estado.destinos].join(', ')}] bloqueados=${b.length}${b.length ? ` [${[...new Set(b)].join(', ')}]` : ''}\n`
  );
});
