// Mutaciones solo en una copia temporal. Nunca edita el árbol de trabajo.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, cpSync, symlinkSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const raiz = resolve(import.meta.dirname, '../..')
const copia = mkdtempSync(join(tmpdir(), 'mutaciones-listado-'))
const api = 'src/panel/propuestas.ts', controlador = 'src/panel/controlador.ts'
const mutaciones: [string, string, string, string][] = [
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
    process.stdout.write(`Detectada: ${nombre}\n`)
  }
  process.stdout.write(`${detectadas}/${mutaciones.length} mutaciones detectadas por aserciones; línea base correcta.\n`)
} finally {
  try { unlinkSync(join(copia, 'node_modules')) } catch { /* No se llegó a crear el enlace. */ }
  assert.ok(resolve(copia).startsWith(resolve(tmpdir()) + '\\') || resolve(copia).startsWith(resolve(tmpdir()) + '/'))
  rmSync(copia, { recursive: true, force: true })
}
