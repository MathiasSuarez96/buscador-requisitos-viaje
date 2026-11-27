# Lote AR/BR/CL: visa y documento de viaje desde fuentes del destino

Código: `services/propuestas/fuentes/{argentina-extranjeros-turismo, argentina-migraciones-documentacion-turista, itamaraty-qgrv, consulado-chile-visas, texto-pdf}.js`,
sus adaptadores en `adaptadores/v2/` y los perfiles en `ciclo/perfiles-ar-br-cl.js`.
Pruebas: `scripts/test-lote-ar-br-cl-v2.js`.

## Resultado: 4 de 6 candidatos listos

| Requisito | Estado | Fuente oficial | Contexto exacto de la fuente |
|---|---|---|---|
| AR visa | listo | argentina.gob.ar «Extranjeros» › Turismo › Mercosur | **ciudadano** de Uruguay, turismo, hasta 90 días; no dice el documento |
| AR validez_pasaporte | listo | Migraciones «Documentación para ingresar al país como turista» | documento del **país de origen** Uruguay: pasaporte vigente, cédula vigente o documento de viaje hábil vigente; turista = descanso o esparcimiento, sin tareas remuneradas |
| BR visa | listo | Itamaraty, Quadro Geral de Regime de Vistos (PDF del 07/10/2026) | **nacional** de Uruguay, visa de visita con **pasaporte común**: dispensa por hasta 90 días (código 4); «#» = ingreso permitido con cédula de identidad civil |
| CL visa | listo | Red Consular de Chile, tabla de visas (JSON que carga consulado.gob.cl) | **nacionalidad** Uruguay: «¿Requiere visa?» NO, plazo máximo de estadía 90 días; no dice motivo ni documento |
| BR validez_pasaporte | pendiente | — | El cuadro admite la cédula, pero no dice ninguna vigencia del documento. La página de la Polícia Federal que se probó respondió 404. El texto IATA actual («válido por la duración total de la estadía») no se respalda ni se reemplaza. |
| CL validez_pasaporte | pendiente, **revisar a mano** | — | Solo el Consulado General de Chile en **Buenos Aires** nombra a Uruguay («documento de identidad… mínimo 6 meses de vigencia»), en una página para quien viaja **desde Argentina**. SERMIG dice «Mercosur y Bolivia» sin nombrar a Uruguay. No se generaliza. Atención: el texto IATA publicado («válido al momento de llegada, sin mínimo de meses») contradice esa regla de 6 meses para la cédula. |

## Descripciones antes y después

**AR visa** (`obligatorio` sigue en "no").
- Antes: «No requiere visa para pasaporte normal, estadía máxima 90 días. Se puede extender hasta el
  doble del plazo original otorgado. Requiere pasaje de regreso/continuación.»
- Después: «Los ciudadanos uruguayos pueden ingresar a la Argentina como turistas sin visa, por hasta
  90 días. Para trabajar, estudiar u otros motivos, consultar la fuente oficial.»
- Se retiran «para pasaporte normal» (la fuente habla de ciudadanos y no del documento), «Se puede
  extender hasta el doble…» y «Requiere pasaje de regreso/continuación» (esta fuente no lo dice).

**AR validez_pasaporte** (`obligatorio` pasa de "si" a "no", advertencia `quita_obligatoriedad`).
- Antes: «El documento de viaje debe ser válido al momento de llegada (sin mínimo de meses adicionales).»
- Después: «Para ingresar a la Argentina como turista no se exige pasaporte: con documentos de Uruguay se
  acepta el pasaporte vigente, la cédula de identidad vigente o un documento de viaje hábil vigente.
  Para otros motivos de viaje, consultar la fuente oficial.»
- Se retira «sin mínimo de meses adicionales» (la fuente solo dice «vigente»).

**BR visa** (`obligatorio` sigue en "no").
- Antes: «No requiere visa para pasaportes normales, estadía máxima 90 días. Se puede solicitar
  extensión al llegar.»
- Después: «Según el cuadro de visas de Itamaraty, los nacionales de Uruguay con pasaporte común no
  necesitan visa de visita: la dispensa es por hasta 90 días. El mismo cuadro permite el ingreso con
  cédula de identidad civil. Para trabajo, estudio o residencia, consultar la fuente oficial.»
