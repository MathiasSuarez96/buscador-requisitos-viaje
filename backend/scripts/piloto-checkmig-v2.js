/**
 * Piloto LOCAL de CheckMig 2.0: de la ficha al dato que devuelve GET /api/destinos, con un solo
 * comando y sin preparar una propuesta a mano.
 *
 *   node scripts/piloto-checkmig-v2.js
 *
 * Siempre corre contra un Mongo EFÍMERO que levanta él mismo (mongodb-memory-server, 127.0.0.1) y
 * con la ficha SIMULADA (fixtures de scripts/fixtures/checkmig). No acepta URI, no lee .env y no
 * consulta la red: nunca toca Atlas.
 *
 * Un ciclo es el CICLO COMPARTIDO (services/propuestas/ciclo/ciclo-revalidacion-v2.js) con el perfil
 * checkmig-colombia, la política habilitada y las identidades locales del piloto:
 *  1. Una propuesta activa para el requisito se informa y no se crea otra (sin consultar la fuente).
 *  2. Lee la ficha con el adaptador 2.0 (adaptador.leer: una consulta) y clasifica la lectura:
 *     sin_cambio, cambio_aplicable, revision_humana o fuente_no_disponible.
 *  3. Solo un cambio aplicable genera la propuesta 2.0, registra la aprobación con
 *     decidirPropuesta y aplica con H3.3 (aplicarConRevalidacionV2).
 *
 * La demostración corre seis ciclos sobre dos destinos de prueba e imprime GET /api/destinos
 * antes y después. Identidades del piloto: solo válidas en este Mongo efímero, que no tiene
 * autenticación (ver docs/piloto-checkmig-v2.md).
 */
const crypto = require('node:crypto');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const mongoose = require('../config/mongoose');
const { ObjectId } = require('mongodb');
const { crearApp } = require('../app');
const V2 = require('../services/propuestas/aplicar-propuesta-v2');
const { INDICES_DECISION, INDICES_APLICACION } = require('../services/propuestas/indices-propuestas');
const { ejecutarCicloV2, crearDepsAplicacion } = require('../services/propuestas/ciclo/ciclo-revalidacion-v2');
const perfilCheckmig = require('../services/propuestas/ciclo/perfil-checkmig-colombia');

// ------------------------------------------------------------------
// Perfil e identidades del piloto (solo Mongo efímero)
// ------------------------------------------------------------------

// El piloto usa el MISMO perfil y el MISMO ciclo que la ejecución real (services/propuestas/ciclo).
const PERFIL = perfilCheckmig;
// Aprobador: la persona que corre el piloto, bajo la política (identidad solo local).
const IDENTIDAD_POLITICA = Object.freeze({
  actor: { tipo: 'humano', identificador: 'piloto.local' },
  identidad_operador: { metodo: 'politica_piloto_local', politica: 'piloto-checkmig-obligatoriedad-v1' },
  comando: { nombre: 'piloto-checkmig-v2', version: '1' }
});
// Aplicador: credencial de comando de H3.3 con una allowlist propia del piloto.
const CREDENCIAL_PILOTO = Object.freeze({
  origen: 'comando_administrativo',
  usuarios_autenticados: [{ user: 'piloto-local', db: 'admin' }],
  operadores_autorizados: Object.freeze([Object.freeze({ usuario_atlas: 'piloto-local', db: 'admin', identificador: 'piloto.local' })])
});

// Un ciclo del piloto: el ciclo compartido con las identidades locales y la política habilitada.
const ejecutarCiclo = (objetivo, e) => ejecutarCicloV2(objetivo, PERFIL, {
  conexion: e.conexion, fetch: e.fetch, ahora: e.ahora, uuid: e.uuid, depsAplicacion: e.depsAplicacion,
  politicaHabilitada: true, identidadDecision: IDENTIDAD_POLITICA, credencialAplicacion: CREDENCIAL_PILOTO
});

// ------------------------------------------------------------------
// Entorno efímero: Mongo, índices, API pública y ficha simulada
// ------------------------------------------------------------------

