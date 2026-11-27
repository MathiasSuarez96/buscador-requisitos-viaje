/**
 * Lectura mínima y determinista del TEXTO de un PDF, sin dependencias: lo necesario para el Quadro
 * Geral de Regime de Vistos de Itamaraty (Word 2013, texto en cadenas literales y FlateDecode).
 *
 * Recorre el árbol de páginas desde /Root → /Pages → /Kids (en orden), toma el /Contents de cada
 * página (objeto sin comprimir), lo descomprime y lee cada bloque BT…ET: su posición (Tm) y el texto
 * de los operadores Tj/TJ. Agrupa en LÍNEAS los bloques de la misma página con la misma y, ordenados
 * por x; cada bloque conserva su x (sirve para leer columnas).
 *
 * No interpreta fuentes ni codificaciones especiales: las cadenas se leen como bytes latin1 (WinAnsi).
 * Las cadenas hexadecimales (glifos de fuentes CID sin tabla) se leen como «�», nunca como letras.
 * Si algo no tiene la forma esperada (página o contenido que no se encuentran, varios contenidos por
 * página, un bloque sin una única posición absoluta) lanza ErrorPdfNoReconocido: la fuente lo
 * convierte en una lectura ambigua, nunca en un dato.
 *
 * Lista cerrada, no lista negra: el contenido se separa en operadores con sus operandos y, dentro de
 * BT…ET, solo se admiten Tm, Tj, TJ y los de estado de este cuadro (Tf, Tc, g, G, gs). Cualquier otro
 * operador —' y " (que también muestran texto), Td/TD/T*— lanza aunque el bloque no tenga Tj/TJ: un
 * texto escrito de una forma que no se lee nunca desaparece en silencio. Fuera de BT…ET no puede haber
 * texto (Tj, TJ, ', ", ni cadenas salvo el idioma /Lang de una sección marcada) ni objetos externos
 * (Do, imágenes en línea); una página con anotaciones también lanza.
 */
const zlib = require('node:zlib');

class ErrorPdfNoReconocido extends Error {}
const falla = m => { throw new ErrorPdfNoReconocido(m); };

function objeto(pdf, n) {
  const re = new RegExp(`(?:^|[\\r\\n\\s])${n} 0 obj\\b`, 'g');
  const hallados = [...pdf.matchAll(re)];
  if (hallados.length !== 1) falla(`el objeto ${n} aparece ${hallados.length} veces sin comprimir`);
  const inicio = hallados[0].index + hallados[0][0].length;
  const fin = pdf.indexOf('endobj', inicio);
  if (fin < 0) falla(`el objeto ${n} no termina`);
  return pdf.slice(inicio, fin);
}

function referencia(dic, clave) {
  const m = dic.match(new RegExp(`/${clave}\\s+(\\d+) 0 R`));
  return m ? Number(m[1]) : null;
}

function contenidoDePagina(pdf, cuerpoPagina) {
  if (/\/Contents\s*\[/.test(cuerpoPagina)) falla('una página tiene varios contenidos');
  const n = referencia(cuerpoPagina, 'Contents');
  if (n === null) falla('una página no tiene /Contents');
  const obj = objeto(pdf, n);
  const m = obj.match(/^\s*<<([\s\S]*?)>>\s*stream\r?\n/);
  if (!m || !/\/Filter\s*\/FlateDecode/.test(m[1]) || /\/DecodeParms/.test(m[1])) falla('el contenido de una página no es FlateDecode simple');
  const datos = obj.slice(m[0].length, obj.lastIndexOf('endstream'));
  try { return zlib.inflateSync(Buffer.from(datos.replace(/\r?\n$/, ''), 'latin1')).toString('latin1'); }
  catch { falla('el contenido de una página no se puede descomprimir'); }
}

function paginas(pdf) {
  const raiz = pdf.match(/\/Root\s+(\d+) 0 R/g);
  if (!raiz || new Set(raiz).size !== 1) falla('no hay una raíz única');
  const catalogo = objeto(pdf, Number(raiz[0].match(/(\d+) 0 R/)[1]));
  const nPaginas = referencia(catalogo, 'Pages');
  if (nPaginas === null) falla('la raíz no tiene /Pages');
  const nodoPaginas = objeto(pdf, nPaginas);
  const kids = nodoPaginas.match(/\/Kids\s*\[([^\]]*)\]/);
  const cuenta = nodoPaginas.match(/\/Count\s+(\d+)/);
  if (!kids || !cuenta) falla('el nodo de páginas no tiene /Kids o /Count');
  const ids = [...kids[1].matchAll(/(\d+) 0 R/g)].map(x => Number(x[1]));
  if (ids.length !== Number(cuenta[1])) falla('las páginas no son hojas directas del nodo raíz');
  return ids.map(id => {
    const cuerpo = objeto(pdf, id);
    if (!/\/Type\s*\/Page\b/.test(cuerpo)) falla(`el objeto ${id} no es una página`);
    // Una anotación (nota emergente, texto libre) muestra texto fuera del contenido: no se lee.
    if (/\/Annots\b/.test(cuerpo)) falla(`la página ${id} tiene anotaciones`);
    return contenidoDePagina(pdf, cuerpo);
  });
}

