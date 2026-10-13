// Se hereda mediante --require en los procesos de build y mutaciones.
const net = require('node:net');
const tls = require('node:tls');
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
let intentos = 0;
const bloquear = () => { intentos++; throw new Error('Las pruebas no permiten red'); };
net.Socket.prototype.connect = bloquear;
tls.connect = bloquear;
for (const nombre of ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveSrv', 'resolveTxt', 'resolveAny']) {
  dns[nombre] = bloquear;
  if (dns.promises[nombre]) dns.promises[nombre] = bloquear;
}
http.request = http.get = https.request = https.get = bloquear;
globalThis.fetch = bloquear;
process.on('exit', () => {
  if (intentos) { process.stderr.write(`Intentos de red bloqueados: ${intentos}\n`); process.exitCode = 1; }
});
