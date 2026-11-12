/**
 * Corrección puntual de UN requisito publicado, con plan, hash, respaldo y reversión.
 * Reutilizable: la corrección se describe en scripts/correcciones/<id>.json.
 *
 *   node scripts/corregir-requisito.js --preparar ESPEC.json --salida PLAN_NUEVO.json
 *       Lee la API pública (GET) y la fuente oficial, y escribe el plan. No conecta a ninguna base.
 *   node scripts/corregir-requisito.js --mostrar PLAN.json
 *       Antes, después, fecha de verificación y hashes de confirmación. Sin red ni base.
 *   node scripts/corregir-requisito.js --verificar PLAN.json --esperado despues|antes
 *       GET de la API pública y comparación con el estado esperado. Sin base.
 *   MONGODB_URI_DECISION=… node scripts/corregir-requisito.js --aplicar PLAN.json --confirmo HASH --respaldo RUTA_NUEVA
 *   MONGODB_URI_DECISION=… node scripts/corregir-requisito.js --revertir PLAN.json --confirmo HASH_REVERSION --respaldo RUTA_NUEVA
 *       Escritura con el driver nativo (sin modelos ni Mongoose, sin .env), solo con el usuario
 *       operador del plan (connectionStatus). Identifica destino y requisito por _id, exige que el
 *       requisito sea EXACTAMENTE el estado anterior (lectura) y lo vuelve a exigir en el filtro del
 *       update (CAS); si encuentra otro estado, aborta sin escribir. Antes del update guarda el
 *       documento completo (EJSON canónico) en un respaldo nuevo (wx + fsync). Después relee y
 *       comprueba que solo cambió ese requisito (y updatedAt).
 *   La reversión es la misma operación con los estados invertidos y su propia precondición: solo
 *   escribe si el requisito está exactamente como lo dejó la corrección.
 *
 * Salida: 0 ok · 3 estado distinto o cambio concurrente (nada escrito) · 1 error.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
// Del driver: los documentos leídos traen su ObjectId (instanceof fiable).
const { ObjectId, BSON } = require('mongodb');
const { EJSON } = BSON;

const VERSION_PLAN = 'correccion-requisito-v1';
const VIGENCIA_PLAN_MS = 72 * 60 * 60 * 1000;
const COMANDOS_PERMITIDOS = ['connectionStatus', 'find', 'update', 'endSessions'];

class ErrorPlan extends Error {}
class ErrorEstadoDistinto extends Error { constructor(m, diferencias) { super(m); this.diferencias = diferencias; } }

// Canónico: claves ordenadas, sin undefined. Mismo texto → mismo hash.
function canonico(v) {
  if (v === undefined) throw new ErrorPlan('el plan no admite undefined.');
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonico).join(',')}]`;
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonico(v[k])}`).join(',')}}`;
}
const sha256 = t => crypto.createHash('sha256').update(t).digest('hex');
const hashPlan = plan => { const { hash, hash_reversion, ...resto } = plan; return sha256(canonico(resto)); };
const hashReversion = plan => sha256(canonico({ version: plan.version, id: plan.id, base_datos: plan.base_datos, operador_esperado: plan.operador_esperado,
  destino: plan.destino, requisito: plan.requisito, desde: plan.despues, hacia: plan.antes }));

// ------------------------------------------------------------------
// Preparación: API pública + fuente oficial → plan (sin base de datos)
// ------------------------------------------------------------------

const fechaDia = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

async function prepararPlan(espec, { fetch = globalThis.fetch, ahora = () => new Date() } = {}) {
  const t0 = ahora();
  const r = await fetch(espec.api, { headers: { accept: 'application/json', 'user-agent': 'buscador-requisitos-viaje/corregir-requisito' }, signal: AbortSignal.timeout(20000) });
  if (r.status !== 200) throw new ErrorPlan(`API pública: HTTP ${r.status}.`);
  const texto = await r.text();
  const destino = JSON.parse(texto);
  if (destino._id !== espec.destino._id || destino.codigo_iso !== espec.destino.codigo_iso) throw new ErrorPlan('API pública: el destino no coincide con la especificación.');
  const candidatos = (destino.requisitos ?? []).filter(x => x._id === espec.requisito._id);
  if (candidatos.length !== 1) throw new ErrorPlan(`API pública: se esperaba un requisito ${espec.requisito._id} (hay ${candidatos.length}).`);
  const mismosNombre = destino.requisitos.filter(x => x.tipo === espec.requisito.tipo && x.nombre === espec.requisito.nombre);
  if (mismosNombre.length !== 1 || mismosNombre[0]._id !== espec.requisito._id) throw new ErrorPlan('API pública: el requisito objetivo no es único por tipo y nombre.');
  const { _id, ...publicado } = candidatos[0];
  // La API castea fecha_verificacion a Date (ISO a medianoche); en la base es texto YYYY-MM-DD.
  const antes = { ...publicado, ...(publicado.fecha_verificacion !== undefined ? { fecha_verificacion: fechaDia(publicado.fecha_verificacion) } : {}) };
  for (const [k, v] of Object.entries(antes)) if (typeof v !== 'string') throw new ErrorPlan(`API pública: ${k} no es texto; esta corrección solo admite campos de texto.`);

  // Evidencia del día: la ficha (adaptador real) y el enlace nuevo.
  const perfil = require('../services/propuestas/ciclo/perfil-checkmig-colombia');
  const { fechaMontevideo } = require('../services/propuestas/plan-aplicacion-requisito-v2');
  const lectura = await perfil.adaptador.leer({ fetch, ahora });
  if (lectura.tipo !== 'hechos') throw new ErrorPlan(`fuente oficial: lectura ${lectura.tipo}; sin hechos confirmados no se prepara la corrección.`);
  const h = lectura.hechos, esp = espec.respaldo_de_la_descripcion;
  const respalda = h.obligatoriedad === esp.obligatoriedad && canonico(h.alcance.sentidos) === canonico(esp.sentidos)
    && h.ventana_horas_antes.maximo_horas_antes === esp.maximo_horas_antes && h.ventana_horas_antes.minimo_horas_antes === esp.minimo_horas_antes;
  if (!respalda) throw new ErrorPlan('fuente oficial: los hechos de hoy no respaldan la descripción nueva.');
  const esperadoObligatorio = h.obligatoriedad === 'obligatorio' ? 'si' : 'no';
  if (espec.cambios.obligatorio !== undefined && espec.cambios.obligatorio !== esperadoObligatorio) throw new ErrorPlan('fuente oficial: el obligatorio pedido no es el de la ficha.');
  const enlace = async url => {
    try {
      const e = await fetch(url, { redirect: 'manual', headers: { accept: 'text/html', 'user-agent': 'buscador-requisitos-viaje/verificacion-enlace' }, signal: AbortSignal.timeout(20000) });
      const cuerpo = await e.text();
      const titulo = (cuerpo.match(/<title[^>]*>([\s\S]*?)<\/title>/i) ?? [])[1]?.replace(/\s+/g, ' ').trim() ?? null;
      return { url, http_status: e.status, content_type: e.headers.get('content-type'), titulo };
    } catch (err) { return { url, http_status: null, error: err?.name ?? 'error' }; }
  };
  const enlaceNuevo = await enlace(espec.cambios.link ?? antes.link);
  const enlaceAnterior = antes.link && antes.link !== espec.cambios.link ? await enlace(antes.link) : null;
  const enlaceOk = enlaceNuevo.http_status === 200 && /^text\/html/i.test(enlaceNuevo.content_type ?? '');
  if (!enlaceOk) throw new ErrorPlan('enlace nuevo: no responde 200 text/html; no se prepara la corrección.');

  // Fecha de verificación, aparte: se renueva solo si TODOS los campos del registro corregido
  // tienen evidencia de hoy (ver docs/correccion-co-checkmig.md).
  const despuesSinFecha = { ...antes, ...espec.cambios };
  const cubiertos = { obligatorio: 'ficha (obligatoriedad)', descripcion: 'ficha (obligatoriedad, sentidos y ventana)', fuente: 'es la ficha leída', link: 'GET 200 del enlace',
    tipo: 'identidad del requisito', nombre: 'identidad del requisito', estado: 'sin cambio (confirmado)', fecha_verificacion: 'este bloque' };
  const sinEvidencia = Object.keys(despuesSinFecha).filter(k => !cubiertos[k]);
  const hoy = fechaMontevideo(t0);
  const renovar = espec.fecha_verificacion === 'renovar_si_la_evidencia_del_dia_cubre_todos_los_campos' && sinEvidencia.length === 0 && despuesSinFecha.fuente === lectura.url;
  const despues = { ...despuesSinFecha, ...(renovar ? { fecha_verificacion: hoy } : {}) };
  const plan = {
    version: VERSION_PLAN, id: espec.id, descripcion: espec.descripcion,
    creado_en: t0.toISOString(), vence_en: new Date(t0.getTime() + VIGENCIA_PLAN_MS).toISOString(),
    base_datos: espec.base_datos, operador_esperado: espec.operador_esperado,
    destino: { _id: espec.destino._id, codigo_iso: espec.destino.codigo_iso, pais: destino.pais },
    requisito: { ...espec.requisito },
    antes, despues,
    campos_cambiados: Object.keys(despues).filter(k => antes[k] !== despues[k]).sort(),
    fecha_verificacion: { antes: antes.fecha_verificacion ?? null, despues: despues.fecha_verificacion ?? null, renovada: renovar,
      motivo: renovar ? 'Todos los campos del registro corregido tienen evidencia del día (ficha leída y enlace verificado).' : `No se renueva: sin evidencia para ${sinEvidencia.join(', ') || 'la fuente'}.` },
    evidencia: {
      api: { url: espec.api, consultado_en: t0.toISOString(), http_status: r.status, sha256: sha256(texto), destino_updatedAt: destino.updatedAt ?? null },
      ficha: { url: lectura.url, consultado_en: lectura.diagnostico.consultado_en, http_status: lectura.diagnostico.http_status, hechos_hash: lectura.hechos_hash,
        contenido_sha256: lectura.diagnostico.contenido_sha256, hechos: lectura.hechos, evidencia_obligatoriedad: lectura.evidencia.obligatoriedad[0] },
      enlace_nuevo: enlaceNuevo, enlace_anterior: enlaceAnterior
    }
  };
  plan.hash = hashPlan(plan);
  plan.hash_reversion = hashReversion(plan);
  return plan;
}

// ------------------------------------------------------------------
// Validación del plan
// ------------------------------------------------------------------

function validarPlan(plan, { modo, confirmo, ahora }) {
  if (plan?.version !== VERSION_PLAN) throw new ErrorPlan('versión de plan desconocida.');
  if (hashPlan(plan) !== plan.hash) throw new ErrorPlan('el plan fue alterado (hash distinto).');
  if (hashReversion(plan) !== plan.hash_reversion) throw new ErrorPlan('la reversión del plan fue alterada.');
  if (!ObjectId.isValid(plan.destino._id) || !ObjectId.isValid(plan.requisito._id)) throw new ErrorPlan('ids inválidos.');
  if (!plan.campos_cambiados.length) throw new ErrorPlan('el plan no cambia nada.');
  const esperado = modo === 'correccion' ? plan.hash : plan.hash_reversion;
  if (confirmo !== esperado) throw new ErrorPlan(`--confirmo no coincide con el hash de ${modo === 'correccion' ? 'la corrección' : 'la reversión'}.`);
  // La corrección usa evidencia del día: vence. La reversión no vence (su precondición la protege).
  if (modo === 'correccion') {
    const t = ahora().getTime();
    if (t < Date.parse(plan.creado_en) || t > Date.parse(plan.vence_en)) throw new ErrorPlan('el plan venció o es del futuro: volver a preparar.');
  }
}

// ------------------------------------------------------------------
// Escritura (driver nativo)
// ------------------------------------------------------------------

function diferencias(actual, esperado) {
  const claves = [...new Set([...Object.keys(actual), ...Object.keys(esperado)])].sort();
  return claves.filter(k => !(typeof actual[k] === 'string' && actual[k] === esperado[k]))
    .map(k => ({ campo: k, actual: actual[k] === undefined ? '(ausente)' : actual[k] instanceof Date ? `Date(${actual[k].toISOString()})` : actual[k], esperado: esperado[k] ?? '(ausente)' }));
}

/**
 * modo 'correccion': antes → despues; modo 'reversion': despues → antes.
 * deps: { client (MongoClient conectado), ahora, respaldo (ruta nueva), antesDeEscribir? (pruebas) }
 */
