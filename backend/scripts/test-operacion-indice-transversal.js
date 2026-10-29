const assert = require('node:assert/strict');
if (!globalThis.__SOLO_LOOPBACK__) throw new Error('Se requiere preload-solo-loopback');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const { MongoClient, ObjectId } = require('mongodb');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const O = require('./lib/operacion-indice-transversal');
const { SPEC, prechequear } = require('./preparar-indice-transversal');
const repo = path.resolve(__dirname, '../..');
// Proceso hijo que ejecuta la creación real y se mata con SIGKILL apenas el servidor
// responde a createIndexes, antes de que el ejecutor vea la respuesta. Si el runner de
// mutaciones exporta MUTACION_OPERACION_INDICE, el hijo compila la misma mutación.
const CODIGO_HIJO_CORTE = `const fs=require('node:fs'),Module=require('node:module'),path=require('node:path');
const d=JSON.parse(process.env.HIJO_CORTE),m=process.env.MUTACION_OPERACION_INDICE&&JSON.parse(process.env.MUTACION_OPERACION_INDICE);
if(m){const s=fs.readFileSync(d.lib,'utf8').split(String.fromCharCode(13)).join('');if(s.split(m[0]).length!==2)throw new Error('ANCLA NO UNICA');
  const mod=new Module(d.lib,module);mod.filename=d.lib;mod.paths=Module._nodeModulePaths(path.dirname(d.lib));require.cache[d.lib]=mod;mod._compile(s.replace(m[0],m[1]),d.lib);}
const O=require(d.lib),{MongoClient}=require('mongodb');
O.ejecutar({tipo:'crear',archivoPlan:d.archivoPlan,confirmado:d.hash,uri:d.uri,salida:d.salida,obtenerCodigo:()=>d.codigo,ahora:()=>new Date(d.t),
  crearCliente:(_u,o)=>{const c=new MongoClient(d.uriLocal,{...o,authSource:'admin',auth:{username:'mathias-operador',password:d.pwd}});
    c.on('commandSucceeded',e=>{if(e.commandName==='createIndexes'){fs.writeSync(1,'__CORTE_TRAS_ENVIO__\\n');process.kill(process.pid,'SIGKILL');}});return c;}})
  .then(()=>fs.writeSync(1,'__TERMINO_NORMAL__\\n'),()=>fs.writeSync(1,'__TERMINO_NORMAL__\\n'));`;