- Se retira «Se puede solicitar extensión al llegar».

**CL visa** (`obligatorio` sigue en "no").
- Antes: «No requiere visa, estadía máxima 90 días. Se puede extender 90 días adicionales. Requiere
  pasaje de regreso/continuación.»
- Después: «Según la tabla de visas de la Red Consular de Chile, los nacionales de Uruguay no requieren
  visa para ingresar a Chile; el plazo máximo de estadía indicado es de 90 días. Para residir o
  trabajar en Chile, consultar la fuente oficial.»
- Se retiran la extensión de 90 días y el pasaje de regreso.

Ninguna regla retirada se declara falsa: solo deja de publicarse porque la fuente nueva no la respalda.
Las cuatro aplicaciones fijan `estado: confirmado` (ya lo estaban), la fuente oficial y la fecha del
día.

## Cédula: cómo se representa sin ampliar el contrato

La tarjeta muestra `nombre` o, si no hay, «Validez de pasaporte». `nombre` forma parte de la identidad
del requisito y el contrato 2.0 no lo cambia. Con `obligatorio: si`, la tarjeta diría «Validez de
pasaporte · Obligatorio», aunque se pueda entrar con cédula. El perfil fija `obligatorio: no` (el
pasaporte no es obligatorio) y una descripción que nombra cada documento aceptado con su vigencia.
Así se evita el error sin tocar el contrato ni el frontend. El límite que queda es solo de redacción:
el título de la tarjeta sigue diciendo «pasaporte». Renombrarlo, por ejemplo a «Documento de viaje»
para todos los destinos, sería un cambio de frontend aparte.

## Ampliación técnica mínima

`lectura-http-oficial.js` admite `contenido: 'json' | 'pdf'` además de HTML, con su propio
content-type; el PDF se lee byte a byte en latin1. `texto-pdf.js` lee el texto de un PDF sin
dependencias:
- recorre las páginas en orden;
- lee los bloques `Tj`/`TJ` con su posición;
- una cadena hexadecimal se lee como `�` (nunca como letra);
- cualquier otra forma no reconocida deja la lectura ambigua.

El lector usa una **lista cerrada**: separa el contenido de cada página en operadores con sus operandos
(cadenas con paréntesis anidados y escapes, hexadecimales, arreglos, diccionarios) y dentro de BT…ET solo
admite Tm, Tj, TJ y los de estado de este cuadro (Tf, Tc, g, G, gs). Cualquier otro operador lanza,
aunque el bloque no tenga Tj/TJ: en particular `'` y `"`, que también muestran texto, y Td/TD/T*.
Fuera de BT…ET no se admite texto (ni cadenas, salvo el idioma `/Lang` de una sección marcada) ni
objetos externos (`Do`, imágenes en línea); una página con anotaciones también lanza. Antes, un bloque
sin Tj/TJ se salteaba ANTES de rechazar los operadores no soportados: una nota escrita con `'` desaparecía
y la lectura seguía confirmada (hallazgo de Codex del 25/11). No es un lector PDF general: un cuadro que
use otras formas deja la lectura ambigua y va a revisión humana.

La lectura de Brasil hace dos consultas: la página del cuadro, que debe tener un único enlace con el
texto exacto, y el PDF de ese enlace. Así una versión nueva del PDF no se pierde por usar un nombre de
archivo fijo.

## Cómo se evita un falso confirmado

Cada fuente ancla completo el texto que respalda el dato. Fuera de ese texto, **cada** segmento de la
página (o cada línea del PDF que no sea una fila de país) tiene que ser uno de los textos conocidos el
25/11/2026. Las huellas sha256 están en `fuentes/textos-conocidos/`. Una lista de palabras clave no
alcanzaba: «Se exige seguro médico.» fuera del cuerpo pasaba como confirmado; la suite lo detectó y la
regla cambió.

Consecuencia operativa: un cambio de texto en esas páginas, aunque sea irrelevante, deja la lectura
ambigua y el caso va a revisión humana sin publicar. Para reanudar hay que revisar el texto nuevo y
actualizar la gramática o las huellas.

