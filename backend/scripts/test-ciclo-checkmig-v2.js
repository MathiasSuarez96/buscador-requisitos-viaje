// Ciclo CheckMig 2.0: clasificación (sin cambio, cambio aplicable, revisión, fuente caída) con la
// fecha informada aparte; comando --simular sin base ni red (HTML local); configuración de la
// ejecución real; y ejecución real contra Mongo efímero con identidad del proceso simulada por
// connectionStatus inyectado. Nada toca Atlas ni la red.
// El proceso solo sale con 0 después de la última aserción (exitCode = 1 por defecto).
const assert = require('node:assert/strict');
if (!globalThis.__SOLO_LOOPBACK__) throw new Error('Se requiere preload-solo-loopback');
process.exitCode = 1;
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { readFileSync, writeFileSync, mkdtempSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const mongoose = require('../config/mongoose');
const { ObjectId } = require('mongodb');
const ciclo = require('../services/propuestas/ciclo/ciclo-revalidacion-v2');
const perfil = require('../services/propuestas/ciclo/perfil-checkmig-colombia');
const R = require('../services/propuestas/ciclo/config-ciclo-real');
const V2 = require('../services/propuestas/aplicar-propuesta-v2');
const { INDICES_DECISION, INDICES_APLICACION, ErrorPrecondicionIndices } = require('../services/propuestas/indices-propuestas');
const { ErrorActorNoAutorizado } = require('../services/propuestas/operadores-autorizados');
const { URL_FICHA } = require('../services/propuestas/fuentes/migracion-colombia-checkmig');

const FX = path.join(__dirname, 'fixtures', 'checkmig');
const html = n => readFileSync(path.join(FX, n), 'utf8').replace(/\r\n/g, '\n');
const respuesta = n => () => new Response(html(n), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
const caida = () => new Response('x', { status: 503, headers: { 'content-type': 'text/html' } });
const PUBLICADO = JSON.parse(readFileSync(path.join(FX, 'registro-publicado-2026-10-21.json'), 'utf8'));
const HOY = '2026-11-12';
const neutro = (extra = {}) => ({ tipo: 'formulario_digital', nombre: 'Check-Mig', obligatorio: 'si', descripcion: 'Formulario de prerregistro migratorio (Check-Mig).',
  fuente: 'Migración Colombia', link: 'https://apps.migracioncolombia.gov.co/check-mig/', estado: 'confirmado', fecha_verificacion: '2026-08-18', ...extra });
const leer = async fabrica => perfil.adaptador.leer({ fetch: async () => fabrica(), ahora: () => new Date('2026-11-12T03:00:00.000Z') });

(async () => {
  let rs;
  try {
    // ---- 1. Clasificación: las cuatro acciones, con la fecha informada aparte ----
    const valida = await leer(respuesta('oficial-muestra.html')), cambio = await leer(respuesta('cambio.html'));
    const ambigua = await leer(respuesta('ambigua.html')), noDisp = await leer(caida);
    const cl = (req, l) => ciclo.clasificar(req, l, perfil, { hoy: HOY });

    const pub = cl(PUBLICADO.requisito, valida);
    assert.deepEqual([pub.accion, pub.motivo, pub.guardado, pub.esperado], ['revision_humana', 'descripcion_contradice', 'si', 'no'], 'registro publicado: la descripción contradice el valor nuevo');
    assert.ok(pub.observaciones.some(o => o.codigo === 'fuente_no_es_la_ficha'), 'el campo fuente apunta al formulario');
    assert.deepEqual([pub.fecha_verificacion.actual, pub.fecha_verificacion.dias_desde_verificacion, pub.fecha_verificacion.efecto], ['2026-08-18', 86, 'no_se_renueva']);

    const aplicable = cl(neutro(), valida);
    assert.deepEqual([aplicable.accion, aplicable.cambios], ['cambio_aplicable', [{ campo: 'obligatorio', propuesto: { presente: true, bson_tipo: 'string', valor: 'no' } }]]);
    assert.equal(aplicable.fecha_verificacion.efecto, 'se_fija_al_aplicar');

    // «Sin cambio» y «renovar la fecha» son dos cosas: los valores coinciden, la fecha no se renueva.
    const sin = cl(neutro({ obligatorio: 'no' }), valida);
    assert.deepEqual([sin.accion, sin.cambios, sin.fecha_verificacion.efecto, sin.fecha_verificacion.renovacion_soportada], ['sin_cambio', undefined, 'no_se_renueva', false]);
    assert.match(sin.fecha_verificacion.detalle, /descripcion, fuente, link/);
    const sinIncoherente = cl(neutro({ obligatorio: 'no', descripcion: 'Formulario obligatorio antes del vuelo.' }), valida);
    assert.equal(sinIncoherente.accion, 'sin_cambio');
    assert.ok(sinIncoherente.observaciones.some(o => o.codigo === 'descripcion_contradice_el_valor'));

    const amb = cl(neutro(), ambigua);
    assert.deepEqual([amb.accion, amb.motivo, amb.pendiente.campos.map(c => c.campo)], ['revision_humana', 'lectura_ambigua', ['obligatoriedad', 'alcance', 'ventana_horas_antes']]);
    assert.equal(amb.fecha_verificacion.efecto, 'sin_efecto');
    const caidaCl = cl(neutro(), noDisp);
    assert.deepEqual([caidaCl.accion, caidaCl.motivo, caidaCl.pendiente.tipo], ['fuente_no_disponible', 'http_503', 'reintentar']);

    assert.deepEqual([cl(neutro({ obligatorio: 'no' }), cambio).accion, cl(neutro({ obligatorio: 'no' }), cambio).esperado], ['cambio_aplicable', 'si']);
    assert.equal(cl(neutro({ obligatorio: 'no', recomendado: 'si' }), cambio).motivo, 'requiere_cambiar_recomendado');
    assert.equal(cl(neutro({ obligatorio: 'no', descripcion: 'No es obligatorio.' }), cambio).motivo, 'descripcion_contradice');
    assert.equal(cl({ ...neutro(), nombre: 'Visa de turismo' }, valida).motivo, 'requisito_fuera_de_perfil');
    assert.equal(cl(neutro(), { ...valida, evidencia: { ...valida.evidencia, obligatoriedad: [] } }).motivo, 'sin_evidencia_confirmada');

    // ---- 2. Comando --simular: sin base de datos ni red (HTML local), códigos de salida ----
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'ciclo-checkmig-'));
    const registro = req => { const f = path.join(tmp, `${crypto.randomUUID()}.json`); writeFileSync(f, JSON.stringify({ destino: { pais: 'Prueba', codigo_iso: 'CO' }, requisito: req })); return f; };
    const cli = (...args) => spawnSync(process.execPath, ['--require', path.join(__dirname, 'preload-solo-loopback.js'), path.join(__dirname, 'ciclo-checkmig-v2.js'), ...args], { encoding: 'utf8', timeout: 60000 });
    for (const [nombre, args, codigo, texto] of [
      ['ayuda', [], 0, /^Uso: /],
      ['argumento desconocido', ['--borrar'], 1, /^Uso: /],
      ['registro publicado (prueba) + ficha', ['--simular', '--html', path.join(FX, 'oficial-muestra.html')], 3, /ACCIÓN: revision_humana \(descripcion_contradice\)/],
      ['registro neutro + ficha', ['--simular', '--registro', registro(neutro()), '--html', path.join(FX, 'valida.html')], 2, /ACCIÓN: cambio_aplicable[\s\S]*cambio que propondría: obligatorio → "no"/],
      ['registro ya corregido + ficha', ['--simular', '--registro', registro(neutro({ obligatorio: 'no' })), '--html', path.join(FX, 'valida.html')], 0, /ACCIÓN: sin_cambio[\s\S]*FECHA DE VERIFICACIÓN \(aparte de la acción\): actual=2026-08-18[\s\S]*efecto=no_se_renueva/],
      ['ficha ambigua', ['--simular', '--html', path.join(FX, 'ambigua.html')], 3, /ACCIÓN: revision_humana \(lectura_ambigua\)[\s\S]*pendiente de revisión: obligatoriedad \(no_atribuible\)/]
    ]) {
      const r = cli(...args);
      assert.equal(r.status, codigo, `${nombre}: ${r.stdout}${r.stderr}`);
      assert.match(r.stdout, texto, nombre);
      assert.match(r.stderr + r.stdout, /SOLO-LOOPBACK permitidos=0 destinos=\[\] bloqueados=0/, `${nombre}: ni base ni red`);
    }

    // ---- 3. Configuración de la ejecución real ----
    const OPS = JSON.stringify([{ usuario_atlas: 'ciclo-checkmig', db: 'admin', identificador: 'proceso.ciclo-checkmig' }]);
    const T = new Date('2026-11-12T03:00:00.000Z');
    const AUT = { politica: 'checkmig-colombia-obligatoriedad@1', autorizada_por: 'persona.autorizante', autorizada_en: '2026-11-12T00:00:00.000Z', vence_en: '2026-12-12T00:00:00.000Z' };
    const env = (extra = {}) => ({ MONGODB_URI_CICLO: 'mongodb+srv://ciclo:SECRETO@ejemplo.invalid/buscador_requisitos', OPERADORES_AUTORIZADOS_JSON: OPS, ...extra });
    const conf = R.cargarConfigCicloReal(env({ CICLO_V2_AUTORIZACION_JSON: JSON.stringify(AUT) }), T);
    assert.deepEqual([conf.politica_habilitada, conf.perfil.nombre, conf.autorizacion.autorizada_por], [true, 'checkmig-colombia', 'persona.autorizante']);
    assert.deepEqual([R.cargarConfigCicloReal(env(), T).politica_habilitada, R.cargarConfigCicloReal(env(), T).motivo_sin_politica], [false, 'CICLO_V2_AUTORIZACION_JSON ausente'], 'sin autorización: solo informa');
    assert.equal(R.cargarConfigCicloReal(env({ CICLO_V2_AUTORIZACION_JSON: JSON.stringify(AUT) }), new Date('2026-12-13T00:00:00.000Z')).motivo_sin_politica, 'la autorización venció');
    for (const [nombre, e] of [
      ['sin URI', { ...env(), MONGODB_URI_CICLO: undefined }],
      ['URI de la app', env({ MONGODB_URI: env().MONGODB_URI_CICLO })],
      ['allowlist vacía', env({ OPERADORES_AUTORIZADOS_JSON: '[]' })],
      ['identidad del piloto', env({ OPERADORES_AUTORIZADOS_JSON: JSON.stringify([{ usuario_atlas: 'piloto-local', db: 'admin', identificador: 'piloto.local' }]) })],
      ['política desconocida', env({ CICLO_V2_AUTORIZACION_JSON: JSON.stringify({ ...AUT, politica: 'todo@1' }) })],
      ['clave extra', env({ CICLO_V2_AUTORIZACION_JSON: JSON.stringify({ ...AUT, campos: ['descripcion'] }) })],
      ['vigencia de más de 90 días', env({ CICLO_V2_AUTORIZACION_JSON: JSON.stringify({ ...AUT, vence_en: '2027-03-12T00:00:00.000Z' }) })],
      ['autorizada por el piloto', env({ CICLO_V2_AUTORIZACION_JSON: JSON.stringify({ ...AUT, autorizada_por: 'piloto.local' }) })]
    ]) {
      assert.throws(() => R.cargarConfigCicloReal(e, T), err => err instanceof R.ErrorConfiguracionCiclo && !/SECRETO/.test(err.message), nombre);
    }

    // ---- 4. Ejecución real contra Mongo efímero (connectionStatus inyectado) ----
    const { MongoMemoryReplSet } = require('mongodb-memory-server');
    rs = await MongoMemoryReplSet.create({ binary: { version: '8.0.32' }, replSet: { count: 1 } });
    await mongoose.connect(rs.getUri('buscador_ciclo'), { autoIndex: false, autoCreate: false, monitorCommands: true });
    const conexion = mongoose.connection, col = n => conexion.db.collection(n);
    const crearIndices = async () => {
      for (const s of new Map([...INDICES_DECISION, ...INDICES_APLICACION, V2.INDICE_TRANSVERSAL].map(x => [`${x.coleccion}/${x.nombre}`, x])).values()) {
        await col(s.coleccion).createIndex(s.clave, { name: s.nombre, unique: true, ...(s.partialFilterExpression ? { partialFilterExpression: s.partialFilterExpression } : {}) });
      }
    };
    const sembrar = async (requisito, codigo = 'CO') => { const destinoId = new ObjectId(), requisitoId = new ObjectId();
      await col('destinos').insertOne({ _id: destinoId, pais: `Colombia ${codigo}`, codigo_iso: codigo, requisitos: [{ _id: requisitoId, ...requisito }] }); return { destinoId, requisitoId }; };
    let consultas = 0;
    const fichaReal = respuestas => { const cola = [...respuestas]; return async () => { consultas++; return cola.shift()(); }; };
    const preparar = (config, respuestas, usuarios = [{ user: 'ciclo-checkmig', db: 'admin' }]) => R.prepararEjecucionReal(config, {
      conexion, usuariosAutenticados: async () => usuarios, fetch: fichaReal(respuestas), ahora: () => new Date(), uuid: () => crypto.randomUUID() });
    const vigente = R.cargarConfigCicloReal(env({ CICLO_V2_AUTORIZACION_JSON: JSON.stringify({ ...AUT, autorizada_en: new Date(Date.now() - 60_000).toISOString(), vence_en: new Date(Date.now() + 86_400_000).toISOString() }) }), new Date());
    const reiniciar = async () => { await conexion.db.dropDatabase(); consultas = 0; };

    // Prechequeo: sin índices, sin identidad o sin destino único se detiene antes de leer la fuente.
    await reiniciar(); await sembrar(neutro());
    await assert.rejects(preparar(vigente, [respuesta('valida.html')]), ErrorPrecondicionIndices);
    await crearIndices();
    await assert.rejects(preparar(vigente, [respuesta('valida.html')], [{ user: 'otro', db: 'admin' }]), ErrorActorNoAutorizado);
    await sembrar(neutro(), 'CO2'); await col('destinos').updateOne({ codigo_iso: 'CO2' }, { $set: { codigo_iso: 'CO', pais: 'Colombia duplicada' } });
    await assert.rejects(preparar(vigente, []), R.ErrorObjetivoCiclo);
    assert.equal(consultas, 0, 'el prechequeo no consulta la fuente');

    // Cambio aplicable con política vigente: identidad real del proceso y autorizante registradas.
    await reiniciar(); await crearIndices();
    const o = await sembrar(neutro());
    const p = await preparar(vigente, [respuesta('valida.html'), respuesta('valida.html')]);
    assert.deepEqual([p.objetivo.destinoId.toHexString(), p.proceso.identificador], [o.destinoId.toHexString(), 'proceso.ciclo-checkmig']);
    const r = await ciclo.ejecutarCicloV2(p.objetivo, p.perfil, p.contexto);
    assert.deepEqual([r.resultado, r.estado_propuesta, r.valor_aplicado, r.lecturas, consultas], ['exito', 'aplicada', 'no', 2, 2], JSON.stringify(r));
    const dec = await col('eventos_propuesta').findOne({ evento_id: r.decision_evento_id });
    assert.deepEqual([dec.actor, dec.detalle.identidad_operador.metodo, dec.detalle.identidad_operador.politica, dec.detalle.identidad_operador.proceso, dec.detalle.identidad_operador.usuario_atlas],
      [{ tipo: 'humano', identificador: 'persona.autorizante' }, 'politica_automatica', 'checkmig-colombia-obligatoriedad@1', 'proceso.ciclo-checkmig', 'ciclo-checkmig']);
    const intento = await col('intentos_aplicacion').findOne({ intento_id: r.intento_id });
    assert.deepEqual([intento.auditoria.origen, intento.auditoria.operador, intento.auditoria.identidad.usuario_atlas, intento.revalidaciones[0].url],
      ['comando_administrativo', 'proceso.ciclo-checkmig', 'ciclo-checkmig', URL_FICHA]);
    assert.equal((await col('destinos').findOne({ _id: o.destinoId })).requisitos[0].obligatorio, 'no');

    // Sin política habilitada: el cambio se informa y no se escribe nada.
    await reiniciar(); await crearIndices();
    const o2 = await sembrar(neutro()), antes2 = JSON.stringify(await col('destinos').findOne({ _id: o2.destinoId }));
    const p2 = await preparar(R.cargarConfigCicloReal(env(), new Date()), [respuesta('valida.html')]);
    const r2 = await ciclo.ejecutarCicloV2(p2.objetivo, p2.perfil, p2.contexto);
    assert.deepEqual([r2.resultado, r2.motivo, r2.lecturas], ['cambio_aplicable', 'politica_no_habilitada', 1]);
    assert.deepEqual([await col('propuestas_cambio').countDocuments(), JSON.stringify(await col('destinos').findOne({ _id: o2.destinoId }))], [0, antes2]);

    // Registro publicado (la descripción afirma «obligatorio»): revisión humana, nada escrito.
    await reiniciar(); await crearIndices();
    const o3 = await sembrar(PUBLICADO.requisito), antes3 = JSON.stringify(await col('destinos').findOne({ _id: o3.destinoId }));
    const p3 = await preparar(vigente, [respuesta('valida.html')]);
    const r3 = await ciclo.ejecutarCicloV2(p3.objetivo, p3.perfil, p3.contexto);
    assert.deepEqual([r3.resultado, r3.motivo, r3.pendiente.tipo], ['revision_humana', 'descripcion_contradice', 'revision_humana']);
    assert.deepEqual([await col('propuestas_cambio').countDocuments(), JSON.stringify(await col('destinos').findOne({ _id: o3.destinoId }))], [0, antes3]);

    // ---- 5. Comando --ejecutar (ejecutarReal): registro de la corrida y códigos de salida ----
    const CLI = require('./ciclo-checkmig-v2');
    const corregido = neutro({ obligatorio: 'no', descripcion: 'Prerregistro migratorio en línea para el ingreso y la salida de Colombia.', fuente: URL_FICHA,
      link: 'https://apps.migracioncolombia.gov.co/pre-registro/', fecha_verificacion: '2026-11-17' });
    const correr = async ({ e = env(), respuestas = [respuesta('valida.html')], registroLocal = null, fetch } = {}) => {
      const lineas = [];
      const codigo = await CLI.ejecutarReal(e, l => lineas.push(l), { conexion, usuariosAutenticados: async () => [{ user: 'ciclo-checkmig', db: 'admin' }],
        fetch: fetch ?? fichaReal(respuestas), uuid: () => crypto.randomUUID() }, { registroLocal });
      const reg = lineas.filter(l => l.startsWith('REGISTRO_EJECUCION '));
      assert.equal(reg.length, 1, 'una sola línea de registro por corrida');
      return { codigo, lineas, registro: JSON.parse(reg[0].slice('REGISTRO_EJECUCION '.length)) };
    };
    const huella = async () => JSON.stringify(await Promise.all(['destinos', 'propuestas_cambio', 'eventos_propuesta', 'intentos_aplicacion', 'inicios_intento_aplicacion', 'historial_cambios']
      .map(n => col(n).find({}).sort({ _id: 1 }).toArray())));

    // Informe (sin política), registro ya corregido: sin_cambio → exit 0, cero escrituras, fuente y fecha registradas.
    await reiniciar(); await crearIndices();
    const o5 = await sembrar(corregido);
    const h5 = await huella();
    const archivo = path.join(tmp, 'registro-corrida.json');
    const e5 = await correr({ registroLocal: archivo });
    assert.equal(e5.codigo, 0, e5.lineas.join('\n'));
    const g = e5.registro;
    assert.deepEqual([g.version, g.modo, g.resultado, g.codigo_salida, g.motivo_sin_politica, g.proceso.identificador, g.objetivo.requisito_id],
      ['registro-ciclo-v1', 'informe', 'sin_cambio', 0, 'CICLO_V2_AUTORIZACION_JSON ausente', 'proceso.ciclo-checkmig', o5.requisitoId.toHexString()]);
    assert.deepEqual([g.fuente.url, g.fuente.tipo, g.fuente.http_status, typeof g.fuente.hechos_hash, Number.isNaN(Date.parse(g.fuente.consultado_en))], [URL_FICHA, 'hechos', 200, 'string', false]);
    assert.deepEqual([g.fecha_verificacion.actual, g.fecha_verificacion.efecto, g.fecha_verificacion.renovacion_soportada], ['2026-11-17', 'no_se_renueva', false], 'la fecha queda pendiente: la ficha no respalda todos los campos');
    assert.ok(g.comandos.length > 0 && g.comandos.every(c => CLI.COMANDOS_INFORME.includes(c)), `comandos: ${g.comandos}`);
    assert.equal(await huella(), h5, 'modo informe: nada escrito');
    assert.deepEqual(JSON.parse(readFileSync(archivo, 'utf8')), g, 'el registro local es el mismo JSON');
    assert.ok(!/SECRETO|mongodb\+srv/.test(e5.lineas.join('\n')), 'la salida no incluye la URI');
    // El registro local no sobrescribe: archivo existente → exit 1.
    assert.equal((await correr({ registroLocal: archivo })).codigo, 1);

    // Informe con un cambio aplicable: exit 2, sin escribir.
    await reiniciar(); await crearIndices(); await sembrar(neutro());
    const h6 = await huella();
    const e6 = await correr();
    assert.deepEqual([e6.codigo, e6.registro.resultado, e6.registro.motivo, e6.registro.pendiente.tipo], [2, 'cambio_aplicable', 'politica_no_habilitada', 'autorizacion']);
    assert.equal(await huella(), h6);

    // Guarda del modo informe: si algo escribiera por la conexión durante la corrida, exit 1.
    const fetchQueEscribe = async (...a) => { await col('destinos').updateOne({ codigo_iso: 'CO' }, { $set: { pais: 'tocado' } }); return respuesta('valida.html')(...a); };
    const e7 = await correr({ fetch: fetchQueEscribe });
    assert.deepEqual([e7.codigo, e7.registro.resultado], [1, 'error']);
    assert.match(e7.registro.error, /modo informe: comandos no permitidos observados: update/);

    // Fuente caída: exit 4 con el HTTP registrado. Prechequeo fallido (sin índices): exit 1 sin consultar la fuente.
    await reiniciar(); await crearIndices(); await sembrar(corregido);
    const e8 = await correr({ respuestas: [caida] });
    assert.deepEqual([e8.codigo, e8.registro.resultado, e8.registro.fuente.http_status, e8.registro.fuente.motivo], [4, 'fuente_no_disponible', 503, 'http_503']);
    await reiniciar(); await sembrar(corregido);
    const e9 = await correr();
    assert.deepEqual([e9.codigo, e9.registro.resultado, e9.registro.fuente, consultas], [1, 'error', null, 0]);
    assert.match(e9.registro.error, /Índices ausentes/);

    // Política vigente con un cambio aplicable: se aplica (exit 0) y el registro trae propuesta e intento.
    await reiniciar(); await crearIndices();
    const o10 = await sembrar(neutro());
    const e10 = await correr({ e: env({ CICLO_V2_AUTORIZACION_JSON: JSON.stringify({ ...AUT, autorizada_en: new Date(Date.now() - 60_000).toISOString(), vence_en: new Date(Date.now() + 86_400_000).toISOString() }) }),
      respuestas: [respuesta('valida.html'), respuesta('valida.html')] });
    assert.deepEqual([e10.codigo, e10.registro.modo, e10.registro.resultado, e10.registro.estado_propuesta, e10.registro.valor_aplicado, e10.registro.politica.autorizada_por],
      [0, 'politica_automatica', 'exito', 'aplicada', 'no', 'persona.autorizante'], e10.lineas.join('\n'));
    assert.ok(e10.registro.propuesta_id && e10.registro.intento_id);
    assert.equal((await col('destinos').findOne({ _id: o10.destinoId })).requisitos[0].obligatorio, 'no');
    // Al día siguiente la misma corrida ya no encuentra cambios: sin_cambio, exit 0.
    assert.deepEqual([(await correr({ e: env() })).codigo], [0]);

    assert.equal(globalThis.__SOLO_LOOPBACK__.bloqueados.length, 0, 'ninguna conexión externa');
    process.exitCode = 0;
    console.log('Ciclo CheckMig 2.0: clasificación y fecha aparte, --simular sin base ni red, configuración real e identidad del proceso en Mongo efímero: OK');
  } catch (err) {
    process.exitCode = 1;
    console.error(err);
  } finally {
    await mongoose.disconnect().catch(() => {});
    if (rs) await rs.stop().catch(() => {});
  }
})();
