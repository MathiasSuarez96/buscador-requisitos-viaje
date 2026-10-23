// Mutaciones solo en una copia temporal. Nunca edita el árbol de trabajo.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, cpSync, symlinkSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const raiz = resolve(import.meta.dirname, '../..')
const copia = mkdtempSync(join(tmpdir(), 'mutaciones-listado-'))
const badges = 'src/BadgesRequisito.tsx'
const api = 'src/panel/propuestas.ts', controlador = 'src/panel/controlador.ts'
const detalle = 'src/panel/detalle.ts', decisiones = 'src/panel/decisiones.ts'
const aplicaciones = 'src/panel/aplicaciones.ts'
const mutaciones: [string, string, string, string][] = [
  ['badge pierde obligatoriedad afirmativa', badges, "if (obligatorio === 'si') etiquetas.push('Obligatorio')", "if (obligatorio === 'si') etiquetas.push('')"],
  ['badge muestra recomendación opcional sin valor si', badges, "else if (recomendado === 'si') etiquetas.push('Opcional · recomendado')", "else if (recomendado === 'si') etiquetas.push('Recomendado')"],
  ['badge muestra recomendación a verificar solo si no es obligatorio', badges, "if (obligatorio === 'no' && recomendado === 'verificar')", "if (obligatorio !== 'verificar' && recomendado === 'verificar')"],
  ['badge agrega etiqueta a recomendación ausente', badges, "else if (recomendado === 'si') etiquetas.push('Opcional · recomendado')", "else if (recomendado !== 'no') etiquetas.push('Opcional · recomendado')"],
  ['badge elimina prioridad de obligatoriedad a verificar', badges, "if (obligatorio === 'no' && recomendado === 'verificar')", "if (recomendado === 'verificar')"],
  ...(['estado_esperado', 'payload_hash_esperado', 'version_coordinacion_esperada', 'decision_aprobacion_id_esperado'] as const).map(campo => [
    `aplicación envío altera ${campo}`, aplicaciones, `${campo}: snapshot.${campo}`, `${campo}: null`,
  ] as [string, string, string, string]),
  ['aplicación instantánea visible altera estado', aplicaciones, "return Object.freeze({ estado_esperado: 'aprobada'", "return Object.freeze({ estado_esperado: 'aplicada'"],
  ['aplicación instantánea visible altera hash', aplicaciones, 'payload_hash_esperado: p.payload_hash', "payload_hash_esperado: 'c'.repeat(64)"],
  ['aplicación instantánea visible altera versión', aplicaciones, 'version_coordinacion_esperada: p.version_coordinacion!', 'version_coordinacion_esperada: 8'],
  ['aplicación instantánea visible altera decisión', aplicaciones, 'decision_aprobacion_id_esperado: p.decision_aprobacion_id', "decision_aprobacion_id_esperado: '054d03c8-e9ba-4352-8370-e4f88534f612'"],
  ['aplicación omite permiso al preparar', controlador, "estado.sesion.permisos.includes('aplicar') || !d.acciones_permitidas", "true || !d.acciones_permitidas"],
  ['aplicación omite bloqueo síncrono', controlador, "const id = aplicacion.propuestaId, snapshot = aplicacion.instantanea, credencial = token, usuario = estado.sesion.identidad.sub\n      envioActivo = true", "const id = aplicacion.propuestaId, snapshot = aplicacion.instantanea, credencial = token, usuario = estado.sesion.identidad.sub\n      queueMicrotask(() => { envioActivo = true })"],
  ['aplicación timeout incorrecto', aplicaciones, 'const tiempoLimite = 30_000', 'const tiempoLimite = 60_000'],
  ['aplicación reintenta automáticamente al fallar red', aplicaciones, "catch { if (timer) clearTimeout(timer); return error('incierto') }", "catch { if (timer) clearTimeout(timer); void hacerFetch(`${origen}/api/panel/propuestas/${id}/aplicacion`, { method: 'POST' }).catch(() => {}); return error('incierto') }"],
  ['aplicación 409 no bloquea', controlador, "['cambio', 'no_aplica', 'incierto', 'no_encontrado']", "['no_aplica', 'incierto', 'no_encontrado']"],
  ['aplicación 422 no bloquea', controlador, "['cambio', 'no_aplica', 'incierto', 'no_encontrado']", "['cambio', 'incierto', 'no_encontrado']"],
  ['aplicación 500 no bloquea', aplicaciones, "if ([500].includes(respuesta.status)", "if (respuesta.status === 500) return error('solicitud', requestId);\n  if ([500].includes(respuesta.status)"],
  ['aplicación red no bloquea', aplicaciones, "catch { if (timer) clearTimeout(timer); return error('incierto') }", "catch { if (timer) clearTimeout(timer); return error('solicitud') }"],
  ['aplicación respuesta inválida no bloquea', aplicaciones, "return aplicacion ? { tipo: 'ok', aplicacion, requestId } : error('incierto', requestId)", "return aplicacion ? { tipo: 'ok', aplicacion, requestId } : error('solicitud', requestId)"],
  ['aplicación recarga fallida libera bloqueo', controlador, "} else {\n      if (resultado.fallo === 'sesion')", "} else {\n      aplicacionesBloqueadas.delete(id); fijarAplicacion({ ...aplicacion, requiereRecarga: false });\n      if (resultado.fallo === 'sesion')"],
  ['aplicación recarga exitosa conserva bloqueo', controlador, '        aplicacionesBloqueadas.delete(id)', '        /* no libera */'],
  ['aplicación 200 omite validar identidad y versión', aplicaciones, "a.propuesta_id !== id || a.resultado !== 'exito' || a.destino_modificado !== true || a.estado_propuesta_nuevo !== 'aplicada' || a.version_coordinacion_nueva !== snapshot.version_coordinacion_esperada + 1 || a.decision_aprobacion_id !== snapshot.decision_aprobacion_id_esperado ||", ''],
  ['aplicación 200 admite destino_modificado falso', aplicaciones, 'a.destino_modificado !== true || ', ''],
  ['límite de bytes omitido', api, 'bytes > MAXIMO_RESPUESTA', 'false'],
  ['límite UTF-16 en lugar de bytes', api, 'bytes += value.byteLength', 'bytes += new TextDecoder().decode(value).length'],
  ['cursor sin vínculo al filtro', api, 'return v.endsWith(`.${mascara}`)', 'return mascara.length > 0'],
  ['cursor inválido aceptado', api, "if (v.siguiente_cursor !== null && !cursorValido(v.siguiente_cursor, filtro)) return null", ''],
  ['sin deduplicación', api, 'if (vistas.has(p.propuesta_id)) return false;', ''],
  ['destino divergente aceptado', api, 'd.destino_id !== p.destino_id || ', ''],
  ['JSON escapado filtra credencial', api, 'return JSON.stringify(cuerpo).includes(token) ? null : cuerpo', 'return cuerpo'],
  ['envío con cookies', api, "credentials: 'omit'", "credentials: 'include'"],
  ['sigue redirecciones', api, "redirect: 'error'", "redirect: 'follow'"],
  ['no detecta repetición del cursor', controlador, 'siguiente === cursor || (mas && cursores.has(siguiente))', 'false'],
  ['no bloquea doble clic', controlador, ' || listado.cargando) return', ') return'],
  ['401 descarta listado', controlador, "if (r.fallo === 'sesion') {", "if (r.fallo === 'sesion') { limpiarListado();"],
  ['401 conserva token', controlador, "if (r.fallo === 'sesion') {\n        token = null", "if (r.fallo === 'sesion') {"],
  ['acepta lectura tardía de otro filtro', controlador, 'if (mia !== lectura || sesionMia !== consulta) return', 'if (sesionMia !== consulta) return'],
  ['selección no se reinicia', controlador, "fijarListado({ ...listadoInicial(), filtro:", "fijarListado({ ...listadoInicial(), seleccion: listado.seleccion, filtro:"],
  ['detalle de otra propuesta aceptado', 'src/panel/detalle.ts', 'if (d.propuesta.propuesta_id !== propuestaId) return null', ''],
  ['detalle conserva identificador privado del actor', 'src/panel/detalle.ts', 'actor: forma({ tipo:', 'actor: forma({ identificador: texto(101), tipo:'],
  ['enlace HTTPS con credenciales aceptado', 'src/panel/detalle.ts', "url.protocol === 'https:' && url.hostname !== '' && !url.username && !url.password", "url.protocol === 'https:'"],
  ['detalle sigue redirecciones', 'src/panel/detalle.ts', "redirect: 'error'", "redirect: 'follow'"],
  ['detalle envía cookies', 'src/panel/detalle.ts', "credentials: 'omit'", "credentials: 'include'"],
  ['detalle tardío reemplaza selección', controlador, 'if (numeroDetalle !== lecturaDetalle || sesionDetalle !== consulta) return', 'if (sesionDetalle !== consulta) return'],
  ['volver descarta listado', controlador, 'function volverAlListado() {', 'function volverAlListado() { fijarListado(listadoInicial());'],
  ['detalle 401 conserva token', controlador, "if (resultado.fallo === 'sesion') {\n        token = null", "if (resultado.fallo === 'sesion') {"],
  ['detalle se reintenta automáticamente al autenticar', controlador, 'if (!listado.cargado) void cargarListado(false)', 'if (!listado.cargado) void cargarListado(false); if (detalle.propuestaId) void cargarDetalle(detalle.propuestaId)'],
  ['historial invierte orden del servidor', 'src/panel/detalle.ts', '    return d\n', '    d.eventos.reverse(); return d\n'],
  ['ausente se confunde con null', 'src/panel/presentacion.ts', '!v.presente', 'false'],
  ['rechazar usa motivos de aprobar', 'src/panel/DetallePropuesta.tsx', 'd.acciones_bloqueadas[a].map', 'd.acciones_bloqueadas.aprobar.map'],
  ['detalle 2.0 acepta resumen ausente', detalle, "if ((d.propuesta.version_contrato === '1.0') !== (d.propuesta.requisito_v2 === null)) return null", 'if (false) return null'],
  ['detalle 2.0 acepta advertencias duplicadas', detalle, "if (new Set(advertencias).size !== advertencias.length || advertencias.some((a, i) => i > 0 && advertencias[i - 1] >= a)) return null", 'if (false) return null'],
  ['detalle 2.0 acepta advertencias desordenadas', detalle, 'advertencias.some((a, i) => i > 0 && advertencias[i - 1] >= a)', 'false'],
  ['detalle 2.0 acepta campos repetidos', detalle, 'if (new Set(d.propuesta.requisito_v2.cambios.map(c => c.campo)).size !== d.propuesta.requisito_v2.cambios.length) return null', ''],
  ['detalle 2.0 confunde ausente con string', detalle, "if (dato.bson_tipo === 'ausente' && !dato.presente && dato.valor === null) return dato", "if (dato.bson_tipo === 'ausente' && !dato.presente) return dato"],
  ['aprobación 2.0 acepta advertencias distintas', decisiones, "if (!advertenciasAceptadas || advertenciasAceptadas.length !== p.requisito_v2.advertencias.length || advertenciasAceptadas.some((a, i) => a !== p.requisito_v2?.advertencias[i])) return null", 'if (!advertenciasAceptadas) return null'],
  ['decisión vuelve al timeout de 20 segundos', decisiones, 'const TIEMPO_LIMITE = 30_000', 'const TIEMPO_LIMITE = 20_000'],
  ['decisión acepta advertencias no string', decisiones, "typeof a === 'string' && /^[a-z0-9_]{1,80}$/.test(a)", '/^[a-z0-9_]{1,80}$/.test(a)'],
  ['decisión omite versión del contrato', decisiones, 'version_contrato_esperada: snapshot.version_contrato_esperada,', ''],
  ['aprobación 2.0 omite advertencias aceptadas', decisiones, "if (accion === 'aprobar' && snapshot.version_contrato_esperada === '2.0') body.advertencias_aceptadas = snapshot.advertencias_aceptadas", ''],
  ['controlador ignora las advertencias aceptadas', controlador, 'instantaneaDe(d, decision.advertenciasAceptadas, accion)', 'instantaneaDe(d, [], accion)'],
  ['controlador permite cambiar advertencias con confirmación abierta', controlador, 'if (envioActivo || decision.accion !== null) return', 'if (envioActivo) return'],
  ['botón aprobar ignora advertencias', 'src/panel/DetallePropuesta.tsx', "bloqueada || (accion === 'aprobar' && detalle.propuesta.version_contrato === '2.0' && !advertenciasCompletas)", 'bloqueada'],
  ['decision incluye solo la instantánea exacta del detalle', 'src/panel/decisiones.ts', 'payload_hash_esperado: snapshot.payload_hash_esperado', 'payload_hash_esperado: "inventado"'],
  ['rechazo omite el motivo validado', 'src/panel/decisiones.ts', "if (accion === 'rechazar') body.motivo = motivo", ''],
  ['POST de decisión incluye cookies', 'src/panel/decisiones.ts', "credentials: 'omit'", "credentials: 'include'"],
  ['confirmación no bloquea envío simultáneo', controlador, "if (envioActivo || !config || !token || estado.fase !== 'autorizado' || !estado.sesion.permisos.includes('decidir') || !decision.accion", "if (!config || !token || estado.fase !== 'autorizado' || !estado.sesion.permisos.includes('decidir') || !decision.accion"],
  ['resultado incierto no exige recarga', controlador, "e.fallo === 'incierto' || e.fallo === 'cambio' || e.fallo === 'no_encontrado' || e.fallo === 'no_decidible'", "e.fallo === 'cambio' || e.fallo === 'no_encontrado'"],
  ['422 no bloquea simultáneamente ambas acciones', controlador, "if (e.fallo === 'no_decidible') {\n          bloqueadasAccion.add('aprobar')", "if (false) {\n          bloqueadasAccion.add('aprobar')"],
]
try {
  for (const p of ['src', 'tests', 'package.json']) cpSync(join(raiz, p), join(copia, p), { recursive: true })
  symlinkSync(join(raiz, 'node_modules'), join(copia, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  const ejecutar = () => spawnSync(process.execPath, [...process.execArgv, join(raiz, 'tests/panel/ejecutar.ts'), '--solo-listado', '--raiz', copia], { cwd: raiz, encoding: 'utf8', timeout: 30000 })
  const base = ejecutar()
  assert.equal(base.status, 0, `Línea base fallida: ${base.error ?? ''}\n${base.stdout}\n${base.stderr}`)
  let detectadas = 0
  for (const [nombre, archivo, antes, despues] of mutaciones) {
    const ruta = join(copia, archivo), original = readFileSync(ruta, 'utf8').replaceAll('\r\n', '\n')
    assert.equal(original.split(antes).length, 2, `Ancla no única: ${nombre}`)
    writeFileSync(ruta, original.replace(antes, despues))
    const r = ejecutar()
    writeFileSync(ruta, original)
    assert.ok(!r.error && r.status !== null, `${nombre}: fallo de infraestructura: ${r.error}`)
    assert.equal(r.status, 1, `${nombre}: sobrevivió\n${r.stdout}\n${r.stderr}`)
    assert.match(r.stdout, /FALLÓ[\s\S]*AssertionError/, `${nombre}: fallo ajeno a las aserciones\n${r.stdout}\n${r.stderr}`)
    assert.doesNotMatch(r.stderr, /Intentos de red bloqueados|SyntaxError|ERR_MODULE_NOT_FOUND/)
    detectadas++
    const pruebas = [...r.stdout.matchAll(/FALLÓ ([^\r\n]+)/g)].map(m => m[1])
    process.stdout.write(`Detectada: ${nombre}\n  Pruebas: ${pruebas.join('; ')}\n`)
  }
  process.stdout.write(`${detectadas}/${mutaciones.length} mutaciones detectadas por aserciones; línea base correcta.\n`)
} finally {
  try { unlinkSync(join(copia, 'node_modules')) } catch { /* No se llegó a crear el enlace. */ }
  assert.ok(resolve(copia).startsWith(resolve(tmpdir()) + '\\') || resolve(copia).startsWith(resolve(tmpdir()) + '/'))
  rmSync(copia, { recursive: true, force: true })
}