const FIXTURES = path.join(__dirname, 'fixtures', 'checkmig');
const fixture = n => readFileSync(path.join(FIXTURES, n), 'utf8').replace(/\r\n/g, '\n');
const FICHA = Object.freeze({
  valida: () => new Response(fixture('valida.html'), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
  ambigua: () => new Response(fixture('ambigua.html'), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
  caida: () => new Response('Servicio no disponible', { status: 503, headers: { 'content-type': 'text/html' } })
});

async function crearEntorno({ ahora = () => new Date(), uuid = () => crypto.randomUUID() } = {}) {
  const { MongoMemoryReplSet } = require('mongodb-memory-server');
  const rs = await MongoMemoryReplSet.create({ binary: { version: '8.0.32' }, replSet: { count: 1 } });
  const uri = rs.getUri('buscador_piloto');
  if (!/^mongodb:\/\/127\.0\.0\.1:/.test(uri)) { await rs.stop(); throw new Error('piloto: solo Mongo efímero en 127.0.0.1.'); }
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  const conexion = mongoose.connection;
  const especies = new Map([...INDICES_DECISION, ...INDICES_APLICACION, V2.INDICE_TRANSVERSAL].map(s => [`${s.coleccion}/${s.nombre}`, s]));
  for (const s of especies.values()) {
    await conexion.db.collection(s.coleccion).createIndex(s.clave, { name: s.nombre, unique: true, ...(s.partialFilterExpression ? { partialFilterExpression: s.partialFilterExpression } : {}) });
  }
  const listados = async () => Object.fromEntries(await Promise.all([...new Set([...especies.values()].map(s => s.coleccion))]
    .map(async c => [c, await conexion.db.collection(c).indexes()])));
  // Solo la API pública: el panel queda deshabilitado (sin env) y su aviso no se imprime.
  const servidor = await new Promise((ok, mal) => { const s = crearApp({ panel: { registrar: () => {} } }).listen(0, '127.0.0.1', () => ok(s)); s.on('error', mal); });
  const base = `http://127.0.0.1:${servidor.address().port}`;

  // Ficha simulada: cada ciclo programa sus respuestas; una consulta de más es un error.
  let cola = [];
  const consultas = [];
  const fetch = async u => {
    consultas.push(u);
    const siguiente = cola.shift();
    if (!siguiente) throw new Error('piloto: consulta a la ficha no programada.');
    return siguiente();
  };
  const depsAplicacion = crearDepsAplicacion(conexion, { fetch, ahora, uuid, listados });

  return {
    conexion, ahora, uuid, fetch, depsAplicacion, consultas,
    programar: respuestas => { if (cola.length) throw new Error('piloto: quedaron respuestas sin consumir.'); cola = [...respuestas]; },
    pendientes: () => cola.length,
    api: async () => { const r = await globalThis.fetch(`${base}/api/destinos`); return { status: r.status, cuerpo: await r.json() }; },
    cerrar: async () => {
      await new Promise(ok => servidor.close(() => ok()));
      await mongoose.disconnect().catch(() => {});
      await rs.stop().catch(() => {});
    }
  };
}

// ------------------------------------------------------------------
// Demostración: tres resultados pedidos, sobre dos destinos de prueba
// ------------------------------------------------------------------

const LINK_FORMULARIO = 'https://apps.migracioncolombia.gov.co/check-mig/';
const checkmigGuardado = id => ({ _id: id, tipo: 'formulario_digital', nombre: 'Check-Mig', obligatorio: 'si',
  descripcion: 'Formulario de prerregistro migratorio (Check-Mig).', fuente: 'Migración Colombia', link: LINK_FORMULARIO,
  estado: 'confirmado', fecha_verificacion: '2026-08-18' });

async function sembrarDestino(e, { pais, codigo_iso }) {
  const destinoId = new ObjectId(), requisitoId = new ObjectId();
  await e.conexion.db.collection('destinos').insertOne({ _id: destinoId, pais, codigo_iso, requisitos: [checkmigGuardado(requisitoId)], updatedAt: new Date('2026-08-18T12:00:00.000Z') });
  return { destinoId, requisitoId, codigo_iso };
}

// Lo que devuelve GET /api/destinos para el CheckMig de cada destino de prueba.
async function vistaApi(e) {
  const { status, cuerpo } = await e.api();
  return { status, destinos: cuerpo.map(d => {
    const r = (d.requisitos ?? []).find(x => x.nombre === 'Check-Mig');
    return { codigo_iso: d.codigo_iso, pais: d.pais, obligatorio: r?.obligatorio ?? null, fecha_verificacion: r?.fecha_verificacion ?? null, link: r?.link ?? null };
  }).sort((a, b) => a.codigo_iso.localeCompare(b.codigo_iso)) };
}

async function huella(e, d) {
  const db = e.conexion.db;
  return {
    destino: JSON.stringify(await db.collection('destinos').findOne({ _id: d.destinoId })),
    propuestas: await db.collection('propuestas_cambio').countDocuments({ destino_id: d.destinoId }),
    historial: await db.collection('historial_cambios').countDocuments({ destino_id: String(d.destinoId) })
      + await db.collection('historial_cambios').countDocuments({ destino_id: d.destinoId })
  };
}

async function ciclo(e, nombre, d, respuestas) {
  e.programar(respuestas.map(n => FICHA[n]));
  const antes = await huella(e, d);
  const r = await ejecutarCiclo(d, e);
  const despues = await huella(e, d);
  if (e.pendientes() !== 0) throw new Error(`piloto: ${nombre}: quedaron respuestas de la ficha sin consumir.`);
  return { nombre, codigo_iso: d.codigo_iso, ficha: respuestas, ...r,
    destino_escrito: antes.destino !== despues.destino, propuestas_nuevas: despues.propuestas - antes.propuestas, historial_nuevo: despues.historial - antes.historial };
}

async function demostrar(e) {
  const co = await sembrarDestino(e, { pais: 'Colombia (piloto local)', codigo_iso: 'CO' });
  const cx = await sembrarDestino(e, { pais: 'Colombia (piloto local, revisión)', codigo_iso: 'CX' });
  const salida = { api_antes: await vistaApi(e), ciclos: [] };
  const correr = async (...a) => { const c = await ciclo(e, ...a); salida.ciclos.push(c); return c; };
  // Lectura ambigua o fallida: destino intacto y pendiente indicado.
  await correr('lectura ambigua', co, ['ambigua']);
  await correr('lectura fallida (HTTP 503)', co, ['caida']);
  salida.api_tras_pendientes = await vistaApi(e);
  // Cambio confirmado: la ficha dice «de uso no obligatorio» y el guardado dice 'si'.
  await correr('cambio confirmado', co, ['valida', 'valida']);
  salida.api_tras_cambio = await vistaApi(e);
  // Segunda ejecución con los mismos datos: ni propuesta nueva ni escritura.
  await correr('segunda ejecución, mismos datos', co, ['valida']);
  // Cambio propuesto, pero la revalidación de H3.3 es ambigua: revisión humana, destino intacto.
  await correr('revalidación ambigua en la aplicación', cx, ['valida', 'ambigua']);
  await correr('segunda ejecución con la revisión pendiente', cx, []);
  salida.api_despues = await vistaApi(e);
  return salida;
}

// ------------------------------------------------------------------
// Salida en texto plano
// ------------------------------------------------------------------

function imprimirApi(titulo, v, log) {
  log(`GET /api/destinos (${titulo}): HTTP ${v.status}`);
  for (const d of v.destinos) log(`  ${d.codigo_iso}  ${d.pais}  Check-Mig.obligatorio=${JSON.stringify(d.obligatorio)}  fecha_verificacion=${d.fecha_verificacion}  link=${d.link}`);
}
function imprimirCiclo(c, i, log) {
  log(`[${i + 1}] ${c.nombre} (${c.codigo_iso}; ficha simulada: ${c.ficha.join(', ') || 'sin consultas'})`);
  log(`    resultado=${c.resultado}${c.motivo ? ` (${c.motivo})` : ''}  lecturas=${c.lecturas}  destino_escrito=${c.destino_escrito ? 'sí' : 'no'}  propuestas_nuevas=${c.propuestas_nuevas}  historial_nuevo=${c.historial_nuevo}`);
  if (c.propuesta_id) log(`    propuesta=${c.propuesta_id}  estado=${c.estado_propuesta}${c.decision_evento_id ? `  decisión=${c.decision_evento_id}` : ''}${c.intento_id ? `  intento=${c.intento_id}` : ''}`);
  if (c.valor_aplicado) log(`    aplicado: obligatorio=${JSON.stringify(c.valor_aplicado)}`);
  if (c.pendiente) {
    const p = c.pendiente;
    log(`    pendiente: ${p.tipo}${p.motivo ? ` (${p.motivo})` : ''}${p.codigo ? ` (${p.codigo})` : ''}`);
    for (const campo of p.campos ?? []) log(`      - ${campo.campo}: ${campo.motivo}`);
  }
}
function imprimir(salida, log = console.log) {
  log(`Piloto CheckMig 2.0 (Mongo efímero, ficha simulada, perfil ${PERFIL.nombre} v${PERFIL.version}, política ${PERFIL.politica.nombre} v${PERFIL.politica.version})`);
  imprimirApi('antes', salida.api_antes, log);
  salida.ciclos.slice(0, 2).forEach((c, i) => imprimirCiclo(c, i, log));
  imprimirApi('tras las lecturas pendientes', salida.api_tras_pendientes, log);
  salida.ciclos.slice(2, 3).forEach((c, i) => imprimirCiclo(c, i + 2, log));
  imprimirApi('tras el cambio confirmado', salida.api_tras_cambio, log);
  salida.ciclos.slice(3).forEach((c, i) => imprimirCiclo(c, i + 3, log));
  imprimirApi('después', salida.api_despues, log);
}

module.exports = { PERFIL, IDENTIDAD_POLITICA, CREDENCIAL_PILOTO, ejecutarCiclo, crearEntorno, demostrar, imprimir };

if (require.main === module) {
  (async () => {
    let e;
    try {
      e = await crearEntorno();
      imprimir(await demostrar(e));
      process.exitCode = 0;
    } catch (err) {
      process.exitCode = 1;
      console.error(`piloto: ${err?.message ?? err}`);
    } finally {
      if (e) await e.cerrar();
    }
  })();
}
