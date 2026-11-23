/**
 * Ciclo de CheckMig (Colombia) 2.0. Dos modos; sin argumentos solo muestra la ayuda.
 *
 *   node scripts/ciclo-checkmig-v2.js --simular [--registro RUTA_JSON] [--html RUTA_HTML]
 *     Consulta la ficha OFICIAL con el adaptador real (o un HTML local con --html) y muestra qué
 *     haría el ciclo con un REGISTRO DE PRUEBA (por defecto, la copia local del Check-Mig
 *     publicado en scripts/fixtures/checkmig/registro-publicado-2026-10-21.json). No conecta a
 *     ninguna base, no lee .env y no escribe nada.
 *     Salida: 0 sin cambio · 2 cambio aplicable · 3 revisión humana · 4 fuente no disponible · 1 error.
 *
 *   node scripts/ciclo-checkmig-v2.js --ejecutar [--perfil NOMBRE] [--registro-local RUTA_NUEVA]
 *     Ejecución REAL (tarea diaria) de UN perfil (services/propuestas/ciclo/perfiles.js; sin
 *     --perfil, checkmig-colombia, como hasta ahora). El workflow corre un proceso por perfil.
 *     Requiere la configuración de config-ciclo-real.js en el entorno (MONGODB_URI_CICLO, OPERADORES_AUTORIZADOS_JSON y, para escribir,
 *     CICLO_V2_AUTORIZACION_JSON). Prechequeo de solo lectura (identidad, índices, destino) antes
 *     de leer la fuente; luego el ciclo compartido con H3.3.
 *     Modo informe (sin autorización vigente): lee y compara, no escribe. Todo comando que no sea
 *     de lectura observado en la conexión hace fallar la corrida (exit 1).
 *     Cada corrida imprime UNA línea «REGISTRO_EJECUCION {json}»: cuándo se consultó la fuente,
 *     el resultado, el código de salida y la fecha de verificación. --registro-local guarda el
 *     mismo JSON en un archivo nuevo (no sobrescribe). Ver docs/ciclo-colombia-real.md.
 *     Salida: 0 sin cambio o aplicado · 2 cambio aplicable sin política · 3 revisión · 4 fuente caída · 1 error.
 */
const path = require('node:path');
const crypto = require('node:crypto');
const { readFileSync } = require('node:fs');

const AYUDA = 'Uso: node scripts/ciclo-checkmig-v2.js --simular [--registro RUTA_JSON] [--html RUTA_HTML] | --ejecutar [--perfil NOMBRE] [--registro-local RUTA_NUEVA] (ver docs/ciclo-colombia-real.md)';
const REGISTRO_PRUEBA = path.join(__dirname, 'fixtures', 'checkmig', 'registro-publicado-2026-10-21.json');
const SALIDA = Object.freeze({ sin_cambio: 0, cambio_aplicable: 2, revision_humana: 3, fuente_no_disponible: 4 });

// ------------------------------------------------------------------
// Simulación: lectura real + registro de prueba, sin base de datos
// ------------------------------------------------------------------

async function simular({ registro, fetch, ahora = () => new Date() }) {
  const { clasificar } = require('../services/propuestas/ciclo/ciclo-revalidacion-v2');
  const perfil = require('../services/propuestas/ciclo/perfil-checkmig-colombia');
  const { fechaMontevideo } = require('../services/propuestas/plan-aplicacion-requisito-v2');
  const lectura = await perfil.adaptador.leer({ fetch, ahora });
  const informe = clasificar(registro.requisito, lectura, perfil, { hoy: fechaMontevideo(ahora()) });
  return { perfil, lectura, informe };
}

