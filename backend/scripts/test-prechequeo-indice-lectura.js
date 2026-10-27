const assert = require('node:assert/strict');
if (!globalThis.__SOLO_LOOPBACK__) throw new Error('Se requiere preload-solo-loopback');
const { EventEmitter } = require('node:events');
const { mkdtempSync, readFileSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { MongoClient } = require('mongodb');
const { BASE, USUARIO, verificarCuenta, instalarMonitor, ejecutar } = require('./prechequear-indice-transversal-lectura');

(async () => {
  const cuenta = { authInfo: { authenticatedUsers: [{ user: USUARIO }], authenticatedUserRoles: [{ role: 'read', db: BASE }] } };
  assert.doesNotThrow(() => verificarCuenta(cuenta));
  for (const roles of [[], [{ role: 'readWrite', db: BASE }], [{ role: 'read', db: 'otra' }],
    [{ role: 'read', db: BASE }, { role: 'root', db: 'admin' }]]) {
    assert.throws(() => verificarCuenta({ authInfo: { ...cuenta.authInfo, authenticatedUserRoles: roles } }), /rol_read/);
  }
  assert.throws(() => verificarCuenta({}), /cuenta/);
  const falso = new EventEmitter();
  const monitor = instalarMonitor(falso);
  assert.throws(() => falso.emit('commandStarted', { commandName: 'update' }), /comando_no_permitido/);
  assert.throws(() => monitor.comprobar(), /monitor_detecto/);
  monitor.retirar();
  assert.equal(falso.listenerCount('commandStarted'), 0);
  let conecto = false;
  await assert.rejects(ejecutar({ uri: 'mongodb://127.0.0.1:1/', salida: join(__dirname, 'informe.json'), crearCliente() { conecto = true; } }), /ruta_de_salida_invalida/);
  assert.equal(conecto, false);

  let rs, admin, lectura;
  const salida = join(mkdtempSync(join(tmpdir(), 'prechequeo-lectura-')), 'informe.json');
  try {
    rs = await MongoMemoryReplSet.create({ binary: { version: '8.0.32' }, replSet: { count: 1,
      auth: { enable: true, customRootName: 'rootlocal', customRootPwd: 'prueba-local-root',
        extraUsers: [{ createUser: USUARIO, pwd: 'prueba-local-read', roles: [{ role: 'read', db: BASE }] }] } } });
    const uri = rs.getUri(BASE);
    assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:/);
    admin = await new MongoClient(uri, { authSource: 'admin', auth: { username: 'rootlocal', password: 'prueba-local-root' } }).connect();
    await admin.db().createCollection('propuestas_cambio');
    const crearCliente = (u, opts) => new MongoClient(u, { ...opts, authSource: 'admin', auth: { username: USUARIO, password: 'prueba-local-read' } });
    const ahora = () => new Date('2026-10-26T23:00:00.000Z');
    await assert.rejects(ejecutar({ uri: rs.getUri('otra_base'), salida: salida + '.otra', crearCliente, ahora }), /base_incorrecta/);
    assert.equal(existsSync(salida + '.otra'), false);
    const resultado = await ejecutar({ uri, salida, crearCliente, ahora });
    assert.equal(resultado.habilitado, true);
    const informe = JSON.parse(readFileSync(salida, 'utf8'));
    const { informe_hash, ...contenido } = informe;
    assert.equal(informe_hash, createHash('sha256').update(JSON.stringify(contenido)).digest('hex'));
    assert.equal(resultado.hash, informe_hash);
    assert.equal(informe.creado_en, ahora().toISOString());
    assert.ok(informe.comandos.includes('connectionStatus'));
    assert.ok(informe.comandos.includes('find'));
    assert.ok(informe.comandos.includes('listIndexes'));
    assert.doesNotMatch(readFileSync(salida, 'utf8'), /prueba-local|mongodb:\/\//, 'informe sin contraseñas ni URI');
    let clienteExtra = false;
    await assert.rejects(ejecutar({ uri, salida, crearCliente: (...args) => { clienteExtra = true; return crearCliente(...args); }, ahora }), /ruta_de_salida_invalida/);
    assert.equal(clienteExtra, false, 'archivo existente: aborta antes de crear el cliente');
    lectura = await crearCliente(uri, {}).connect();
    await assert.rejects(lectura.db().collection('propuestas_cambio').insertOne({ no_debe_existir: true }), e => e.code === 13);
    assert.equal(await admin.db().collection('propuestas_cambio').countDocuments({}), 0, 'Mongo impide escrituras con la cuenta read');
    await admin.db('admin').command({ updateUser: USUARIO, roles: [{ role: 'readWrite', db: BASE }] });
    await assert.rejects(ejecutar({ uri, salida: salida + '.rechazado', crearCliente }), /rol_read/);
    assert.equal(existsSync(salida + '.rechazado'), false, 'sin informe si la cuenta tiene escritura');
    console.log('Prechequeo real local autenticado: cuenta read, monitor, informe fechado y hash íntegro; readWrite rechazado; Mongo deniega escritura: OK');
  } finally {
    await lectura?.close(); await admin?.close(); await rs?.stop({ doCleanup: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
