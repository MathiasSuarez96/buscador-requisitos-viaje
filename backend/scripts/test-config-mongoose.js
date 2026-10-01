// Pruebas offline de config/mongoose.js y del orden de carga de
// server.js / app.js. Cada caso corre en un proceso hijo nuevo (estado de
// módulos limpio). Ninguno conecta a Mongo, escucha un puerto ni lee el .env.
//
// Uso: node scripts/test-config-mongoose.js

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');

// Código que corre al principio de cada hijo: registra, en orden, cada
// archivo del proyecto (fuera de node_modules) que se carga, más el
// require de 'dotenv', y reemplaza dotenv por un doble que cuenta las
// llamadas y fija variables conocidas (nunca lee un .env).
const ESPIA = `
const Module = require('module');
const path = require('path');
const RAIZ = ${JSON.stringify(RAIZ)};
const cargados = [];
const dotenv = { llamadas: 0 };
const original = Module._load;
Module._load = function (pedido, padre, ...resto) {
  if (pedido === 'dotenv') {
    if (!cargados.includes('dotenv')) cargados.push('dotenv');
    return { config: () => { dotenv.llamadas++; process.env.MONGODB_URI = 'mongodb://127.0.0.1:1/desde-dotenv'; process.env.PORT = '4321'; return {}; } };
  }
  if (Module.isBuiltin(pedido)) return original.call(this, pedido, padre, ...resto);
  const resuelto = Module._resolveFilename(pedido, padre, ...resto);
  const relativo = path.relative(RAIZ, resuelto).split(path.sep).join('/');
  if (!relativo.startsWith('..') && !relativo.startsWith('node_modules/') && !cargados.includes(relativo)) cargados.push(relativo);
  return original.call(this, pedido, padre, ...resto);
};
const salir = (datos) => { process.stdout.write(JSON.stringify(datos)); process.exit(0); };
`;

function enHijo(codigo) {
  const r = spawnSync(process.execPath, ['-e', ESPIA + codigo], { cwd: RAIZ, encoding: 'utf8', timeout: 60000, env: { ...process.env, MONGODB_URI: '' } });
  if (r.status !== 0) throw new Error(`hijo terminó con ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

const indice = (lista, prefijo) => lista.findIndex((f) => f.startsWith(prefijo));

const MODELOS = [
  'Destino.model',
  'ReglaGeneral.model',
  'propuestas/PropuestaCambio.model',
  'propuestas/EventoPropuesta.model',
  'propuestas/IntentoAplicacion.model',
  'propuestas/InicioIntentoAplicacion.model',
  'propuestas/HistorialCambio.model',
  'propuestas/EjecucionLectura.model'
];

// ============================================================
// 1) config/mongoose fija autoCreate y autoIndex en false
// ============================================================
{
  const r = enHijo(`
    const mongoose = require('./config/mongoose');
    salir({ autoCreate: mongoose.get('autoCreate'), autoIndex: mongoose.get('autoIndex'), modelos: mongoose.modelNames(), mismo: mongoose === require('mongoose') });
  `);
  assert.deepStrictEqual(r, { autoCreate: false, autoIndex: false, modelos: [], mismo: true });
  console.log('1) config/mongoose: autoCreate=false, autoIndex=false, exporta la instancia global, sin modelos: OK');
}

// ============================================================
// 2) Todos los modelos heredan false (ninguno lo pisa en true)
// ============================================================
{
  const r = enHijo(`
    const mongoose = require('./config/mongoose');
    for (const m of ${JSON.stringify(MODELOS)}) require('./models/' + m);
    salir(mongoose.modelNames().map((n) => {
      const o = mongoose.model(n).schema.options;
      return { n, autoCreate: o.autoCreate ?? mongoose.get('autoCreate'), autoIndex: o.autoIndex ?? mongoose.get('autoIndex') };
    }));
  `);
  assert.strictEqual(r.length, MODELOS.length, 'se registraron los 8 modelos');
  for (const m of r) {
    assert.strictEqual(m.autoCreate, false, `${m.n}: autoCreate efectivo`);
    assert.strictEqual(m.autoIndex, false, `${m.n}: autoIndex efectivo`);
  }
  console.log(`2) los ${r.length} modelos (incluido Destino, que no lo fija en su esquema) quedan con autoCreate/autoIndex efectivos en false: OK`);
}

// ============================================================
// 3) server.js: config antes que app y que cualquier modelo; sin efectos
// ============================================================
{
  const r = enHijo(`
    const servidor = require('./server.js');
    const mongoose = require('mongoose');
    const recursos = process.getActiveResourcesInfo();
    salir({ cargados, dotenv: dotenv.llamadas, estado: mongoose.connection.readyState, escuchando: recursos.includes('TCPServerWrap'), exporta: Object.keys(servidor), autoIndex: mongoose.get('autoIndex') });
  `);
  const iConfig = indice(r.cargados, 'config/mongoose.js');
  const iApp = indice(r.cargados, 'app.js');
  const iModelo = indice(r.cargados, 'models/');
  assert.strictEqual(r.cargados[0], 'server.js');
  assert.strictEqual(iConfig, 1, `config/mongoose es lo primero que carga server.js (orden: ${r.cargados.join(' → ')})`);
  assert.ok(iApp > iConfig, 'app.js después de config');
  assert.ok(iModelo > iConfig, 'los modelos después de config');
  assert.strictEqual(r.dotenv, 0, 'requerido como módulo no lee el .env');
  assert.ok(!r.cargados.includes('dotenv'), 'requerido como módulo ni siquiera requiere dotenv');
  assert.strictEqual(r.estado, 0, 'requerido como módulo no conecta');
  assert.strictEqual(r.escuchando, false, 'requerido como módulo no escucha');
  assert.deepStrictEqual(r.exporta, ['iniciar']);
  console.log(`3) server.js: ${r.cargados.slice(0, 5).join(' → ')} …; requerido como módulo no lee .env, no conecta ni escucha: OK`);
}

// ============================================================
// 4) app.js como punto de entrada también carga config primero
// ============================================================
{
  const r = enHijo(`
    const { crearApp } = require('./app.js');
    const app = crearApp();
    salir({ cargados, tipo: typeof app.listen, estado: require('mongoose').connection.readyState, autoCreate: require('mongoose').get('autoCreate') });
  `);
  assert.strictEqual(r.cargados[0], 'app.js');
  assert.strictEqual(r.cargados[1], 'config/mongoose.js', `orden: ${r.cargados.join(' → ')}`);
  assert.ok(indice(r.cargados, 'models/') > 1);
  assert.deepStrictEqual([r.tipo, r.estado, r.autoCreate], ['function', 0, false]);
  console.log('4) app.js: config/mongoose antes que rutas y modelos; crearApp() no conecta: OK');
}

// ============================================================
// 5) Cargar config DESPUÉS de un modelo aborta
// ============================================================
{
  const r = enHijo(`
    require('./models/Destino.model');
    let mensaje = null;
    try { require('./config/mongoose'); } catch (e) { mensaje = e.message; }
    salir({ mensaje, autoIndex: require('mongoose').get('autoIndex') });
  `);
  assert.match(r.mensaje ?? '', /se cargó después de registrar modelos \(Destino\)/);
  assert.notStrictEqual(r.autoIndex, false, 'no aplica una configuración tardía a medias');
  console.log('5) config/mongoose cargado después de un modelo: lanza y no aplica nada: OK');
}

// ============================================================
// 6) node server.js (proceso principal): dotenv ANTES que config, app y
//    modelos; después conecta y escucha con los valores del .env
// ============================================================
{
  // Preload temporal: el espía más dobles de mongoose.connect y de
  // net.Server#listen que solo registran (no conectan ni abren puertos).
  const fs = require('fs');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orden-server-'));
  const preload = path.join(dir, 'espia.js');
  fs.writeFileSync(
    preload,
    `${ESPIA}