(async () => {
  const t = new Date();
  const temporal = fs.mkdtempSync(path.join(tmpdir(), 'operacion-indice-'));
  const codigo = { commit: 'a'.repeat(40), archivos: Object.fromEntries(O.ARCHIVOS_CODIGO.map(n => [n, O.sha(fs.readFileSync(path.join(repo, n)))])) };
  const obtenerCodigo = () => codigo;
  let rs, admin, serial = 0;
  try {
    rs = await MongoMemoryReplSet.create({ binary: { version: '8.0.32' }, replSet: { count: 1,
      auth: { enable: true, customRootName: 'rootlocal', customRootPwd: 'solo-prueba-root', extraUsers: [
        { createUser: 'mathias-operador', pwd: 'solo-prueba-operador', roles: [{ role: 'readWrite', db: 'buscador_requisitos' }] },
        { createUser: 'buscador-backend-app', pwd: 'solo-prueba-app', roles: [{ role: 'readWrite', db: 'buscador_requisitos' }] }
      ] } } });
    const uriLocal = rs.getUri('buscador_requisitos'); assert.match(uriLocal, /^mongodb:\/\/127\.0\.0\.1:/);
    const host = 'cluster0.simulacion.mongodb.net';
    const uri = 'mongodb+srv://' + host + '/buscador_requisitos'; // Nunca se conecta: la fábrica usa uriLocal.
    admin = await new MongoClient(uriLocal, { authSource: 'admin', auth: { username: 'rootlocal', password: 'solo-prueba-root' } }).connect();
    const db = admin.db(), c = await db.createCollection('propuestas_cambio');
    const versionSimulada = (await db.command({ buildInfo: 1 })).version;
    await c.createIndex({ propuesta_id: 1 }, { name: 'propuesta_id_1', unique: true });
    await c.createIndex({ destino_id: 1, requisito_id: 1, campo: 1 }, { name: 'uniq_propuesta_activa_por_destino_requisito_campo', unique: true,
      partialFilterExpression: SPEC.partialFilterExpression });
    await c.insertOne({ propuesta_id: 'historica', destino_id: new ObjectId(), requisito_id: new ObjectId(), campo: 'costo', estado: 'aplicada' });
    const foto = await prechequear(db);
    const informe = { version: 1, creado_en: t.toISOString(), usuario: 'buscador-prechequeo-lectura', plan: foto, comandos: ['listIndexes', 'find'] };
    const bytesInforme = Buffer.from(JSON.stringify({ ...informe, informe_hash: O.sha(JSON.stringify(informe)) }));
    const archivoInforme = path.join(temporal, 'informe.json'); fs.writeFileSync(archivoInforme, bytesInforme);
    const archivoSimulacion = path.join(temporal, 'simulacion-fixture.json');
    fs.writeFileSync(archivoSimulacion, JSON.stringify({ tipo: 'simulacion_local', resultado: 'OK',
      script: 'backend/scripts/test-operacion-indice-transversal.js', codigo, version_servidor: versionSimulada }));
    const carpeta = path.join(temporal, 'bundle');
    const generado = O.guardarPlan({ informe: archivoInforme, simulacion: archivoSimulacion, carpeta, host, ahora: t, obtenerCodigo });
    const archivoPlan = path.join(carpeta, 'plan.json');
    const bytes = fs.readFileSync(archivoPlan), plan = JSON.parse(bytes);
    assert.equal(generado.hash, O.sha(bytes));
    assert.equal(plan.codigo.commit, codigo.commit);
    assert.equal(plan.informe.sha256_bytes, O.sha(bytesInforme));
    assert.equal(plan.simulacion.sha256_bytes, O.sha(fs.readFileSync(archivoSimulacion)));
    assert.equal(plan.opcion_registrador, 'C');
    assert.equal(plan.corregir_colision_antes_de_abrir_2_0, true);
    const cargado = O.cargarPlan(archivoPlan, generado.hash, codigo, t);
    assert.equal(cargado.plan.operador, 'mathias-operador');
    assert.throws(() => O.cargarPlan(archivoPlan, '0'.repeat(64), codigo, t), /hash_plan/);
    assert.throws(() => O.cargarPlan(archivoPlan, generado.hash, { ...codigo, commit: 'b'.repeat(40) }, t), /codigo_no_coincide/);
    assert.throws(() => O.cargarPlan(archivoPlan, generado.hash, codigo, new Date(t.getTime() + O.VIGENCIA_PLAN_MS + 1)), /vencido/);
    for (const cambiar of [p => { p.creacion.opciones.unique = false; }, p => { p.operador = 'buscador-backend-app'; },
      p => { p.reversion.nombre = 'propuesta_id_1'; }, p => { p.creacion.clave = { requisito_id: 1, destino_id: 1 }; }]) {
      const mutado = structuredClone(plan); cambiar(mutado);
      const b = Buffer.from(JSON.stringify(mutado)); fs.writeFileSync(path.join(carpeta, 'mutado.json'), b);
      assert.throws(() => O.cargarPlan(path.join(carpeta, 'mutado.json'), O.sha(b), codigo, t), /fuera_de_contrato/);
    }
    fs.writeFileSync(path.join(carpeta, 'informe-base.json'), JSON.stringify({ ...JSON.parse(bytesInforme), creado_en: '2026-01-01T00:00:00.000Z' }));
    assert.throws(() => O.cargarPlan(archivoPlan, generado.hash, codigo, t), /informe_base_alterado/);
    fs.writeFileSync(path.join(carpeta, 'informe-base.json'), bytesInforme);
    const bytesSimulacion = fs.readFileSync(path.join(carpeta, 'simulacion.json'));
    fs.writeFileSync(path.join(carpeta, 'simulacion.json'), JSON.stringify({ ...JSON.parse(bytesSimulacion), resultado: 'ALTERADO' }));
    assert.throws(() => O.cargarPlan(archivoPlan, generado.hash, codigo, t), /simulacion_alterada/);
    fs.writeFileSync(path.join(carpeta, 'simulacion.json'), bytesSimulacion);
    let clientes = 0;
    const crearCliente = (_u, opts, usuario = 'mathias-operador', conexion = uriLocal) => {
      clientes++;
      assert.equal(opts.retryWrites, false);
      assert.equal(opts.monitorCommands, true);
      return new MongoClient(conexion, { ...opts, authSource: 'admin', auth: { username: usuario, password: usuario === 'mathias-operador' ? 'solo-prueba-operador' : 'solo-prueba-app' } });
    };
    const args = () => ({ tipo: 'crear', archivoPlan, confirmado: generado.hash, uri, salida: path.join(temporal, `comprobante-${++serial}.json`), crearCliente, obtenerCodigo, ahora: () => t });
    const existente = args(); fs.writeFileSync(existente.salida, 'conservar');
    await assert.rejects(O.ejecutar(existente), /salida_no_reservable/);
    assert.equal(clientes, 0, 'reserva rechazada antes del cliente');
    await assert.rejects(O.ejecutar({ ...args(), uri: 'mongodb+srv://otro.mongodb.net/buscador_requisitos' }), /destino_uri_incorrecto/);
    assert.equal(clientes, 0, 'host fuera del plan: no se crea cliente');
    assert.equal(fs.readFileSync(existente.salida, 'utf8'), 'conservar');
    const abrirOriginal = fs.openSync;
    try {
      fs.openSync = (p, ...resto) => { if (String(p).endsWith('denegado.json')) throw Object.assign(new Error('permiso de prueba'), { code: 'EPERM' }); return abrirOriginal(p, ...resto); };
      await assert.rejects(O.ejecutar({ ...args(), salida: path.join(temporal, 'denegado.json') }), /salida_no_reservable/);
      assert.equal(clientes, 0, 'EPERM real de open: no se crea cliente (inyección de fallo; no prueba de ACL del SO)');
    } finally { fs.openSync = abrirOriginal; }
    const reservaCarrera = args(); let aparecio = false;
    try {
      fs.openSync = (p, ...resto) => {
        if (p === reservaCarrera.salida && !aparecio) {
          aparecio = true; fs.writeFileSync(p, 'CONTENIDO_CONCURRENTE', { flag: 'wx' });
        }
        return abrirOriginal(p, ...resto);
      };
      await assert.rejects(O.ejecutar(reservaCarrera), /salida_no_reservable/);
    } finally { fs.openSync = abrirOriginal; }
    assert.equal(fs.readFileSync(reservaCarrera.salida, 'utf8'), 'CONTENIDO_CONCURRENTE');
    assert.equal(clientes, 0, 'carrera al reservar: no se crea cliente ni se sobrescribe');
    const auth = { authInfo: { authenticatedUsers: [{ user: 'mathias-operador', db: 'admin' }],
      authenticatedUserRoles: [{ role: 'readWrite', db: 'buscador_requisitos' }], authenticatedUserPrivileges: [] } };
    assert.throws(() => O.verificarOperador(auth, 'createIndex'), /privilegios_insuficientes/);
    const app = await O.ejecutar({ ...args(), crearCliente: (u, opts) => crearCliente(u, opts, 'buscador-backend-app') });
    assert.equal(app.estado, 'abortado_sin_envio'); assert.equal(app.codigo, 'operador_incorrecto');
    const baseMala = await O.ejecutar({ ...args(), crearCliente: (u, opts) => crearCliente(u, opts, 'mathias-operador', rs.getUri('otra_base')) });
    assert.equal(baseMala.estado, 'abortado_sin_envio'); assert.equal(baseMala.codigo, 'base_incorrecta');
    assert.equal((await c.indexes()).length, 3);
    await c.createIndex({ estado: 1 }, { name: 'extra_no_previsto' });
    const indicesCambiados = await O.ejecutar(args());
    assert.equal(indicesCambiados.estado, 'abortado_sin_envio'); assert.equal(indicesCambiados.codigo, 'prechequeo_cambio');
    await c.dropIndex('extra_no_previsto');
    const activo = { propuesta_id: 'activa', destino_id: new ObjectId(), requisito_id: new ObjectId(), campo: 'costo', estado: 'aprobada' };
    await c.insertOne(activo);
    const cambiado = await O.ejecutar(args());
    assert.equal(cambiado.estado, 'abortado_sin_envio'); assert.equal(cambiado.codigo, 'prechequeo_cambio');
    await c.deleteOne({ propuesta_id: 'activa' });
    let ticks = 0;
    const vencido = await O.ejecutar({ ...args(), ahora: () => new Date(t.getTime() + (++ticks >= 4 ? 60001 : 0)) });
    assert.equal(vencido.estado, 'abortado_sin_envio'); assert.equal(vencido.codigo, 'prechequeo_o_plan_vencido');
    const clienteVersionMala = (u, opts) => {
      const cliente = crearCliente(u, opts), dbOriginal = cliente.db.bind(cliente);
      cliente.db = (...dargs) => {
        const d = dbOriginal(...dargs), comandoOriginal = d.command.bind(d);
        d.command = (cmd, ...resto) => cmd.buildInfo ? Promise.resolve({ version: '7.0.0' }) : comandoOriginal(cmd, ...resto);
        return d;
      }; return cliente;
    };
    const versionMala = await O.ejecutar({ ...args(), crearCliente: clienteVersionMala });
    assert.equal(versionMala.estado, 'abortado_sin_envio'); assert.equal(versionMala.codigo, 'version_servidor_no_admitida');
    const inicial = await c.find({}).toArray(), indicesIniciales = await c.indexes();
    const correcto = await O.ejecutar(args());
    assert.equal(correcto.estado, 'confirmado', JSON.stringify(correcto)); assert.equal(correcto.codigo, null);
    const recibo = JSON.parse(fs.readFileSync(correcto.comprobante, 'utf8'));
    const { comprobante_hash, ...contenido } = recibo;
    assert.equal(comprobante_hash, O.sha(JSON.stringify(contenido)));
    assert.equal(recibo.version_servidor, versionSimulada);
    assert.equal(recibo.comandos.filter(n => n === 'createIndexes').length, 1);
    assert.ok(!recibo.comandos.some(n => ['update', 'insert', 'delete', 'dropIndexes'].includes(n)));
    assert.deepEqual(await c.find({}).toArray(), inicial);
    assert.equal((await c.indexes()).length, 4);
    await assert.rejects(O.ejecutar({ ...args(), tipo: 'revertir', confirmadoReversion: '0'.repeat(64),
      comprobanteCreacion: correcto.comprobante, confirmarSinDependientes: true }), /reversion_no_confirmada/);
    const rollback = await O.ejecutar({ ...args(), tipo: 'revertir', confirmadoReversion: generado.hashReversion,
      comprobanteCreacion: correcto.comprobante, confirmarSinDependientes: true });
    assert.equal(rollback.estado, 'confirmado');
    assert.ok(O.mismosIndices(await c.indexes(), indicesIniciales));
    assert.deepEqual(await c.find({}).toArray(), inicial);
    const reciboRollback = JSON.parse(fs.readFileSync(rollback.comprobante, 'utf8'));
    assert.equal(reciboRollback.comandos.filter(n => n === 'dropIndexes').length, 1);
    // Se pierde la respuesta después de que Mongo confirma: no reintentar ni borrar.
    const clienteConCorte = (u, opts) => {
      const cliente = crearCliente(u, opts), dbOriginal = cliente.db.bind(cliente);
      cliente.db = (...dargs) => {
        const d = dbOriginal(...dargs), colOriginal = d.collection.bind(d);
        d.collection = (...cargs) => {
          const col = colOriginal(...cargs), crear = col.createIndex.bind(col);
          col.createIndex = async (...iargs) => { await crear(...iargs); throw new Error('mongodb://usuario:SECRETO_DE_PRUEBA@host/'); };
          return col;
        }; return d;
      }; return cliente;
    };
    const incierto = await O.ejecutar({ ...args(), crearCliente: clienteConCorte });
    assert.equal(incierto.estado, 'incierto_requiere_lectura_independiente');
    const reciboIncierto = fs.readFileSync(incierto.comprobante, 'utf8');
    assert.doesNotMatch(reciboIncierto, /SECRETO_DE_PRUEBA|mongodb:\/\//);
    assert.equal(JSON.parse(reciboIncierto).comandos.filter(n => n === 'createIndexes').length, 1);
    assert.ok(!JSON.parse(reciboIncierto).comandos.includes('dropIndexes'));
    assert.equal((await c.indexes()).length, 4, 'el índice sigue presente tras el corte');
    await c.dropIndex(SPEC.nombre); // Solo limpieza del entorno efímero de prueba.
    const clienteMetadataIncompleta = (u, opts) => {
      const cliente = crearCliente(u, opts), dbOriginal = cliente.db.bind(cliente);
      cliente.db = (...dargs) => {
        const d = dbOriginal(...dargs), colOriginal = d.collection.bind(d);
        d.collection = (...cargs) => {
          const col = colOriginal(...cargs), crear = col.createIndex.bind(col), listar = col.listIndexes.bind(col); let creado = false;
          col.createIndex = async (...iargs) => { const r = await crear(...iargs); creado = true; return r; };
          col.listIndexes = (...iargs) => creado ? { toArray: async () => (await listar(...iargs).toArray()).filter(i => i.name !== SPEC.nombre) } : listar(...iargs);
          return col;
        }; return d;
      }; return cliente;
    };
    const sinVerificar = await O.ejecutar({ ...args(), crearCliente: clienteMetadataIncompleta });
    assert.equal(sinVerificar.estado, 'incierto_requiere_lectura_independiente');
    assert.equal(sinVerificar.codigo, 'verificacion_posterior_fallo');
    await c.dropIndex(SPEC.nombre);
    // Una colisión aparece después del prechequeo; el servidor rechaza la construcción.
    const clienteConCarrera = (u, opts) => {
      const cliente = crearCliente(u, opts), dbOriginal = cliente.db.bind(cliente);
      cliente.db = (...dargs) => {
        const d = dbOriginal(...dargs), colOriginal = d.collection.bind(d);
        d.collection = (...cargs) => {
          const col = colOriginal(...cargs), crear = col.createIndex.bind(col);
          col.createIndex = async (...iargs) => {
            const destino_id = new ObjectId(), requisito_id = new ObjectId();
            await c.insertMany([{ propuesta_id: 'carrera-1', destino_id, requisito_id, campo: 'costo', estado: 'aprobada' },
              { propuesta_id: 'carrera-2', destino_id, requisito_id, campo: 'requisito', estado: 'pendiente_aprobacion' }]);
            return crear(...iargs);
          }; return col;
        }; return d;
      }; return cliente;
    };
    const duplicado = await O.ejecutar({ ...args(), crearCliente: clienteConCarrera });
    assert.equal(duplicado.estado, 'fallo_confirmado_sin_cambio_de_indices');
    assert.equal(duplicado.codigo, 'duplicados_impiden_indice');
    assert.ok(O.mismosIndices(await c.indexes(), indicesIniciales));
    await c.deleteMany({ propuesta_id: { $in: ['carrera-1', 'carrera-2'] } });
    const conCierreFallido = fabrica => (u, opts) => {
      const cliente = fabrica(u, opts), cerrar = cliente.close.bind(cliente);
      cliente.close = async () => { await cerrar(); throw new Error('fallo de cierre simulado'); };
      return cliente;
    };
    const conColeccion = (fabrica, alterar) => (u, opts) => {
      const cliente = fabrica(u, opts), dbOriginal = cliente.db.bind(cliente);
      cliente.db = (...dargs) => {
        const d = dbOriginal(...dargs), colOriginal = d.collection.bind(d);
        d.collection = (...cargs) => { const col = colOriginal(...cargs); alterar(col); return col; };
        return d;
      }; return cliente;
    };
    const cierre = await O.ejecutar({ ...args(), crearCliente: conCierreFallido(crearCliente) });
    assert.equal(cierre.estado, 'incierto_requiere_lectura_independiente');
    assert.equal(cierre.codigo, 'cierre_o_monitor_no_concluyente', 'sin causa previa, el cierre es la causa principal');
    assert.equal(cierre.codigo_cierre, 'cierre_o_monitor_no_concluyente');
    assert.equal((await c.indexes()).length, 4, 'el índice se creó aunque el cierre falló');
    await c.dropIndex(SPEC.nombre);
    // Cambio deliberado: el cierre fallido ya NO tapa la causa original del corte.
    const corteYCierre = await O.ejecutar({ ...args(), crearCliente: conCierreFallido(clienteConCorte) });
    assert.equal(corteYCierre.estado, 'incierto_requiere_lectura_independiente');
    assert.equal(corteYCierre.codigo, 'error_externo_no_publicado');
    assert.equal(corteYCierre.codigo_cierre, 'cierre_o_monitor_no_concluyente');
    assert.equal((await c.indexes()).length, 4, 'el índice sigue presente tras corte y cierre fallido');
    await c.dropIndex(SPEC.nombre);
    // Un insert con el mismo cliente se bloquea en commandStarted, antes de salir al servidor.
    const marca = { propuesta_id: 'insert-fuera-de-alcance', destino_id: new ObjectId(), requisito_id: new ObjectId(), campo: 'costo', estado: 'aplicada' };
    const fueraDeAlcance = await O.ejecutar({ ...args(), crearCliente: conColeccion(crearCliente, col => {
      col.createIndex = async () => { await col.insertOne({ ...marca }); };
    }) });
    assert.equal(fueraDeAlcance.estado, 'abortado_sin_envio');
    assert.equal(fueraDeAlcance.codigo, 'comando_fuera_de_alcance');
    assert.equal(fueraDeAlcance.codigo_cierre, null, 'la violación ya reportada no es un fallo de cierre');
    assert.equal(await c.countDocuments({ propuesta_id: marca.propuesta_id }), 0, 'el insert no llegó al servidor');
    assert.ok(O.mismosIndices(await c.indexes(), indicesIniciales));
    // La violación se traga en el código llamador: la detecta monitor.comprobar(), no el cierre.
    const violacionYCierre = await O.ejecutar({ ...args(), crearCliente: conCierreFallido(conColeccion(crearCliente, col => {
      col.createIndex = async () => { try { await col.insertOne({ ...marca }); } catch { /* tragado a propósito */ } };
    })) });
    assert.equal(violacionYCierre.estado, 'abortado_sin_envio');
    assert.equal(violacionYCierre.codigo, 'monitor_violo_alcance');
    assert.equal(violacionYCierre.codigo_cierre, 'cierre_o_monitor_no_concluyente');
    assert.equal(await c.countDocuments({ propuesta_id: marca.propuesta_id }), 0, 'el insert tragado tampoco llegó');
    assert.ok(O.mismosIndices(await c.indexes(), indicesIniciales));
    const duplicadoYCierre = await O.ejecutar({ ...args(), crearCliente: conCierreFallido(clienteConCarrera) });
    assert.equal(duplicadoYCierre.estado, 'incierto_requiere_lectura_independiente', 'cierre fallido: no se afirma fallo confirmado');
    assert.equal(duplicadoYCierre.codigo, 'duplicados_impiden_indice');
    assert.equal(duplicadoYCierre.codigo_cierre, 'cierre_o_monitor_no_concluyente');
    assert.ok(O.mismosIndices(await c.indexes(), indicesIniciales), 'E11000: el índice no se creó');
    await c.deleteMany({ propuesta_id: { $in: ['carrera-1', 'carrera-2'] } });
    const operadorYCierre = await O.ejecutar({ ...args(), crearCliente: conCierreFallido((u, opts) => crearCliente(u, opts, 'buscador-backend-app')) });
    assert.equal(operadorYCierre.estado, 'abortado_sin_envio');
    assert.equal(operadorYCierre.codigo, 'operador_incorrecto');
    assert.equal(operadorYCierre.codigo_cierre, 'cierre_o_monitor_no_concluyente');
    assert.ok(!JSON.parse(fs.readFileSync(operadorYCierre.comprobante, 'utf8')).comandos.includes('createIndexes'));
    assert.ok(O.mismosIndices(await c.indexes(), indicesIniciales));
    for (const r of [fueraDeAlcance, violacionYCierre, operadorYCierre]) {
      const comandos = JSON.parse(fs.readFileSync(r.comprobante, 'utf8')).comandos;
      assert.ok(!comandos.some(n => ['insert', 'createIndexes'].includes(n)), `sin escrituras registradas en ${r.codigo}`);
    }
    assert.deepEqual(await c.find({}).toArray(), inicial, 'documentos intactos tras los escenarios de cierre');
    // Muerte abrupta del proceso justo después del envío: queda el comprobante intermedio.
    const fotoAntesHijo = await prechequear(db);
    const salidaHijo = path.join(temporal, `comprobante-${++serial}.json`);
    const hijo = spawnSync(process.execPath, ['--require', path.join(__dirname, 'preload-solo-loopback.js'), '-e', CODIGO_HIJO_CORTE], {
      cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 60000,
      env: { ...process.env, HIJO_CORTE: JSON.stringify({ lib: require.resolve('./lib/operacion-indice-transversal'), archivoPlan,
        hash: generado.hash, uri, salida: salidaHijo, uriLocal, codigo, t: t.toISOString(), pwd: 'solo-prueba-operador' }) }
    });
    assert.ok(!hijo.error && hijo.status !== 0, `hijo terminado abruptamente\n${hijo.stdout}\n${hijo.stderr}`);
    assert.match(hijo.stdout, /__CORTE_TRAS_ENVIO__/);
    assert.doesNotMatch(hijo.stdout, /__TERMINO_NORMAL__/);
    const textoHijo = fs.readFileSync(salidaHijo, 'utf8'), reciboHijo = JSON.parse(textoHijo);
    assert.equal(reciboHijo.estado, 'envio_autorizado_resultado_no_confirmado');
    assert.deepEqual(reciboHijo.codigo, codigo);
    assert.equal(reciboHijo.version_servidor, versionSimulada);
    assert.ok(O.mismosIndices(reciboHijo.indices_antes, indicesIniciales));
    assert.equal(reciboHijo.prechequeo_hash, fotoAntesHijo.hash);
    { const { comprobante_hash: h, ...datos } = reciboHijo; assert.equal(h, O.sha(JSON.stringify(datos))); }
    for (const campo of ['indices_despues', 'finalizado_en', 'codigo_resultado', 'documentos_despues_hash']) assert.ok(!(campo in reciboHijo), `sin ${campo}`);
    assert.doesNotMatch(textoHijo, /"confirmado"|solo-prueba-|mongodb:\/\//);
    assert.equal((await c.indexes()).length, 4, 'el índice existe: el comprobante no lo niega ni afirma éxito');
    await c.dropIndex(SPEC.nombre);
    // Si la escritura intermedia falla, se aborta antes del envío.
    const fsyncOriginal = fs.fsyncSync; let fsyncs = 0;
    let sinIntermedio;
    try {
      fs.fsyncSync = (...fargs) => { if (++fsyncs === 2) throw Object.assign(new Error('fsync de prueba'), { code: 'EIO' }); return fsyncOriginal(...fargs); };
      sinIntermedio = await O.ejecutar(args());
    } finally { fs.fsyncSync = fsyncOriginal; }
    assert.equal(sinIntermedio.estado, 'abortado_sin_envio', JSON.stringify(sinIntermedio));
    assert.equal(sinIntermedio.codigo, 'comprobante_intermedio_no_escribible');
    assert.ok(!JSON.parse(fs.readFileSync(sinIntermedio.comprobante, 'utf8')).comandos.includes('createIndexes'));
    assert.ok(O.mismosIndices(await c.indexes(), indicesIniciales), 'sin escritura intermedia no hay índice');
    // El error nunca reemplaza la identidad del código, especialmente en inciertos.
    for (const r of [app, baseMala, indicesCambiados, cambiado, vencido, versionMala, correcto, rollback, incierto, sinVerificar, duplicado, cierre, corteYCierre,
      fueraDeAlcance, violacionYCierre, duplicadoYCierre, operadorYCierre, sinIntermedio]) {
      const texto = fs.readFileSync(r.comprobante, 'utf8');
      const completo = JSON.parse(texto);
      assert.deepEqual(completo.codigo, codigo, `trazabilidad preservada en ${r.estado}`);
      assert.equal(completo.codigo_resultado ?? null, r.codigo);
      assert.equal(completo.codigo_cierre ?? null, r.codigo_cierre);
      const { comprobante_hash, ...datos } = completo;
      assert.equal(comprobante_hash, O.sha(JSON.stringify(datos)));
      assert.doesNotMatch(texto, /solo-prueba-|SECRETO_DE_PRUEBA|mongodb:\/\//);
    }
    const emisor = new EventEmitter();
    const m = O.instalarMonitor(emisor, plan, 'crear');
    const evento = { commandName: 'createIndexes', databaseName: plan.base, command: { createIndexes: plan.coleccion,
      indexes: [{ key: plan.creacion.clave, ...plan.creacion.opciones }] } };
    assert.throws(() => emisor.emit('commandStarted', evento), /fuera_de_alcance/);
    m.retirar();
    const m2 = O.instalarMonitor(emisor, plan, 'crear'); m2.permitir();
    emisor.emit('commandStarted', evento);
    assert.equal(m2.enviados, 1);
    m2.permitir(); // Aun si se reabre la fase, no debe admitir una segunda escritura.
    assert.throws(() => emisor.emit('commandStarted', evento), /fuera_de_alcance/);
    m2.retirar();
    for (const alterado of [
      { ...evento, databaseName: 'otra_base' },
      { ...evento, command: { ...evento.command, createIndexes: 'destinos' } },
      { ...evento, command: { ...evento.command, indexes: [{ ...evento.command.indexes[0], unique: false }] } },
      { ...evento, commandName: 'update', command: { update: plan.coleccion } }
    ]) {
      const monitor = O.instalarMonitor(emisor, plan, 'crear'); monitor.permitir();
      assert.throws(() => emisor.emit('commandStarted', alterado), /fuera_de_alcance/);
      monitor.retirar();
    }
    console.log('Operación índice v2: hashes, trazabilidad, vencimiento, operador real, reserva previa, prechequeo, un createIndex, relectura, rollback separado y corte posterior: OK');
    if (process.argv[2] === '--evidencia' && process.argv.length === 4) {
      const salida = require('./prechequear-indice-transversal-lectura').validarSalida(process.argv[3]);
      const evidencia = { tipo: 'simulacion_local', resultado: 'OK', script: 'backend/scripts/test-operacion-indice-transversal.js',
        codigo: O.capturarCodigo(), version_servidor: versionSimulada, finalizado_en: new Date().toISOString() };
      fs.writeFileSync(salida, JSON.stringify(evidencia, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      console.log('Evidencia local versionada guardada.');
    }
  } finally { await admin?.close(); await rs?.stop({ doCleanup: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
