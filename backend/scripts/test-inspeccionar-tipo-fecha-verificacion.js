const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ObjectId } = require('mongodb');
const { MongoMemoryServer } = require('mongodb-memory-server');
const {
  PROYECCION,
  inspeccionar,
  mensajeSeguro,
  resumirDocumentos,
  tipoBsonDeserializado,
  vigilarComandos
} = require('./inspeccionar-tipo-fecha-verificacion');

function clienteFalso({ documentos = [], base = 'buscador_requisitos', comando = 'find' } = {}) {
  const cliente = new EventEmitter();
  const llamadas = { connect: 0, close: 0, find: [], sort: [] };
  cliente.connect = async () => { llamadas.connect++; };
  cliente.close = async () => { llamadas.close++; };
  cliente.db = () => ({
    databaseName: base,
    collection(nombre) {
      assert.equal(nombre, 'destinos');
      return {
        find(filtro, opciones) {
          llamadas.find.push({ filtro, opciones });
          cliente.emit('commandStarted', { commandName: comando });
          return {
            sort(orden) {
              llamadas.sort.push(orden);
              return { toArray: async () => documentos };
            }
          };
        }
      };
    }
  });
  return { cliente, llamadas };
}

async function rechaza(promesa, patron) {
  await assert.rejects(promesa, patron);
}

async function main() {
  assert.equal(tipoBsonDeserializado(undefined, false), 'ausente');
  assert.equal(tipoBsonDeserializado(null, true), 'null');
  assert.equal(tipoBsonDeserializado(new Date(), true), 'date');
  assert.equal(tipoBsonDeserializado('2026-01-01', true), 'string');

  const id1 = new ObjectId('64addd0e9f54309f9d8272d1');
  const id2 = new ObjectId('64addd0e9f54309f9d8272d2');
  const documentos = [
    { pais: 'Colombia', codigo_iso: 'CO', requisitos: [
      { _id: id1, tipo: 'formulario_digital', nombre: 'Check-Mig', fecha_verificacion: new Date('2026-01-01') }
    ] },
    { pais: 'Curazao', codigo_iso: 'CW', requisitos: [
      { _id: id2, tipo: 'formulario_digital', nombre: 'DI Card', fecha_verificacion: '2026-01-02' },
      { tipo: 'visa', fecha_verificacion: null },
      { tipo: 'vacuna' }
    ] }
  ];
  const resumen = resumirDocumentos(documentos);
  assert.deepEqual(resumen.tipos, { ausente: 1, date: 1, null: 1, string: 1 });
  assert.equal(resumen.tipos_mezclados, true);
  assert.equal(resumen.foco.length, 4);
  assert.equal(resumen.filas[0].requisito_id, String(id1));

  await rechaza(inspeccionar({ uri: '' }), /MONGODB_URI_AUDITORIA ausente/);
  const uriSecreta = 'mongodb+srv://usuario:secreto@host/buscador_requisitos';
  assert.equal(mensajeSeguro(new Error(`falló ${uriSecreta}`), uriSecreta), 'falló [URI oculta]');
  assert.equal(
    mensajeSeguro(new Error('falló mongodb://usuario:otra-clave@host/otra'), uriSecreta),
    'falló mongodb://[credenciales ocultas]@host/otra'
  );

  const falso = clienteFalso({ documentos });
  const resultado = await inspeccionar({ uri: 'mongodb://credencial-que-no-se-imprime/buscador_requisitos', crearCliente: () => falso.cliente });
  assert.deepEqual(falso.llamadas.find, [{ filtro: {}, opciones: { projection: PROYECCION } }]);
  assert.deepEqual(falso.llamadas.sort, [{ codigo_iso: 1, _id: 1 }]);
  assert.equal(falso.llamadas.connect, 1);
  assert.equal(falso.llamadas.close, 1);
  assert.deepEqual(resultado.comandos, ['find']);

  const baseMala = clienteFalso({ documentos, base: 'otra' });
  await rechaza(inspeccionar({ uri: 'mongodb://oculta/otra', crearCliente: () => baseMala.cliente }), /Base inesperada/);
  assert.equal(baseMala.llamadas.close, 1);

  const escritura = new EventEmitter();
  const vigilancia = vigilarComandos(escritura);
  escritura.emit('commandStarted', { commandName: 'find' });
  escritura.emit('commandStarted', { commandName: 'update' });
  assert.throws(() => vigilancia.verificar(), /Comando no permitido observado: update/);

  const agregado = clienteFalso({ documentos, comando: 'aggregate' });
  await rechaza(inspeccionar({ uri: 'mongodb://oculta/buscador_requisitos', crearCliente: () => agregado.cliente }), /exactamente un find|aggregate/);
  assert.equal(agregado.llamadas.close, 1);

  assert.throws(() => resumirDocumentos([{ codigo_iso: 'CO', requisitos: null }]), /requisitos no es una lista/);
  assert.throws(() => resumirDocumentos([{ codigo_iso: 'CO', requisitos: [null] }]), /Requisito con forma inválida/);

  let servidor;
  let semilla;
  try {
    servidor = await MongoMemoryServer.create({ instance: { dbName: 'buscador_requisitos' } });
    const uri = servidor.getUri('buscador_requisitos');
    const { MongoClient } = require('mongodb');
    semilla = new MongoClient(uri);
    await semilla.connect();
    await semilla.db('buscador_requisitos').collection('destinos').insertMany(documentos);
    await semilla.close();
    semilla = null;

    const real = await inspeccionar({ uri });
    assert.deepEqual(real.tipos, { ausente: 1, date: 1, null: 1, string: 1 });
    assert.equal(real.tipos_mezclados, true);
    assert.equal(real.comandos.filter((nombre) => nombre === 'find').length, 1);
    assert.ok(real.comandos.every((nombre) => ['find', 'getMore', 'killCursors', 'endSessions'].includes(nombre)));
  } finally {
    if (semilla) await semilla.close();
    if (servidor) await servidor.stop();
  }

  console.log('1) Tipos BSON date, string, null y ausente se distinguen sin casts: OK');
  console.log('2) Un único find usa filtro vacío, proyección cerrada y orden estable: OK');
  console.log('3) URI obligatoria y base esperada; no hay fallback: OK');
  console.log('4) Escrituras y aggregate provocan fallo; la conexión siempre se cierra: OK');
  console.log('5) Driver real con Mongo efímero conserva tipos y solo emite comandos permitidos: OK');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
