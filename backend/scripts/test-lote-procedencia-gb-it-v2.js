// Lote de procedencia IATA → fuente oficial (GB validez_pasaporte, IT visa, IT validez_pasaporte):
//  1. Extracción determinista: fixtures reales y mutaciones (redacción, condiciones nuevas, ausencias).
//  2. Adaptadores: misma URL que GB visa con esquema propio (compatibilidades disjuntas), fallos sin lanzar.
//  3. Perfiles: procedencia vs valor, campos sin respaldo, estado no confirmado, idempotencia.
//  4. Autorizaciones: cada perfil exige SU política; ninguna se reutiliza.
//  5. Mongo efímero + GET /api/destinos: fuente → clasificación → aplicación → API; repetición sin
//     escrituras; ambigua/caída/segunda lectura ambigua sin publicar; regresión CO, GB visa/ETA, DE.
// Nada toca Atlas ni la red (preload solo-loopback). exitCode = 1 hasta la última aserción.
const assert = require('node:assert/strict');
if (!globalThis.__SOLO_LOOPBACK__) throw new Error('Se requiere preload-solo-loopback');
process.exitCode = 1;
const path = require('node:path');
const crypto = require('node:crypto');
const { readFileSync } = require('node:fs');
const mongoose = require('../config/mongoose');
const { ObjectId } = require('mongodb');
const FI = require('../services/propuestas/fuentes/embajada-italia-montevideo-visas');
const FG = require('../services/propuestas/fuentes/govuk-check-uk-visa-frontera');
const FV = require('../services/propuestas/fuentes/govuk-check-uk-visa');
const FDE = require('../services/propuestas/fuentes/auswaertiges-amt-visumpflicht');
const { URL_FICHA } = require('../services/propuestas/fuentes/migracion-colombia-checkmig');
const adIt = require('../services/propuestas/adaptadores/v2/embajada-italia-montevideo');
const adGbF = require('../services/propuestas/adaptadores/v2/govuk-check-uk-visa-frontera');
const adGbV = require('../services/propuestas/adaptadores/v2/govuk-check-uk-visa');
const { ADAPTADORES_V2, elegirAdaptadorV2 } = require('../services/propuestas/adaptadores/v2');
const ciclo = require('../services/propuestas/ciclo/ciclo-revalidacion-v2');
const P = require('../services/propuestas/ciclo/perfiles-procedencia-gb-it');
const { PERFILES, clavePolitica } = require('../services/propuestas/ciclo/perfiles');
const R = require('../services/propuestas/ciclo/config-ciclo-real');
const V2 = require('../services/propuestas/aplicar-propuesta-v2');
const { INDICES_DECISION, INDICES_APLICACION } = require('../services/propuestas/indices-propuestas');
const { fechaMontevideo } = require('../services/propuestas/plan-aplicacion-requisito-v2');
const CLI = require('./ciclo-checkmig-v2');