Pruebas: 52 mutaciones de fuente que deben dar ambiguo:
- 16 AR visa, 12 AR documento, 11 BR PDF, 3 BR enlace y 10 CL;
- condición dentro del texto admitido y al final;
- listas, divs, texto suelto y contenedores anidados;
- duplicados, secciones faltantes y contexto distinto (residencia en lugar de origen, otra rama,
  otro motivo).

Las 18 mutaciones de código sobre las guardas se detectan todas.

## Activación (pendiente de autorización; nada ejecutado)

Políticas nuevas, una por requisito:
- `argentina-gob-ar-visa-uy@1`
- `migraciones-ar-documento-uy@1`
- `itamaraty-br-visa-uy@1`
- `consulado-chile-cl-visa-uy@1`

Perfiles: `argentina-ar-visa`, `migraciones-ar-documento`, `itamaraty-br-visa` y `consulado-cl-visa`.

Igual que con ETIAS, los pasos 3 a 6 van seguidos en una misma sesión, después de la corrida
programada del día.

1. **Respaldo** con la cuenta de solo lectura: 28 destinos, índices y 0 propuestas activas.
2. **Push** de `main` hasta el commit del lote. El workflow no cambia.
3. **Perfiles:** agregar los 4 perfiles a `PERFILES_CICLO`, conservando los 13.
4. **Informe:** `workflow_dispatch` con `solo_informe=true`. Se esperan 4 `cambio_aplicable`
   (exit 2; el job falla, y es lo esperado por cambios sin política), los 13 en `sin_cambio` y DE en
   `ya_existe`. Si algo difiere, volver `PERFILES_CICLO` a los 13 y detenerse.
5. **Políticas:** agregarlas de a una, encadenando el generador desde la copia privada de las 8 vigentes:
   ```
   node scripts/preparar-autorizaciones-ciclo.js --actuales backups/activacion-etias-20261124/autorizaciones.json --esperadas 8  --agregar argentina-gob-ar-visa-uy@1     --autorizada-por <persona> --salida <fuera>/a9.json
   node scripts/preparar-autorizaciones-ciclo.js --actuales <fuera>/a9.json  --esperadas 9  --agregar migraciones-ar-documento-uy@1  --autorizada-por <persona> --salida <fuera>/a10.json
   node scripts/preparar-autorizaciones-ciclo.js --actuales <fuera>/a10.json --esperadas 10 --agregar itamaraty-br-visa-uy@1         --autorizada-por <persona> --salida <fuera>/a11.json
   node scripts/preparar-autorizaciones-ciclo.js --actuales <fuera>/a11.json --esperadas 11 --agregar consulado-chile-cl-visa-uy@1   --autorizada-por <persona> --salida <fuera>/a12.json
   ```
   Cada paso confirma que las entradas previas quedan exactas. Después se carga con
   `gh secret set CICLO_V2_AUTORIZACION_JSON < <fuera>/a12.json` y se guarda la copia en la carpeta del
   respaldo.
6. **Aplicación:** `workflow_dispatch` con `solo_informe=false`. Se esperan 4 `exito`, uno de ellos
   con la advertencia `quita_obligatoriedad` (AR documento).
7. **Verificación** en la API pública: los 4 textos de arriba, las fuentes oficiales, la fecha del día
   y AR validez con `obligatorio: no`. Los otros 25 destinos y el resto de los requisitos de AR/BR/CL,
   sin cambios.
8. **Repetición:** otra corrida con `solo_informe=false`. Se esperan los 17 perfiles en `sin_cambio` y
   cero escrituras.

Sin índices, permisos, red de Atlas, servicios ni costos nuevos.

## Cobertura real

Hoy hay 13 requisitos automatizados en 9 países; seis de ellos son el mismo ETIAS. Con este lote
serían 17 en 12 países. Los ligados a IATA bajarían de 123 a 119. Siguen pendientes BR y CL
validez_pasaporte, más todo lo demás atribuido a IATA. Sobre la licencia o los términos de esa
procedencia no se concluye nada.