function lineasSimulacion({ registro, lectura, informe }, origen) {
  const l = [];
  const r = registro.requisito;
  l.push(`Ciclo CheckMig 2.0 — SIMULACIÓN (sin base de datos, sin escrituras)`);
  l.push(`Fuente: ${lectura.url} (${origen})`);
  l.push(`Registro de prueba: ${registro.destino?.pais ?? '?'} / ${r.nombre}  obligatorio=${JSON.stringify(r.obligatorio)}  fecha_verificacion=${r.fecha_verificacion}`);
  const d = lectura.diagnostico ?? {};
  l.push(`Lectura: ${lectura.tipo}  consultado_en=${d.consultado_en ?? '-'}  http=${d.http_status ?? '-'}  contenido_sha256=${d.contenido_sha256 ?? '-'} (solo diagnóstico)`);
  if (lectura.tipo === 'hechos') {
    const h = lectura.hechos;
    l.push(`Hechos confirmados: obligatoriedad=${h.obligatoriedad}  viajeros=${h.alcance.viajeros.join('+')}  sentidos=${h.alcance.sentidos.join('+')}  ventana=${h.ventana_horas_antes.maximo_horas_antes}h→${h.ventana_horas_antes.minimo_horas_antes}h  hechos_hash=${lectura.hechos_hash}`);
    l.push(`Evidencia (obligatoriedad): ${lectura.evidencia.obligatoriedad[0]}`);
  }
  l.push(`ACCIÓN: ${informe.accion}${informe.motivo ? ` (${informe.motivo})` : ''}`);
  if (informe.guardado !== undefined) l.push(`  obligatorio: guardado=${JSON.stringify(informe.guardado)}  según la ficha=${JSON.stringify(informe.esperado)}`);
  if (informe.detalle) l.push(`  ${informe.detalle}`);
  for (const c of informe.cambios ?? []) l.push(`  cambio que propondría: ${c.campo} → ${JSON.stringify(c.propuesto.valor)}`);
  for (const c of informe.pendiente?.campos ?? []) l.push(`  pendiente de revisión: ${c.campo} (${c.motivo})`);
  if (informe.accion === 'fuente_no_disponible') l.push(`  pendiente: reintentar más tarde (${informe.motivo})`);
  for (const o of informe.observaciones ?? []) l.push(`  observación: ${o.codigo} — ${o.detalle}`);
  const f = informe.fecha_verificacion;
  l.push(`FECHA DE VERIFICACIÓN (aparte de la acción): actual=${f.actual ?? '-'}  hoy=${f.hoy}  días=${f.dias_desde_verificacion ?? '-'}  efecto=${f.efecto}`);
  l.push(`  ${f.detalle}`);
  return l;
}

// ------------------------------------------------------------------
// Ejecución real (no se corre sin autorización)
// ------------------------------------------------------------------

// Modo informe: solo lecturas y metadatos de conexión.
const COMANDOS_INFORME = Object.freeze(['connectionStatus', 'listIndexes', 'find', 'getMore', 'killCursors', 'endSessions', 'hello', 'isMaster', 'ping', 'saslStart', 'saslContinue', 'buildInfo']);
const VERSION_REGISTRO = 'registro-ciclo-v1';
const sinUri = t => String(t ?? '').replace(/mongodb(\+srv)?:\/\/\S+/g, '<uri>').slice(0, 500);

function codigoSalida(r) {
  if (r.resultado === 'exito' || r.resultado === 'sin_cambio') return 0;
  if (r.resultado === 'cambio_aplicable') return 2;
  if (r.resultado === 'fuente_no_disponible' || r.resultado === 'fuente_temporalmente_no_disponible') return 4;
  return 3;
}

// Pura. Registro de una corrida: lo que permite comprobar que la tarea diaria funciona.
function registroEjecucion({ iniciado_en, terminado_en, config, proceso, objetivo, r, error, comandos, codigo, perfilPedido = null }) {
  const f = r?.informe?.fecha_verificacion;
  return {
    version: VERSION_REGISTRO, comando: 'ciclo-checkmig-v2 --ejecutar', perfil: config?.perfil?.nombre ?? perfilPedido ?? null, iniciado_en, terminado_en,
    modo: config ? (config.politica_habilitada ? 'politica_automatica' : 'informe') : null,
    politica: config?.autorizacion ? { nombre: config.autorizacion.politica, autorizada_por: config.autorizacion.autorizada_por, vence_en: config.autorizacion.vence_en } : null,
    motivo_sin_politica: config?.motivo_sin_politica ?? null,
    proceso: proceso ?? null,
    objetivo: objetivo ? { codigo_iso: config.perfil.destino.codigo_iso, destino_id: objetivo.destinoId.toHexString(), requisito: config.perfil.requisito.nombre ?? config.perfil.requisito.tipo, requisito_id: objetivo.requisitoId.toHexString() } : null,
    fuente: r?.fuente ?? null,
    resultado: error ? 'error' : r.resultado, motivo: error ? null : r.motivo ?? null, error: error ? sinUri(error.message ?? error) : null,
    codigo_salida: codigo,
    propuesta_id: r?.propuesta_id ?? null, intento_id: r?.intento_id ?? null, estado_propuesta: r?.estado_propuesta ?? null, valor_aplicado: r?.valor_aplicado ?? null,
    pendiente: r?.pendiente ?? null,
    observaciones: (r?.informe?.observaciones ?? []).map(o => o.codigo),
    fecha_verificacion: f ? { actual: f.actual, hoy: f.hoy, dias_desde_verificacion: f.dias_desde_verificacion, efecto: f.efecto, renovacion_soportada: f.renovacion_soportada ?? null } : null,
    comandos: [...new Set(comandos)].sort()
  };
}

