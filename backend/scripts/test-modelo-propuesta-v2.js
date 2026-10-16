// Validaci?n offline del branch 2.0 del modelo; no abre conexiones.
const assert = require('node:assert/strict');
const PropuestaCambio = require('../models/propuestas/PropuestaCambio.model');
const Destino = require('../models/Destino.model');
const { crearSobreRequisitoV2, ALGORITMO_HECHOS_HASH, hashHechos } = require('../services/propuestas/payload-requisito-v2');
const { capturarIdentidadEInstantanea } = require('../services/propuestas/contrato-requisito-v2');

const DESTINO_ID='000000000000000000000001', REQUISITO_ID='000000000000000000000002';
const RUN_ID='11111111-1111-4111-8111-111111111111', PROPUESTA_ID='22222222-2222-4222-8222-222222222222';
const requisito={ _id: REQUISITO_ID, tipo:'formulario_digital', nombre:'Check-Mig', obligatorio:'si', descripcion:'Anterior', fuente:'Migracion Colombia', link:'https://viejo.example/', fecha_verificacion:'2026-08-18', estado:'confirmado' };
const capturado=capturarIdentidadEInstantanea(requisito);
const hechos={ obligatorio:'no' };
const fuente={ nombre:'Migracion Colombia', url:'https://fuente.example/requisito', capturado_en:'2026-10-15T20:00:00.000Z', hechos, algoritmo_hechos_hash:ALGORITMO_HECHOS_HASH, hechos_hash:hashHechos(hechos) };
const entrada={ fecha_propuesta:'2026-10-15T20:30:00.000Z', destino_id:DESTINO_ID, requisito_id:REQUISITO_ID, identidad_requisito:capturado.identidad_requisito, run_id_origen:RUN_ID, propuesta_id:PROPUESTA_ID, instantanea_anterior:capturado.instantanea_anterior, cambios:[{ campo:'obligatorio', propuesto:{ presente:true, bson_tipo:'string', valor:'no' } }], fuentes:[fuente], advertencias:['quita_obligatoriedad'] };
const sobre=crearSobreRequisitoV2(entrada);
function docV2({ payload=sobre.payload, payload_hash=sobre.payload_hash, campo='requisito', destino_id=DESTINO_ID, requisito_id=REQUISITO_ID, run_id_origen=RUN_ID, propuesta_id=PROPUESTA_ID }={}) {
  return new PropuestaCambio({ destino_id, requisito_id, campo, run_id_origen, propuesta_id, algoritmo_canonicalizacion:'toc-v1', algoritmo_hash:'sha256', payload, payload_hash });
}
async function validarValido(documento, etiqueta) {
  try { await documento.validate(); } catch (e) { assert.fail(`${etiqueta}: payload valido rechazado: ${e.message}`); }
}
async function invalido(documento, etiqueta) {
  const error=await documento.validate().then(()=>null,e=>e);
  assert.ok(error, `${etiqueta}: se esperaba rechazo`);
  assert.ok(error.codigo === 'contrato_requisito_2_invalido' || String(error.message).startsWith('propuestas_cambio:'), `${etiqueta}: rechazo por validacion esperada, no fallo accidental: ${error}`);
  return error;
}
(async()=>{
  assert.deepStrictEqual(Destino.schema.path('requisitos').schema.path('tipo').enumValues, require('../services/propuestas/contrato-requisito-v2').TIPOS_REQUISITO);
  await validarValido(docV2(), 'fixture 2.0');
  assert.equal(docV2().valor_anterior, undefined, 'virtual 1.0 no interpreta snapshot 2.0 como costo');
  assert.equal(docV2().valor_propuesto, undefined);
  assert.equal(docV2().fuente, undefined);

  const fixture1={ version_contrato:'1.0', tipo_propuesta:'actualizacion_campo_requisito', fecha_propuesta:'2026-10-15T20:30:00.000Z', destino_id:DESTINO_ID, requisito_id:REQUISITO_ID, campo:'costo', run_id_origen:RUN_ID, propuesta_id:PROPUESTA_ID, valor_anterior:{presente:false,valor:null}, valor_propuesto:{valor:'GBP 20',valor_normalizado:{importe:20,moneda:'GBP'},evidencia:{}}, fuente:{nombre:'GOV.UK',url:'https://www.gov.uk/eta',capturado_en:'2026-10-15T20:00:00.000Z'} };
  const {hashSobreCanonico}=require('../services/propuestas/canonicalizacion-propuestas');
  const doc1=new PropuestaCambio({destino_id:DESTINO_ID,requisito_id:REQUISITO_ID,campo:'costo',run_id_origen:RUN_ID,propuesta_id:PROPUESTA_ID,algoritmo_canonicalizacion:'toc-v1',algoritmo_hash:'sha256',payload:fixture1,payload_hash:hashSobreCanonico(fixture1,'toc-v1','sha256')});
  await validarValido(doc1, 'fixture 1.0');
  assert.deepStrictEqual(Object.keys(doc1.toObject({virtuals:false}).payload).sort(),Object.keys(fixture1).sort());
  assert.deepStrictEqual(doc1.valor_anterior,fixture1.valor_anterior);
  assert.deepStrictEqual(doc1.valor_propuesto,fixture1.valor_propuesto);
  assert.deepStrictEqual(doc1.fuente,fixture1.fuente);

  for (const [version,campo,valido] of [['1.0','costo',true],['1.0','requisito',false],['2.0','requisito',true],['2.0','costo',false]]) {
    if (valido) await validarValido(version==='1.0'?doc1:docV2({campo}), `${version}+${campo}`);
    else {
      const d=version==='1.0'?new PropuestaCambio({destino_id:DESTINO_ID,requisito_id:REQUISITO_ID,campo,run_id_origen:RUN_ID,propuesta_id:PROPUESTA_ID,algoritmo_canonicalizacion:'toc-v1',algoritmo_hash:'sha256',payload:fixture1,payload_hash:hashSobreCanonico(fixture1,'toc-v1','sha256')}):docV2({campo});
      const error=await invalido(d,`${version}+${campo}`);
      assert.match(error.message,/solo admite campo/,`${version}+${campo}: rechazo especifico de matriz`);
    }
  }
  const desconocido={...fixture1,version_contrato:'3.0'};
  await invalido(new PropuestaCambio({destino_id:DESTINO_ID,requisito_id:REQUISITO_ID,campo:'costo',run_id_origen:RUN_ID,propuesta_id:PROPUESTA_ID,algoritmo_canonicalizacion:'toc-v1',algoritmo_hash:'sha256',payload:desconocido,payload_hash:hashSobreCanonico(desconocido,'toc-v1','sha256')}),'version desconocida');

  const mutaciones=[
    ['identidad tipo',p=>{p.identidad_requisito.tipo='visa';}],['identidad nombre',p=>{p.identidad_requisito.nombre.valor='renombrado';}],
    ['instantanea',p=>{p.instantanea_anterior.descripcion.valor='manipulada';}],['cambios',p=>{p.cambios[0].propuesto.valor='si';}],
    ['fuentes',p=>{p.fuentes[0].nombre='otra fuente';}],['advertencias',p=>{p.advertencias=[];}],
    ['identidad faltante',p=>{delete p.identidad_requisito;}],['identidad adicional',p=>{p.identidad_requisito.extra=true;}],
    ['payload adicional',p=>{p.extra=true;}],['snapshot faltante',p=>{delete p.instantanea_anterior;}]
  ];
  for(const [nombre,mutar] of mutaciones){const payload=structuredClone(sobre.payload);mutar(payload);await invalido(docV2({payload}),nombre);}
  const alterado=structuredClone(sobre.payload);alterado.identidad_requisito.tipo='visa';
  const hashManipulado=hashSobreCanonico(alterado,'toc-v1','sha256');
  assert.notEqual(hashManipulado,sobre.payload_hash);
  const errorHashReferencia=await invalido(docV2({payload:alterado,payload_hash:sobre.payload_hash}),'hash de documento confiable');
  assert.match(errorHashReferencia.message,/referencia almacenada/,'la comparacion final usa el hash almacenado en el documento');
  const invalidoPeroRehasheado=structuredClone(sobre.payload); invalidoPeroRehasheado.identidad_requisito.extra='no permitido';
  const hashRecalculado=hashSobreCanonico(invalidoPeroRehasheado,'toc-v1','sha256');
  await invalido(docV2({payload:invalidoPeroRehasheado,payload_hash:hashRecalculado}),'estructura invalida con hash recalculado');
  const externo=[['destino_id',{destino_id:'000000000000000000000003'}],['requisito_id',{requisito_id:'000000000000000000000003'}],['campo',{campo:'costo'}],['run_id_origen',{run_id_origen:'33333333-3333-4333-8333-333333333333'}],['propuesta_id',{propuesta_id:'33333333-3333-4333-8333-333333333333'}]];
  for(const [nombre,opciones] of externo) await invalido(docV2(opciones),`divergencia ${nombre}`);
  const payloadExtra=structuredClone(sobre.payload); payloadExtra.extra='x'; await invalido(docV2({payload:payloadExtra}),'clave payload adicional');
  await invalido(docV2({payload_hash:'0'.repeat(64)}),'hash modificado');
  console.log('Modelo 2.0: payload, referencias de hash, matriz de campos, catalogo, virtuales 1.0 y rechazo de adulteraciones: OK');
})().catch(e=>{console.error(e);process.exitCode=1;});
