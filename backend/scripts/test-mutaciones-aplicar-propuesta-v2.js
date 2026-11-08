const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const archivo = path.join(__dirname, '../services/propuestas/aplicar-propuesta-v2.js');
const prueba = path.join(__dirname, 'test-aplicar-propuesta-v2.js');
const mutaciones = [
  ['omite el CAS de la propuesta', "      await casPropuesta(ctx, 'aplicacion', session, deps);\n", ''],
  ['omite la clasificación del requisito en la transacción', '      if (!c.ok) throw new ErrorConflictoV2(c);\n', ''],
  ['acepta claves desconocidas', "  if (desconocidas.length) return conflicto('valor_actual_cambio', 'claves_desconocidas', { claves: desconocidas });\n", ''],
  ['acepta _id duplicado', "  if (mismos.length > 1 || (mismos.length === 1 && ambiguos > 0)) return conflicto(", "  if (false) return conflicto("],
  ['identidad por String(_id)', 'esObjectId(r._id) && r._id.equals(ids.requisito_id));\n  const ambiguos', 'r._id != null && String(r._id) === ids.requisito_hex);\n  const ambiguos'],
  ['acepta matchedCount o modifiedCount distinto de 1', 'if (r?.matchedCount !== 1 || r?.modifiedCount !== 1) {', 'if (false) {'],
  ['acepta modifiedCount 0', 'r?.matchedCount !== 1 || r?.modifiedCount !== 1', 'r?.matchedCount !== 1'],
  ['omite advertencias aceptadas', '    || !Array.isArray(p?.advertencias) || canonico(d.advertencias_aceptadas) !== canonico(p.advertencias)) {', ') {'],
  ['omite contrato 2.0 en la aprobación', '|| d.version_contrato !== VERSION_CONTRATO ||', '||'],
  ['omite el índice transversal', 'verificarConjuntoIndices([...INDICES_APLICACION, INDICE_TRANSVERSAL], listados);', 'verificarConjuntoIndices([...INDICES_APLICACION], listados);'],
  ['confirma sin comparar el intento', "  compararDocumento(diffs, 'intento', leido.intento, esperado.intento);\n", ''],
  ['confirma sin comparar la propuesta', "  if (!p) diffs.push('la propuesta no existe');\n  else for", "  if (false) diffs.push('la propuesta no existe');\n  else if (false) for"],
  ['confirma ante relectura fallida', 'throw new ErrorResultadoIncierto(ctx, `falló "${plan.nombre}"', 'return plan.confirmado("x"); throw new ErrorResultadoIncierto(ctx, `falló "${plan.nombre}"'],
  ['acepta el modelo como colección', "  if (!coleccion || typeof coleccion !== 'object' || coleccion.schema !== undefined || typeof coleccion.updateOne !== 'function' || typeof coleccion.collectionName !== 'string') {", '  if (!coleccion) {'],
  ['conflicto con otra transición', 'const tipoEvento = TRANSICION_POR_RESULTADO[clasificacion.resultado];', "const tipoEvento = 'obsolescencia';"],
  ['ESTRUCTURAL: lee el destino fuera de la sesión', 'await deps.leerDestino({ _id: ctx.ids.destino_id }, session);', 'await deps.leerDestino({ _id: ctx.ids.destino_id }, null);'],
  ['aprobador reemplazado por el aplicador', "aprobacion: evento ? { evento_id: evento.evento_id ?? null, actor: { ...(evento.actor ?? {}) },", "aprobacion: evento ? { evento_id: evento.evento_id ?? null, actor: { tipo: 'humano', identificador: auditoria.operador },"],
  ['identificadores nuevos en cada intento de la transacción', 'await deps.insertarIntento(structuredClone(intento), session);\n      await deps.insertarEvento(structuredClone(evento), session);\n    },\n    confirmado: causa => resultado(ctx, \'exito\'',
    'await deps.insertarIntento({ ...structuredClone(intento), intento_id: deps.uuid() }, session);\n      await deps.insertarEvento(structuredClone(evento), session);\n    },\n    confirmado: causa => resultado(ctx, \'exito\''],
  ['persiste revalidaciones sin validar (restaura el defecto)', '    revalidaciones_resumen: null\n  };',
    "    revalidaciones_resumen: Array.isArray(revalidaciones) ? revalidaciones.map(r => ({ url: r?.url ?? null, fuente_nombre: r?.fuente_nombre ?? null, revalidada_en: r?.revalidada_en ?? null })) : []\n  };"],
  ['omite el resumen validado', '  ctx.revalidaciones_resumen = resumirRevalidaciones(construido.payload, revalidaciones);\n', ''],
  ['omite precondiciones en la etapa 0', '  const fallas = verificarPrecondicionesV2(entrada, propuesta, evento);\n  let construido;', '  const fallas = [];\n  let construido;'],
  ['omite precondiciones dentro de la transacción', '      if (fallas.length) throw new ErrorNoAplicableV2(fallas);\n      const vigente', '      const vigente'],
  ['H2.1: omite la validación previa con los modelos', '  await validarDocumentos(plan, deps);\n', ''],
  ['H2.1: error de red sin código propio', "  if (RED.includes(err?.name)) return 'red';\n", ''],
  ['H2.2: el evento copia al aprobador', 'adaptador: { ...ctx.adaptador }, decision_aprobacion_id: ctx.decision_aprobacion_id_esperado },', 'adaptador: { ...ctx.adaptador }, decision_aprobacion_id: ctx.decision_aprobacion_id_esperado, aprobacion: ctx.aprobacion },'],
  ['H2.1: transición por fallo sin resultado_no_registrado', "resultado_no_registrado: clasificacion.resultado,\n      finalizado_en: fin", 'finalizado_en: fin']
];
function correr(m) {
  const codigo = `const fs=require('node:fs');const Module=require('node:module');const path=require('node:path');const f=${JSON.stringify(archivo)};const m=${JSON.stringify(m)};
  if(m){let s=fs.readFileSync(f,'utf8').split(String.fromCharCode(13)).join('');if(s.split(m[1]).length!==2)throw new Error('ANCLA NO UNICA');
  const mod=new Module(f,module);mod.filename=f;mod.paths=Module._nodeModulePaths(path.dirname(f));require.cache[f]=mod;mod._compile(s.replace(m[1],()=>m[2]),f);}
  require(${JSON.stringify(prueba)});`;
  return spawnSync(process.execPath, ['--require', path.join(__dirname, 'preload-solo-loopback.js'), '-e', codigo], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 90000, maxBuffer: 4 * 1024 * 1024
  });
}
const base = correr(null);
assert.equal(base.status, 0, `${base.stdout}\n${base.stderr}`);
for (const m of mutaciones) {
  const r = correr(m);
  assert.ok(!r.error && r.status !== null, `Infraestructura: ${m[0]}`);
  assert.equal(r.status, 1, `Sobrevive ${m[0]}\n${r.stdout}\n${r.stderr}`);
  // La primera línea de error decide: solo AssertionError cuenta (el texto de la aserción puede nombrar otros errores).
  const primera = r.stderr.split('\n').map(l => l.trim()).find(l => /^\w*Error\b/.test(l) || /ANCLA NO UNICA|SOLO-LOOPBACK BLOQUEADO/.test(l));
  assert.match(primera ?? '', /^AssertionError\b/, `Muerte inválida ${m[0]}\n${r.stderr}`);
  console.log(`Detectada por AssertionError: ${m[0]}`);
}
console.log(`${mutaciones.length}/${mutaciones.length} mutaciones del aplicador 2.0 detectadas por aserciones.`);