// Pura. Una fila Markdown para el resumen del job (GITHUB_STEP_SUMMARY). Solo campos ya saneados
// del registro: nunca la URI ni mensajes crudos de Mongo.
function lineaResumen(g) {
  const aplicado = g.resultado === 'exito' ? `APLICADO: obligatorio → ${JSON.stringify(g.valor_aplicado)} (propuesta ${g.propuesta_id})` : '';
  const pendiente = g.pendiente ? `pendiente: ${g.pendiente.tipo}${g.pendiente.motivo ? ` (${g.pendiente.motivo})` : ''}` : '';
  const celdas = [g.perfil ?? '-', g.objetivo?.codigo_iso ?? '-', g.modo ?? '-', g.resultado + (g.motivo ? ` (${g.motivo})` : ''), String(g.codigo_salida),
    g.fuente ? `HTTP ${g.fuente.http_status ?? '-'} ${g.fuente.consultado_en ?? ''}` : '-', [aplicado, pendiente].filter(Boolean).join('; ') || '-'];
  return `| ${celdas.map(c => String(c).replace(/[|\r\n]/g, ' ')).join(' | ')} |`;
}
const ENCABEZADO_RESUMEN = '| Perfil | Destino | Modo | Resultado | Exit | Fuente | Aplicación / pendiente |\n|---|---|---|---|---|---|---|';

/**
 * deps (pruebas): { conexion (mongoose ya conectado; no se cierra), usuariosAutenticados, fetch, ahora, uuid }.
 * Devuelve el código de salida. No lanza: los errores quedan en el registro (exit 1).
 */
async function ejecutarReal(env = process.env, log = console.log, deps = {}, { registroLocal = null, perfil = undefined } = {}) {
  const mongoose = require('../config/mongoose');
  const { cargarConfigCicloReal, prepararEjecucionReal } = require('../services/propuestas/ciclo/config-ciclo-real');
  const { ejecutarCicloV2 } = require('../services/propuestas/ciclo/ciclo-revalidacion-v2');
  const { usuariosAutenticadosDe } = require('../services/propuestas/decidir-propuesta');
  const ahora = deps.ahora ?? (() => new Date());
  const iniciado_en = ahora().toISOString();
  const comandos = [];
  const espia = e => comandos.push(e.commandName);
  let config = null, p = null, r = null, error = null, cliente = null, propia = false;
  try {
    config = cargarConfigCicloReal(env, ahora(), perfil === undefined ? {} : { perfil });
    let conexion = deps.conexion;
    if (!conexion) {
      await mongoose.connect(config.uri, { autoIndex: false, autoCreate: false, monitorCommands: true });
      conexion = mongoose.connection;
      propia = true;
    }
    cliente = conexion.getClient();
    cliente.on('commandStarted', espia);
    p = await prepararEjecucionReal(config, { conexion, usuariosAutenticados: deps.usuariosAutenticados ?? (() => usuariosAutenticadosDe(conexion)),
      fetch: deps.fetch ?? globalThis.fetch, ahora, uuid: deps.uuid ?? (() => crypto.randomUUID()) });
    log(`Ciclo 2.0 (${config.perfil.nombre}) — EJECUCIÓN REAL. Proceso: ${p.proceso.identificador}. Política automática: ${config.politica_habilitada ? 'habilitada' : `no habilitada (${config.motivo_sin_politica})`}.`);
    r = await ejecutarCicloV2(p.objetivo, p.perfil, p.contexto);
    log(`resultado=${r.resultado}${r.motivo ? ` (${r.motivo})` : ''}  lecturas=${r.lecturas}${r.propuesta_id ? `  propuesta=${r.propuesta_id}  estado=${r.estado_propuesta}` : ''}${r.intento_id ? `  intento=${r.intento_id}` : ''}`);
    if (r.pendiente) log(`pendiente: ${r.pendiente.tipo}${r.pendiente.motivo ? ` (${r.pendiente.motivo})` : ''}`);
  } catch (e) {
    error = e;
  } finally {
    cliente?.off('commandStarted', espia);
    if (propia) await mongoose.disconnect().catch(() => {});
  }
  // Modo informe: cualquier comando que no sea de lectura invalida la corrida.
  const fuera = config && !config.politica_habilitada ? [...new Set(comandos.filter(c => !COMANDOS_INFORME.includes(c)))] : [];
  if (!error && fuera.length) error = new Error(`modo informe: comandos no permitidos observados: ${fuera.join(', ')}`);
  const codigo = error ? 1 : codigoSalida(r);
  const registro = registroEjecucion({ iniciado_en, terminado_en: ahora().toISOString(), config, proceso: p?.proceso, objetivo: p?.objetivo, r, error, comandos, codigo, perfilPedido: perfil ?? null });
  if (error) log(`ciclo: ${registro.error}`);
  log(`REGISTRO_EJECUCION ${JSON.stringify(registro)}`);
  if (deps.resumen) deps.resumen(lineaResumen(registro));
  if (registroLocal) {
    try { require('node:fs').writeFileSync(registroLocal, `${JSON.stringify(registro, null, 2)}\n`, { flag: 'wx' }); }
    catch (e) { log(`ciclo: no se pudo guardar el registro local (${e.code ?? 'error'})`); return 1; }
  }
  return codigo;
}