const literal = s => s.replace(/\\(\d{1,3}|.)/gs, (_, c) => (/^\d/.test(c) ? String.fromCharCode(parseInt(c, 8))
  : ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[c] ?? c));

// Análisis léxico mínimo de un contenido de página (no de un PDF cualquiera): cadenas literales con
// paréntesis anidados y escapes, cadenas hexadecimales, nombres, números, arreglos, diccionarios y
// operadores. Lo que no tenga una de esas formas lanza ErrorPdfNoReconocido.
const BLANCO = /[\0\t\n\f\r ]/;
const DELIM = /[\0\t\n\f\r ()<>[\]{}/%]/;
function tokens(c) {
  const ts = [];
  for (let i = 0; i < c.length;) {
    const ch = c[i];
    if (BLANCO.test(ch)) { i++; continue; }
    if (ch === '%') { while (i < c.length && c[i] !== '\n' && c[i] !== '\r') i++; continue; }
    if (ch === '(') {
      let j = i + 1, nivel = 1;
      for (; j < c.length; j++) {
        if (c[j] === '\\') { j++; continue; }
        if (c[j] === '(') nivel++;
        else if (c[j] === ')' && --nivel === 0) break;
      }
      if (nivel !== 0) falla('una cadena del contenido no termina');
      ts.push({ t: 'cadena', v: c.slice(i + 1, j) }); i = j + 1; continue;
    }
    if (ch === '<' && c[i + 1] === '<') { ts.push({ t: '<<' }); i += 2; continue; }
    if (ch === '>' && c[i + 1] === '>') { ts.push({ t: '>>' }); i += 2; continue; }
    if (ch === '<') {
      const fin = c.indexOf('>', i);
      if (fin < 0 || !/^[0-9A-Fa-f\0\t\n\f\r ]*$/.test(c.slice(i + 1, fin))) falla('una cadena hexadecimal del contenido no tiene la forma esperada');
      ts.push({ t: 'hex' }); i = fin + 1; continue;
    }
    if (ch === '[' || ch === ']') { ts.push({ t: ch }); i++; continue; }
    if (ch === ')' || ch === '>' || ch === '{' || ch === '}') falla(`el contenido tiene un «${ch}» fuera de lugar`);
    let j = i + 1;
    while (j < c.length && !DELIM.test(c[j])) j++;
    const palabra = c.slice(i, j);
    if (ch === '/') ts.push({ t: 'nombre', v: palabra.slice(1) });
    else if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(palabra)) ts.push({ t: 'numero', v: palabra });
    else ts.push({ t: 'op', v: palabra });
    i = j;
  }
  return ts;
}

// Operandos de cada operador: arreglos y diccionarios anidados como valores.
function instrucciones(c) {
  const ts = tokens(c), salida = [];
  let pila = [];
  const abiertos = [];
  for (const tk of ts) {
    if (tk.t === '[' || tk.t === '<<') { abiertos.push({ t: tk.t === '[' ? 'arreglo' : 'dic', items: [], pila }); pila = abiertos.at(-1).items; continue; }
    if (tk.t === ']' || tk.t === '>>') {
      const a = abiertos.pop();
      if (!a || (a.t === 'arreglo') !== (tk.t === ']')) falla('arreglo o diccionario mal cerrado en el contenido');
      pila = a.pila; pila.push({ t: a.t, items: a.items }); continue;
    }
    if (tk.t === 'op') {
      if (abiertos.length) falla(`el operador ${tk.v} aparece dentro de un arreglo o diccionario`);
      salida.push({ op: tk.v, operandos: pila }); pila = []; continue;
    }
    pila.push(tk);
  }
  if (abiertos.length || pila.length) falla('el contenido termina con operandos sueltos');
  return salida;
}

