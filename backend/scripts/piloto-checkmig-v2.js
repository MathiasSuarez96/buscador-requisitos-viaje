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
 * Un ciclo (ejecutarCiclo):
 *  1. Lee el destino y el requisito CheckMig guardado. Si ya hay una propuesta activa para ese
 *     requisito, no crea otra (y no consulta la fuente).
 *  2. Lee la ficha con el adaptador 2.0 (adaptador.leer: una consulta). Ambigua o fallida → no se
 *     propone nada; el resultado dice qué quedó pendiente.
 *  3. Compara los hechos confirmados con el requisito guardado. Sin diferencia → sin_cambio.
 *  4. POLÍTICA DEL PILOTO (POLITICA_PILOTO, explícita y solo local): autoriza ÚNICAMENTE corregir
 *     `obligatorio` del requisito «Check-Mig» (formulario_digital) desde una lectura con hechos y
 *     evidencia de obligatoriedad. Cualquier otro caso → cambio_no_autorizado.
 *  5. Genera la propuesta 2.0 (crearSobreRequisitoV2 + modelo PropuestaCambio), registra la
 *     aprobación con decidirPropuesta (identidad de la política) y aplica con H3.3
 *     (aplicarConRevalidacionV2): permiso, inicio durable, segunda lectura de la ficha, CAS,
 *     transacción, auditoría y confirmación son los de H3.3.
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
const Destino = require('../models/Destino.model');
const PropuestaCambio = require('../models/propuestas/PropuestaCambio.model');
const D = require('../services/propuestas/decidir-propuesta');
const V2 = require('../services/propuestas/aplicar-propuesta-v2');
const { aplicarConRevalidacionV2 } = require('../services/propuestas/orquestar-aplicacion-v2');
const { crearPersistenciaV2 } = require('../services/propuestas/persistencia-aplicacion-v2');
const adaptador = require('../services/propuestas/adaptadores/v2/migracion-colombia-checkmig');
const { crearSobreRequisitoV2, advertenciasRequeridas } = require('../services/propuestas/payload-requisito-v2');
const { capturarIdentidadEInstantanea, aplicarCambiosAInstantanea } = require('../services/propuestas/contrato-requisito-v2');
const { INDICES_DECISION, INDICES_APLICACION } = require('../services/propuestas/indices-propuestas');
const { ESTADOS_ACTIVOS } = require('../services/propuestas/contrato-propuestas');

// ------------------------------------------------------------------
// Política explícita del piloto
// ------------------------------------------------------------------

const POLITICA_PILOTO = Object.freeze({
  nombre: 'piloto-checkmig-obligatoriedad', version: '1',
  requisito: Object.freeze({ tipo: 'formulario_digital', nombre: 'Check-Mig' }),
  campo: 'obligatorio',
  fuente: adaptador.FUENTE_NOMBRE
});
// Aprobador: la persona que corre el piloto, bajo la política (identidad solo local).
const IDENTIDAD_POLITICA = Object.freeze({
  actor: { tipo: 'humano', identificador: 'piloto.local' },
  identidad_operador: { metodo: 'politica_piloto_local', politica: `${POLITICA_PILOTO.nombre}-v${POLITICA_PILOTO.version}` },
  comando: { nombre: 'piloto-checkmig-v2', version: '1' }
});
// Aplicador: credencial de comando de H3.3 con una allowlist propia del piloto.
const CREDENCIAL_PILOTO = Object.freeze({
  origen: 'comando_administrativo',
  usuarios_autenticados: [{ user: 'piloto-local', db: 'admin' }],
  operadores_autorizados: Object.freeze([Object.freeze({ usuario_atlas: 'piloto-local', db: 'admin', identificador: 'piloto.local' })])
});
const valor = v => ({ presente: true, bson_tipo: 'string', valor: v });

// Pura. ¿La lectura confirma un valor distinto del guardado y la política lo autoriza?
function evaluarPolitica(requisito, lectura) {
  if (requisito?.tipo !== POLITICA_PILOTO.requisito.tipo || requisito?.nombre !== POLITICA_PILOTO.requisito.nombre) {
    return { cambio: false, autoriza: false, motivo: 'requisito_fuera_de_politica' };
  }
  if (lectura?.tipo !== 'hechos' || lectura.fuente_nombre !== POLITICA_PILOTO.fuente || !(lectura.evidencia?.obligatoriedad?.length > 0)) {
    return { cambio: false, autoriza: false, motivo: 'sin_evidencia_confirmada' };
  }
  const esperado = lectura.hechos.obligatoriedad === 'obligatorio' ? 'si' : 'no';
  if (requisito.obligatorio === esperado) return { cambio: false, autoriza: true, esperado };
  // El contrato no admite un obligatorio recomendado: ese cambio excede la política.
  if (esperado === 'si' && ['si', 'verificar'].includes(requisito.recomendado)) return { cambio: true, autoriza: false, motivo: 'requiere_cambiar_recomendado', esperado };
  return { cambio: true, autoriza: true, esperado, cambios: [{ campo: POLITICA_PILOTO.campo, propuesto: valor(esperado) }] };
}