const net = require('net');
const registro = { connect: null, listen: null };
net.Server.prototype.listen = function (...args) {
  registro.listen = args.find((a) => typeof a === 'number' || typeof a === 'string') ?? null;
  setImmediate(() => salir({ cargados, dotenv: dotenv.llamadas, ...registro }));
  return this;
};
const cargarMongoose = Module._load;
Module._load = function (pedido, ...resto) {
  const m = cargarMongoose.call(this, pedido, ...resto);
  if (pedido === 'mongoose' && !m.__espiado) {
    m.__espiado = true;
    m.connect = async (uri) => { registro.connect = uri; return m; };
  }
  return m;
};
`
  );
  try {
    const env = { ...process.env };
    delete env.MONGODB_URI;
    delete env.PORT;
    const r = spawnSync(process.execPath, ['--require', preload, 'server.js'], { cwd: RAIZ, encoding: 'utf8', timeout: 60000, env });
    if (r.status !== 0) throw new Error(`hijo terminó con ${r.status}: ${r.stderr}`);
    const d = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
    const orden = d.cargados;
    const iDotenv = orden.indexOf('dotenv');
    const iConfig = orden.indexOf('config/mongoose.js');
    const iApp = orden.indexOf('app.js');
    const iModelo = indice(orden, 'models/');
    assert.strictEqual(orden[0], 'server.js');
    assert.strictEqual(iDotenv, 1, `dotenv es lo primero que carga server.js (orden: ${orden.join(' → ')})`);
    assert.ok(iDotenv < iConfig && iConfig < iApp && iApp < iModelo, `dotenv → config → app → modelos (orden: ${orden.join(' → ')})`);
    assert.strictEqual(d.dotenv, 1, 'config() de dotenv se llama una vez');
    assert.strictEqual(d.connect, 'mongodb://127.0.0.1:1/desde-dotenv', 'conecta con la URI cargada por dotenv');
    assert.strictEqual(String(d.listen), '4321', 'escucha en el PORT cargado por dotenv');
    console.log(`6) node server.js: ${orden.slice(0, 4).join(' → ')} → … modelos; conecta y escucha con los valores del .env: OK`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\nTodas las pruebas de config/mongoose y orden de carga pasaron (sin red, sin Mongo, sin .env).');