const tieneCadena = v => v.t === 'cadena' || v.t === 'hex' || ((v.t === 'arreglo' || v.t === 'dic') && v.items.some(tieneCadena));
// Dentro de BT…ET solo se admiten los operadores de este cuadro (07/10/2026): posición absoluta (Tm),
// texto (Tj/TJ) y estado gráfico/de fuente. Cualquier otro —en particular ' y " (también muestran
// texto), Td/TD/T* (posición relativa)— lanza: una nota escrita con una forma no soportada no se pierde.
const ESTADO_EN_TEXTO = new Set(['Tf', 'Tc', 'g', 'G', 'gs']);
// Fuera de BT…ET: nada que muestre texto ni objetos externos (un formulario puede contener texto).
const PROHIBIDOS_FUERA = new Set(['Tj', 'TJ', "'", '"', 'Do', 'BI', 'ID', 'EI']);
// Única cadena admitida fuera de un bloque de texto: el idioma de una sección marcada (/Lang (es-ES)).
function cadenasFueraAdmitidas(ins) {
  if (ins.op !== 'BDC' && ins.op !== 'BMC') return !ins.operandos.some(tieneCadena);
  return ins.operandos.every(v => {
    if (!tieneCadena(v)) return true;
    if (v.t !== 'dic') return false;
    for (let k = 0; k < v.items.length; k += 2) {
      const [clave, valor] = [v.items[k], v.items[k + 1]];
      if (valor && tieneCadena(valor) && !(clave.t === 'nombre' && clave.v === 'Lang' && valor.t === 'cadena' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(valor.v))) return false;
    }
    return true;
  });
}

// Pura. [{ pagina, y, bloques: [{ x, texto }], texto }] en orden de página, y descendente y x.
function lineasPdf(pdf) {
  const lineas = [];
  paginas(String(pdf)).forEach((contenido, i) => {
    const bloques = [];
    let bloque = null;
    for (const ins of instrucciones(contenido)) {
      const { op, operandos } = ins;
      if (op === 'BT') {
        if (bloque) falla('un bloque de texto empieza dentro de otro');
        bloque = { texto: '', tm: [] };
        continue;
      }
      if (op === 'ET') {
        if (!bloque) falla('un bloque de texto termina sin haber empezado');
        const { texto, tm } = bloque;
        bloque = null;
        if (!texto.trim()) continue;
        if (tm.length !== 1 || tm[0][0] !== '1' || tm[0][3] !== '1') falla('un bloque de texto no tiene una única posición absoluta');
        bloques.push({ x: Number(tm[0][4]), y: Number(tm[0][5]), texto });
        continue;
      }
      if (!bloque) {
        if (PROHIBIDOS_FUERA.has(op)) falla(`la página usa ${op} fuera de un bloque de texto; ese contenido no se lee`);
        if (!cadenasFueraAdmitidas(ins)) falla(`la página tiene texto en el operador ${op} fuera de un bloque de texto`);
        continue;
      }
      // Cadenas hexadecimales (glifos de fuentes CID sin tabla de caracteres): «�», nunca una letra.
      if (op === 'Tj') {
        if (operandos.length !== 1 || !['cadena', 'hex'].includes(operandos[0].t)) falla('Tj sin una única cadena');
        bloque.texto += operandos[0].t === 'hex' ? '�' : literal(operandos[0].v);
      } else if (op === 'TJ') {
        if (operandos.length !== 1 || operandos[0].t !== 'arreglo' || !operandos[0].items.every(p => ['cadena', 'hex', 'numero'].includes(p.t))) falla('TJ sin un único arreglo de cadenas y números');
        bloque.texto += operandos[0].items.filter(p => p.t !== 'numero').map(p => (p.t === 'hex' ? '�' : literal(p.v))).join('');
      } else if (op === 'Tm') {
        if (operandos.length !== 6 || !operandos.every(p => p.t === 'numero')) falla('Tm sin seis números');
        bloque.tm.push(operandos.map(p => p.v));
      } else if (ESTADO_EN_TEXTO.has(op)) {
        if (operandos.some(tieneCadena)) falla(`el operador ${op} lleva una cadena dentro de un bloque de texto`);
      } else {
        falla(`un bloque de texto usa el operador ${JSON.stringify(op.slice(0, 8))}, que no se lee`);
      }
    }
    if (bloque) falla('un bloque de texto no termina');
    const porY = new Map();
    for (const b of bloques) porY.set(b.y, [...(porY.get(b.y) ?? []), b]);
    for (const y of [...porY.keys()].sort((a, b) => b - a)) {
      const bs = porY.get(y).sort((a, b) => a.x - b.x).map(b => ({ x: b.x, texto: b.texto }));
      lineas.push({ pagina: i + 1, y, bloques: bs, texto: bs.map(b => b.texto).join('').replace(/\s+/g, ' ').trim() });
    }
  });
  return lineas;
}

module.exports = { lineasPdf, ErrorPdfNoReconocido };