const camposPendientes = lectura => Object.entries(lectura.campos).filter(([, c]) => c.estado !== 'ok')
  .map(([campo, c]) => ({ campo, motivo: String(c.motivo).split(':')[0], evidencia: [...c.evidencia] }));

// ------------------------------------------------------------------
// Un ciclo del piloto
// ------------------------------------------------------------------

async function ejecutarCiclo({ destinoId, requisitoId }, e) {
  const col = n => e.conexion.db.collection(n);
  const destino = await col('destinos').findOne({ _id: destinoId });
  const requisito = (destino?.requisitos ?? []).find(r => r?._id instanceof ObjectId && r._id.equals(requisitoId));
  if (!requisito) return { resultado: 'requisito_no_encontrado' };

  // 1. Sin duplicar: una propuesta activa para este requisito se informa y no se crea otra.
  const activa = await col('propuestas_cambio').findOne({ destino_id: destinoId, requisito_id: requisitoId, estado: { $in: ESTADOS_ACTIVOS } });
  if (activa) {
    return { resultado: 'propuesta_activa_existente', propuesta_id: activa.propuesta_id, estado_propuesta: activa.estado, lecturas: 0,
      pendiente: activa.estado === 'revision_requerida' ? { tipo: 'revision_humana', propuesta_id: activa.propuesta_id } : null };
  }

  // 2. Lectura de la ficha con el adaptador.
  const lectura = await adaptador.leer({ fetch: e.fetch, ahora: e.ahora });
  if (lectura.tipo === 'no_disponible') {
    return { resultado: 'lectura_no_disponible', lecturas: 1, pendiente: { tipo: 'reintentar', motivo: lectura.motivo } };
  }
  if (lectura.tipo === 'ambiguo') {
    return { resultado: 'lectura_ambigua', lecturas: 1, pendiente: { tipo: 'revision_humana', url: lectura.url, campos: camposPendientes(lectura) } };
  }

  // 3–4. Comparación con el requisito guardado y política.
  const politica = evaluarPolitica(requisito, lectura);
  if (!politica.cambio) return { resultado: politica.autoriza ? 'sin_cambio' : 'cambio_no_autorizado', motivo: politica.motivo ?? null, lecturas: 1, hechos_hash: lectura.hechos_hash };
  if (!politica.autoriza) return { resultado: 'cambio_no_autorizado', motivo: politica.motivo, lecturas: 1 };

  // 5a. Propuesta 2.0 desde la lectura confirmada.
  const captura = capturarIdentidadEInstantanea(requisito);
  const advertencias = advertenciasRequeridas(captura.instantanea_anterior, aplicarCambiosAInstantanea(captura.instantanea_anterior, politica.cambios));
  const propuestaId = e.uuid(), runId = e.uuid();
  const sobre = crearSobreRequisitoV2({
    fecha_propuesta: e.ahora().toISOString(), destino_id: destinoId.toHexString(), requisito_id: requisitoId.toHexString(),
    run_id_origen: runId, propuesta_id: propuestaId, ...captura, cambios: politica.cambios,
    fuentes: [{ nombre: lectura.fuente_nombre, url: lectura.url, capturado_en: lectura.revalidada_en.toISOString(),
      hechos: lectura.hechos, algoritmo_hechos_hash: lectura.algoritmo_hechos_hash, hechos_hash: lectura.hechos_hash }],
    advertencias
  });
  try {
    await new PropuestaCambio({ propuesta_id: propuestaId, destino_id: destinoId, requisito_id: requisitoId, campo: 'requisito', run_id_origen: runId,
      algoritmo_canonicalizacion: sobre.algoritmo_canonicalizacion, algoritmo_hash: sobre.algoritmo_hash, payload: sobre.payload, payload_hash: sobre.payload_hash }).save();
  } catch (err) {
    // Otra propuesta activa ganó la carrera (índice único de propuesta activa): no se duplica.
    if (err?.code === 11000) return { resultado: 'propuesta_activa_existente', lecturas: 1, pendiente: null };
    throw err;
  }

  // 5b. Decisión registrada bajo la política (evento de aprobación real).
  const decision = await D.decidirPropuesta({ tipo_evento: 'aprobacion', propuesta_id: propuestaId, estado_esperado: 'pendiente_aprobacion',
    payload_hash_esperado: sobre.payload_hash, version_coordinacion_esperada: 0, decision_aprobacion_id_esperado: null,
    version_contrato_esperada: '2.0', advertencias_aceptadas: [...sobre.payload.advertencias] },
  { ...D.crearDependenciasMongoose(e.conexion), uuid: e.uuid, ahora: e.ahora, resolverIdentidad: async () => structuredClone(IDENTIDAD_POLITICA) });
  if (decision?.resultado !== 'decision_registrada') return { resultado: 'decision_no_registrada', propuesta_id: propuestaId, detalle: decision?.resultado ?? null, lecturas: 1 };

  // 5c. Aplicación con H3.3 (revalida la ficha y escribe solo si los hechos siguen confirmados).
  const entrada = { propuesta_id: propuestaId, estado_esperado: 'aprobada', payload_hash_esperado: sobre.payload_hash,
    version_coordinacion_esperada: decision.version_coordinacion_nueva, decision_aprobacion_id_esperado: decision.evento_id };
  const r = await aplicarConRevalidacionV2(entrada, CREDENCIAL_PILOTO, e.depsAplicacion());
  const propuesta = await col('propuestas_cambio').findOne({ propuesta_id: propuestaId });
  const intento = r.intento_id ? await col('intentos_aplicacion').findOne({ intento_id: r.intento_id }) : null;
  const ultima = intento?.lecturas_fuente?.at(-1);
  const pendiente = propuesta.estado === 'revision_requerida'
    ? { tipo: 'revision_humana', propuesta_id: propuestaId, intento_id: r.intento_id, campos: (ultima?.campos_sin_confirmar ?? []).map(c => ({ ...c })) }
    : propuesta.estado === 'aprobada' && r.resultado !== 'exito' ? { tipo: 'reintentar', propuesta_id: propuestaId, intento_id: r.intento_id, codigo: ultima?.codigo_fallo ?? r.resultado } : null;
  return { resultado: r.resultado, propuesta_id: propuestaId, decision_evento_id: decision.evento_id, intento_id: r.intento_id,
    estado_propuesta: propuesta.estado, lecturas: 1 + (r.lecturas ?? 0), valor_aplicado: r.resultado === 'exito' ? politica.esperado : null, pendiente };
}

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
  const P = crearPersistenciaV2();
  const depsAplicacion = () => ({
    ahora, uuid, fetch,
    verificarIndices: async () => V2.verificarIndicesV2(await listados()),
    ejecutarTransaccion: fn => conexion.transaction(fn, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } }),
    leerPropuesta: (id, s) => conexion.db.collection('propuestas_cambio').findOne({ propuesta_id: id }, s ? { session: s } : {}),
    leerEvento: (id, s) => conexion.db.collection('eventos_propuesta').findOne({ evento_id: id }, s ? { session: s } : {}),
    ...P,
    ...V2.dependenciasDestino(Destino.collection),
    actualizarPropuestaCas: (f, upd, s) => conexion.db.collection('propuestas_cambio').updateOne(f, upd, { session: s })
  });
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
  log(`    resultado=${c.resultado}  lecturas=${c.lecturas}  destino_escrito=${c.destino_escrito ? 'sí' : 'no'}  propuestas_nuevas=${c.propuestas_nuevas}  historial_nuevo=${c.historial_nuevo}`);
  if (c.propuesta_id) log(`    propuesta=${c.propuesta_id}  estado=${c.estado_propuesta}${c.decision_evento_id ? `  decisión=${c.decision_evento_id}` : ''}${c.intento_id ? `  intento=${c.intento_id}` : ''}`);
  if (c.valor_aplicado) log(`    aplicado: obligatorio=${JSON.stringify(c.valor_aplicado)}`);
  if (c.pendiente) {
    const p = c.pendiente;
    log(`    pendiente: ${p.tipo}${p.motivo ? ` (${p.motivo})` : ''}${p.codigo ? ` (${p.codigo})` : ''}`);
    for (const campo of p.campos ?? []) log(`      - ${campo.campo}: ${campo.motivo}`);
  }
}
function imprimir(salida, log = console.log) {
  log(`Piloto CheckMig 2.0 (Mongo efímero, ficha simulada, política ${POLITICA_PILOTO.nombre} v${POLITICA_PILOTO.version})`);
  imprimirApi('antes', salida.api_antes, log);
  salida.ciclos.slice(0, 2).forEach((c, i) => imprimirCiclo(c, i, log));
  imprimirApi('tras las lecturas pendientes', salida.api_tras_pendientes, log);
  salida.ciclos.slice(2, 3).forEach((c, i) => imprimirCiclo(c, i + 2, log));
  imprimirApi('tras el cambio confirmado', salida.api_tras_cambio, log);
  salida.ciclos.slice(3).forEach((c, i) => imprimirCiclo(c, i + 3, log));
  imprimirApi('después', salida.api_despues, log);
}

module.exports = { POLITICA_PILOTO, IDENTIDAD_POLITICA, CREDENCIAL_PILOTO, evaluarPolitica, ejecutarCiclo, crearEntorno, demostrar, imprimir };

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
