/**
 * Prepara, FUERA del repositorio, el contenido de CICLO_V2_AUTORIZACION_JSON con una política nueva.
 * No conecta a ninguna base, no lee .env ni secretos y no imprime conexiones ni contraseñas.
 *
 *   node scripts/preparar-autorizaciones-ciclo.js --actuales RUTA --agregar POLITICA \
 *     --autorizada-por TEXTO --salida RUTA_NUEVA [--esperadas N] [--autorizada-en ISO] [--dias N]
 *
 *  --actuales   Lista vigente (el secreto de GitHub no se puede leer: se usa la copia privada
 *               guardada en la última activación, p. ej. backups/<activación>/autorizaciones.json).
 *  --agregar    UNA política conocida del ciclo o de altas que todavía no esté en la lista.
 *  --esperadas  Cantidad exacta de entradas actuales (por defecto 7).
 *  --dias       Vigencia de la nueva (por defecto 90, máximo 90). autorizada_en por defecto: ahora.
 *  --salida     Archivo NUEVO fuera del repositorio (no sobrescribe).
 *
 * Comprueba antes de escribir:
 *  1. las entradas actuales se validan con el cargador real (leerAutorizacion) y se conservan
 *     EXACTAS (mismas claves, valores y orden); solo se agrega la nueva al final;
 *  2. la lista resultante se valida completa con el mismo cargador, y la política nueva queda vigente;
 *  3. se informa la vigencia de cada política y el sha256 de las entradas previas antes y después.
 * Salida: 0 archivo escrito · 1 error (nada escrito).
 */
// El cargador real arrastra los modelos del ciclo: config/mongoose primero (autoCreate/autoIndex
// apagados). Este script nunca conecta.
require('../config/mongoose');
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { leerAutorizacion, POLITICAS } = require('../services/propuestas/ciclo/config-ciclo-real');
const { POLITICAS_ALTA } = require('../services/propuestas/altas/perfiles-alta');

const AYUDA = 'Uso: node scripts/preparar-autorizaciones-ciclo.js --actuales RUTA --agregar POLITICA --autorizada-por TEXTO --salida RUTA_NUEVA [--esperadas N] [--autorizada-en ISO] [--dias N]';
const DIA_MS = 24 * 60 * 60 * 1000;
const RAIZ_REPO = path.resolve(__dirname, '..', '..');
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const falla = m => { throw new Error(`preparar-autorizaciones: ${m}`); };

function leerOpciones(args) {
  const o = { esperadas: 7, dias: 90, autorizadaEn: null };
  const claves = { '--actuales': 'actuales', '--agregar': 'agregar', '--autorizada-por': 'autorizadaPor', '--salida': 'salida', '--esperadas': 'esperadas', '--autorizada-en': 'autorizadaEn', '--dias': 'dias' };
  for (let i = 0; i < args.length; i += 2) {
    const k = claves[args[i]], v = args[i + 1];
    if (!k || v === undefined || v.startsWith('--')) return null;
    o[k] = ['esperadas', 'dias'].includes(k) ? Number(v) : v;
  }
  if (!o.actuales || !o.agregar || !o.autorizadaPor || !o.salida) return null;
  return o;
}

