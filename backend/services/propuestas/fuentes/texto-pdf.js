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
    return contenidoDePagina(pdf, cuerpo);
  });
}

const literal = s => s.replace(/\\(\d{1,3}|.)/gs, (_, c) => (/^\d/.test(c) ? String.fromCharCode(parseInt(c, 8))
  : ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[c] ?? c));

// Pura. [{ pagina, y, bloques: [{ x, texto }], texto }] en orden de página, y descendente y x.
function lineasPdf(pdf) {
  const lineas = [];
  paginas(String(pdf)).forEach((contenido, i) => {
    const bloques = [];
    for (const bt of contenido.split(/\bBT\b/).slice(1)) {
      const cuerpo = bt.split(/\bET\b/)[0];
      let texto = '';
      // Cadenas hexadecimales (glifos de fuentes CID sin tabla de caracteres): «�», nunca una letra.
      for (const m of cuerpo.matchAll(/\[((?:\\.|[^\]\\])*)\]\s*TJ|\(((?:\\.|[^)\\])*)\)\s*Tj|<[0-9A-Fa-f\s]*>\s*Tj/g)) {
        if (m[1] === undefined && m[2] === undefined) { texto += '�'; continue; }
        const piezas = m[1] !== undefined ? [...m[1].matchAll(/\(((?:\\.|[^)\\])*)\)|<[0-9A-Fa-f\s]*>/g)].map(p => (p[1] === undefined ? '�' : literal(p[1]))) : [literal(m[2])];
        texto += piezas.join('');
      }
      if (!texto.trim()) continue;
      const tm = [...cuerpo.matchAll(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) Tm/g)];
      if (tm.length !== 1 || tm[0][1] !== '1' || tm[0][4] !== '1' || /\bT[dD*]\b|\b'|"\s/.test(cuerpo.replace(/\((?:\\.|[^)\\])*\)/g, ''))) falla('un bloque de texto no tiene una única posición absoluta');
      bloques.push({ x: Number(tm[0][5]), y: Number(tm[0][6]), texto });
    }
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
