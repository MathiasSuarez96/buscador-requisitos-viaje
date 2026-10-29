// Operación administrativa aislada. Nunca importada por servicios publicados.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { EJSON } = require('bson');
const { MongoServerError } = require('mongodb');
const { SPEC, opciones, prechequear } = require('../preparar-indice-transversal');
const { evaluarIndice } = require('../../services/propuestas/indices-propuestas');
const { canonicalizarValor } = require('../../services/propuestas/canonicalizacion-propuestas');
const { validarSalida } = require('../prechequear-indice-transversal-lectura');
const REPO = path.resolve(__dirname, '../../..');
const ARCHIVOS_CODIGO = Object.freeze([
  'backend/scripts/lib/operacion-indice-transversal.js',
  'backend/scripts/generar-plan-indice-transversal.js',
  'backend/scripts/crear-indice-transversal.js',
  'backend/scripts/revertir-indice-transversal.js',
  'backend/scripts/preparar-indice-transversal.js',
  'backend/scripts/prechequear-indice-transversal-lectura.js',
  'backend/scripts/test-operacion-indice-transversal.js',
  'backend/services/propuestas/indices-propuestas.js',
  'backend/services/propuestas/contrato-propuestas.js',
  'backend/services/propuestas/canonicalizacion-propuestas.js',
  'backend/package.json', 'backend/package-lock.json'
]);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const estable = x => JSON.stringify(canonicalizarValor(JSON.parse(JSON.stringify(x))));
const igual = (a, b) => estable(a) === estable(b);
const ordenarIndices = xs => xs.map(i => ({ ...i, key: Object.entries(i.key) })).sort((a, b) => a.name.localeCompare(b.name));
const mismosIndices = (a, b) => igual(ordenarIndices(a), ordenarIndices(b));
const VIGENCIA_PLAN_MS = 24 * 60 * 60 * 1000;
const VIGENCIA_PRECHEQUEO_MS = 60 * 1000;
const OPERADOR = 'mathias-operador';
class ErrorOperacionIndice extends Error { constructor(codigo) { super(codigo); this.codigo = codigo; } }
const falla = codigo => { throw new ErrorOperacionIndice(codigo); };

function capturarCodigo() {
  const git = args => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', windowsHide: true });
  if (git(['status', '--porcelain']).trim()) falla('repositorio_no_limpio');
  const commit = git(['rev-parse', 'HEAD']).trim();
  const archivos = {};
  for (const nombre of ARCHIVOS_CODIGO) {
    const blob = execFileSync('git', ['show', `${commit}:${nombre}`], { cwd: REPO, windowsHide: true });
    const actual = fs.readFileSync(path.join(REPO, nombre), 'utf8').replace(/\r\n/g, '\n');
    if (actual !== blob.toString('utf8').replace(/\r\n/g, '\n')) falla('codigo_distinto_del_commit');
    archivos[nombre] = sha(blob); // SHA de blobs Git, independiente de autocrlf.
  }
  return { commit, archivos };
}

function verificarInforme(bytes) {
  const informe = JSON.parse(bytes.toString('utf8'));
  const { informe_hash, ...contenido } = informe;
  if (sha(JSON.stringify(contenido)) !== informe_hash) falla('hash_informe_invalido');
  const { hash, ...foto } = informe.plan;
  if (sha(JSON.stringify(foto)) !== hash) falla('hash_prechequeo_invalido');
  if (informe.usuario !== 'buscador-prechequeo-lectura' || foto.base !== 'buscador_requisitos' || !igual(foto.spec, SPEC)) falla('informe_fuera_de_alcance');
  if (!foto.habilitado || foto.invalidas.length || foto.duplicadas.length || evaluarIndice(foto.indices, SPEC).estado !== 'crear') falla('informe_no_habilitado');
  if (!Array.isArray(foto.propuestas_activas) || foto.activas !== foto.propuestas_activas.length) falla('informe_incoherente');
  return informe;
}