// Pura salvo `ahora`. Devuelve { lista, texto, resumen } sin escribir nada.
function prepararLista(actualesTexto, o, ahora) {
  let actuales;
  try { actuales = JSON.parse(actualesTexto); } catch { falla('las autorizaciones actuales no son JSON.'); }
  if (!Array.isArray(actuales)) falla('las autorizaciones actuales deben ser una lista.');
  if (!Number.isInteger(o.esperadas) || actuales.length !== o.esperadas) falla(`se esperaban ${o.esperadas} entradas actuales (hay ${actuales.length}).`);
  const conocidas = [...Object.keys(POLITICAS), ...POLITICAS_ALTA];
  if (!conocidas.includes(o.agregar)) falla('la política a agregar no es una política conocida del ciclo ni de altas.');
  if (actuales.some(a => a?.politica === o.agregar)) falla('la política a agregar ya está en la lista; no se renueva ni se duplica.');
  const env = lista => ({ CICLO_V2_AUTORIZACION_JSON: JSON.stringify(lista) });
  // 1. La lista actual pasa el cargador real (lanza si alguna entrada es inválida).
  for (const a of actuales) leerAutorizacion(env(actuales), ahora, a.politica);

  if (!Number.isInteger(o.dias) || o.dias < 1 || o.dias > 90) falla('--dias debe ser un entero entre 1 y 90.');
  const desde = o.autorizadaEn === null ? new Date(ahora.getTime()) : new Date(o.autorizadaEn);
  if (Number.isNaN(desde.getTime()) || (o.autorizadaEn !== null && desde.toISOString() !== o.autorizadaEn)) falla('--autorizada-en debe ser ISO UTC exacta.');
  const nueva = { politica: o.agregar, autorizada_por: o.autorizadaPor, autorizada_en: desde.toISOString(), vence_en: new Date(desde.getTime() + o.dias * DIA_MS).toISOString() };
  const lista = [...actuales.map(a => ({ ...a })), nueva];

  // 2. Las previas quedan EXACTAS (serialización idéntica, en el mismo orden).
  const previasAntes = JSON.stringify(actuales), previasDespues = JSON.stringify(lista.slice(0, actuales.length));
  if (previasAntes !== previasDespues) falla('las entradas previas cambiarían; no se escribe nada.');
  // 3. Lista completa por el cargador real; la nueva debe quedar vigente ahora.
  const vigencia = lista.map(a => {
    const r = leerAutorizacion(env(lista), ahora, a.politica);
    return { politica: a.politica, vigente: r.autorizacion !== null, motivo: r.motivo, vence_en: a.vence_en };
  });
  if (!vigencia.at(-1).vigente) falla(`la política nueva no queda vigente (${vigencia.at(-1).motivo}).`);
  const texto = `${JSON.stringify(lista)}\n`;
  return { lista, texto, resumen: { entradas: lista.length, agregada: nueva.politica, autorizada_en: nueva.autorizada_en, vence_en: nueva.vence_en,
    previas_sha256_antes: sha(previasAntes), previas_sha256_despues: sha(previasDespues), archivo_sha256: sha(texto), vigencia } };
}

function fueraDelRepositorio(ruta) {
  const rel = path.relative(RAIZ_REPO, path.resolve(ruta));
  return rel.startsWith('..') || path.isAbsolute(rel);
}

function ejecutar(args, { log = console.log, ahora = new Date() } = {}) {
  const o = leerOpciones(args);
  if (!o) { log(AYUDA); return 1; }
  try {
    if (!fueraDelRepositorio(o.salida)) falla('--salida debe estar fuera del repositorio.');
    const { texto, resumen } = prepararLista(fs.readFileSync(o.actuales, 'utf8'), o, ahora);
    fs.writeFileSync(o.salida, texto, { flag: 'wx' });
    log(`Autorizaciones preparadas (nada se cargó en GitHub): ${resumen.entradas} entradas; agregada ${resumen.agregada} (${resumen.autorizada_en} → ${resumen.vence_en}).`);
    log(`Entradas previas idénticas: sha256 ${resumen.previas_sha256_antes} = ${resumen.previas_sha256_despues}. Archivo: sha256 ${resumen.archivo_sha256}.`);
    for (const v of resumen.vigencia) log(`  ${v.politica}: ${v.vigente ? 'vigente' : `NO vigente (${v.motivo})`} hasta ${v.vence_en}`);
    return 0;
  } catch (e) {
    log(String(e?.code === 'EEXIST' ? 'preparar-autorizaciones: --salida ya existe; no se sobrescribe.' : e?.message ?? e).replace(/mongodb(\+srv)?:\/\/\S+/g, '<uri>'));
    return 1;
  }
}

module.exports = { leerOpciones, prepararLista, fueraDelRepositorio, ejecutar };

if (require.main === module) process.exitCode = ejecutar(process.argv.slice(2));
