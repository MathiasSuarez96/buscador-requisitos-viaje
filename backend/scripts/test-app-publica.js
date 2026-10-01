// Pruebas de app.js: las rutas públicas responden igual que antes de
// separar la app del arranque. La app escucha en 127.0.0.1 con un puerto
// efímero y los modelos se reemplazan por dobles: no hay Mongo ni red
// externa. El cliente HTTP es un socket TCP mínimo a 127.0.0.1 (compatible
// con preload-solo-loopback.js, que bloquea http.request y fetch).
//
// Uso: node --require ./scripts/preload-solo-loopback.js scripts/test-app-publica.js

const assert = require('assert');
const net = require('net');

const { crearApp } = require('../app');
const mongoose = require('mongoose');
const Destino = require('../models/Destino.model');
const ReglaGeneral = require('../models/ReglaGeneral.model');

// GET mínimo sobre TCP: devuelve { status, headers, body }.
function get(puerto, ruta, headers = {}) {
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
    const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
    socket.write(`GET ${ruta} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n${extra}\r\n`);
  });
}

const DESTINOS = [
  { _id: '000000000000000000000001', pais: 'Argentina', codigo_iso: 'AR', requisitos: [] },
  { _id: '000000000000000000000002', pais: 'Reino Unido', codigo_iso: 'GB', requisitos: [{ _id: '6aaddd0e9f54309f9d8272dc', nombre: 'UK ETA', costo: '£20' }] }
];
const REGLA = { _id: 'permiso_menor_uruguay', contenido: 'Regla de prueba', estado: 'confirmado', pendiente_confirmar: [] };

// Dobles de los modelos, controlados por `estado`.
const estado = { fallarFind: false, fallarFindOne: false, llamadas: [] };
Destino.find = (filtro) => {
  estado.llamadas.push(['find', filtro]);
  return {
    sort: async (orden) => {
      estado.llamadas.push(['sort', orden]);
      if (estado.fallarFind) throw new Error('falla simulada');
      return DESTINOS;
    }
  };
};
Destino.findOne = async (filtro) => {
  estado.llamadas.push(['findOne', filtro]);
  if (estado.fallarFindOne) throw new Error('falla simulada');
  const d = DESTINOS.find((x) => x.codigo_iso === filtro.codigo_iso);
  return d ? { toObject: () => ({ ...d }) } : null;
};
ReglaGeneral.findById = async (id) => {
  estado.llamadas.push(['findById', id]);
  return REGLA;
};

(async () => {
  const servidor = crearApp().listen(0, '127.0.0.1');
  await new Promise((r) => servidor.once('listening', r));
  const { port } = servidor.address();
  try {
    // ============================================================
    // 1) GET /api/destinos
    // ============================================================
    {
      estado.llamadas = [];
      const r = await get(port, '/api/destinos');
      assert.strictEqual(r.status, 200);
      assert.match(r.headers['content-type'], /^application\/json/);
      assert.strictEqual(r.headers['access-control-allow-origin'], '*', 'CORS público sin cambios');
      assert.deepStrictEqual(JSON.parse(r.body), DESTINOS);
      assert.deepStrictEqual(estado.llamadas, [['find', undefined], ['sort', { pais: 1 }]]);
      console.log('1) GET /api/destinos: 200, JSON, ordenado por país, CORS abierto como antes: OK');
    }

    // ============================================================
    // 2) GET /api/destinos/:codigo (normaliza a mayúsculas, agrega la regla)
    // ============================================================
    {
      estado.llamadas = [];
      const r = await get(port, '/api/destinos/gb');
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(JSON.parse(r.body), { ...DESTINOS[1], regla_general: REGLA });
      assert.deepStrictEqual(estado.llamadas, [['findOne', { codigo_iso: 'GB' }], ['findById', 'permiso_menor_uruguay']]);
      console.log('2) GET /api/destinos/gb: busca GB, agrega regla_general: OK');
    }

    // ============================================================
    // 3) Errores con la misma forma que antes
    // ============================================================
    {
      const r404 = await get(port, '/api/destinos/zz');
      assert.strictEqual(r404.status, 404);
      assert.deepStrictEqual(JSON.parse(r404.body), { error: 'Destino no encontrado' });

      estado.fallarFind = true;
      const r500a = await get(port, '/api/destinos');
      estado.fallarFind = false;
      assert.strictEqual(r500a.status, 500);
      assert.deepStrictEqual(JSON.parse(r500a.body), { error: 'Error al obtener los destinos' });

      estado.fallarFindOne = true;
      const r500b = await get(port, '/api/destinos/GB');
      estado.fallarFindOne = false;
      assert.strictEqual(r500b.status, 500);
      assert.deepStrictEqual(JSON.parse(r500b.body), { error: 'Error al obtener el destino' });
      console.log('3) 404 y 500 con los mismos mensajes que antes: OK');
    }

    // ============================================================
    // 4) Preflight CORS público y rutas inexistentes
    // ============================================================
    {
      const r = await get(port, '/api/panel/sesion');
      assert.strictEqual(r.status, 404, 'el panel todavía no existe');
      const otra = await get(port, '/api/inexistente');
      assert.strictEqual(otra.status, 404);
      console.log('4) /api/panel/* y rutas inexistentes: 404: OK');
    }

    // ============================================================
    // 5) crearApp() no conecta a Mongo
    // ============================================================
    {
      assert.strictEqual(mongoose.connection.readyState, 0);
      assert.strictEqual(mongoose.get('autoCreate'), false);
      assert.strictEqual(mongoose.get('autoIndex'), false);
      console.log('5) la app sirvió pedidos sin conectar a Mongo; autoCreate/autoIndex en false: OK');
    }

    console.log('\nTodas las pruebas de la app pública pasaron (solo 127.0.0.1, sin Mongo).');
  } finally {
    servidor.close();
  }
})().catch((err) => {
  console.error('FALLÓ una prueba:', err);
  process.exitCode = 1;
});
