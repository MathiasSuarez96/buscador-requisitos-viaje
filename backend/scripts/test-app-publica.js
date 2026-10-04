// Pruebas de app.js: las rutas públicas responden igual que antes de
// separar la app del arranque. La app escucha en 127.0.0.1 con un puerto
// efímero y los modelos se reemplazan por dobles: no hay Mongo ni red
// externa. El cliente HTTP (scripts/lib/http-prueba.js) es un socket TCP
// mínimo a 127.0.0.1, compatible con preload-solo-loopback.js.
//
// Uso: node --require ./scripts/preload-solo-loopback.js scripts/test-app-publica.js

const assert = require('assert');
const { pedir, get } = require('./lib/http-prueba');

const { crearApp } = require('../app');
const mongoose = require('mongoose');
const Destino = require('../models/Destino.model');
const destinosRoutes = require('../routes/destinos.routes');
const ReglaGeneral = require('../models/ReglaGeneral.model');


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
  // Sin env: el panel queda deshabilitado (503). El aviso se captura.
  const avisos = [];
  const app = crearApp({ panel: { registrar: (e) => avisos.push(e) } });
  const servidor = app.listen(0, '127.0.0.1');
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
    // 4) Panel sin configuración: 503 cerrado y separado del CORS público
    // ============================================================
    {
      for (const ruta of ['/api/panel/sesion', '/api/panel/propuestas', '/api/panel/x']) {
        const r = await get(port, ruta, { Origin: 'https://cualquiera.example' });
        assert.strictEqual(r.status, 503, ruta);
        assert.strictEqual(JSON.parse(r.body).error.codigo, 'no_disponible', ruta);
        assert.strictEqual(r.headers['cache-control'], 'no-store', `${ruta}: no-store`);
        assert.strictEqual(r.headers['access-control-allow-origin'], undefined, `${ruta}: el CORS público no alcanza al panel`);
      }
      assert.deepStrictEqual(
        avisos.filter((a) => a.evento === 'panel_deshabilitado').map((a) => a.motivo),
        ['GOOGLE_CLIENT_ID: ausente o con forma inválida.'],
        'un único aviso al crear la app, sin valores de variables'
      );
      const errores = avisos.filter((a) => a.evento === 'panel_error');
      assert.strictEqual(errores.length, 3, 'cada pedido rechazado queda registrado');
      assert.ok(errores.every((e) => e.status === 503 && e.codigo === 'no_disponible' && typeof e.request_id === 'string'));
      const otra = await get(port, '/api/inexistente');
      assert.strictEqual(otra.status, 404);
      console.log('4) /api/panel/* sin configuración → 503 no_disponible, no-store y sin CORS público; rutas públicas inexistentes → 404: OK');
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

    // ============================================================
    // 6) Sin parser JSON global: las rutas públicas no lo necesitan
    // ============================================================
    {
      // La app no monta ningún parser de body propio (el del panel vive
      // dentro de su router).
      const nombres = app.router.stack.map((capa) => capa.name);
      assert.ok(!nombres.some((n) => /json|urlencoded|raw|text|bodyParser/i.test(n)), `capas de la app: ${nombres.join(', ')}`);
      // Todas las rutas públicas son GET: ninguna lee un body.
      const metodos = destinosRoutes.stack.flatMap((capa) => Object.keys(capa.route?.methods ?? {}));
      assert.deepStrictEqual([...new Set(metodos)], ['get']);
      // Un POST con JSON a la API pública no se procesa: 404, como cualquier ruta inexistente.
      estado.llamadas = [];
      const r = await pedir(port, 'POST', '/api/destinos', { 'Content-Type': 'application/json' }, JSON.stringify({ x: 1 }));
      assert.strictEqual(r.status, 404);
      assert.strictEqual(estado.llamadas.filter(([m]) => m === 'find').length, 0, 'el POST no llegó a ningún controlador');
      console.log(`6) sin parser JSON global (capas: ${nombres.join(' → ')}); rutas públicas solo GET; POST público → 404: OK`);
    }

    console.log('\nTodas las pruebas de la app pública pasaron (solo 127.0.0.1, sin Mongo).');
  } finally {
    servidor.close();
  }
})().catch((err) => {
  console.error('FALLÓ una prueba:', err);
  process.exitCode = 1;
});
