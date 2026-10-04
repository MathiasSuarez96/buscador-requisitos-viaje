// Ayudante SOLO para pruebas: cliente HTTP/1.1 mínimo sobre un socket TCP a
// 127.0.0.1 (compatible con preload-solo-loopback.js, que bloquea
// http.request). Devuelve { status, headers, body }.

const net = require('net');

function pedir(puerto, metodo, ruta, headers = {}, cuerpo = null) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: puerto });
    const partes = [];
    socket.on('data', (d) => partes.push(d));
    socket.on('error', reject);
    socket.on('end', () => {
      const crudo = Buffer.concat(partes).toString('utf8');
      const fin = crudo.indexOf('\r\n\r\n');
      const [linea, ...resto] = crudo.slice(0, fin).split('\r\n');
      const h = Object.fromEntries(resto.map((l) => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]));
      resolve({ status: Number(linea.split(' ')[1]), headers: h, body: crudo.slice(fin + 4) });
    });
    const conCuerpo = cuerpo !== null ? { ...headers, 'Content-Length': Buffer.byteLength(cuerpo) } : headers;
    const extra = Object.entries(conCuerpo).map(([k, v]) => `${k}: ${v}\r\n`).join('');
    socket.write(`${metodo} ${ruta} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n${extra}\r\n${cuerpo ?? ''}`);
  });
}

const get = (puerto, ruta, headers) => pedir(puerto, 'GET', ruta, headers);

module.exports = { pedir, get };
