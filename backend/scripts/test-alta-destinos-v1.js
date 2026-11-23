// Alta automática de un destino ausente (DE) desde la lista oficial del Auswärtiges Amt:
//  1. Extracción determinista (extracto real y mutaciones): solo la fila positiva «Uruguay» cuenta.
//  2. Entrada explícita y construcción con el contrato actual (lo no confirmado queda 'verificar').
//  3. Plan de índices: reutiliza los únicos de destinos y solo crea los de altas_destino.
//  4. Mongo efímero + GET /api/destinos: informe sin escrituras, alta visible (B), repetición y
//     concurrencia sin duplicar (C), fuente ambigua/caída/inestable sin publicar (D), mantenimiento del
//     mismo país después del alta, y Colombia con la autorización en lista (E).
// Nada toca Atlas ni la red. exitCode = 1 hasta la última aserción.
const assert = require('node:assert/strict');
if (!globalThis.__SOLO_LOOPBACK__) throw new Error('Se requiere preload-solo-loopback');
process.exitCode = 1;
const path = require('node:path');
const crypto = require('node:crypto');
const { readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const mongoose = require('../config/mongoose');
const { ObjectId } = require('mongodb');
const F = require('../services/propuestas/fuentes/auswaertiges-amt-visumpflicht');
const A = require('../services/propuestas/altas/alta-destino-v1');
const { ADAPTADORES_V2 } = require('../services/propuestas/adaptadores/v2');
const V2 = require('../services/propuestas/aplicar-propuesta-v2');
const { INDICES_DECISION, INDICES_APLICACION } = require('../services/propuestas/indices-propuestas');
const { capturarIdentidadEInstantanea } = require('../services/propuestas/contrato-requisito-v2');
const { fechaMontevideo } = require('../services/propuestas/plan-aplicacion-requisito-v2');
const { URL_FICHA } = require('../services/propuestas/fuentes/migracion-colombia-checkmig');
const IDX = require('./crear-indices-altas');
const ALTA = require('./alta-destinos-v1');
const CICLO = require('./ciclo-checkmig-v2');

const FX = path.join(__dirname, 'fixtures', 'auswaertiges-amt', 'extracto-staatenliste-2026-11-22.html');
const LISTA = readFileSync(FX, 'utf8').replace(/\r\n/g, '\n');
const FICHA_CO = readFileSync(path.join(__dirname, 'fixtures', 'checkmig', 'valida.html'), 'utf8').replace(/\r\n/g, '\n');
const FILA = '<tr><td>Uruguay</td><td>Nein (1)</td></tr>';
assert.ok(LISTA.includes(FILA), 'el extracto real trae la fila de Uruguay');
const con = fila => LISTA.replace(FILA, fila);
const LISTA_JA = con('<tr><td>Uruguay</td><td>Ja</td></tr>');
const SIN_FILA = con('');
const okHtml = h => () => new Response(h, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
const caida = () => new Response('x', { status: 503, headers: { 'content-type': 'text/html' } });
// Condiciones no admitidas: nota en la celda del país (con Nein o Ja), nota con Ja, nota 1 restringida o
// con texto agregado. Todas deben quedar ambiguas en ambos campos.
const NOTA_BIOMETRICA = LISTA.replace('Inhaber von Nationalpässen', 'Nur Inhaber von Nationalpässen mit biometrischen Pässen');
const FALSOS = [
  ['nota en la celda del país (Nein)', con('<tr><td>Uruguay (5)</td><td>Nein (1)</td></tr>'), 'visa', 'condicionada'],
  ['nota en la celda del país (Ja)', con('<tr><td>Uruguay (5)</td><td>Ja</td></tr>'), 'visa', 'condicionada'],
  ['Ja con nota', con('<tr><td>Uruguay</td><td>Ja (5)</td></tr>'), 'visa', 'condicionada'],
  ['Nein con otra nota además de la 1', con('<tr><td>Uruguay</td><td>Nein (1, 5)</td></tr>'), 'visa', 'condicionada'],
  ['nota 1 restringida a pasaportes biométricos', NOTA_BIOMETRICA, 'estancia', 'no_reconocido'],
  ['nota 1 con una condición agregada al final', LISTA.replace('in den betroffenen Staaten.', 'in den betroffenen Staaten. Dies gilt nur für Inhaber biometrischer Pässe.'), 'estancia', 'no_reconocido']
];
const ENTRADA = JSON.parse(readFileSync(path.join(__dirname, '..', 'config', 'altas-destinos.json'), 'utf8'));

(async () => {
  let rs, servidor;
  try {
    // ---- 1. Extracción ----
    const e = F.extraer(LISTA);
    assert.deepEqual([e.estado, e.campos.visa.valor, e.campos.estancia.valor], ['ok', 'no', { dias: 90, periodo_dias: 180, actividad_remunerada: 'no_permitida' }]);
    assert.equal(e.campos.visa.evidencia[0], 'Uruguay: Nein (1) (Visumpflicht für Deutschland: Ja/Nein)');
    assert.match(e.campos.estancia.evidencia[1], /^1\) Inhaber von Nationalpässen .*nicht länger als 90 Tage je Zeitraum von 180 Tagen/);
    const ja = F.extraer(LISTA_JA);
    assert.deepEqual([ja.estado, ja.campos.visa.valor, ja.campos.estancia.valor], ['ok', 'si', null]);
    for (const [nombre, h, campo, motivo] of [
      ['fila ausente (la ausencia no se interpreta)', SIN_FILA, 'visa', 'sin_evidencia'],
      ['fila repetida', con(FILA + FILA), 'visa', 'sin_evidencia'],
      ['condición particular (pasaporte biométrico)', con('<tr><td>Uruguay</td><td>Nein (1, 5)</td></tr>'), 'estancia', 'condicionada'],
      ['«Nein» sin la nota de estadía', con('<tr><td>Uruguay</td><td>Nein</td></tr>'), 'estancia', 'condicionada'],
      ['valor no reconocido', con('<tr><td>Uruguay</td><td>Nein*</td></tr>'), 'visa', 'no_reconocido'],
      ['nota 1 con otra redacción', LISTA.replace('je Zeitraum von 180 Tagen im Bundesgebiet', 'im Bundesgebiet'), 'estancia', 'no_reconocido'],
      ['nota 1 sin la restricción de trabajo', LISTA.replace('keine Erwerbstätigkeit aufnehmen', 'arbeiten'), 'estancia', 'no_reconocido'],
      ['encabezado distinto', LISTA.replace('Visumpflicht für Deutschland: Ja/Nein', 'Visa: Ja/Nein'), 'visa', 'sin_evidencia'],
      ['dos tablas', LISTA.replace('</main>', '<table><tr><td>x</td></tr></table></main>'), 'visa', 'sin_evidencia'],
      ['dos <main>', LISTA.replace('</main>', '</main><main></main>'), 'visa', 'sin_evidencia'],
      // Regresiones (revisión de Codex): condiciones no admitidas en cualquiera de las dos celdas o en la nota.
      ...FALSOS.map(([nombre, h, campo, motivo]) => [nombre, h, campo, motivo])
    ]) {
      const x = F.extraer(h);
      assert.equal(x.estado, 'ambiguo', nombre);
      assert.equal(x.campos[campo].motivo.split(':')[0], motivo, `${nombre}: ${x.campos[campo].motivo}`);
      if (FALSOS.some(f => f[0] === nombre)) {
        assert.ok(Object.values(x.campos).every(c => c.estado === 'ambiguo' && c.valor === null), `${nombre}: ningún campo queda confirmado`);
      }
    }
    const adaptador = ADAPTADORES_V2.find(a => a.nombre === 'auswaertiges-amt-visumpflicht');
    assert.ok(adaptador, 'registrado en adaptadores 2.0');

    // ---- 2. Entrada explícita y construcción ----
    const [objetivo] = A.validarEntrada(ENTRADA);
    assert.deepEqual([objetivo.codigo_iso, objetivo.pais, objetivo.perfil.nombre], ['DE', 'Alemania', 'auswaertiges-amt-alemania']);
    for (const [nombre, entrada] of [
      ['país distinto del perfil', { ...ENTRADA, destinos: [{ ...ENTRADA.destinos[0], pais: 'Deutschland' }] }],
      ['ISO en minúsculas', { ...ENTRADA, destinos: [{ ...ENTRADA.destinos[0], codigo_iso: 'de' }] }],
      ['ISO de otro destino', { ...ENTRADA, destinos: [{ ...ENTRADA.destinos[0], codigo_iso: 'AT' }] }],
      ['perfil desconocido', { ...ENTRADA, destinos: [{ ...ENTRADA.destinos[0], perfil_alta: 'descubrir-todo' }] }],
      ['repetido', { ...ENTRADA, destinos: [ENTRADA.destinos[0], ENTRADA.destinos[0]] }],
      ['clave extra', { ...ENTRADA, destinos: [{ ...ENTRADA.destinos[0], requisitos: [] }] }],
      ['sin destinos', { ...ENTRADA, destinos: [] }],
      ['versión', { ...ENTRADA, version: 'v0' }]
    ]) assert.throws(() => A.validarEntrada(entrada), A.ErrorEntradaAltas, nombre);

    const l1 = await adaptador.leer({ fetch: async () => okHtml(LISTA)(), ahora: () => new Date('2026-11-22T12:00:00.000Z') });
    const doc = await A.construirDestino(objetivo, l1, { hoy: '2026-11-22', ahora: new Date('2026-11-22T12:00:00.000Z') });
    assert.deepEqual(doc.requisitos.map(r => [r.tipo, r.obligatorio, r.estado]), [['visa', 'no', 'confirmado'], ['formulario_digital', 'verificar', 'verificar'], ['vacuna', 'verificar', 'verificar'],
      ['validez_pasaporte', 'verificar', 'verificar'], ['tasa_aeropuerto', 'verificar', 'verificar'], ['documentacion_menor', 'verificar', 'verificar']]);
    assert.deepEqual([doc.requisitos[0].fuente, doc.requisitos[0].fecha_verificacion], [F.URL_LISTA, '2026-11-22']);
    assert.match(doc.requisitos[0].descripcion, /pasaporte nacional uruguayo .* hasta 90 días dentro de cualquier período de 180 días, sin actividad remunerada/);
    assert.ok(doc.requisitos.slice(1).every(r => !('fuente' in r) && !('fecha_verificacion' in r) && !('link' in r)), 'lo no confirmado no lleva fuente ni fecha');
    for (const r of doc.requisitos) capturarIdentidadEInstantanea(r);
    const docJa = await A.construirDestino(objetivo, await adaptador.leer({ fetch: async () => okHtml(LISTA_JA)() }), { hoy: '2026-11-22', ahora: new Date() });
    assert.equal(docJa.requisitos[0].obligatorio, 'si');
    // Un perfil que construyera algo fuera del contrato actual se rechaza antes de escribir.
    const roto = { ...objetivo, perfil: { ...objetivo.perfil, construirRequisitos: h => [{ ...objetivo.perfil.construirRequisitos(h, { hoy: '2026-11-22' })[0], obligatorio: 'quizas' }] } };
    await assert.rejects(A.construirDestino(roto, l1, { hoy: '2026-11-22', ahora: new Date() }), /contrato 2\.0|no cumple el modelo/);
    const sinFuente = { ...objetivo, perfil: { ...objetivo.perfil, construirRequisitos: h => { const { fuente, ...visa } = objetivo.perfil.construirRequisitos(h, { hoy: '2026-11-22' })[0]; return [visa]; } } };
    await assert.rejects(A.construirDestino(sinFuente, l1, { hoy: '2026-11-22', ahora: new Date() }), /no cumple el modelo \(requisitos\.0\.fuente\)/, 'confirmado exige fuente');

    // ---- 3. Plan de índices ----
    const destinosIdx = [{ name: '_id_', key: { _id: 1 } }, { name: 'pais_1', key: { pais: 1 }, unique: true }, { name: 'codigo_iso_1', key: { codigo_iso: 1 }, unique: true }];
    assert.deepEqual(IDX.planificar({ destinos: destinosIdx }).map(p => [p.coleccion, p.nombre, p.accion]),
      [['destinos', 'codigo_iso_1', 'ya_existe'], ['destinos', 'pais_1', 'ya_existe'], ['altas_destino', 'alta_id_1', 'crear'], ['altas_destino', 'uniq_alta_por_codigo_iso', 'crear']], 'reutiliza los índices de destinos');
    assert.equal(IDX.planificar({ destinos: destinosIdx.slice(0, 2) }).find(p => p.nombre === 'codigo_iso_1').accion, 'conflicto', 'nunca crea índices en destinos');
    const plan = []; assert.equal(await IDX.main('plan', {}, l => plan.push(l)), 0);
    assert.equal(plan.filter(l => l.startsWith('crear si falta')).length, 2);

    // ---- 4. Mongo efímero ----
    const { MongoMemoryReplSet } = require('mongodb-memory-server');
    const { crearApp } = require('../app');
    rs = await MongoMemoryReplSet.create({ binary: { version: '8.0.32' }, replSet: { count: 1 } });
    await mongoose.connect(rs.getUri('buscador_alta'), { autoIndex: false, autoCreate: false, monitorCommands: true });
    const conexion = mongoose.connection, col = n => conexion.db.collection(n);
    servidor = await new Promise((ok, mal) => { const s = crearApp({ panel: { registrar: () => {} } }).listen(0, '127.0.0.1', () => ok(s)); s.on('error', mal); });
    const api = async () => { const r = await globalThis.fetch(`http://127.0.0.1:${servidor.address().port}/api/destinos`); assert.equal(r.status, 200); return r.json(); };
    const indicesAlta = async () => { for (const s of A.INDICES_ALTA) await col(s.coleccion).createIndex(s.clave, { name: s.nombre, unique: true }); };
    const indicesCiclo = async () => {
      for (const s of new Map([...INDICES_DECISION, ...INDICES_APLICACION, V2.INDICE_TRANSVERSAL].map(x => [`${x.coleccion}/${x.nombre}`, x])).values()) {
        await col(s.coleccion).createIndex(s.clave, { name: s.nombre, unique: true, ...(s.partialFilterExpression ? { partialFilterExpression: s.partialFilterExpression } : {}) });
      }
    };
    const CO = { _id: new ObjectId(), tipo: 'formulario_digital', nombre: 'Check-Mig', obligatorio: 'no', descripcion: 'Prerregistro migratorio en línea para el ingreso y la salida de Colombia.',
      fuente: URL_FICHA, link: 'https://apps.migracioncolombia.gov.co/pre-registro/', fecha_verificacion: '2026-11-17', estado: 'confirmado' };
    const sembrar = async ({ altas = true } = {}) => {
      await conexion.db.dropDatabase();
      await col('destinos').createIndex({ codigo_iso: 1 }, { unique: true }); await col('destinos').createIndex({ pais: 1 }, { unique: true });
      if (altas) await indicesAlta();
      await indicesCiclo();
      await col('destinos').insertMany([{ pais: 'Colombia', codigo_iso: 'CO', requisitos: [CO] }, { pais: 'Austria', codigo_iso: 'AT', requisitos: [] }]);
    };
    let cola = [];
    const fuente = async () => { if (!cola.length) throw new Error('consulta no esperada a la fuente'); return cola.shift()(); };
    const OPS = JSON.stringify([{ usuario_atlas: 'ciclo-proceso', db: 'admin', identificador: 'proceso.ciclo' }]);
    const aut = politica => ({ politica, autorizada_por: 'persona.autorizante', autorizada_en: new Date(Date.now() - 60_000).toISOString(), vence_en: new Date(Date.now() + 86_400_000).toISOString() });
    const env = a => ({ MONGODB_URI_CICLO: 'mongodb+srv://ciclo:SECRETO@ejemplo.invalid/x', OPERADORES_AUTORIZADOS_JSON: OPS, ...(a ? { CICLO_V2_AUTORIZACION_JSON: JSON.stringify(a) } : {}) });
    const CO_AUT = aut('checkmig-colombia-obligatoriedad@1'), DE_ALTA = aut('alta-auswaertiges-amt-alemania@1'), DE_MANT = aut('auswaertiges-amt-alemania-visa@1');
    const resumen = [];
    const alta = async (e, respuestas) => {
      cola = [...respuestas];
      const lineas = [];
      const codigo = await ALTA.ejecutarReal(e, l => lineas.push(l), { conexion, usuariosAutenticados: async () => [{ user: 'ciclo-proceso', db: 'admin' }], fetch: fuente, uuid: () => crypto.randomUUID(), resumen: l => resumen.push(l) });
      assert.equal(cola.length, 0, 'respuestas sin consumir');
      assert.ok(!/SECRETO|mongodb\+srv/.test(lineas.join('\n')));
      const regs = lineas.filter(l => l.startsWith('REGISTRO_ALTA ')).map(l => JSON.parse(l.slice('REGISTRO_ALTA '.length)));
      assert.equal(regs.length, 1);
      return { codigo, registro: regs[0], lineas };
    };
    const huella = async () => JSON.stringify(await Promise.all(['destinos', 'altas_destino', 'propuestas_cambio', 'historial_cambios'].map(n => col(n).find({}).sort({ _id: 1 }).toArray())));

    // Informe (sin la política de alta, solo la de Colombia): construye y compara, no escribe.
    await sembrar();
    let h = await huella();
    const inf = await alta(env(CO_AUT), [okHtml(LISTA), okHtml(LISTA)]);
    assert.deepEqual([inf.codigo, inf.registro.modo, inf.registro.resultado, inf.registro.motivo_sin_politica, inf.registro.lecturas.length],
      [2, 'informe', 'alta_aplicable', 'CICLO_V2_AUTORIZACION_JSON no incluye alta-auswaertiges-amt-alemania@1', 2]);
    assert.ok(inf.registro.comandos.every(c => CICLO.COMANDOS_INFORME.includes(c)), inf.registro.comandos.join(','));
    assert.equal(await huella(), h, 'informe: nada escrito');

    // D. Fuente ambigua, caída o inestable: nada publicado.
    for (const [nombre, respuestas, codigo, resultado, motivo] of [
      ['fila ausente', [okHtml(SIN_FILA)], 3, 'revision_humana', 'lectura_ambigua'],
      ['condición particular', [okHtml(con('<tr><td>Uruguay</td><td>Nein (1, 5)</td></tr>'))], 3, 'revision_humana', 'lectura_ambigua'],
      ['caída', [caida], 4, 'fuente_no_disponible', 'http_503'],
      ['segunda lectura caída', [okHtml(LISTA), caida], 4, 'fuente_no_disponible', 'http_503'],
      ['las dos lecturas difieren', [okHtml(LISTA), okHtml(LISTA_JA)], 3, 'revision_humana', 'cambio_no_confirmado']
    ]) {
      const r = await alta(env([CO_AUT, DE_ALTA]), respuestas);
      assert.deepEqual([r.codigo, r.registro.resultado, r.registro.motivo], [codigo, resultado, motivo], nombre);
    }
    // Regresión: con las condiciones no admitidas el alta no se crea (dos respuestas iguales disponibles).
    for (const [nombre, h] of FALSOS) {
      cola = [okHtml(h), okHtml(h)];
      const lineas = [];
      const codigo = await ALTA.ejecutarReal(env([CO_AUT, DE_ALTA]), l => lineas.push(l), { conexion, usuariosAutenticados: async () => [{ user: 'ciclo-proceso', db: 'admin' }], fetch: fuente, uuid: () => crypto.randomUUID() });
      const g = JSON.parse(lineas.find(l => l.startsWith('REGISTRO_ALTA ')).slice('REGISTRO_ALTA '.length));
      assert.deepEqual([codigo, g.resultado, g.motivo], [3, 'revision_humana', 'lectura_ambigua'], nombre);
    }
    assert.equal(await huella(), h, 'D: cero escrituras');
    assert.ok(!(await api()).some(d => d.codigo_iso === 'DE'));

    // Sin los índices de altas_destino: con política, error antes de escribir.
    await sembrar({ altas: false });
    h = await huella();
    const sinIdx = await alta(env([DE_ALTA]), [okHtml(LISTA), okHtml(LISTA)]);
    assert.deepEqual([sinIdx.codigo, sinIdx.registro.resultado], [1, 'error']);
    assert.match(sinIdx.registro.error, /falta altas_destino\.alta_id_1/);
    assert.equal(await huella(), h);

    // B. Destino ausente → alta → visible en la API pública.
    await sembrar();
    const b = await alta(env([CO_AUT, DE_ALTA]), [okHtml(LISTA), okHtml(LISTA)]);
    assert.deepEqual([b.codigo, b.registro.modo, b.registro.resultado, b.registro.requisitos_confirmados, b.registro.requisitos_a_verificar.length, b.registro.politica.nombre],
      [0, 'politica_automatica', 'creado', ['visa'], 5, 'alta-auswaertiges-amt-alemania@1'], b.lineas.join('\n'));
    const de = (await api()).find(d => d.codigo_iso === 'DE');
    assert.equal(de.pais, 'Alemania');
    assert.equal(de.requisitos.length, 6);
    const hoy = fechaMontevideo(new Date());
    assert.deepEqual([de.requisitos[0].tipo, de.requisitos[0].obligatorio, de.requisitos[0].estado, de.requisitos[0].fuente, String(de.requisitos[0].fecha_verificacion).slice(0, 10)],
      ['visa', 'no', 'confirmado', F.URL_LISTA, hoy]);
    assert.ok(de.requisitos.slice(1).every(r => r.estado === 'verificar' && r.obligatorio === 'verificar' && r.fuente === undefined));
    const reg = await col('altas_destino').findOne({ alta_id: b.registro.alta_id });
    assert.deepEqual([reg.codigo_iso, reg.resultado, reg.destino_id.toHexString(), reg.proceso.usuario_atlas, reg.autorizacion.autorizada_por, reg.fuente.url, reg.fuente.lecturas.length, reg.fuente.hechos.visa_requerida, reg.contexto_viajero.nacionalidad],
      ['DE', 'creado', b.registro.destino_id, 'ciclo-proceso', 'persona.autorizante', F.URL_LISTA, 2, 'no', 'UY']);
    assert.match(resumen.at(-1), /^\| alta auswaertiges-amt-alemania \| DE \| politica_automatica \| creado \| 0 \| HTTP 200, HTTP 200 \| ALTA CREADA: /);

    // C. Repetir: ya existe, sin consultar la fuente ni escribir.
    h = await huella();
    const c1 = await alta(env([CO_AUT, DE_ALTA]), []);
    assert.deepEqual([c1.codigo, c1.registro.resultado, c1.registro.alta_id, c1.registro.lecturas.length], [0, 'ya_existe', b.registro.alta_id, 0]);
    assert.equal(await huella(), h);
    assert.deepEqual([await col('destinos').countDocuments({ codigo_iso: 'DE' }), await col('altas_destino').countDocuments()], [1, 1]);

    // Mismo país: mantenimiento de la visa de DE con el ciclo compartido (perfil del mismo adaptador).
    const ciclo = async (perfil, e, respuestas) => {
      cola = [...respuestas];
      const lineas = [];
      const codigo = await CICLO.ejecutarReal(e, l => lineas.push(l), { conexion, usuariosAutenticados: async () => [{ user: 'ciclo-proceso', db: 'admin' }], fetch: fuente, uuid: () => crypto.randomUUID() }, { perfil });
      assert.equal(cola.length, 0);
      return { codigo, registro: JSON.parse(lineas.find(l => l.startsWith('REGISTRO_EJECUCION ')).slice('REGISTRO_EJECUCION '.length)) };
    };
    const todas = env([CO_AUT, DE_ALTA, DE_MANT]);
    const m1 = await ciclo('auswaertiges-amt-de-visa', todas, [okHtml(LISTA)]);
    assert.deepEqual([m1.codigo, m1.registro.resultado, m1.registro.fecha_verificacion.efecto], [0, 'sin_cambio', 'no_se_renueva']);
    // La fuente pasa a «Ja»: la descripción publicada dice «No requiere visa» → revisión humana, sin escribir.
    const m2 = await ciclo('auswaertiges-amt-de-visa', todas, [okHtml(LISTA_JA)]);
    assert.deepEqual([m2.codigo, m2.registro.resultado, m2.registro.motivo], [3, 'revision_humana', 'descripcion_contradice']);
    assert.equal(await huella(), h, 'mantenimiento: nada escrito');

    // E. Colombia con la autorización en lista que incluye políticas de alta y de DE.
    const co = await ciclo('checkmig-colombia', todas, [okHtml(FICHA_CO)]);
    assert.deepEqual([co.codigo, co.registro.modo, co.registro.resultado], [0, 'politica_automatica', 'sin_cambio']);

    // Regresión de mantenimiento: visa de DE guardada como 'si' con una descripción neutra, política vigente.
    // Las condiciones no admitidas no aplican nada; un «Nein (1)» claro sí (control positivo).
    await col('destinos').updateOne({ codigo_iso: 'DE' }, { $set: { 'requisitos.0.obligatorio': 'si', 'requisitos.0.descripcion': 'Visado según la lista oficial del Auswärtiges Amt.' } });
    const hm = await huella();
    for (const [nombre, h] of FALSOS) {
      cola = [okHtml(h), okHtml(h)];
      const lineas = [];
      const codigo = await CICLO.ejecutarReal(todas, l => lineas.push(l), { conexion, usuariosAutenticados: async () => [{ user: 'ciclo-proceso', db: 'admin' }], fetch: fuente, uuid: () => crypto.randomUUID() }, { perfil: 'auswaertiges-amt-de-visa' });
      const g = JSON.parse(lineas.find(l => l.startsWith('REGISTRO_EJECUCION ')).slice('REGISTRO_EJECUCION '.length));
      assert.deepEqual([codigo, g.resultado, g.motivo], [3, 'revision_humana', 'lectura_ambigua'], `mantenimiento: ${nombre}`);
    }
    assert.equal(await huella(), hm, 'mantenimiento con condiciones no admitidas: nada escrito');
    const positivo = await ciclo('auswaertiges-amt-de-visa', todas, [okHtml(LISTA), okHtml(LISTA)]);
    assert.deepEqual([positivo.codigo, positivo.registro.resultado, positivo.registro.valor_aplicado], [0, 'exito', 'no'], 'control positivo: «Nein (1)» claro se aplica');
    assert.equal((await api()).find(d => d.codigo_iso === 'DE').requisitos[0].obligatorio, 'no');

    // C. Concurrencia: dos altas simultáneas crean un solo destino y un solo registro.
    await sembrar();
    const ctx = { conexion, fetch: async () => okHtml(LISTA)(), ahora: () => new Date(), uuid: () => crypto.randomUUID(), politicaHabilitada: true,
      identidad: { politica: DE_ALTA.politica, autorizada_por: 'persona.autorizante', autorizada_en: DE_ALTA.autorizada_en, vence_en: DE_ALTA.vence_en, proceso: 'proceso.ciclo', usuario_atlas: 'ciclo-proceso', db_autenticacion: 'admin' } };
    const rr = await Promise.all([A.ejecutarAlta(objetivo, ctx), A.ejecutarAlta(objetivo, ctx), A.ejecutarAlta(objetivo, ctx)]);
    const res = rr.map(r => r.resultado).sort();
    assert.deepEqual([res.filter(r => r === 'creado').length, res.filter(r => r === 'ya_existe').length], [1, 2], res.join(','));
    assert.deepEqual([await col('destinos').countDocuments({ codigo_iso: 'DE' }), await col('altas_destino').countDocuments()], [1, 1]);
    // Un destino existente cargado a mano (sin alta) tampoco se duplica.
    await sembrar();
    await col('destinos').insertOne({ pais: 'Alemania', codigo_iso: 'DE', requisitos: [] });
    const manual = await A.ejecutarAlta(objetivo, ctx);
    assert.deepEqual([manual.resultado, manual.alta_id], ['ya_existe', null]);

    // --simular con el extracto: sin base ni red.
    const sim = spawnSync(process.execPath, ['--require', path.join(__dirname, 'preload-solo-loopback.js'), path.join(__dirname, 'alta-destinos-v1.js'), '--simular', '--html', FX], { encoding: 'utf8', timeout: 60000 });
    assert.equal(sim.status, 0, sim.stdout + sim.stderr);
    assert.match(sim.stdout, /RESULTADO: alta_aplicable[\s\S]*visa: obligatorio=no estado=confirmado/);
    assert.match(sim.stderr + sim.stdout, /SOLO-LOOPBACK permitidos=0 destinos=\[\] bloqueados=0/);
    const ayuda = spawnSync(process.execPath, ['--require', path.join(__dirname, 'preload-solo-loopback.js'), path.join(__dirname, 'alta-destinos-v1.js'), '--borrar'], { encoding: 'utf8', timeout: 60000 });
    assert.equal(ayuda.status, 1);

    assert.equal(globalThis.__SOLO_LOOPBACK__.bloqueados.length, 0, 'ninguna conexión externa');
    process.exitCode = 0;
    console.log(`Alta DE: extracción, entrada explícita, contrato, índices, informe, B/C/D/E, concurrencia (${res.join(' + ')}) y mantenimiento del mismo país en Mongo efímero: OK`);
  } catch (err) {
    process.exitCode = 1;
    console.error(err);
  } finally {
    if (servidor) await new Promise(ok => servidor.close(ok));
    await mongoose.disconnect().catch(() => {});
    if (rs) await rs.stop().catch(() => {});
  }
})();
