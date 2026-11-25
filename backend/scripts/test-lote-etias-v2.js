// Lote ETIAS (Comisión Europea) para «ETIAS (Schengen)» de AT, HR, FI, FR, IT y PT:
//  1. Extracción determinista: fixture real y mutaciones (inicio anunciado, fechas, redacción, condiciones
//     fuera de <p>, bloque repetido o sin cierre).
//  2. Adaptador: hechos, caída y redirección sin lanzar; compatibilidad disjunta con los demás.
//  3. Perfiles: verificar → confirmado con el requisito completo; sin cambio sin renovar la fecha;
//     campos sin respaldo; los perfiles anteriores siguen exigiendo 'confirmado'.
//  4. Autorizaciones: solo comision-europea-etias-uy@1 habilita el lote.
//  5. Mongo efímero + GET /api/destinos: fuente → clasificación → aplicación → API; repetición sin
//     escrituras; ambigua/caída/condición nueva sin publicar; reintento tras caída; regresión.
// Nada toca Atlas ni la red (preload solo-loopback). exitCode = 1 hasta la última aserción.
const assert = require('node:assert/strict');
if (!globalThis.__SOLO_LOOPBACK__) throw new Error('Se requiere preload-solo-loopback');
process.exitCode = 1;
const path = require('node:path');
const crypto = require('node:crypto');
const { readFileSync } = require('node:fs');
const mongoose = require('../config/mongoose');
const { ObjectId } = require('mongodb');
const FE = require('../services/propuestas/fuentes/comision-europea-etias');
const FI = require('../services/propuestas/fuentes/embajada-italia-montevideo-visas');
const { URL_FICHA } = require('../services/propuestas/fuentes/migracion-colombia-checkmig');
const adE = require('../services/propuestas/adaptadores/v2/comision-europea-etias');
const { ADAPTADORES_V2, elegirAdaptadorV2 } = require('../services/propuestas/adaptadores/v2');
const ciclo = require('../services/propuestas/ciclo/ciclo-revalidacion-v2');
const E = require('../services/propuestas/ciclo/perfiles-etias-schengen');
const PI = require('../services/propuestas/ciclo/perfiles-procedencia-gb-it');
const { PERFILES, clavePolitica } = require('../services/propuestas/ciclo/perfiles');
const R = require('../services/propuestas/ciclo/config-ciclo-real');
const V2 = require('../services/propuestas/aplicar-propuesta-v2');
const { INDICES_DECISION, INDICES_APLICACION } = require('../services/propuestas/indices-propuestas');
const { fechaMontevideo } = require('../services/propuestas/plan-aplicacion-requisito-v2');
const CLI = require('./ciclo-checkmig-v2');

