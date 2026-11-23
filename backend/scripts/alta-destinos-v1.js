/**
 * Alta automática de destinos ausentes desde fuentes oficiales (v1). Dos modos; sin argumentos, ayuda.
 *
 *   node scripts/alta-destinos-v1.js --simular [--html RUTA_HTML]
 *     Lee la fuente OFICIAL de cada entrada de config/altas-destinos.json (o un HTML local) y muestra
 *     el destino que crearía. No conecta a ninguna base, no lee .env y no escribe nada.
 *     Salida: 0 alta aplicable · 3 revisión humana · 4 fuente no disponible · 1 error.
 *
 *   node scripts/alta-destinos-v1.js --ejecutar [--registro-local RUTA_NUEVA]
 *     Ejecución REAL. Misma configuración que el ciclo (MONGODB_URI_CICLO, OPERADORES_AUTORIZADOS_JSON
 *     y, para escribir, una entrada vigente de la política del perfil de alta en
 *     CICLO_V2_AUTORIZACION_JSON). Identidad por connectionStatus antes de leer la fuente.
 *     Modo informe (sin autorización vigente): lee, construye y compara, sin escribir; cualquier
 *     comando que no sea de lectura hace fallar la corrida. Una línea «REGISTRO_ALTA {json}» por entrada.
 *     Salida (la peor de las entradas): 0 creado o ya existente · 2 alta aplicable sin política ·
 *     3 revisión humana · 4 fuente caída · 1 error.
 */
const path = require('node:path');
const crypto = require('node:crypto');
const { readFileSync } = require('node:fs');

const AYUDA = 'Uso: node scripts/alta-destinos-v1.js --simular [--html RUTA_HTML] | --ejecutar [--registro-local RUTA_NUEVA] (ver docs/alta-destinos.md)';
const ENTRADA = path.join(__dirname, '..', 'config', 'altas-destinos.json');
const VERSION_REGISTRO = 'registro-alta-v1';
const sinUri = t => String(t ?? '').replace(/mongodb(\+srv)?:\/\/\S+/g, '<uri>').slice(0, 500);

function codigoSalida(resultado) {
  if (resultado === 'creado' || resultado === 'ya_existe') return 0;
  if (resultado === 'alta_aplicable') return 2;
  if (resultado === 'fuente_no_disponible') return 4;
  if (resultado === 'error') return 1;
  return 3;
}
const peor = codigos => (codigos.includes(1) ? 1 : Math.max(0, ...codigos));

function registroAlta({ iniciado_en, terminado_en, modo, autorizacion, motivo_sin_politica, proceso, r, error, comandos, codigo, objetivo }) {
  return {
    version: VERSION_REGISTRO, comando: 'alta-destinos-v1 --ejecutar', iniciado_en, terminado_en, modo,
    perfil: objetivo?.perfil?.nombre ?? null, codigo_iso: objetivo?.codigo_iso ?? null, pais: objetivo?.pais ?? null,
    politica: autorizacion ? { nombre: autorizacion.politica, autorizada_por: autorizacion.autorizada_por, vence_en: autorizacion.vence_en } : null,
    motivo_sin_politica: motivo_sin_politica ?? null, proceso: proceso ?? null,
    resultado: error ? 'error' : r.resultado, motivo: error ? null : r.motivo ?? null, error: error ? sinUri(error.message ?? error) : null, codigo_salida: codigo,
    destino_id: r?.destino_id ?? null, alta_id: r?.alta_id ?? null, lecturas: r?.lecturas ?? [], hechos_hash: r?.hechos_hash ?? null,
    contexto_viajero: r?.contexto_viajero ?? null, requisitos_confirmados: r?.requisitos_confirmados ?? null, requisitos_a_verificar: r?.requisitos_a_verificar ?? null,
    pendiente: r?.pendiente ?? null, comandos: [...new Set(comandos)].sort()
  };
}

function lineaResumen(g) {
  const det = g.resultado === 'creado' ? `ALTA CREADA: destino ${g.destino_id}, alta ${g.alta_id}; confirmados ${g.requisitos_confirmados.join(', ')}; a verificar ${g.requisitos_a_verificar.length}`
    : g.pendiente ? `pendiente: ${g.pendiente.tipo}${g.pendiente.motivo ? ` (${g.pendiente.motivo})` : ''}` : '-';
  const celdas = [`alta ${g.perfil ?? '-'}`, g.codigo_iso ?? '-', g.modo ?? '-', g.resultado + (g.motivo ? ` (${g.motivo})` : ''), String(g.codigo_salida),
    g.lecturas.length ? g.lecturas.map(l => `HTTP ${l.http_status ?? '-'}`).join(', ') : '-', det];
  return `| ${celdas.map(c => String(c).replace(/[|\r\n]/g, ' ')).join(' | ')} |`;
}