function construirPlan(bytesInforme, codigo, ahora = new Date(), bytesSimulacion, host) {
  const informe = verificarInforme(bytesInforme);
  if (!/^[a-f0-9]{40}$/.test(codigo.commit) || !igual(Object.keys(codigo.archivos).sort(), [...ARCHIVOS_CODIGO].sort())) falla('huella_codigo_incompleta');
  if (Object.values(codigo.archivos).some(h => !/^[a-f0-9]{64}$/.test(h))) falla('huella_codigo_invalida');
  if (typeof host !== 'string' || !/^[a-z0-9][a-z0-9.-]*\.mongodb\.net$/.test(host)) falla('host_srv_requerido');
  const simulacion = JSON.parse(bytesSimulacion.toString('utf8'));
  if (simulacion.tipo !== 'simulacion_local' || simulacion.resultado !== 'OK'
    || simulacion.script !== 'backend/scripts/test-operacion-indice-transversal.js'
    || !igual(simulacion.codigo, codigo) || !/^8\.\d+\.\d+$/.test(simulacion.version_servidor)) falla('evidencia_simulacion_invalida');
  return {
    version: 2, creado_en: ahora.toISOString(), vence_en: new Date(ahora.getTime() + VIGENCIA_PLAN_MS).toISOString(),
    codigo, cluster_srv: host, base: 'buscador_requisitos', coleccion: SPEC.coleccion, operador: OPERADOR, autenticacion_base: 'admin',
    opcion_registrador: 'C', corregir_colision_antes_de_abrir_2_0: true,
    informe: { archivo: 'informe-base.json', sha256_bytes: sha(bytesInforme), informe_hash: informe.informe_hash,
      procedencia: 'informe_v1_sin_commit_declarado; no se atribuye retroactivamente a un commit' },
    simulacion: { archivo: 'simulacion.json', sha256_bytes: sha(bytesSimulacion) },
    inventario_anterior: informe.plan.indices, propuestas_activas_esperadas: informe.plan.propuestas_activas,
    creacion: { metodo: 'createIndex', clave: SPEC.clave, opciones: opciones() },
    reversion: { metodo: 'dropIndex', nombre: SPEC.nombre, requiere_autorizacion_separada: true,
      requiere_comprobante_creacion: true, requiere_confirmar_sin_servicios_dependientes: true },
    servidor: { politica: 'leer_buildInfo_antes_de_escribir_y_guardar_en_comprobante', version_mayor_admitida: 8 },
    controles: { vigencia_prechequeo_ms: VIGENCIA_PRECHEQUEO_MS, maximo_comandos_escritura: 1, maximo_documentos_control: 10000,
      resultado_incierto: 'no_reintentar_no_revertir; nueva_lectura_con_cuenta_read' }
  };
}