const fx = (...p) => readFileSync(path.join(__dirname, 'fixtures', ...p), 'utf8').replace(/\r\n/g, '\n');
const ET = fx('comision-europea-etias', 'extracto-etias-2026-11-24.html');
const PUB = JSON.parse(fx('comision-europea-etias', 'registro-publicado-etias-2026-11-24.json'));
const IT = fx('embajada-italia-montevideo', 'extracto-visas-2026-11-23.html');
const PUB_IT = JSON.parse(fx('embajada-italia-montevideo', 'registro-publicado-it-2026-11-23.json'));
const FICHA_CO = fx('checkmig', 'valida.html');
const okHtml = h => () => new Response(h, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
const caida = () => new Response('x', { status: 503, headers: { 'content-type': 'text/html' } });
const T0 = new Date('2026-11-24T12:00:00.000Z');
const leer = (f, a = adE) => a.leer({ fetch: async () => f(), ahora: () => T0 });
const AVISO = 'The European Travel Information and Authorisation System (ETIAS) is currently not in operation and no applications for travel authorisations are collected at this point.';
const ETU = FE.URL_PAGINA, ITU = FI.URL_PAGINA;
const enAviso = extra => ET.replace('</li></ul><h2>What is ETIAS</h2>', `</li>${extra}</ul><h2>What is ETIAS</h2>`);
const reqPub = iso => PUB.requisitos.find(x => x.destino.codigo_iso === iso);

(async () => {
  let rs, servidor;
  try {
    // ---- 1. Extracción ----
    const e0 = FE.extraer(ET);
    assert.deepEqual([e0.estado, e0.campos.etias.valor], ['ok', { en_funcionamiento: 'no', paises: 30, estancia_dias: 90, periodo_dias: 180 }]);
    assert.ok(e0.campos.etias.evidencia[0].startsWith(AVISO), 'evidencia: el aviso oficial');
    assert.equal(FE.extraer(ET.replace('for up to 90 days within any 180-day period', 'for up to 60 days within any 180-day period')).campos.etias.valor.estancia_dias, 60, 'la duración se captura, no se supone');
    const MUT = [
      ['ya funciona', ET.replace('is currently not in operation and no applications for travel authorisations are collected at this point', 'is in operation and applications are collected'), 'no_reconocido'],
      ['aviso con fecha', ET.replace('several months prior to its launch.', 'several months prior to its launch. ETIAS will start operations on 1 May 2027.'), 'no_reconocido'],
      ['sin aviso', ET.replace(/<li>The <a[\s\S]*?prior to its launch\.<\/li>/, ''), 'sin_evidencia'],
      ['aviso repetido', enAviso(`<li>${AVISO} The European Union will inform about the specific date for the start of ETIAS several months prior to its launch.</li>`), 'sin_evidencia'],
      ['fecha anunciada en otro punto', enAviso('<li>ETIAS will start operations in the last quarter of 2027.</li>'), 'condicionada'],
      ['obligatoriedad en un div', enAviso('<li><div>Travellers must hold a valid ETIAS travel authorisation.</div></li>'), 'condicionada'],
      ['fecha como texto suelto', ET.replace('<h2>Background</h2>', 'From 1 May 2027 an ETIAS will be mandatory.<h2>Background</h2>'), 'condicionada'],
      ['tasa distinta (texto conocido cambiado)', ET.replace('EUR 20 instead of the previous EUR 7', 'EUR 25 instead of the previous EUR 7'), 'condicionada'],
      ['sin definición de estadía corta', ET.replace(/<p><a[^>]*>ETIAS<\/a> is a new travel requirement[\s\S]*?<\/p>/, ''), 'sin_evidencia'],
      ['dos bloques de aviso', ET.replace('</main>', '<div class="ecl"><h2>Important notice</h2></div></main>'), 'sin_evidencia'],
      ['sin bloque de aviso', ET.replace('<h2>Important notice</h2>', '<h2>Notice</h2>'), 'sin_evidencia'],
      ['dos <main>', ET.replace('</main>', '</main><main></main>'), 'sin_evidencia'],
      ['bloque sin cierre', ET.replace(/<\/div>\s*<\/main>/, '</main>'), 'no_reconocido'],
      // Revisión Codex: texto no validado dentro del párrafo de definición (antes daba ok) y fuera del bloque.
      ['obligatoriedad al comienzo del resto de la definición', ET.replace('It aims to identify', 'ETIAS will become mandatory on 1 May 2027. It aims to identify'), 'condicionada'],
      ['inicio en medio de la definición', ET.replace('while respecting', 'from 2027 onwards, while respecting'), 'condicionada'],
      ['fecha al final de la definición', ET.replace('who do not pose such risks.</p>', 'who do not pose such risks. Operations start in 2027.</p>'), 'condicionada'],
      ['obligatoriedad al final de la definición', ET.replace('who do not pose such risks.</p>', 'who do not pose such risks. Travellers must apply before departure.</p>'), 'condicionada'],
      ['inicio anunciado fuera del bloque', ET.replace('<h1>ETIAS</h1>', '<h1>ETIAS</h1><p>ETIAS will start operations on 1 May 2027.</p>'), 'condicionada'],
      ['aviso duplicado fuera del bloque', ET.replace('<h1>ETIAS</h1>', `<h1>ETIAS</h1><p>${AVISO} The European Union will inform about the specific date for the start of ETIAS several months prior to its launch.</p>`), 'sin_evidencia'],
      ['definición repetida con otra duración', ET.replace('<h1>ETIAS</h1>', '<h1>ETIAS</h1><p>ETIAS is a new travel requirement for visa-free travellers visiting 30 European countries for a short stay (i.e. for up to 60 days within any 180-day period). See below.</p>'), 'sin_evidencia']
    ];
    for (const [nombre, h] of MUT.slice(-7)) assert.notEqual(h, ET, `${nombre}: la mutación se aplicó`);
    for (const [nombre, h, motivo] of MUT) {
      const x = FE.extraer(h);
      assert.equal(x.estado, 'ambiguo', nombre);
      assert.equal(x.campos.etias.motivo.split(':')[0], motivo, `${nombre}: ${x.campos.etias.motivo}`);
    }

    // ---- 2. Adaptador ----
    const le = await leer(okHtml(ET));
    assert.deepEqual([le.tipo, le.url, le.fuente_nombre, le.hechos.etias_en_funcionamiento, le.hechos.solicitudes, le.hechos.fecha_inicio, le.hechos.estancia_corta],
      ['hechos', ETU, FE.FUENTE_NOMBRE, 'no', 'no_se_reciben', 'sin_anunciar', { dias: 90, periodo_dias: 180 }]);
    assert.deepEqual([(await leer(caida)).tipo, (await leer(caida)).motivo], ['no_disponible', 'http_503']);
    assert.equal((await leer(() => new Response(null, { status: 302, headers: { location: 'https://ejemplo.invalid/' } }))).motivo, 'redireccion_fuera_del_sitio');
    assert.equal((await leer(okHtml(MUT[4][1]))).tipo, 'ambiguo');
    assert.ok(ADAPTADORES_V2.includes(adE));
    const prop = l => ({ payload: { version_contrato: '2.0', campo: 'requisito', fuentes: [{ nombre: l.fuente_nombre, url: l.url, algoritmo_hechos_hash: l.algoritmo_hechos_hash, hechos: l.hechos, hechos_hash: l.hechos_hash }] } });
    assert.equal(elegirAdaptadorV2(prop(le)), adE);
    const li = await leer(okHtml(IT), require('../services/propuestas/adaptadores/v2/embajada-italia-montevideo'));
    assert.equal(adE.compatibilidad(prop(li)).codigo, 'fuente_no_soportada', 'compatibilidad disjunta');
    assert.equal(adE.compatibilidad(prop({ ...le, hechos: { ...le.hechos, fecha_inicio: '2027-05-01' } })).codigo, 'hechos_guardados_no_canonicos');

    // ---- 3. Perfiles ----
    const HOY = fechaMontevideo(T0);
    assert.deepEqual(E.PERFILES_ETIAS.map(p => p.destino.codigo_iso), ['AT', 'HR', 'FI', 'FR', 'IT', 'PT']);
    assert.ok(E.PERFILES_ETIAS.every(p => PERFILES.includes(p) && clavePolitica(p) === 'comision-europea-etias-uy@1'));
    const desc = E.descripcionEtias(le.hechos);
    assert.equal(desc, 'A la fecha de verificación indicada, según la Comisión Europea, el ETIAS todavía no está en funcionamiento y no recibe solicitudes, por lo que no había que tramitarlo. No es una exención permanente: el ETIAS es un requisito previsto para los viajeros exentos de visa en estadías cortas (hasta 90 días en cualquier período de 180 días), y la Unión Europea anunciará la fecha de inicio con varios meses de antelación. Para viajes futuros, consultar la información oficial actualizada.', 'descripción canónica exacta');
    assert.ok(!/2027|2026|obligatorio para uruguayos/.test(desc), 'sin la fecha estimada ni la afirmación que la fuente no da');
    for (const p of E.PERFILES_ETIAS) {
      const r = ciclo.clasificar(reqPub(p.destino.codigo_iso).requisito, le, p, { hoy: HOY });
      assert.deepEqual([r.accion, r.tipo_cambio, r.cambios.map(c => [c.campo, c.propuesto.valor]), r.observaciones.map(o => o.codigo), r.fecha_verificacion.efecto],
        ['cambio_aplicable', 'procedencia', [['descripcion', desc], ['fuente', ETU], ['estado', 'confirmado']], ['cambio_de_procedencia', 'descripcion_reemplazada'], 'se_fija_al_aplicar'], p.nombre);
    }
    const [pAT] = E.PERFILES_ETIAS, rAT = reqPub('AT').requisito;
    const cl = (req, l = le) => ciclo.clasificar(req, l, pAT, { hoy: HOY });
    const canon = { ...rAT, descripcion: desc, fuente: ETU, estado: 'confirmado' };
    assert.deepEqual([cl(canon).accion, cl(canon).fecha_verificacion.efecto], ['sin_cambio', 'no_se_renueva']);
    assert.equal(cl({ ...rAT, link: 'https://travel-europe.europa.eu/etias_en' }).motivo, 'campos_sin_respaldo');
    assert.equal(cl({ ...rAT, costo: 'EUR 20' }).motivo, 'campos_sin_respaldo');
    assert.equal(cl({ ...rAT, estado: 'pendiente' }).motivo, 'estado_no_confirmado');
    assert.deepEqual([cl({ ...canon, obligatorio: 'si' }).accion, cl({ ...canon, obligatorio: 'si' }).tipo_cambio], ['cambio_aplicable', 'valor']);
    assert.equal(cl({ ...rAT, nombre: 'ETIAS' }).motivo, 'requisito_fuera_de_perfil');
    assert.equal(cl(rAT, await leer(okHtml(MUT[4][1]))).motivo, 'lectura_ambigua');
    assert.equal(cl(rAT, await leer(caida)).accion, 'fuente_no_disponible');
    assert.equal(cl(rAT, li).motivo, 'sin_evidencia_confirmada', 'otra fuente no respalda el ETIAS');
    // Los perfiles de procedencia anteriores siguen exigiendo 'confirmado' y no tocan el estado.
    assert.deepEqual([PI.itVisa.estados_admitidos, PI.itVisa.campos_autorizados], [['confirmado'], ['obligatorio', 'descripcion', 'fuente']]);
    assert.equal(ciclo.clasificar({ ...PUB_IT.visa, estado: 'verificar' }, li, PI.itVisa, { hoy: HOY }).motivo, 'estado_no_confirmado');

    // ---- 4. Autorizaciones ----
    const OPS = JSON.stringify([{ usuario_atlas: 'ciclo-proceso', db: 'admin', identificador: 'proceso.ciclo' }]);
    const env = lista => ({ MONGODB_URI_CICLO: 'mongodb+srv://ciclo:SECRETO@ejemplo.invalid/x', OPERADORES_AUTORIZADOS_JSON: OPS, ...(lista ? { CICLO_V2_AUTORIZACION_JSON: JSON.stringify(lista) } : {}) });
    const aut = politica => ({ politica, autorizada_por: 'persona.autorizante', autorizada_en: new Date(Date.now() - 60_000).toISOString(), vence_en: new Date(Date.now() + 86_400_000).toISOString() });
    const VIGENTES = ['checkmig-colombia-obligatoriedad@1', 'govuk-reino-unido-turismo-uy@1', 'auswaertiges-amt-alemania-visa@1', 'alta-auswaertiges-amt-alemania@1',
      'govuk-gb-pasaporte-uy@1', 'embajada-italia-it-visa-uy@1', 'embajada-italia-it-pasaporte-uy@1'].map(aut);
    const conVigentes = env(VIGENTES), conLote = env([...VIGENTES, aut('comision-europea-etias-uy@1')]);
    for (const p of E.PERFILES_ETIAS) {
      assert.deepEqual([R.cargarConfigCicloReal(conVigentes, new Date(), { perfil: p.nombre }).politica_habilitada, R.cargarConfigCicloReal(conLote, new Date(), { perfil: p.nombre }).politica_habilitada], [false, true], p.nombre);
    }
    assert.equal(R.cargarConfigCicloReal(env([aut('comision-europea-etias-uy@1')]), new Date(), { perfil: 'embajada-it-visa' }).politica_habilitada, false, 'la política ETIAS no habilita otro requisito de IT');

    // ---- 5. Mongo efímero ----
    const { MongoMemoryReplSet } = require('mongodb-memory-server');
    const { crearApp } = require('../app');
    rs = await MongoMemoryReplSet.create({ binary: { version: '8.0.32' }, replSet: { count: 1 } });
    await mongoose.connect(rs.getUri('buscador_lote_etias'), { autoIndex: false, autoCreate: false, monitorCommands: true });
    const conexion = mongoose.connection, col = n => conexion.db.collection(n);
    servidor = await new Promise((ok, mal) => { const s = crearApp({ panel: { registrar: () => {} } }).listen(0, '127.0.0.1', () => ok(s)); s.on('error', mal); });
    const api = async () => { const r = await globalThis.fetch(`http://127.0.0.1:${servidor.address().port}/api/destinos`); assert.equal(r.status, 200); return r.json(); };
    const reqApi = async (iso, tipo, nombre) => (await api()).find(d => d.codigo_iso === iso).requisitos.find(r => r.tipo === tipo && (nombre === undefined || r.nombre === nombre));
    const etiasApi = iso => reqApi(iso, 'formulario_digital', E.NOMBRE_REQUISITO);
    // La API serializa la fecha con hora; Atlas guarda el texto AAAA-MM-DD (inspección de solo lectura del 24/11/2026).
    const conId = r => ({ ...r, _id: new ObjectId(r._id), ...(typeof r.fecha_verificacion === 'string' ? { fecha_verificacion: r.fecha_verificacion.slice(0, 10) } : {}) });
    const CO = { _id: new ObjectId(), tipo: 'formulario_digital', nombre: 'Check-Mig', obligatorio: 'no', descripcion: 'Prerregistro migratorio en línea para el ingreso y la salida de Colombia.',
      fuente: URL_FICHA, link: 'https://apps.migracioncolombia.gov.co/pre-registro/', fecha_verificacion: '2026-11-17', estado: 'confirmado' };
    const otroAT = { _id: new ObjectId(), tipo: 'visa', obligatorio: 'no', descripcion: 'No requiere visa.', fuente: 'https://www.iatatravelcentre.com/', fecha_verificacion: new Date('2026-08-20T00:00:00Z'), estado: 'confirmado' };
    const itCanon = { ...conId(PUB_IT.visa), descripcion: PI.descripcionItVisa(li.hechos), fuente: ITU };
    const sembrar = async () => {
      await conexion.db.dropDatabase();
      await col('destinos').createIndex({ codigo_iso: 1 }, { unique: true }); await col('destinos').createIndex({ pais: 1 }, { unique: true });
      for (const s of new Map([...INDICES_DECISION, ...INDICES_APLICACION, V2.INDICE_TRANSVERSAL].map(x => [`${x.coleccion}/${x.nombre}`, x])).values()) {
        await col(s.coleccion).createIndex(s.clave, { name: s.nombre, unique: true, ...(s.partialFilterExpression ? { partialFilterExpression: s.partialFilterExpression } : {}) });
      }
      await col('destinos').insertMany([
        ...PUB.requisitos.map(x => ({ _id: new ObjectId(x.destino._id), pais: x.destino.pais, codigo_iso: x.destino.codigo_iso,
          requisitos: [conId(x.requisito), ...(x.destino.codigo_iso === 'IT' ? [itCanon] : x.destino.codigo_iso === 'AT' ? [otroAT] : [])] })),
        { _id: new ObjectId(), pais: 'Colombia', codigo_iso: 'CO', requisitos: [CO] }
      ]);
    };
    const correr = async (perfil, e, respuestas) => {
      const cola = [...respuestas];
      const lineas = [], resumen = [];
      const codigo = await CLI.ejecutarReal(e, l => lineas.push(l), { conexion, usuariosAutenticados: async () => [{ user: 'ciclo-proceso', db: 'admin' }],
        fetch: async u => { const r = cola.shift(); if (!r) throw new Error(`consulta no esperada a ${u}`); return r(); }, uuid: () => crypto.randomUUID(), resumen: l => resumen.push(l) }, { perfil });
      const reg = lineas.filter(l => l.startsWith('REGISTRO_EJECUCION '));
      assert.equal(reg.length, 1);
      assert.equal(cola.length, 0, `${perfil}: quedaron respuestas sin consumir\n${lineas.join('\n')}`);
      assert.ok(!/SECRETO|mongodb\+srv/.test(lineas.join('\n')), 'sin credenciales en la salida');
      return { codigo, registro: JSON.parse(reg[0].slice('REGISTRO_EJECUCION '.length)), lineas, resumen };
    };
    const huella = async () => JSON.stringify(await Promise.all(['destinos', 'propuestas_cambio', 'eventos_propuesta', 'intentos_aplicacion', 'inicios_intento_aplicacion', 'historial_cambios']
      .map(n => col(n).find({}).sort({ _id: 1 }).toArray())));

    await sembrar();
    let h = await huella();
    // Modo informe: las políticas vigentes no habilitan el lote (exit 2, cero escrituras).
    for (const p of E.PERFILES_ETIAS) {
      const r = await correr(p.nombre, conVigentes, [okHtml(ET)]);
      assert.deepEqual([r.codigo, r.registro.modo, r.registro.resultado, r.registro.motivo, r.registro.tipo_cambio, r.registro.campos_propuestos],
        [2, 'informe', 'cambio_aplicable', 'politica_no_habilitada', 'procedencia', ['descripcion', 'fuente', 'estado']], p.nombre);
    }
    assert.equal(await huella(), h, 'sin su política, el lote no escribe');
    // Con la política: caída, ambigua y condiciones nuevas no publican nada.
    assert.deepEqual((await correr('comision-etias-fr', conLote, [caida])).codigo, 4);
    for (const [nombre, pag] of MUT.filter(m => m[2] !== 'no_reconocido' || m[0] === 'aviso con fecha')) {
      const r = await correr('comision-etias-pt', conLote, [okHtml(pag)]);
      assert.deepEqual([r.codigo, r.registro.resultado, r.registro.motivo], [3, 'revision_humana', 'lectura_ambigua'], nombre);
    }
    assert.equal(await huella(), h, 'caída, ambigua o condición nueva: cero escrituras');

    // Fuente → clasificación → aplicación (detección + revalidación H3.3) → GET /api/destinos.
    const hoy = fechaMontevideo(new Date());
    const otrosAntes = JSON.stringify([await reqApi('IT', 'visa'), await reqApi('AT', 'visa'), await reqApi('CO', 'formulario_digital')]);
    for (const p of E.PERFILES_ETIAS) {
      const r = await correr(p.nombre, conLote, [okHtml(ET), okHtml(ET)]);
      assert.deepEqual([r.codigo, r.registro.modo, r.registro.resultado, r.registro.estado_propuesta, r.registro.politica.nombre, r.registro.objetivo.codigo_iso],
        [0, 'politica_automatica', 'exito', 'aplicada', 'comision-europea-etias-uy@1', p.destino.codigo_iso], r.lineas.join('\n'));
      assert.match(r.resumen[0], /APLICADO: cambio de procedencia \(descripcion, fuente, estado; obligatorio sigue "no"\)/);
      const a = await etiasApi(p.destino.codigo_iso);
      assert.deepEqual([a.obligatorio, a.estado, a.fuente, a.descripcion, String(a.fecha_verificacion).slice(0, 10), a.nombre], ['no', 'confirmado', ETU, desc, hoy, E.NOMBRE_REQUISITO], p.nombre);
      const intento = await col('intentos_aplicacion').findOne({ intento_id: r.registro.intento_id });
      assert.deepEqual([intento.adaptador.nombre, intento.revalidaciones[0].url], ['comision-europea-etias', ETU]);
    }
    assert.equal(JSON.stringify([await reqApi('IT', 'visa'), await reqApi('AT', 'visa'), await reqApi('CO', 'formulario_digital')]), otrosAntes, 'los demás requisitos no se tocan');
    const propuestas = await col('propuestas_cambio').find({}).toArray();
    assert.equal(propuestas.length, 6);
    assert.ok(propuestas.every(p => p.payload.instantanea_anterior.fuente.valor.includes('wikipedia') && p.payload.instantanea_anterior.estado.valor === 'verificar'), 'la auditoría conserva lo anterior');
    assert.deepEqual(propuestas.map(p => p.payload.advertencias), Array(6).fill([]));
    assert.equal(await col('historial_cambios').countDocuments(), 6);

    // Repetición: sin propuestas, eventos ni escrituras nuevas; regresión de perfiles existentes.
    h = await huella();
    for (const p of E.PERFILES_ETIAS) {
      const r = await correr(p.nombre, conLote, [okHtml(ET)]);
      assert.deepEqual([r.codigo, r.registro.resultado, r.registro.fecha_verificacion.efecto], [0, 'sin_cambio', 'no_se_renueva'], p.nombre);
    }
    for (const [perfil, pag] of [['checkmig-colombia', FICHA_CO], ['embajada-it-visa', IT]]) {
      const r = await correr(perfil, conLote, [okHtml(pag)]);
      assert.deepEqual([r.codigo, r.registro.resultado], [0, 'sin_cambio'], `${perfil}: ${r.lineas.join('\n')}`);
    }
    assert.equal(await huella(), h, 'repetición y regresión sin escrituras');
    // El aviso cambia después de aplicar (fecha anunciada): revisión humana, nada se publica.
    const cambio = await correr('comision-etias-hr', conLote, [okHtml(MUT[4][1])]);
    assert.deepEqual([cambio.codigo, cambio.registro.motivo], [3, 'lectura_ambigua']);
    assert.equal(await huella(), h);

    // Caída en la revalidación de H3.3 → la corrida siguiente reintenta la MISMA propuesta y aplica.
    await sembrar();
    const c1 = await correr('comision-etias-fi', conLote, [okHtml(ET), caida]);
    assert.deepEqual([c1.codigo, c1.registro.estado_propuesta, (await etiasApi('FI')).estado], [4, 'aprobada', 'verificar']);
    const c2 = await correr('comision-etias-fi', conLote, [okHtml(ET)]);
    assert.deepEqual([c2.codigo, c2.registro.resultado, c2.registro.propuesta_id, c2.registro.reintento.admitido, (await etiasApi('FI')).estado], [0, 'exito', c1.registro.propuesta_id, true, 'confirmado']);
    assert.equal(await col('propuestas_cambio').countDocuments(), 1);
    // Segunda lectura de H3.3 ambigua: revisión, sin publicar.
    const d1 = await correr('comision-etias-it', conLote, [okHtml(ET), okHtml(MUT[5][1])]);
    assert.deepEqual([d1.codigo, d1.registro.estado_propuesta, (await etiasApi('IT')).estado], [3, 'revision_requerida', 'verificar']);
    // La obligatoriedad aparece recién en la segunda lectura, dentro del párrafo de definición: nada se publica.
    const ptAntes = JSON.stringify(await etiasApi('PT'));
    const d2 = await correr('comision-etias-pt', conLote, [okHtml(ET), okHtml(MUT.find(m => m[0] === 'obligatoriedad al comienzo del resto de la definición')[1])]);
    assert.deepEqual([d2.codigo, d2.registro.resultado, d2.registro.estado_propuesta], [3, 'extraccion_ambigua', 'revision_requerida'], d2.lineas.join('\n'));
    assert.equal(JSON.stringify(await etiasApi('PT')), ptAntes, 'segunda lectura con condición: nada publicado');
    // Caso de Codex en los seis perfiles: primera lectura ambigua y condición en la segunda lectura, sin publicar.
    const CODEX = MUT.find(m => m[0] === 'obligatoriedad al comienzo del resto de la definición')[1];
    await sembrar();
    const publicadoAntes = JSON.stringify(await Promise.all(E.PERFILES_ETIAS.map(p => etiasApi(p.destino.codigo_iso))));
    for (const p of E.PERFILES_ETIAS) {
      const r1 = await correr(p.nombre, conLote, [okHtml(CODEX)]);
      assert.deepEqual([r1.codigo, r1.registro.resultado, r1.registro.motivo, r1.registro.propuesta_id], [3, 'revision_humana', 'lectura_ambigua', null], `${p.nombre}: primera lectura`);
      const r2 = await correr(p.nombre, conLote, [okHtml(ET), okHtml(CODEX)]);
      assert.deepEqual([r2.codigo, r2.registro.resultado, r2.registro.estado_propuesta], [3, 'extraccion_ambigua', 'revision_requerida'], `${p.nombre}: segunda lectura`);
    }
    assert.equal(JSON.stringify(await Promise.all(E.PERFILES_ETIAS.map(p => etiasApi(p.destino.codigo_iso)))), publicadoAntes, 'caso de Codex: ningún cambio publicado en los seis');
    assert.deepEqual([await col('historial_cambios').countDocuments(), await col('propuestas_cambio').countDocuments({ estado: 'revision_requerida' })], [0, 6]);

    assert.equal(globalThis.__SOLO_LOOPBACK__.bloqueados.length, 0, 'ninguna conexión externa');
    process.exitCode = 0;
    console.log('Lote ETIAS 2.0: extracción, adaptador disjunto, perfiles verificar→confirmado, política propia, aplicación → API en 6 destinos, repetición, ambigua/caída/condición nueva, reintento y regresión en Mongo efímero: OK');
  } catch (err) {
    process.exitCode = 1;
    console.error(err);
  } finally {
    if (servidor) await new Promise(ok => servidor.close(ok));
    await mongoose.disconnect().catch(() => {});
    if (rs) await rs.stop().catch(() => {});
  }
})();