/**
 * deps (pruebas): { conexion, usuariosAutenticados, fetch, ahora, uuid, entrada, resumen }.
 * Devuelve el código de salida. No lanza.
 */
async function ejecutarReal(env = process.env, log = console.log, deps = {}, { registroLocal = null } = {}) {
  const mongoose = require('../config/mongoose');
  const R = require('../services/propuestas/ciclo/config-ciclo-real');
  const A = require('../services/propuestas/altas/alta-destino-v1');
  const { resolverActor } = require('../services/propuestas/operadores-autorizados');
  const { usuariosAutenticadosDe } = require('../services/propuestas/decidir-propuesta');
  const { COMANDOS_INFORME } = require('./ciclo-checkmig-v2');
  const ahora = deps.ahora ?? (() => new Date());
  const iniciado_en = ahora().toISOString();
  const registros = [];
  let comandos = [];
  const espia = e => comandos.push(e.commandName);
  let cliente = null, propia = false, base = null, objetivos = null, proceso = null, errorGeneral = null;
  try {
    base = R.cargarBaseCiclo(env);
    objetivos = A.validarEntrada(deps.entrada ?? JSON.parse(readFileSync(ENTRADA, 'utf8')));
    let conexion = deps.conexion;
    if (!conexion) {
      await mongoose.connect(base.uri, { autoIndex: false, autoCreate: false, monitorCommands: true });
      conexion = mongoose.connection;
      propia = true;
    }
    cliente = conexion.getClient();
    cliente.on('commandStarted', espia);
    const usuarios = await (deps.usuariosAutenticados ?? (() => usuariosAutenticadosDe(conexion)))();
    const p = resolverActor(usuarios, base.operadores);
    proceso = { identificador: p.actor.identificador, usuario_atlas: p.identidad_operador.usuario_atlas, db_autenticacion: p.identidad_operador.db_autenticacion };
    for (const objetivo of objetivos) {
      comandos = [];
      let r = null, error = null, aut = { autorizacion: null, motivo: null };
      try {
        aut = R.leerAutorizacion(env, ahora(), A.clavePolitica(objetivo.perfil));
        const a = aut.autorizacion;
        r = await A.ejecutarAlta(objetivo, { conexion, fetch: deps.fetch ?? globalThis.fetch, ahora, uuid: deps.uuid ?? (() => crypto.randomUUID()),
          politicaHabilitada: a !== null,
          identidad: a ? { politica: a.politica, autorizada_por: a.autorizada_por, autorizada_en: a.autorizada_en, vence_en: a.vence_en, ...proceso, proceso: proceso.identificador } : null });
      } catch (e) { error = e; }
      const fuera = aut.autorizacion === null ? [...new Set(comandos.filter(x => !COMANDOS_INFORME.includes(x)))] : [];
      if (!error && fuera.length) error = new Error(`modo informe: comandos no permitidos observados: ${fuera.join(', ')}`);
      const codigo = error ? 1 : codigoSalida(r.resultado);
      registros.push(registroAlta({ iniciado_en, terminado_en: ahora().toISOString(), modo: aut.autorizacion ? 'politica_automatica' : 'informe', autorizacion: aut.autorizacion,
        motivo_sin_politica: aut.motivo, proceso, r, error, comandos, codigo, objetivo }));
    }
  } catch (e) {
    errorGeneral = e;
  } finally {
    cliente?.off('commandStarted', espia);
    if (propia) await mongoose.disconnect().catch(() => {});
  }
  if (errorGeneral) registros.push(registroAlta({ iniciado_en, terminado_en: ahora().toISOString(), modo: null, proceso, r: null, error: errorGeneral, comandos, codigo: 1 }));
  for (const g of registros) {
    if (g.error) log(`alta: ${g.error}`);
    else log(`alta ${g.codigo_iso}: resultado=${g.resultado}${g.motivo ? ` (${g.motivo})` : ''} modo=${g.modo} lecturas=${g.lecturas.length}${g.alta_id ? ` alta=${g.alta_id}` : ''}`);
    log(`REGISTRO_ALTA ${JSON.stringify(g)}`);
    if (deps.resumen) deps.resumen(lineaResumen(g));
  }
  if (registroLocal) {
    try { require('node:fs').writeFileSync(registroLocal, `${JSON.stringify(registros, null, 2)}\n`, { flag: 'wx' }); }
    catch (e) { log(`alta: no se pudo guardar el registro local (${e.code ?? 'error'})`); return 1; }
  }
  return peor(registros.map(g => g.codigo_salida));
}

