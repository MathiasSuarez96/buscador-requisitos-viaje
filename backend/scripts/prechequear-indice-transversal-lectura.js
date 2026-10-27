// Ejecutable independiente, nunca importado por servicios. Sin dotenv ni Mongoose.
// Por defecto muestra ayuda y no conecta. La ejecución real requiere autorización
// humana previa, URI dedicada y cuenta read exclusiva de la base esperada.
const { prechequear } = require('./preparar-indice-transversal');
const { createHash } = require('node:crypto');
const { writeFileSync, statSync, lstatSync, realpathSync, accessSync, constants } = require('node:fs');
const { isAbsolute, relative, resolve, sep, dirname, basename, join } = require('node:path');
const BASE = 'buscador_requisitos';
const USUARIO = 'buscador-prechequeo-lectura';
const COMANDOS = new Set(['connectionStatus', 'listIndexes', 'find', 'getMore', 'killCursors', 'endSessions']);
const CODIGOS_PUBLICOS = new Set(['cuenta_de_lectura_incorrecta', 'se_exige_rol_read_exclusivo', 'base_incorrecta', 'variable_faltante', 'ruta_de_salida_invalida']);

class ErrorPrechequeo extends Error {
  constructor(codigo) { super(codigo); this.codigo = codigo; }
}

function mensajeErrorSeguro(error) {
  const codigo = error instanceof ErrorPrechequeo && CODIGOS_PUBLICOS.has(error.codigo)
    ? error.codigo : 'error_no_clasificado';
  return `Prechequeo abortado: ${codigo}. No se autoriza ninguna creación.`;
}

function validarSalida(salida) {
  try {
    if (typeof salida !== 'string' || !isAbsolute(salida)) throw new Error('ruta');
    const carpeta = realpathSync(dirname(salida));
    if (!statSync(carpeta).isDirectory()) throw new Error('carpeta');
    accessSync(carpeta, constants.W_OK);
    const destino = join(carpeta, basename(salida));
    const relativa = relative(realpathSync(resolve(__dirname, '../..')), destino);
    if (relativa === '' || (!relativa.startsWith('..' + sep) && !isAbsolute(relativa))) throw new Error('repo');
    // lstat detecta también un enlace roto: tampoco se permite sobrescribirlo.
    try { lstatSync(destino); } catch (error) {
      if (error.code === 'ENOENT') return destino;
      throw error;
    }
  } catch { /* Solo se publica un código fijo, nunca una ruta ni error crudo. */ }
  throw new ErrorPrechequeo('ruta_de_salida_invalida');
}

function verificarCuenta(status) {
  const auth = status?.authInfo;
  if (auth?.authenticatedUsers?.length !== 1 || auth.authenticatedUsers[0].user !== USUARIO) throw new ErrorPrechequeo('cuenta_de_lectura_incorrecta');
  const roles = auth.authenticatedUserRoles;
  if (!Array.isArray(roles) || roles.length !== 1 || roles[0].role !== 'read' || roles[0].db !== BASE) throw new ErrorPrechequeo('se_exige_rol_read_exclusivo');
}

function instalarMonitor(cliente) {
  const observados = [];
  let bloqueado = false;
  const listener = e => {
    observados.push(e.commandName);
    if (!COMANDOS.has(e.commandName)) {
      bloqueado = true;
      throw new Error('comando_no_permitido');
    }
  };
  cliente.on('commandStarted', listener);
  return { observados, comprobar() { if (bloqueado) throw new Error('monitor_detecto_comando_no_permitido'); },
    retirar() { cliente.off('commandStarted', listener); } };
}

async function ejecutar({ uri, salida, crearCliente, ahora = () => new Date() }) {
  if (typeof uri !== 'string' || uri.length === 0) throw new ErrorPrechequeo('variable_faltante');
  if (!/^mongodb(?:\+srv)?:\/\//.test(uri)) throw new Error('uri_invalida');
  const salidaValidada = validarSalida(salida);
  const cliente = crearCliente(uri, { monitorCommands: true, serverSelectionTimeoutMS: 15000, connectTimeoutMS: 15000 });
  const monitor = instalarMonitor(cliente);
  let informe;
  try {
    await cliente.connect();
    // Respeta la base de la URI: una URI dirigida a otra base debe abortar.
    const db = cliente.db();
    if (db.databaseName !== BASE) throw new ErrorPrechequeo('base_incorrecta');
    verificarCuenta(await db.command({ connectionStatus: 1 }));
    // Capacidad limitada: el prechequeo no recibe métodos de escritura.
    const dbLectura = Object.freeze({ databaseName: BASE, collection(nombre) {
      if (nombre !== 'propuestas_cambio') throw new Error('coleccion_no_permitida');
      const c = db.collection(nombre);
      return Object.freeze({ listIndexes: () => c.listIndexes(), find: (filtro, opciones) => c.find(filtro, opciones) });
    } });
    const plan = await prechequear(dbLectura);
    monitor.comprobar();
    informe = { version: 1, creado_en: ahora().toISOString(), usuario: USUARIO, plan, comandos: [...monitor.observados] };
  } finally {
    try { await cliente.close(); } finally { monitor.retirar(); }
  }
  monitor.comprobar();
  informe.comandos = [...monitor.observados];
  const hash = createHash('sha256').update(JSON.stringify(informe)).digest('hex');
  // No sobrescribe. El destino debe ser una carpeta privada fuera del repo.
  writeFileSync(salidaValidada, JSON.stringify({ ...informe, informe_hash: hash }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { hash, habilitado: informe.plan.habilitado };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 3 || args[0] !== '--solo-lectura' || args[1] !== '--salida') {
    console.log('Sin conexión. Uso tras autorización: node scripts/prechequear-indice-transversal-lectura.js --solo-lectura --salida RUTA_ABSOLUTA_PRIVADA');
    console.log('URI exclusiva en MONGODB_PRECHEQUEO_URI; cuenta buscador-prechequeo-lectura con read solo en buscador_requisitos.');
    if (args.length) process.exitCode = 1;
  } else {
    const { MongoClient } = require('mongodb');
    ejecutar({ uri: process.env.MONGODB_PRECHEQUEO_URI, salida: args[2], crearCliente: (uri, opciones) => new MongoClient(uri, opciones) })
      .then(r => { console.log(JSON.stringify(r)); if (!r.habilitado) process.exitCode = 1; })
      .catch(error => { console.error(mensajeErrorSeguro(error)); process.exitCode = 1; });
  }
}
module.exports = { BASE, USUARIO, ErrorPrechequeo, mensajeErrorSeguro, validarSalida, verificarCuenta, instalarMonitor, ejecutar };