function guardarPlan({ informe, simulacion, carpeta, host, ahora = new Date(), obtenerCodigo = capturarCodigo }) {
  if (!path.isAbsolute(carpeta) || fs.existsSync(carpeta)) falla('carpeta_nueva_absoluta_requerida');
  const bytesInforme = fs.readFileSync(informe);
  const bytesSimulacion = fs.readFileSync(simulacion);
  const plan = construirPlan(bytesInforme, obtenerCodigo(), ahora, bytesSimulacion, host);
  const bytes = Buffer.from(JSON.stringify(plan, null, 2) + '\n');
  // Valida el padre real y excluye el repo antes de crear la carpeta del bundle.
  validarSalida(carpeta);
  fs.mkdirSync(carpeta, { mode: 0o700 });
  fs.writeFileSync(path.join(carpeta, 'informe-base.json'), bytesInforme, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(carpeta, 'simulacion.json'), bytesSimulacion, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(carpeta, 'plan.json'), bytes, { flag: 'wx', mode: 0o600 });
  const hash = sha(bytes), hashReversion = sha(Buffer.concat([bytes, Buffer.from('\0reversion')]));
  fs.writeFileSync(path.join(carpeta, 'hashes.json'), JSON.stringify({ sha256_plan_bytes: hash, sha256_autorizacion_reversion: hashReversion }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  // No hay comandos ejecutables en Markdown: el ejecutor consume exclusivamente el JSON validado.
  fs.writeFileSync(path.join(carpeta, 'LEEME.txt'), 'Plan v2 pendiente de revisión y confirmación. Solo plan.json contiene argumentos de operación.\nHash sobre sus bytes UTF-8 exactos (incluido salto final), sin excluir campos. hashes.json no es autorización.\nEl informe-base y la simulación quedan vinculados por SHA de sus bytes. No hay comandos para copiar a mano.\nLEEME.txt y hashes.json son informativos y no se consumen para autorizar operaciones.\n', { flag: 'wx', mode: 0o600 });
  return { hash, hashReversion, carpeta };
}

function cargarPlan(archivo, confirmado, codigo, ahora) {
  const bytes = fs.readFileSync(archivo);
  if (!/^[a-f0-9]{64}$/.test(confirmado) || sha(bytes) !== confirmado) falla('hash_plan_no_confirmado');
  const plan = JSON.parse(bytes.toString('utf8'));
  if (!igual(plan.codigo, codigo)) falla('codigo_no_coincide');
  const creado = Date.parse(plan.creado_en), vence = Date.parse(plan.vence_en);
  if (!Number.isFinite(creado) || !Number.isFinite(vence) || vence - creado !== VIGENCIA_PLAN_MS || ahora.getTime() < creado || ahora.getTime() > vence) falla('plan_vencido_o_fecha_invalida');
  const bytesInforme = fs.readFileSync(path.join(path.dirname(archivo), 'informe-base.json'));
  if (sha(bytesInforme) !== plan.informe?.sha256_bytes) falla('informe_base_alterado');
  const bytesSimulacion = fs.readFileSync(path.join(path.dirname(archivo), 'simulacion.json'));
  if (sha(bytesSimulacion) !== plan.simulacion?.sha256_bytes) falla('simulacion_alterada');
  const reconstruido = construirPlan(bytesInforme, codigo, new Date(creado), bytesSimulacion, plan.cluster_srv);
  if (!igual(plan, reconstruido) || JSON.stringify(plan.creacion?.clave) !== JSON.stringify(SPEC.clave)) falla('plan_fuera_de_contrato');
  return { plan, bytes };
}

function verificarOperador(status, accion) {
  const auth = status?.authInfo;
  if (auth?.authenticatedUsers?.length !== 1 || auth.authenticatedUsers[0].user !== OPERADOR
    || auth.authenticatedUsers[0].db !== 'admin') falla('operador_incorrecto');
  const roles = auth.authenticatedUserRoles;
  if (!Array.isArray(roles) || roles.length !== 1 || roles[0].role !== 'readWrite' || roles[0].db !== 'buscador_requisitos') falla('rol_operador_no_admitido');
  const privilegios = auth.authenticatedUserPrivileges;
  for (const requerida of ['find', 'listIndexes', accion]) {
    if (!Array.isArray(privilegios) || !privilegios.some(p => p?.resource?.db === 'buscador_requisitos'
      && ['', SPEC.coleccion].includes(p.resource.collection) && Array.isArray(p.actions) && p.actions.includes(requerida))) falla('privilegios_insuficientes');
  }
}

function instalarMonitor(cliente, plan, tipo) {
  const lectura = new Set(['connectionStatus', 'buildInfo', 'listIndexes', 'find', 'getMore', 'killCursors', 'endSessions']);
  const registro = []; let permitirEscritura = false, enviados = 0, violacion = false;
  const comandoEscritura = tipo === 'crear' ? 'createIndexes' : 'dropIndexes';
  const listener = e => {
    const nombre = e.commandName;
    if (lectura.has(nombre)) { registro.push(nombre); return; }
    let correcto = permitirEscritura && enviados === 0 && nombre === comandoEscritura
      && e.databaseName === plan.base && e.command[nombre] === plan.coleccion;
    if (correcto && tipo === 'crear') {
      const esperada = { key: plan.creacion.clave, ...plan.creacion.opciones };
      const indices = e.command.indexes;
      const recibido = indices?.[0] && { ...indices[0], key: indices[0].key instanceof Map
        ? Object.fromEntries(indices[0].key) : indices[0].key };
      correcto = Array.isArray(indices) && indices.length === 1
        && JSON.stringify(recibido.key) === JSON.stringify(esperada.key) && igual(recibido, esperada);
    } else if (correcto) correcto = e.command.index === plan.reversion.nombre;
    if (!correcto) { violacion = true; falla('comando_fuera_de_alcance'); }
    enviados++; permitirEscritura = false; registro.push(nombre);
  };
  cliente.on('commandStarted', listener);
  return { registro, get enviados() { return enviados; }, permitir() { permitirEscritura = true; },
    comprobar() { if (violacion) falla('monitor_violo_alcance'); }, retirar() { cliente.off('commandStarted', listener); } };
}

function escribirDescriptor(fd, valor) {
  const bytes = Buffer.from(JSON.stringify(valor, null, 2) + '\n');
  let escritos = 0;
  while (escritos < bytes.length) {
    const n = fs.writeSync(fd, bytes, escritos, bytes.length - escritos, escritos);
    if (n === 0) falla('comprobante_no_escribible');
    escritos += n;
  }
  fs.ftruncateSync(fd, bytes.length); fs.fsyncSync(fd);
}

async function hashDocumentos(c, limite) {
  const docs = await c.find({}).sort({ _id: 1 }).limit(limite + 1).toArray();
  if (docs.length > limite) falla('demasiados_documentos_para_control');
  return sha(JSON.stringify(EJSON.serialize(docs, { relaxed: false })));
}

async function ejecutar({ tipo, archivoPlan, confirmado, salida, uri, crearCliente, ahora = () => new Date(),
  obtenerCodigo = capturarCodigo, confirmadoReversion, comprobanteCreacion, confirmarSinDependientes = false }) {
  if (!['crear', 'revertir'].includes(tipo)) falla('operacion_invalida');
  const { plan, bytes } = cargarPlan(archivoPlan, confirmado, obtenerCodigo(), ahora());
  if (typeof uri !== 'string' || !/^mongodb(?:\+srv)?:\/\//.test(uri)) falla('uri_dedicada_requerida');
  let destinoUri;
  try { destinoUri = new URL(uri); } catch { falla('destino_uri_incorrecto'); }
  if (destinoUri.protocol !== 'mongodb+srv:' || destinoUri.hostname !== plan.cluster_srv
    || destinoUri.pathname !== '/' + plan.base) falla('destino_uri_incorrecto');
  if (tipo === 'revertir') {
    if (confirmadoReversion !== sha(Buffer.concat([bytes, Buffer.from('\0reversion')])) || confirmarSinDependientes !== true) falla('reversion_no_confirmada');
    const r = JSON.parse(fs.readFileSync(comprobanteCreacion, 'utf8'));
    const { comprobante_hash, ...contenido } = r;
    if (sha(JSON.stringify(contenido)) !== comprobante_hash || r.plan_hash !== confirmado || r.operacion !== 'crear'
      || r.estado !== 'confirmado' || !igual(r.codigo, plan.codigo)) falla('comprobante_creacion_invalido');
  }
  // Reserva real: Windows ACL y archivo existente se detectan ANTES del cliente.
  let destino, fd;
  try { destino = validarSalida(salida); fd = fs.openSync(destino, 'wx', 0o600); }
  catch { falla('salida_no_reservable'); }
  const recibo = { version: 2, operacion: tipo, plan_hash: confirmado, codigo: plan.codigo,
    iniciado_en: ahora().toISOString(), estado: 'iniciado_no_concluyente', base: plan.base, coleccion: plan.coleccion };
  let cliente, monitor, error, coleccionOperacion;
  try {
    escribirDescriptor(fd, recibo); // Evidencia durable incluso si el proceso se interrumpe.
    cliente = crearCliente(uri, { monitorCommands: true, retryWrites: false, maxPoolSize: 1,
      serverSelectionTimeoutMS: 15000, connectTimeoutMS: 15000 });
    monitor = instalarMonitor(cliente, plan, tipo);
    await cliente.connect();
    const db = cliente.db();
    if (db.databaseName !== plan.base) falla('base_incorrecta');
    verificarOperador(await db.command({ connectionStatus: 1, showPrivileges: true }), tipo === 'crear' ? 'createIndex' : 'dropIndex');
    const info = await db.command({ buildInfo: 1 });
    if (typeof info.version !== 'string' || !/^8\.\d+\.\d+(?:[-.][a-zA-Z0-9]+)*$/.test(info.version)) falla('version_servidor_no_admitida');
    recibo.version_servidor = info.version; recibo.operador = OPERADOR;
    const c = db.collection(plan.coleccion);
    coleccionOperacion = c;
    const tomada = ahora();
    const foto = await prechequear(db);
    recibo.indices_antes = foto.indices; recibo.prechequeo_hash = foto.hash;
    const esperadoAntes = tipo === 'crear' ? foto.indices : foto.indices.filter(i => i.name !== SPEC.nombre);
    if (!mismosIndices(esperadoAntes, plan.inventario_anterior)
      || !igual(foto.propuestas_activas, plan.propuestas_activas_esperadas) || foto.invalidas.length || foto.duplicadas.length) falla('prechequeo_cambio');
    if (evaluarIndice(foto.indices, SPEC).estado !== (tipo === 'crear' ? 'crear' : 'ya_existe')) falla('indice_no_coincide');
    recibo.documentos_antes_hash = await hashDocumentos(c, plan.controles.maximo_documentos_control);
    monitor.comprobar();
    // Comprobante intermedio durable por el descriptor reservado: si el proceso muere
    // tras el envío, queda la foto previa sin afirmar éxito. Sin esta escritura no se envía.
    const intermedio = { ...recibo, estado: 'envio_autorizado_resultado_no_confirmado',
      siguiente_paso: 'Si no hay comprobante final: no reintentar ni revertir; realizar nueva lectura independiente con cuenta read.' };
    try { escribirDescriptor(fd, { ...intermedio, comprobante_hash: sha(JSON.stringify(intermedio)) }); }
    catch { falla('comprobante_intermedio_no_escribible'); }
    const t = ahora();
    if (t.getTime() - tomada.getTime() < 0 || t.getTime() - tomada.getTime() > VIGENCIA_PRECHEQUEO_MS || t.getTime() > Date.parse(plan.vence_en)) falla('prechequeo_o_plan_vencido');
    monitor.permitir();
    if (tipo === 'crear') await c.createIndex(plan.creacion.clave, plan.creacion.opciones);
    else await c.dropIndex(plan.reversion.nombre);
    monitor.comprobar();
    recibo.indices_despues = await c.listIndexes().toArray();
    if (tipo === 'crear') {
      if (evaluarIndice(recibo.indices_despues, SPEC).estado !== 'ya_existe'
        || !mismosIndices(recibo.indices_despues.filter(i => i.name !== SPEC.nombre), plan.inventario_anterior)) falla('verificacion_posterior_fallo');
    } else if (!mismosIndices(recibo.indices_despues, plan.inventario_anterior)) falla('verificacion_posterior_fallo');
    recibo.documentos_despues_hash = await hashDocumentos(c, plan.controles.maximo_documentos_control);
    if (recibo.documentos_antes_hash !== recibo.documentos_despues_hash) falla('documentos_cambiaron_durante_operacion');
    if (monitor.enviados !== 1) falla('cantidad_comandos_incorrecta');
    recibo.estado = 'confirmado';
  } catch (e) {
    error = e;
    recibo.estado = monitor?.enviados ? 'incierto_requiere_lectura_independiente' : 'abortado_sin_envio';
    // Después del envío no se presume que el índice no exista, ni siquiera por E11000.
    recibo.codigo_resultado = e instanceof ErrorOperacionIndice ? e.codigo : 'error_externo_no_publicado';
    // Solo una respuesta semántica del servidor MÁS una relectura intacta
    // permite afirmar fallo confirmado. Un timeout/corte nunca entra aquí.
    const confirmados = new Map([[11000, 'duplicados_impiden_indice'], [85, 'opciones_indice_en_conflicto'],
      [86, 'clave_indice_en_conflicto'], [13, 'permiso_operacion_denegado'], [26, 'coleccion_inexistente']]);
    if (monitor?.enviados === 1 && e instanceof MongoServerError && confirmados.has(e.code)) {
      try {
        const actuales = await coleccionOperacion.listIndexes().toArray();
        monitor.comprobar();
        if (mismosIndices(actuales, recibo.indices_antes)) {
          recibo.indices_despues = actuales;
          recibo.estado = 'fallo_confirmado_sin_cambio_de_indices';
          recibo.codigo_resultado = confirmados.get(e.code);
          error = new ErrorOperacionIndice(recibo.codigo_resultado);
        }
      } catch { /* Conserva incierto si no se puede comprobar el inventario. */ }
    }
  } finally {
    // La causa principal queda en codigo_resultado; un fallo adicional del cierre va
    // aparte en codigo_cierre. Una violación del monitor ya reportada no es fallo de cierre.
    let cierreFallido = false;
    try { await cliente?.close(); } catch { cierreFallido = true; }
    try { monitor?.comprobar(); }
    catch (e) { if (!error) error = e; else if (!['comando_fuera_de_alcance', 'monitor_violo_alcance'].includes(error.codigo)) cierreFallido = true; }
    if (cierreFallido) {
      recibo.codigo_cierre = 'cierre_o_monitor_no_concluyente';
      if (!error) error = new ErrorOperacionIndice(recibo.codigo_cierre);
    }
    if (error && (cierreFallido || recibo.estado === 'confirmado')) {
      recibo.estado = monitor?.enviados ? 'incierto_requiere_lectura_independiente' : 'abortado_sin_envio';
      recibo.codigo_resultado ??= error.codigo ?? 'error_externo_no_publicado';
    }
    recibo.comandos = [...(monitor?.registro ?? [])]; monitor?.retirar();
    try {
      recibo.finalizado_en = ahora().toISOString();
      if (recibo.estado !== 'confirmado') recibo.siguiente_paso = 'No reintentar ni revertir; revisar comprobante y realizar nueva lectura independiente con cuenta read.';
      escribirDescriptor(fd, { ...recibo, comprobante_hash: sha(JSON.stringify(recibo)) });
    } catch { recibo.estado = 'incierto_requiere_lectura_independiente'; error = new ErrorOperacionIndice('resultado_no_concluyente_sin_comprobante'); }
    finally { fs.closeSync(fd); }
  }
  return { estado: recibo.estado, codigo: error ? (error instanceof ErrorOperacionIndice ? error.codigo : 'error_externo_no_publicado') : null,
    codigo_cierre: recibo.codigo_cierre ?? null, plan_hash: confirmado, comprobante: destino };
}

module.exports = { ARCHIVOS_CODIGO, ErrorOperacionIndice, sha, igual, mismosIndices, capturarCodigo, construirPlan,
  guardarPlan, cargarPlan, verificarOperador, instalarMonitor, ejecutar, VIGENCIA_PLAN_MS };