// Simulación sin base: lectura real (o HTML local) y el destino que se crearía.
async function simular({ fetch, ahora = () => new Date() }) {
  const A = require('../services/propuestas/altas/alta-destino-v1');
  const { fechaMontevideo } = require('../services/propuestas/plan-aplicacion-requisito-v2');
  const salida = [];
  for (const objetivo of A.validarEntrada(JSON.parse(readFileSync(ENTRADA, 'utf8')))) {
    const leer = () => objetivo.perfil.adaptador.leer({ fetch, ahora });
    const l1 = await leer();
    if (l1.tipo !== 'hechos') { salida.push({ objetivo, resultado: l1.tipo === 'no_disponible' ? 'fuente_no_disponible' : 'revision_humana', lectura: l1 }); continue; }
    const l2 = await leer();
    if (l2.tipo !== 'hechos' || l2.hechos_hash !== l1.hechos_hash) { salida.push({ objetivo, resultado: l2.tipo === 'no_disponible' ? 'fuente_no_disponible' : 'revision_humana', lectura: l2 }); continue; }
    salida.push({ objetivo, resultado: 'alta_aplicable', lectura: l1, destino: await A.construirDestino(objetivo, l1, { hoy: fechaMontevideo(l1.revalidada_en), ahora: ahora() }) });
  }
  return salida;
}

function leerOpciones(args) {
  if (args[0] === '--ejecutar' && args.length === 1) return { modo: 'ejecutar', registroLocal: null };
  if (args[0] === '--ejecutar' && args.length === 3 && args[1] === '--registro-local' && args[2] && !args[2].startsWith('--')) return { modo: 'ejecutar', registroLocal: path.resolve(args[2]) };
  if (args[0] === '--simular' && args.length === 1) return { modo: 'simular', html: null };
  if (args[0] === '--simular' && args.length === 3 && args[1] === '--html' && args[2]) return { modo: 'simular', html: path.resolve(args[2]) };
  return null;
}

module.exports = { ejecutarReal, simular, leerOpciones, codigoSalida, registroAlta, lineaResumen, VERSION_REGISTRO };

if (require.main === module) {
  (async () => {
    const o = leerOpciones(process.argv.slice(2));
    if (!o) { console.log(AYUDA); process.exitCode = process.argv.length > 2 ? 1 : 0; return; }
    try {
      if (o.modo === 'ejecutar') {
        const archivo = process.env.GITHUB_STEP_SUMMARY;
        const resumen = archivo ? l => { try { require('node:fs').appendFileSync(archivo, `${l}\n`); } catch { /* opcional */ } } : undefined;
        process.exitCode = await ejecutarReal(process.env, console.log, { resumen }, { registroLocal: o.registroLocal });
        return;
      }
      const html = o.html ? readFileSync(o.html, 'utf8') : null;
      const fetch = html === null ? globalThis.fetch : async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
      const codigos = [];
      for (const s of await simular({ fetch })) {
        const d = s.lectura.diagnostico ?? {};
        console.log(`Alta ${s.objetivo.codigo_iso} (${s.objetivo.pais}) — SIMULACIÓN (sin base de datos). Fuente: ${s.lectura.url} (${html === null ? 'consulta real' : `HTML local ${path.basename(o.html)}`})`);
        console.log(`Lectura: ${s.lectura.tipo}  consultado_en=${d.consultado_en ?? '-'}  http=${d.http_status ?? '-'}  contenido_sha256=${d.contenido_sha256 ?? '-'}`);
        console.log(`RESULTADO: ${s.resultado}${s.lectura.motivo ? ` (${s.lectura.motivo})` : ''}`);
        if (s.destino) {
          console.log(`Hechos: ${JSON.stringify(s.lectura.hechos)}  hechos_hash=${s.lectura.hechos_hash}`);
          for (const e of s.lectura.evidencia.visa.concat(s.lectura.evidencia.estancia)) console.log(`  evidencia: ${e}`);
          for (const r of s.destino.requisitos) console.log(`  ${r.tipo}: obligatorio=${r.obligatorio} estado=${r.estado}${r.fecha_verificacion ? ` fecha_verificacion=${r.fecha_verificacion}` : ''} — ${r.descripcion}`);
        }
        codigos.push(s.resultado === 'alta_aplicable' ? 0 : codigoSalida(s.resultado));
      }
      process.exitCode = peor(codigos);
    } catch (err) {
      console.error(`alta: ${sinUri(err?.message ?? err)}`);
      process.exitCode = 1;
    }
  })();
}
