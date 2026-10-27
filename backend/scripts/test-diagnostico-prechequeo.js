const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, existsSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const { ErrorPrechequeo, mensajeErrorSeguro, validarSalida, ejecutar } = require('./prechequear-indice-transversal-lectura');

(async () => {
  const temporal = mkdtempSync(join(tmpdir(), 'diagnostico-prechequeo-'));
  const salida = join(temporal, 'informe.json');
  const secreto = 'CLAVE_RECONOCIBLE_NO_PUBLICAR';
  const uri = `mongodb://lector:${secreto}@127.0.0.1:puerto/buscador_requisitos`;
  for (const codigo of ['cuenta_de_lectura_incorrecta', 'se_exige_rol_read_exclusivo', 'base_incorrecta', 'variable_faltante', 'ruta_de_salida_invalida']) {
    assert.equal(mensajeErrorSeguro(new ErrorPrechequeo(codigo)), `Prechequeo abortado: ${codigo}. No se autoriza ninguna creación.`);
  }
  for (const error of [new Error(uri), new ErrorPrechequeo(uri), { codigo: 'base_incorrecta', message: uri }, new Error('base_incorrecta')]) {
    assert.equal(mensajeErrorSeguro(error), 'Prechequeo abortado: error_no_clasificado. No se autoriza ninguna creación.');
  }
  assert.equal(validarSalida(salida), salida);
  const existente = join(temporal, 'existente.json');
  writeFileSync(existente, 'conservar');
  const casos = [join(temporal, 'carpeta-inexistente', 'informe.json'), existente,
    join(existente, 'informe.json'), join(__dirname, 'informe.json'), 'relativo.json'];
  for (const ruta of casos) {
    let clientes = 0, conexiones = 0;
    const crearCliente = () => {
      clientes++;
      const c = new EventEmitter();
      c.connect = async () => { conexiones++; throw new Error('no_debe_conectar'); };
      c.close = async () => {};
      return c;
    };
    await assert.rejects(ejecutar({ uri, salida: ruta, crearCliente }), e => e.codigo === 'ruta_de_salida_invalida');
    assert.equal(clientes, 0, 'ruta inválida: no debe crear cliente');
    assert.equal(conexiones, 0, 'ruta inválida: no debe conectar ni leer');
  }
  assert.equal(readFileSync(existente, 'utf8'), 'conservar');
  const cli = join(__dirname, 'prechequear-indice-transversal-lectura.js');
  for (const [variable, esperado] of [['', 'variable_faltante'], [uri, 'error_no_clasificado']]) {
    const r = spawnSync(process.execPath, ['--require', join(__dirname, 'preload-solo-loopback.js'), cli, '--solo-lectura', '--salida', salida], {
      env: { ...process.env, MONGODB_PRECHEQUEO_URI: variable }, encoding: 'utf8', timeout: 20000
    });
    assert.ok(!r.error && r.status !== null, 'CLI no falla por infraestructura');
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`Prechequeo abortado: ${esperado}\\.`));
    assert.doesNotMatch(r.stdout + r.stderr, new RegExp(`${secreto}|mongodb://|lector:`));
    assert.equal(existsSync(salida), false);
  }
  console.log('Diagnóstico: cinco códigos seguros, errores del driver ocultos; rutas rechazadas antes del cliente/conexión; CLI con URI y contraseña sin fugas: OK');
})().catch(e => { console.error(e); process.exitCode = 1; });
