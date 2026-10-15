const assert = require('node:assert/strict');
const Destino = require('../models/Destino.model');

function requisito({ obligatorio = 'no', ...extra } = {}) {
  const destino = new Destino({
    pais: 'Destino de prueba',
    codigo_iso: 'ZZ',
    requisitos: [{ tipo: 'formulario_digital', obligatorio, descripcion: 'Prueba', estado: 'verificar', ...extra }]
  });
  return destino.requisitos[0];
}

async function validar(doc) {
  let error;
  try { await doc.validate(); } catch (e) { error = e; }
  return error;
}

(async () => {
  {
    const doc = requisito();
    assert.equal(await validar(doc), undefined, 'ausencia es válida y no se sustituye por null');
    const serializado = doc.toObject();
    assert.equal(Object.hasOwn(serializado, 'recomendado'), false, 'el campo ausente no se serializa');
  }

  for (const recomendado of ['si', 'no', 'verificar']) {
    assert.equal(await validar(requisito({ recomendado })), undefined, recomendado + ' está permitido');
  }

  for (const valor of [null, 7, true, {}, 'desconocido']) {
    assert.ok(await validar(requisito({ recomendado: valor })), 'se rechaza ' + JSON.stringify(valor));
  }

  assert.ok(await validar(requisito({ obligatorio: 'si', recomendado: 'si' })), 'obligatorio si + recomendado si es contradictorio');
  assert.ok(await validar(requisito({ obligatorio: 'si', recomendado: 'verificar' })), 'obligatorio si + recomendado verificar es contradictorio');
  assert.equal(await validar(requisito({ obligatorio: 'si', recomendado: 'no' })), undefined);
  assert.equal(await validar(requisito({ obligatorio: 'verificar', recomendado: 'si' })), undefined);
  assert.equal(await validar(requisito({ obligatorio: 'no', recomendado: 'verificar' })), undefined);

  process.stdout.write('recomendado Destino: ausencia, enum, null, tipo, valor y reglas cruzadas OK\n');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