async function aplicarPlan(plan, modo, deps) {
  const desde = modo === 'correccion' ? plan.antes : plan.despues;
  const hacia = modo === 'correccion' ? plan.despues : plan.antes;
  const comandos = [];
  const espia = e => comandos.push(e.commandName);
  deps.client.on('commandStarted', espia);
  try {
    const admin = deps.client.db('admin');
    const estado = await admin.command({ connectionStatus: 1 });
    const usuarios = estado?.authInfo?.authenticatedUsers ?? [];
    if (!deps.omitirOperador && !(usuarios.length === 1 && usuarios[0].user === plan.operador_esperado.user && usuarios[0].db === plan.operador_esperado.db)) {
      throw new ErrorPlan(`la conexión no es la del operador ${plan.operador_esperado.user}@${plan.operador_esperado.db}.`);
    }
    const col = deps.client.db(plan.base_datos).collection('destinos');
    const destinoId = ObjectId.createFromHexString(plan.destino._id), requisitoId = ObjectId.createFromHexString(plan.requisito._id);
    const leido = await col.findOne({ _id: destinoId });
    if (!leido) throw new ErrorEstadoDistinto('el destino no existe.', []);
    if (leido.codigo_iso !== plan.destino.codigo_iso) throw new ErrorEstadoDistinto('el destino no tiene el código esperado.', []);
    const mismos = (leido.requisitos ?? []).filter(x => x?._id instanceof ObjectId && x._id.equals(requisitoId));
    if (mismos.length !== 1) throw new ErrorEstadoDistinto(`se esperaba un requisito con el _id objetivo (hay ${mismos.length}).`, []);
    const { _id, ...actual } = mismos[0];
    const difs = diferencias(actual, desde);
    if (difs.length) throw new ErrorEstadoDistinto('el requisito no está en el estado esperado; no se escribe.', difs);

    // Respaldo del documento completo ANTES de escribir (archivo nuevo, no sobrescribe).
    const respaldo = { plan_id: plan.id, plan_hash: plan.hash, modo, leido_en: deps.ahora().toISOString(), base_datos: plan.base_datos, destino: EJSON.serialize(leido, { relaxed: false }) };
    const textoRespaldo = `${JSON.stringify(respaldo, null, 2)}\n`;
    const fd = fs.openSync(deps.respaldo, 'wx');
    try { fs.writeSync(fd, textoRespaldo); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }

    if (deps.antesDeEscribir) await deps.antesDeEscribir();

    // CAS: el elemento debe seguir exactamente en el estado leído (cada campo, como texto) y ser único.
    const condicion = Object.fromEntries(Object.entries(desde).map(([k, v]) => [k, { $eq: v, $type: 'string' }]));
    const t = deps.ahora();
    const set = { updatedAt: t };
    for (const [k, v] of Object.entries(hacia)) if (desde[k] !== v) set[`requisitos.$[r].${k}`] = v;
    const unset = {};
    for (const k of Object.keys(desde)) if (!(k in hacia)) unset[`requisitos.$[r].${k}`] = '';
    const filtro = {
      _id: destinoId,
      requisitos: { $elemMatch: { _id: requisitoId, ...condicion } },
      $expr: { $eq: [{ $size: { $filter: { input: '$requisitos', as: 'x', cond: { $eq: ['$$x._id', requisitoId] } } } }, 1] }
    };
    const res = await col.updateOne(filtro, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
      { arrayFilters: [{ 'r._id': requisitoId, ...Object.fromEntries(Object.entries(condicion).map(([k, v]) => [`r.${k}`, v])) }] });
    if (res.matchedCount === 0) throw new ErrorEstadoDistinto('cambio concurrente: el requisito cambió entre la lectura y la escritura; no se escribió nada.', []);
    if (res.matchedCount !== 1 || res.modifiedCount !== 1) throw new Error(`update inesperado: matched=${res.matchedCount} modified=${res.modifiedCount}.`);

    // Relectura: solo cambió ese requisito (y updatedAt).
    const final = await col.findOne({ _id: destinoId });
    const sinUpdated = d => { const { updatedAt, ...resto } = d; return resto; };
    const clonar = d => EJSON.deserialize(EJSON.serialize(d, { relaxed: false }), { relaxed: false });
    const esperadoFinal = clonar(leido);
    const i = esperadoFinal.requisitos.findIndex(x => x?._id instanceof ObjectId && x._id.equals(requisitoId));
    esperadoFinal.requisitos[i] = { _id: requisitoId, ...Object.fromEntries(Object.entries({ ...actual, ...hacia }).filter(([k]) => k in hacia)) };
    const igual = EJSON.stringify(sinUpdated(final), { relaxed: false }) === EJSON.stringify(sinUpdated(reordenar(esperadoFinal, final)), { relaxed: false });
    return { resultado: igual ? 'aplicada' : 'aplicada_con_diferencias', modo, matched: res.matchedCount, modified: res.modifiedCount, updatedAt: t.toISOString(),
      respaldo: deps.respaldo, respaldo_sha256: sha256(textoRespaldo), comandos: [...comandos], campos: Object.keys(set).filter(k => k !== 'updatedAt').map(k => k.replace('requisitos.$[r].', '')) };
  } finally {
    deps.client.off('commandStarted', espia);
    const fuera = comandos.filter(c => !COMANDOS_PERMITIDOS.includes(c));
    if (fuera.length) throw new Error(`comandos no permitidos enviados: ${[...new Set(fuera)].join(', ')}`);
  }
}