// ------------------------------------------------------------------
// CLI
// ------------------------------------------------------------------

function leerOpciones(args) {
  if (args[0] === '--ejecutar') {
    const o = { modo: 'ejecutar', registroLocal: null, perfil: undefined };
    for (let i = 1; i < args.length; i += 2) {
      const v = args[i + 1];
      if (!v || v.startsWith('--')) return null;
      if (args[i] === '--registro-local' && o.registroLocal === null) o.registroLocal = path.resolve(v);
      else if (args[i] === '--perfil' && o.perfil === undefined && /^[a-z0-9-]{1,64}$/.test(v)) o.perfil = v;
      else return null;
    }
    return o;
  }
  if (args[0] !== '--simular') return null;
  const o = { modo: 'simular', registro: REGISTRO_PRUEBA, html: null };
  for (let i = 1; i < args.length; i += 2) {
    if (args[i] === '--registro' && args[i + 1]) o.registro = path.resolve(args[i + 1]);
    else if (args[i] === '--html' && args[i + 1]) o.html = path.resolve(args[i + 1]);
    else return null;
  }
  return o;
}

module.exports = { simular, lineasSimulacion, ejecutarReal, leerOpciones, codigoSalida, registroEjecucion, lineaResumen, ENCABEZADO_RESUMEN, SALIDA, COMANDOS_INFORME };

if (require.main === module) {
  (async () => {
    const o = leerOpciones(process.argv.slice(2));
    if (!o) { console.log(AYUDA); process.exitCode = process.argv.length > 2 ? 1 : 0; return; }
    try {
      if (o.modo === 'ejecutar') {
        // En GitHub Actions, una fila por corrida en el resumen del job (aviso gratuito existente).
        const archivo = process.env.GITHUB_STEP_SUMMARY;
        const resumen = archivo ? linea => { try { require('node:fs').appendFileSync(archivo, `${linea}\n`); } catch { /* el resumen es opcional */ } } : undefined;
        process.exitCode = await ejecutarReal(process.env, console.log, { resumen }, { registroLocal: o.registroLocal, perfil: o.perfil });
        return;
      }
      const registro = JSON.parse(readFileSync(o.registro, 'utf8'));
      const html = o.html ? readFileSync(o.html, 'utf8') : null;
      const fetch = html === null ? globalThis.fetch
        : async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
      const r = await simular({ registro, fetch });
      for (const linea of lineasSimulacion({ registro, ...r }, html === null ? 'consulta real' : `HTML local ${path.basename(o.html)}`)) console.log(linea);
      process.exitCode = SALIDA[r.informe.accion] ?? 1;
    } catch (err) {
      console.error(`ciclo: ${err?.message ?? err}`);
      process.exitCode = 1;
    }
  })();
}