const fx = (...p) => readFileSync(path.join(__dirname, 'fixtures', ...p), 'utf8').replace(/\r\n/g, '\n');
const IT = fx('embajada-italia-montevideo', 'extracto-visas-2026-11-23.html');
const GBH = fx('govuk-check-uk-visa', 'resultado-uy-turismo-2026-11-22.html');
const GB_CO = fx('govuk-check-uk-visa', 'resultado-co-turismo-sin-familia-2026-11-22.html');
const GB_PREGUNTA = fx('govuk-check-uk-visa', 'pregunta-motivo-uy-2026-11-22.html');
const DEH = fx('auswaertiges-amt', 'extracto-staatenliste-2026-11-22.html');
const FICHA_CO = fx('checkmig', 'valida.html');
const PUB_IT = JSON.parse(fx('embajada-italia-montevideo', 'registro-publicado-it-2026-11-23.json'));
const PUB_GBP = JSON.parse(fx('govuk-check-uk-visa', 'registro-publicado-gb-pasaporte-2026-11-23.json'));
const PUB_GB = JSON.parse(fx('govuk-check-uk-visa', 'registro-publicado-gb-2026-11-22.json'));
const conId = r => ({ ...r, _id: new ObjectId(r._id) });
const okHtml = h => () => new Response(h, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
const caida = () => new Response('x', { status: 503, headers: { 'content-type': 'text/html' } });
const T0 = new Date('2026-11-23T12:00:00.000Z');
const leer = (a, f) => a.leer({ fetch: async () => f(), ahora: () => T0 });
const P1 = 'Los residentes en Uruguay que sean naturales uruguayos no necesitan de visa de ingreso al espacio Schengen para viajes por turismo de hasta 90 días.';
const P2_INICIO = 'Los residentes en Uruguay que sean ciudadanos legales uruguayos pueden necesitar de una visa';

(async () => {
  let rs, servidor;
  try {
    // ---- 1. Extracción ----
    const ei = FI.extraer(IT);
    assert.deepEqual([ei.estado, ei.campos.visa.valor, ei.campos.pasaporte.valor], ['ok', { requerida: 'no', dias: 90 }, { meses_tras_salida: 3 }]);
    assert.equal(ei.campos.visa.evidencia[1].startsWith(P2_INICIO), true, 'la condición de ciudadanos legales queda en la evidencia');
    assert.equal(FI.extraer(IT.replace('de hasta 90 días', 'de hasta 30 días')).campos.visa.valor.dias, 30, 'la duración se captura, no se supone');
    for (const [nombre, h, motivo] of [
      ['necesitan visa', IT.replace('no necesitan de visa', 'necesitan de visa'), 'no_reconocido'],
      ['condición agregada', IT.replace('de hasta 90 días.', 'de hasta 90 días, con pasaporte biométrico.'), 'no_reconocido'],
      ['sin ciudadanos legales', IT.replace(/<p>Los residentes en Uruguay que sean ciudadanos legales[\s\S]*?<\/p>/, ''), 'sin_evidencia'],
      ['ciudadanos legales con otra redacción', IT.replace('pueden necesitar de una visa', 'no necesitan visa'), 'no_reconocido'],
      ['sin párrafo de naturales', IT.replace(/<p>Los residentes en Uruguay que sean naturales[\s\S]*?<\/p>/, ''), 'sin_evidencia'],
      ['párrafo de naturales repetido', IT.replace('<p>Para todos', `<p>${P1}</p><p>Para todos`), 'sin_evidencia'],
      ['otro párrafo con condiciones', IT.replace('<p>Para todos', '<p>Desde 2027 los turistas uruguayos deberán tramitar una autorización previa.</p><p>Para todos'), 'condicionada'],
      ['sin bloque de contenido', IT.replace('class="entry-content"', 'class="otro"'), 'sin_evidencia'],
      ['dos <main>', IT.replace('</main>', '</main><main></main>'), 'sin_evidencia']
    ]) {
      const x = FI.extraer(h);
      assert.equal(x.estado, 'ambiguo', nombre);
      for (const c of FI.CAMPOS) assert.equal(x.campos[c].motivo.split(':')[0], motivo, `${nombre}/${c}: ${x.campos[c].motivo}`);
    }
    // Revisión Codex: una condición en lista, div o después de un div anidado no se ignora; un
    // contenedor que no cierra no se interpreta.
    const COND_IT = 'Los pasaportes uruguayos deben ser biométricos para esta exención.';
    const conCondicionIt = envoltura => IT.replace('<p>Para todos', `${envoltura}<p>Para todos`);
    const MUT_IT = [
      ['condición en lista', conCondicionIt(`<ul><li>${COND_IT}</li></ul>`), 'condicionada'],
      ['condición en div', conCondicionIt(`<div>${COND_IT}</div>`), 'condicionada'],
      ['condición después de un div anidado', conCondicionIt(`<div class="nota"><p>Aviso.</p></div><p>${COND_IT}</p>`), 'condicionada'],
      ['condición como texto suelto', conCondicionIt(COND_IT), 'condicionada'],
      ['contenedor sin cierre', IT.replace('</div><!-- .entry-content -->', ''), 'no_reconocido']
    ];
    for (const [nombre, h, motivo] of MUT_IT) {
      const x = FI.extraer(h);
      assert.equal(x.estado, 'ambiguo', nombre);
      for (const c of FI.CAMPOS) assert.equal(x.campos[c].motivo.split(':')[0], motivo, `${nombre}/${c}: ${x.campos[c].motivo}`);
    }
    const COND_GB = 'Your passport must be valid for at least six months after your stay.';
    const conCondicionGb = envoltura => GBH.replace('valid for the whole of your stay in the UK.</p>', `valid for the whole of your stay in the UK.</p>${envoltura}`);
    const MUT_GB = [
      ['condición en div', conCondicionGb(`<div>${COND_GB}</div>`)],
      ['condición en p', conCondicionGb(`<p>${COND_GB}</p>`)],
      ['condición en lista', conCondicionGb(`<ul><li>${COND_GB}</li></ul>`)],
      ['condición después de un div anidado', conCondicionGb(`<div><div><p>Note.</p></div></div><div>${COND_GB}</div>`)],
      ['condición como texto suelto', conCondicionGb(COND_GB)]
    ];
    for (const [nombre, h] of MUT_GB) {
      const x = FG.extraer(h);
      assert.deepEqual([x.estado, x.campos.pasaporte.motivo.split(':')[0]], ['ambiguo', 'condicionada'], `GB ${nombre}`);
    }
    const eg = FG.extraer(GBH);
    assert.deepEqual([eg.estado, eg.campos.pasaporte.valor, eg.campos.contexto.valor.nacionalidad], ['ok', 'toda_la_estadia', 'UY']);
    for (const [nombre, h, campo, motivo] of [
      ['otro resultado (Colombia, sin la sección)', GB_CO, 'pasaporte', 'sin_evidencia'],
      ['pregunta, no resultado', GB_PREGUNTA, 'pasaporte', 'sin_evidencia'],
      ['mínimo de meses', GBH.replace('valid for the whole of your stay in the UK.</p>', 'valid for at least 6 months after your stay.</p>'), 'pasaporte', 'no_reconocido'],
      ['frase agregada sobre el pasaporte', GBH.replace('<p>You may also be asked to prove that:</p>', '<p>Your passport must have one blank page.</p><p>You may also be asked to prove that:</p>'), 'pasaporte', 'condicionada'],
      ['otra nacionalidad', GBH.replace('<dd class="govuk-summary-list__value">Uruguay</dd>', '<dd class="govuk-summary-list__value">Argentina</dd>'), 'contexto', 'contexto_no_coincide']
    ]) {
      const x = FG.extraer(h);
      assert.equal(x.estado, 'ambiguo', nombre);
      assert.equal(x.campos[campo].motivo.split(':')[0], motivo, `${nombre}: ${x.campos[campo].motivo}`);
    }
    // La sección de frontera no cambia la lectura de visa/ETA, y al revés.
    const sinFrontera = GBH.replace('Your passport should be valid for the whole of your stay in the UK.', 'Your passport should be valid for 6 months.');
    assert.deepEqual([FV.extraer(sinFrontera).estado, FG.extraer(sinFrontera).estado], ['ok', 'ambiguo']);

    // ---- 2. Adaptadores ----
    const li = await leer(adIt, okHtml(IT));
    assert.deepEqual([li.tipo, li.url, li.fuente_nombre, li.hechos.estancia_dias_max, li.hechos.pasaporte_meses_tras_salida], ['hechos', FI.URL_PAGINA, 'Embajada de Italia en Montevideo', 90, 3]);
    const lg = await leer(adGbF, okHtml(GBH));
    assert.deepEqual([lg.tipo, lg.url, lg.hechos.pasaporte_validez], ['hechos', FV.URL_RESULTADO, 'toda_la_estadia']);
    for (const a of [adIt, adGbF]) {
      assert.deepEqual([(await leer(a, caida)).tipo, (await leer(a, caida)).motivo], ['no_disponible', 'http_503']);
      const fuera = await leer(a, () => new Response(null, { status: 302, headers: { location: 'https://ejemplo.invalid/' } }));
      assert.equal(fuera.motivo, 'redireccion_fuera_del_sitio');
      assert.ok(ADAPTADORES_V2.includes(a));
    }
    assert.equal((await leer(adIt, okHtml(IT.replace('no necesitan de visa', 'necesitan de visa')))).tipo, 'ambiguo');
    // Compatibilidad disjunta: una propuesta con hechos de frontera elige SOLO el adaptador de frontera.
    const prop = l => ({ payload: { version_contrato: '2.0', campo: 'requisito', fuentes: [{ nombre: l.fuente_nombre, url: l.url, algoritmo_hechos_hash: l.algoritmo_hechos_hash, hechos: l.hechos, hechos_hash: l.hechos_hash }] } });
    const lv = await leer(adGbV, okHtml(GBH));
    assert.equal(elegirAdaptadorV2(prop(lg)), adGbF);
    assert.equal(elegirAdaptadorV2(prop(lv)), adGbV);
    assert.equal(elegirAdaptadorV2(prop(li)), adIt);
    assert.equal(adGbF.compatibilidad(prop(lv)).codigo, 'esquema_hechos_no_soportado');

    // ---- 3. Perfiles ----
    const HOY = fechaMontevideo(T0);
    const cl = (perfil, req, l) => ciclo.clasificar(req, l, perfil, { hoy: HOY });
    const gbReal = cl(P.gbPasaporte, PUB_GBP.requisito, lg);
    assert.deepEqual([gbReal.accion, gbReal.tipo_cambio, gbReal.cambios.map(c => c.campo), gbReal.observaciones.map(o => o.codigo), gbReal.fecha_verificacion.efecto],
      ['cambio_aplicable', 'procedencia', ['descripcion', 'fuente'], ['cambio_de_procedencia', 'descripcion_reemplazada'], 'se_fija_al_aplicar']);
    const itVisaReal = cl(P.itVisa, PUB_IT.visa, li);
    assert.deepEqual([itVisaReal.accion, itVisaReal.tipo_cambio, itVisaReal.esperado, itVisaReal.cambios.map(c => [c.campo, c.propuesto.valor])],
      ['cambio_aplicable', 'procedencia', 'no', [['descripcion', P.descripcionItVisa(li.hechos)], ['fuente', FI.URL_PAGINA]]]);
    for (const t of ['uruguayos naturales', 'residentes en Uruguay', 'turismo', '90 días', 'ciudadanos legales', 'nacionalidad de origen']) assert.ok(P.descripcionItVisa(li.hechos).includes(t), `condición representada: ${t}`);
    for (const t of ['uruguayos naturales', 'turismo', '3 meses', 'salida del espacio Schengen']) assert.ok(P.descripcionItPasaporte(li.hechos).includes(t), t);
    const itPasReal = cl(P.itPasaporte, PUB_IT.validez_pasaporte, li);
    assert.deepEqual([itPasReal.accion, itPasReal.tipo_cambio, itPasReal.esperado], ['cambio_aplicable', 'procedencia', 'si']);
    // Ya canónico → sin cambio y sin renovar la fecha.
    const canon = { ...PUB_IT.visa, descripcion: P.descripcionItVisa(li.hechos), fuente: FI.URL_PAGINA };
    assert.deepEqual([cl(P.itVisa, canon, li).accion, cl(P.itVisa, canon, li).fecha_verificacion.efecto], ['sin_cambio', 'no_se_renueva']);
    // Valor distinto: el perfil también lo informa como cambio de valor (con advertencia al aplicarse).
    const valor = cl(P.itVisa, { ...PUB_IT.visa, obligatorio: 'si' }, li);
    assert.deepEqual([valor.accion, valor.tipo_cambio, valor.cambios[0].campo], ['cambio_aplicable', 'valor', 'obligatorio']);
    // Campos que la fuente no respalda o estado no confirmado → revisión humana (no se renueva la fecha).
    assert.equal(cl(P.gbPasaporte, { ...PUB_GBP.requisito, link: 'https://www.gov.uk/x' }, lg).motivo, 'campos_sin_respaldo');
    assert.equal(cl(P.gbPasaporte, { ...PUB_GBP.requisito, costo: '£1' }, lg).motivo, 'campos_sin_respaldo');
    assert.equal(cl(P.itPasaporte, { ...PUB_IT.validez_pasaporte, estado: 'verificar' }, li).motivo, 'estado_no_confirmado');
    assert.equal(cl(P.itVisa, PUB_IT.validez_pasaporte, li).motivo, 'requisito_fuera_de_perfil');
    assert.equal(cl(P.gbPasaporte, PUB_GBP.requisito, lv).motivo, 'sin_evidencia_confirmada', 'la lectura de visa no respalda el pasaporte');
    assert.equal(cl(P.itVisa, PUB_IT.visa, await leer(adIt, okHtml(IT.replace('no necesitan de visa', 'necesitan de visa')))).motivo, 'lectura_ambigua');
    assert.equal(cl(P.itVisa, PUB_IT.visa, await leer(adIt, caida)).accion, 'fuente_no_disponible');
    assert.ok(['govuk-gb-pasaporte', 'embajada-it-visa', 'embajada-it-pasaporte'].every(n => PERFILES.some(p => p.nombre === n)));

    // ---- 4. Autorizaciones ----
    const OPS = JSON.stringify([{ usuario_atlas: 'ciclo-proceso', db: 'admin', identificador: 'proceso.ciclo' }]);
    const env = (lista) => ({ MONGODB_URI_CICLO: 'mongodb+srv://ciclo:SECRETO@ejemplo.invalid/x', OPERADORES_AUTORIZADOS_JSON: OPS, ...(lista ? { CICLO_V2_AUTORIZACION_JSON: JSON.stringify(lista) } : {}) });
    const aut = politica => ({ politica, autorizada_por: 'persona.autorizante', autorizada_en: new Date(Date.now() - 60_000).toISOString(), vence_en: new Date(Date.now() + 86_400_000).toISOString() });
    const ACTIVAS = ['checkmig-colombia-obligatoriedad@1', 'govuk-reino-unido-turismo-uy@1', 'auswaertiges-amt-alemania-visa@1', 'alta-auswaertiges-amt-alemania@1'].map(aut);
    const LOTE = [P.gbPasaporte, P.itVisa, P.itPasaporte].map(p => aut(clavePolitica(p)));
    assert.deepEqual(LOTE.map(a => a.politica), ['govuk-gb-pasaporte-uy@1', 'embajada-italia-it-visa-uy@1', 'embajada-italia-it-pasaporte-uy@1']);
    for (const p of [P.gbPasaporte, P.itVisa, P.itPasaporte]) {
      const c = R.cargarConfigCicloReal(env(ACTIVAS), new Date(), { perfil: p.nombre });
      assert.deepEqual([c.politica_habilitada, c.motivo_sin_politica], [false, `CICLO_V2_AUTORIZACION_JSON no incluye ${clavePolitica(p)}`], `${p.nombre}: ninguna política activa lo habilita`);
    }
    // La política de IT visa no habilita IT pasaporte (mismo destino y fuente, otro requisito).
    assert.equal(R.cargarConfigCicloReal(env([...ACTIVAS, LOTE[1]]), new Date(), { perfil: 'embajada-it-pasaporte' }).politica_habilitada, false);
    assert.equal(R.cargarConfigCicloReal(env([...ACTIVAS, ...LOTE]), new Date(), { perfil: 'embajada-it-pasaporte' }).politica_habilitada, true);

    // ---- 5. Mongo efímero ----
    const { MongoMemoryReplSet } = require('mongodb-memory-server');
    const { crearApp } = require('../app');
    rs = await MongoMemoryReplSet.create({ binary: { version: '8.0.32' }, replSet: { count: 1 } });
    await mongoose.connect(rs.getUri('buscador_lote'), { autoIndex: false, autoCreate: false, monitorCommands: true });
    const conexion = mongoose.connection, col = n => conexion.db.collection(n);
    servidor = await new Promise((ok, mal) => { const s = crearApp({ panel: { registrar: () => {} } }).listen(0, '127.0.0.1', () => ok(s)); s.on('error', mal); });
    const api = async () => { const r = await globalThis.fetch(`http://127.0.0.1:${servidor.address().port}/api/destinos`); assert.equal(r.status, 200); return r.json(); };
    const reqApi = async (iso, tipo, nombre) => (await api()).find(d => d.codigo_iso === iso).requisitos.find(r => r.tipo === tipo && (nombre === undefined || r.nombre === nombre));
    const CO = { _id: new ObjectId(), tipo: 'formulario_digital', nombre: 'Check-Mig', obligatorio: 'no', descripcion: 'Prerregistro migratorio en línea para el ingreso y la salida de Colombia.',
      fuente: URL_FICHA, link: 'https://apps.migracioncolombia.gov.co/pre-registro/', fecha_verificacion: '2026-11-17', estado: 'confirmado' };
    const DE = { _id: new ObjectId(), tipo: 'visa', obligatorio: 'no', descripcion: 'No requiere visa con pasaporte nacional uruguayo para estadías de hasta 90 días dentro de cualquier período de 180 días, sin actividad remunerada (por ejemplo, turismo). Para estadías más largas o para trabajar, consultar la fuente oficial.',
      fuente: FDE.URL_LISTA, fecha_verificacion: new Date('2026-11-22T00:00:00Z'), estado: 'confirmado' };
    const sembrar = async () => {
      await conexion.db.dropDatabase();
      await col('destinos').createIndex({ codigo_iso: 1 }, { unique: true }); await col('destinos').createIndex({ pais: 1 }, { unique: true });
      for (const s of new Map([...INDICES_DECISION, ...INDICES_APLICACION, V2.INDICE_TRANSVERSAL].map(x => [`${x.coleccion}/${x.nombre}`, x])).values()) {
        await col(s.coleccion).createIndex(s.clave, { name: s.nombre, unique: true, ...(s.partialFilterExpression ? { partialFilterExpression: s.partialFilterExpression } : {}) });
      }
      await col('destinos').insertMany([
        { _id: new ObjectId(PUB_GB.destino._id), pais: 'Reino Unido', codigo_iso: 'GB', requisitos: [conId(PUB_GB.visa), conId(PUB_GB.eta), conId(PUB_GBP.requisito)] },
        { _id: new ObjectId(PUB_IT.destino._id), pais: 'Italia', codigo_iso: 'IT', requisitos: [conId(PUB_IT.visa), conId(PUB_IT.validez_pasaporte)] },
        { _id: new ObjectId(), pais: 'Colombia', codigo_iso: 'CO', requisitos: [CO] },
        { _id: new ObjectId(), pais: 'Alemania', codigo_iso: 'DE', requisitos: [DE] }
      ]);
    };
    let colas = {};
    const fuente = async u => { const c = colas[u]; if (!c?.length) throw new Error(`consulta no esperada a ${u}`); return c.shift()(); };
    const resumen = [];
    const correr = async (perfil, e, respuestas) => {
      colas = respuestas;
      const lineas = [];
      const codigo = await CLI.ejecutarReal(e, l => lineas.push(l), { conexion, usuariosAutenticados: async () => [{ user: 'ciclo-proceso', db: 'admin' }],
        fetch: fuente, uuid: () => crypto.randomUUID(), resumen: l => resumen.push(l) }, { perfil });
      const reg = lineas.filter(l => l.startsWith('REGISTRO_EJECUCION '));
      assert.equal(reg.length, 1);
      assert.ok(Object.values(colas).every(c => c.length === 0), `${perfil}: quedaron respuestas sin consumir\n${lineas.join('\n')}`);
      assert.ok(!/SECRETO|mongodb\+srv/.test(lineas.join('\n')));
      return { codigo, registro: JSON.parse(reg[0].slice('REGISTRO_EJECUCION '.length)), lineas };
    };
    const huella = async () => JSON.stringify(await Promise.all(['destinos', 'propuestas_cambio', 'eventos_propuesta', 'intentos_aplicacion', 'inicios_intento_aplicacion', 'historial_cambios']
      .map(n => col(n).find({}).sort({ _id: 1 }).toArray())));
    const GOV = FV.URL_RESULTADO, ITU = FI.URL_PAGINA;
    const LOTE_PERFILES = [['govuk-gb-pasaporte', GOV, GBH], ['embajada-it-visa', ITU, IT], ['embajada-it-pasaporte', ITU, IT]];
    const conActivas = env(ACTIVAS), conLote = env([...ACTIVAS, ...LOTE]);

    await sembrar();
    let h = await huella();
    // Modo informe: las políticas activas no habilitan el lote (exit 2, cero escrituras).
    for (const [perfil, url, pag] of LOTE_PERFILES) {
      const r = await correr(perfil, conActivas, { [url]: [okHtml(pag)] });
      assert.deepEqual([r.codigo, r.registro.modo, r.registro.resultado, r.registro.motivo, r.registro.tipo_cambio, r.registro.campos_propuestos],
        [2, 'informe', 'cambio_aplicable', 'politica_no_habilitada', 'procedencia', ['descripcion', 'fuente']], perfil);
    }
    assert.equal(await huella(), h, 'sin su política, el lote no escribe');

    // Ambigua y caída con la política vigente: nada publicado.
    const a1 = await correr('embajada-it-visa', conLote, { [ITU]: [okHtml(IT.replace('no necesitan de visa', 'necesitan de visa'))] });
    assert.deepEqual([a1.codigo, a1.registro.resultado, a1.registro.motivo, a1.registro.pendiente.campos.map(c => c.campo)], [3, 'revision_humana', 'lectura_ambigua', ['visa', 'pasaporte']]);
    const a2 = await correr('govuk-gb-pasaporte', conLote, { [GOV]: [caida] });
    assert.deepEqual([a2.codigo, a2.registro.resultado, a2.registro.fuente.http_status], [4, 'fuente_no_disponible', 503]);
    assert.equal(await huella(), h, 'ambigua o caída: cero escrituras');
    // Condiciones en listas, divs o tras divs anidados, por el ciclo real con la política vigente.
    for (const [perfil, url, mutaciones] of [['embajada-it-visa', ITU, MUT_IT], ['embajada-it-pasaporte', ITU, MUT_IT], ['govuk-gb-pasaporte', GOV, MUT_GB]]) {
      for (const [nombre, pag] of mutaciones) {
        const r = await correr(perfil, conLote, { [url]: [okHtml(pag)] });
        assert.deepEqual([r.codigo, r.registro.resultado, r.registro.motivo], [3, 'revision_humana', 'lectura_ambigua'], `${perfil} / ${nombre}`);
      }
    }
    assert.equal(await huella(), h, 'condiciones no admitidas: cero escrituras');

    // Fuente → clasificación → aplicación (detección + revalidación H3.3) → GET /api/destinos.
    const hoy = fechaMontevideo(new Date());
    const otrosAntes = JSON.stringify([await reqApi('GB', 'visa'), await reqApi('GB', 'formulario_digital', 'UK ETA'), await reqApi('CO', 'formulario_digital'), await reqApi('DE', 'visa')]);
    for (const [perfil, url, pag] of LOTE_PERFILES) {
      const r = await correr(perfil, conLote, { [url]: [okHtml(pag), okHtml(pag)] });
      assert.deepEqual([r.codigo, r.registro.modo, r.registro.resultado, r.registro.estado_propuesta, r.registro.tipo_cambio, r.registro.politica.nombre],
        [0, 'politica_automatica', 'exito', 'aplicada', 'procedencia', clavePolitica(PERFILES.find(p => p.nombre === perfil))], r.lineas.join('\n'));
      assert.match(resumen.at(-1), new RegExp(`^\\| ${perfil} \\| (GB|IT) \\| politica_automatica \\| exito \\| 0 \\| HTTP 200 .* \\| APLICADO: cambio de procedencia \\(descripcion, fuente; obligatorio sigue "(si|no)"\\) \\(propuesta [0-9a-f-]{36}\\) \\|$`));
      const intento = await col('intentos_aplicacion').findOne({ intento_id: r.registro.intento_id });
      assert.deepEqual([intento.auditoria.operador, intento.revalidaciones[0].url], ['proceso.ciclo', url]);
      const ev = await col('eventos_propuesta').findOne({ propuesta_id: r.registro.propuesta_id, tipo_evento: 'aprobacion' });
      assert.deepEqual([ev.detalle.identidad_operador.metodo, ev.detalle.identidad_operador.politica], ['politica_automatica', clavePolitica(PERFILES.find(p => p.nombre === perfil))]);
    }
    const gbp = await reqApi('GB', 'validez_pasaporte'), itv = await reqApi('IT', 'visa'), itp = await reqApi('IT', 'validez_pasaporte');
    assert.deepEqual([gbp.obligatorio, gbp.fuente, gbp.descripcion, String(gbp.fecha_verificacion).slice(0, 10), gbp.estado], ['si', GOV, P.DESCRIPCION_GB_PASAPORTE, hoy, 'confirmado']);
    assert.deepEqual([itv.obligatorio, itv.fuente, itv.descripcion, String(itv.fecha_verificacion).slice(0, 10)], ['no', ITU, P.descripcionItVisa(li.hechos), hoy]);
    assert.deepEqual([itp.obligatorio, itp.fuente, itp.descripcion, String(itp.fecha_verificacion).slice(0, 10)], ['si', ITU, P.descripcionItPasaporte(li.hechos), hoy]);
    assert.equal(JSON.stringify([await reqApi('GB', 'visa'), await reqApi('GB', 'formulario_digital', 'UK ETA'), await reqApi('CO', 'formulario_digital'), await reqApi('DE', 'visa')]), otrosAntes, 'los demás requisitos no se tocan');
    const historial = await col('historial_cambios').find({}).toArray();
    assert.equal(historial.length, 3);
    const propuestas = await col('propuestas_cambio').find({}).toArray();
    assert.deepEqual(propuestas.map(p => p.payload.instantanea_anterior.fuente.valor), Array(3).fill('https://www.iatatravelcentre.com/'), 'la auditoría conserva la procedencia anterior');
    assert.deepEqual(propuestas.map(p => p.payload.advertencias), [[], [], []]);

    // Repetición: sin propuestas, eventos ni escrituras nuevas.
    h = await huella();
    for (const [perfil, url, pag] of LOTE_PERFILES) {
      const r = await correr(perfil, conLote, { [url]: [okHtml(pag)] });
      assert.deepEqual([r.codigo, r.registro.resultado, r.registro.fecha_verificacion.efecto], [0, 'sin_cambio', 'no_se_renueva'], perfil);
    }
    // Regresión: Colombia, GB visa/ETA y Alemania siguen sin cambio con las políticas en lista.
    for (const [perfil, url, pag] of [['checkmig-colombia', URL_FICHA, FICHA_CO], ['govuk-gb-eta', GOV, GBH], ['auswaertiges-amt-de-visa', FDE.URL_LISTA, DEH]]) {
      const r = await correr(perfil, conLote, { [url]: [okHtml(pag)] });
      assert.deepEqual([r.codigo, r.registro.resultado], [0, 'sin_cambio'], `${perfil}: ${r.lineas.join('\n')}`);
    }
    assert.equal(await huella(), h, 'repetición y regresión sin escrituras');
    // GB visa (IATA en el registro sembrado) sigue aplicándose con su política y su adaptador.
    const gv = await correr('govuk-gb-visa', conLote, { [GOV]: [okHtml(GBH), okHtml(GBH)] });
    assert.deepEqual([gv.codigo, gv.registro.resultado, gv.registro.valor_aplicado, (await reqApi('GB', 'visa')).fuente], [0, 'exito', 'no', GOV]);
    assert.equal((await col('intentos_aplicacion').findOne({ intento_id: gv.registro.intento_id })).adaptador.nombre, 'govuk-check-uk-visa');
    assert.deepEqual([(await reqApi('GB', 'validez_pasaporte')).descripcion, await col('historial_cambios').countDocuments()], [P.DESCRIPCION_GB_PASAPORTE, 4]);

    // Revalidación de H3.3 (segunda lectura) caída, ambigua o con hechos nuevos: el destino no se toca.
    await sembrar();
    const itDoc = async () => JSON.stringify(await col('destinos').findOne({ codigo_iso: 'IT' }));
    const antes = await itDoc();
    const c1 = await correr('embajada-it-pasaporte', conLote, { [ITU]: [okHtml(IT), caida] });
    assert.deepEqual([c1.codigo, c1.registro.estado_propuesta, c1.registro.pendiente?.tipo], [4, 'aprobada', 'reintentar'], c1.lineas.join('\n'));
    assert.equal(await itDoc(), antes, 'caída en H3.3: nada publicado');
    await sembrar();
    const d1 = await correr('embajada-it-pasaporte', conLote, { [ITU]: [okHtml(IT), okHtml(IT.replace('no necesitan de visa', 'necesitan de visa'))] });
    assert.deepEqual([d1.codigo, d1.registro.estado_propuesta, d1.registro.pendiente?.tipo], [3, 'revision_requerida', 'revision_humana'], d1.lineas.join('\n'));
    assert.equal(await itDoc(), antes, 'ambigua en H3.3: nada publicado');
    // La condición aparece recién en la revalidación de H3.3 (en un div): tampoco se publica.
    const gbDoc = async () => JSON.stringify(await col('destinos').findOne({ codigo_iso: 'GB' }));
    const gbAntes = await gbDoc();
    const d1b = await correr('govuk-gb-pasaporte', conLote, { [GOV]: [okHtml(GBH), okHtml(MUT_GB[0][1])] });
    assert.deepEqual([d1b.codigo, d1b.registro.estado_propuesta], [3, 'revision_requerida'], d1b.lineas.join('\n'));
    assert.equal(await gbDoc(), gbAntes, 'condición en la revalidación: nada publicado');
    const d2 = await correr('embajada-it-pasaporte', conLote, {});
    assert.deepEqual([d2.codigo, d2.registro.resultado, await col('propuestas_cambio').countDocuments({ destino_id: new ObjectId(PUB_IT.destino._id) })], [3, 'propuesta_activa_existente', 1], 'la siguiente corrida no duplica');
    // La fuente cambia entre detección y aplicación (dos lecturas con los mismos hechos nuevos): la
    // propuesta queda obsoleta sin publicar; la corrida siguiente propone con los hechos nuevos.
    await sembrar();
    const IT6 = IT.replace('de 3 meses', 'de 6 meses');
    const f1 = await correr('embajada-it-pasaporte', conLote, { [ITU]: [okHtml(IT), okHtml(IT6), okHtml(IT6)] });
    assert.deepEqual([f1.codigo, f1.registro.resultado, f1.registro.estado_propuesta], [3, 'fuente_cambio', 'obsoleta']);
    assert.equal(await itDoc(), antes, 'fuente cambiada: nada publicado con los hechos viejos');
    const f2 = await correr('embajada-it-pasaporte', conLote, { [ITU]: [okHtml(IT6), okHtml(IT6)] });
    assert.deepEqual([f2.codigo, f2.registro.resultado, (await reqApi('IT', 'validez_pasaporte')).descripcion.includes('al menos 6 meses')], [0, 'exito', true]);
    // El otro requisito de Italia sigue su propio camino.
    const d3 = await correr('embajada-it-visa', conLote, { [ITU]: [okHtml(IT6), okHtml(IT6)] });
    assert.deepEqual([d3.codigo, d3.registro.resultado], [0, 'exito']);

    assert.equal(globalThis.__SOLO_LOOPBACK__.bloqueados.length, 0, 'ninguna conexión externa');
    process.exitCode = 0;
    console.log('Lote procedencia GB/IT 2.0: extracción, adaptadores disjuntos, perfiles, autorizaciones propias, aplicación → API, repetición, ambigua/caída y regresión CO/GB/DE en Mongo efímero: OK');
  } catch (err) {
    process.exitCode = 1;
    console.error(err);
  } finally {
    if (servidor) await new Promise(ok => servidor.close(ok));
    await mongoose.disconnect().catch(() => {});
    if (rs) await rs.stop().catch(() => {});
  }
})();
