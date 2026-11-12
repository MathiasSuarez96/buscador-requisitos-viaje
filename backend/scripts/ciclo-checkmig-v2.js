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
 *   node scripts/ciclo-checkmig-v2.js --ejecutar
 *     Ejecución REAL (tarea diaria). Requiere la configuración de config-ciclo-real.js en el
 *     entorno (MONGODB_URI_CICLO, OPERADORES_AUTORIZADOS_JSON y, para escribir,
 *     CICLO_V2_AUTORIZACION_JSON). Prechequeo de solo lectura (identidad, índices, destino) antes
 *     de leer la fuente; luego el ciclo compartido con H3.3. Sin autorización vigente solo informa.
 *     NO se ejecuta sin autorización explícita: ver docs/ciclo-colombia-real.md.
 *     Salida: 0 sin cambio o aplicado · 2 cambio aplicable sin política · 3 revisión · 4 fuente caída · 1 error.
 */
const path = require('node:path');
const crypto = require('node:crypto');
const { readFileSync } = require('node:fs');

const AYUDA = 'Uso: node scripts/ciclo-checkmig-v2.js --simular [--registro RUTA_JSON] [--html RUTA_HTML] | --ejecutar (ver docs/ciclo-colombia-real.md)';
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

async function ejecutarReal(env = process.env, log = console.log) {
  const mongoose = require('../config/mongoose');
  const { cargarConfigCicloReal, prepararEjecucionReal } = require('../services/propuestas/ciclo/config-ciclo-real');
  const { ejecutarCicloV2 } = require('../services/propuestas/ciclo/ciclo-revalidacion-v2');
  const { usuariosAutenticadosDe } = require('../services/propuestas/decidir-propuesta');
  const ahora = () => new Date();
  const config = cargarConfigCicloReal(env, ahora());
  await mongoose.connect(config.uri, { autoIndex: false, autoCreate: false });
  try {
    const conexion = mongoose.connection;
    const p = await prepararEjecucionReal(config, { conexion, usuariosAutenticados: () => usuariosAutenticadosDe(conexion),
      fetch: globalThis.fetch, ahora, uuid: () => crypto.randomUUID() });
    log(`Ciclo CheckMig 2.0 — EJECUCIÓN REAL. Proceso: ${p.proceso.identificador}. Política automática: ${config.politica_habilitada ? 'habilitada' : `no habilitada (${config.motivo_sin_politica})`}.`);
    const r = await ejecutarCicloV2(p.objetivo, p.perfil, p.contexto);
    log(`resultado=${r.resultado}${r.motivo ? ` (${r.motivo})` : ''}  lecturas=${r.lecturas}${r.propuesta_id ? `  propuesta=${r.propuesta_id}  estado=${r.estado_propuesta}` : ''}${r.intento_id ? `  intento=${r.intento_id}` : ''}`);
    if (r.pendiente) log(`pendiente: ${r.pendiente.tipo}${r.pendiente.motivo ? ` (${r.pendiente.motivo})` : ''}`);
    return r.resultado === 'exito' || r.resultado === 'sin_cambio' ? 0 : r.resultado === 'cambio_aplicable' ? 2 : r.resultado === 'fuente_no_disponible' || r.resultado === 'fuente_temporalmente_no_disponible' ? 4 : 3;
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

// ------------------------------------------------------------------
// CLI
// ------------------------------------------------------------------

function leerOpciones(args) {
  if (args[0] === '--ejecutar' && args.length === 1) return { modo: 'ejecutar' };
  if (args[0] !== '--simular') return null;
  const o = { modo: 'simular', registro: REGISTRO_PRUEBA, html: null };
  for (let i = 1; i < args.length; i += 2) {
    if (args[i] === '--registro' && args[i + 1]) o.registro = path.resolve(args[i + 1]);
    else if (args[i] === '--html' && args[i + 1]) o.html = path.resolve(args[i + 1]);
    else return null;
  }
  return o;
}

module.exports = { simular, lineasSimulacion, ejecutarReal, leerOpciones, SALIDA };

if (require.main === module) {
  (async () => {
    const o = leerOpciones(process.argv.slice(2));
    if (!o) { console.log(AYUDA); process.exitCode = process.argv.length > 2 ? 1 : 0; return; }
    try {
      if (o.modo === 'ejecutar') { process.exitCode = await ejecutarReal(); return; }
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