// Mongo conserva el orden de claves del elemento al hacer $set de campos existentes: se compara
// con el mismo orden que devolvió la relectura.
function reordenar(esperado, final) {
  const r = { ...esperado, requisitos: [...esperado.requisitos] };
  r.requisitos = r.requisitos.map((x, i) => {
    const orden = Object.keys(final.requisitos?.[i] ?? {});
    return Object.fromEntries([...orden.filter(k => k in x).map(k => [k, x[k]]), ...Object.keys(x).filter(k => !orden.includes(k)).map(k => [k, x[k]])]);
  });
  return Object.fromEntries([...Object.keys(final).filter(k => k in r).map(k => [k, r[k]]), ...Object.keys(r).filter(k => !(k in final)).map(k => [k, r[k]])]);
}

// ------------------------------------------------------------------
// Verificación vía API pública
// ------------------------------------------------------------------

async function verificarApi(plan, esperado, { fetch = globalThis.fetch } = {}) {
  const r = await fetch(plan.evidencia.api.url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  const d = await r.json();
  const req = (d.requisitos ?? []).filter(x => x._id === plan.requisito._id);
  if (req.length !== 1) return { ok: false, http_status: r.status, motivo: `requisitos con el _id objetivo: ${req.length}` };
  const { _id, ...publicado } = req[0];
  const normalizado = { ...publicado, ...(publicado.fecha_verificacion !== undefined ? { fecha_verificacion: fechaDia(publicado.fecha_verificacion) } : {}) };
  const objetivo = esperado === 'antes' ? plan.antes : plan.despues;
  const difs = diferencias(normalizado, objetivo);
  return { ok: difs.length === 0, http_status: r.status, diferencias: difs, publicado: normalizado };
}

// ------------------------------------------------------------------
// CLI
// ------------------------------------------------------------------

function mostrar(plan, log = console.log) {
  log(`Plan ${plan.id} (${plan.version}) · creado ${plan.creado_en} · vence ${plan.vence_en}`);
  log(`Destino ${plan.destino.codigo_iso} ${plan.destino._id} · requisito ${plan.requisito.nombre} ${plan.requisito._id} · base ${plan.base_datos} · operador ${plan.operador_esperado.user}@${plan.operador_esperado.db}`);
  for (const k of Object.keys({ ...plan.antes, ...plan.despues })) {
    const a = plan.antes[k], d = plan.despues[k];
    log(`  ${a === d ? ' ' : '*'} ${k}: ${JSON.stringify(a)}${a === d ? '' : ` → ${JSON.stringify(d)}`}`);
  }
  log(`Fecha de verificación: ${plan.fecha_verificacion.antes} → ${plan.fecha_verificacion.despues} (${plan.fecha_verificacion.renovada ? 'renovada' : 'sin cambio'}). ${plan.fecha_verificacion.motivo}`);
  const e = plan.evidencia;
  log(`Evidencia: API ${e.api.http_status} sha256 ${e.api.sha256} · ficha ${e.ficha.http_status} hechos_hash ${e.ficha.hechos_hash} (${e.ficha.consultado_en}) · enlace nuevo ${e.enlace_nuevo.http_status} «${e.enlace_nuevo.titulo}»${e.enlace_anterior ? ` · enlace anterior ${e.enlace_anterior.http_status}` : ''}`);
  log(`Confirmación de la corrección: ${plan.hash}`);
  log(`Confirmación de la reversión:  ${plan.hash_reversion}`);
}

async function principal(args, env = process.env, log = console.log) {
  const a = Object.fromEntries(args.reduce((acc, x, i) => (x.startsWith('--') ? [...acc, [x.slice(2), args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true]] : acc), []));
  const leerJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
  if (a.preparar) {
    if (typeof a.salida !== 'string') throw new ErrorPlan('falta --salida PLAN_NUEVO.json.');
    const plan = await prepararPlan(leerJson(a.preparar));
    fs.writeFileSync(a.salida, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx' });
    mostrar(plan, log);
    return 0;
  }
  if (a.mostrar) { const plan = leerJson(a.mostrar); validarPlan(plan, { modo: 'correccion', confirmo: plan.hash, ahora: () => new Date(Date.parse(plan.creado_en)) }); mostrar(plan, log); return 0; }
  if (a.verificar) {
    const v = await verificarApi(leerJson(a.verificar), a.esperado === 'antes' ? 'antes' : 'despues');
    log(`API pública: HTTP ${v.http_status} · ${v.ok ? 'coincide' : 'NO coincide'} con el estado ${a.esperado === 'antes' ? 'anterior' : 'corregido'}`);
    for (const d of v.diferencias ?? []) log(`  ${d.campo}: publicado=${JSON.stringify(d.actual)} esperado=${JSON.stringify(d.esperado)}`);
    return v.ok ? 0 : 3;
  }
  const modo = a.aplicar ? 'correccion' : a.revertir ? 'reversion' : null;
  if (!modo) { log('Uso: --preparar ESPEC --salida PLAN | --mostrar PLAN | --verificar PLAN --esperado despues|antes | --aplicar PLAN --confirmo HASH --respaldo RUTA | --revertir PLAN --confirmo HASH --respaldo RUTA'); return args.length ? 1 : 0; }
  const plan = leerJson(a.aplicar || a.revertir);
  validarPlan(plan, { modo, confirmo: a.confirmo, ahora: () => new Date() });
  if (typeof a.respaldo !== 'string' || fs.existsSync(a.respaldo)) throw new ErrorPlan('--respaldo debe ser una ruta NUEVA.');
  const uri = env.MONGODB_URI_DECISION;
  if (typeof uri !== 'string' || !/^mongodb(\+srv)?:\/\//.test(uri)) throw new ErrorPlan('MONGODB_URI_DECISION ausente.');
  if (env.MONGODB_URI && env.MONGODB_URI === uri) throw new ErrorPlan('MONGODB_URI_DECISION no puede ser la URI de la app.');
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(uri, { monitorCommands: true, retryWrites: false });
  await client.connect();
  try {
    const r = await aplicarPlan(plan, modo, { client, ahora: () => new Date(), respaldo: path.resolve(a.respaldo) });
    log(`${modo}: ${r.resultado} · matched ${r.matched} · modified ${r.modified} · campos ${r.campos.join(', ')} · updatedAt ${r.updatedAt}`);
    log(`respaldo: ${r.respaldo} (sha256 ${r.respaldo_sha256}) · comandos: ${[...new Set(r.comandos)].join(', ')}`);
    return r.resultado === 'aplicada' ? 0 : 1;
  } finally { await client.close(); }
}

module.exports = { VERSION_PLAN, ErrorPlan, ErrorEstadoDistinto, canonico, hashPlan, hashReversion, prepararPlan, validarPlan, aplicarPlan, verificarApi, mostrar, principal };

if (require.main === module) {
  principal(process.argv.slice(2)).then(c => { process.exitCode = c; }, err => {
    console.error(`corrección: ${err?.message ?? err}`);
    for (const d of err?.diferencias ?? []) console.error(`  ${d.campo}: actual=${JSON.stringify(d.actual)} esperado=${JSON.stringify(d.esperado)}`);
    process.exitCode = err instanceof ErrorEstadoDistinto ? 3 : 1;
  });
}
