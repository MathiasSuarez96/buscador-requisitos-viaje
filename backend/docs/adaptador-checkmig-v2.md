# Adaptador 2.0 de CheckMig (H3.2, solo lectura)

Estado: implementado. Desde H3.3 lo usa el flujo interno `services/propuestas/orquestar-aplicacion-v2.js`
(ver `docs/aplicador-v2.md`, sección H3.3). No hay ruta, CLI ni panel que lo llame.
No escribe nada, no usa Mongo ni modelos y hace una sola lectura de la ficha por invocación.

Archivos:

- `services/propuestas/fuentes/migracion-colombia-checkmig.js`: lectura, parser y normalización.
- `services/propuestas/adaptadores/v2/migracion-colombia-checkmig.js`: el adaptador.
- `services/propuestas/adaptadores/v2/index.js`: registro 2.0, separado del registro 1.0.
- `scripts/prototipo-checkmig.js`: CLI de diagnóstico sobre la fuente.
- Pruebas: `scripts/test-adaptador-v2-checkmig.js` y `scripts/test-prototipo-checkmig.js`.
- Fixtures: `scripts/fixtures/checkmig/`.

## 1. Fuente

- URL: `https://www.migracioncolombia.gov.co/tramites-y-servicios/aplicativos/checkmig`
  (`URL_FICHA`).
- Nombre de la fuente en la propuesta: `Migración Colombia` (`FUENTE_NOMBRE`).
- Adaptador: `nombre` `migracion-colombia-checkmig`, `version` `1`.

## 2. Compatibilidad: sin consultar la fuente

`compatibilidad(propuesta)` es pura y devuelve `{compatible: true}` o `{compatible: false, codigo}`.
`revalidar()` devuelve `{tipo: 'incompatible', codigo}` **antes de cualquier consulta**.

Códigos cerrados (`CODIGOS_INCOMPATIBILIDAD`), en el orden en que se evalúan:

1. `propuesta_invalida`: sin `payload` objeto.
2. `version_contrato_no_soportada`: distinta de `2.0`.
3. `campo_no_soportado`: distinto de `requisito`.
4. `sin_fuentes`.
5. `varias_fuentes`: el verificador exige una revalidación por cada URL y este adaptador lee una sola.
6. `fuente_no_soportada`: otra URL u otro nombre.
7. `algoritmo_hechos_no_soportado`: distinto de `sha256-toc-hechos-v1`.
8. `esquema_hechos_no_soportado`: `hechos.esquema` distinto de `checkmig-hechos-v1`.
9. `hechos_guardados_no_canonicos`: los hechos guardados no son exactamente los que produciría
   `normalizarHechos`, por ejemplo con listas sin ordenar o claves de más. Si se aceptaran, una
   diferencia de forma se leería como un cambio de la fuente.

Fixtures existentes revisados (11/11/2026):

- **Aplicador:** la propuesta de `test-aplicar-propuesta-v2.js` tiene una sola fuente, pero con
  la URL `https://www.migracioncolombia.gov.co/checkmig` y hechos ad hoc. Para este adaptador es
  `fuente_no_soportada`.
- **Payload:** la base de `test-payload-requisito-v2.js` tiene dos fuentes (`/pagina-a` y
  `/pagina-b`). Es `varias_fuentes`.
- Las dos quedan como pruebas de incompatibilidad.
- **Piloto:** la propuesta piloto de `test-adaptador-v2-checkmig.js` es **sintética**. Se arma con
  `crearSobreRequisitoV2` dentro de la prueba y usa los ids de Colombia y CheckMig, pero no sale de
  Atlas ni de una corrida. Tiene una sola fuente, con la URL **exacta** de la ficha informativa
  (§1).
- **URL exacta:** la compatibilidad compara la URL por igualdad estricta. El enlace al formulario
  (`https://apps.migracioncolombia.gov.co/check-mig/`, que es el `link` del requisito en los
  respaldos) y `https://apps.migracioncolombia.gov.co/pre-registro/` cumplen otra función: llevan al
  trámite, no son la fuente que se revalida. Dan `fuente_no_soportada`, igual que la ficha con
  barra final, con query, con otra capitalización o por http.

## 3. Resultados de `revalidar(propuesta, {fetch, ahora, timeoutMs})`

`revalidar()` nunca lanza por la fuente y nunca compara contra la propuesta.

- **Incompatible:** `{tipo: 'incompatible', codigo}`.
- **Fallo HTTP o de transporte:** `{tipo: 'no_disponible', motivo, url, fuente_nombre, diagnostico}`.
  No trae `revalidada_en`. Motivos posibles:
  - `red:<código>` (el código se sanea; uno inesperado queda como `red:desconocido`);
  - `tiempo_agotado`;
  - `http_<status>`, para cualquier status distinto de 200 que no sea una redirección;
  - `redireccion_fuera_del_sitio`, `redireccion_sin_destino`, `demasiadas_redirecciones`;
  - `no_html`, `cuerpo_ilegible`, `demasiado_grande`.
- **Evidencia insuficiente:** `{tipo: 'ambiguo', motivo, url, fuente_nombre, revalidada_en, campos, diagnostico}`.
  - `motivo` lista los códigos `campo:motivo` de los campos que no quedaron `ok`, por ejemplo
    `obligatoriedad:no_atribuible,alcance:sin_evidencia`.
  - `campos.<campo>` tiene la forma `{estado, motivo?, evidencia}`.
  - **No trae `hechos`, `hechos_hash` ni valores parciales.** Así nadie puede armar una
    revalidación con una lectura incompleta.
- **Evidencia suficiente en los tres campos:**
  `{tipo: 'hechos', url, fuente_nombre, algoritmo_hechos_hash, revalidada_en, hechos, hechos_hash, evidencia, diagnostico}`.
  - `evidencia.<campo>`: oraciones de la ficha, de 240 caracteres como máximo cada una.
  - `revalidada_en`: el instante (Date) en que llegó la respuesta, según el reloj inyectado.
  - `diagnostico`: `{consultado_en, url_final, redirecciones, http_status, bytes, contenido_sha256}`.

`proyectarRevalidacion(r)` devuelve solo `{tipo, url, fuente_nombre, algoritmo_hechos_hash, revalidada_en, hechos}`.
Es la forma que espera `verificarRevalidaciones` y solo acepta un resultado `hechos`. La evidencia
y el diagnóstico van al intento, nunca a `revalidaciones`.

## 4. Datos normalizados y hashes

```
hechos = {
  esquema: 'checkmig-hechos-v1',
  obligatoriedad: 'no_obligatorio' | 'obligatorio',
  alcance: { viajeros: ⊆ ['extranjeros', 'nacionales'] (no vacío, ordenado),
             sentidos: ⊆ ['ingreso', 'salida'] (no vacío, ordenado) },
  ventana_horas_antes: { maximo_horas_antes: entero 1..720,
                         minimo_horas_antes: entero 0..máximo-1 | null }
}
hechos_hash = hashHechos(hechos)   // sha256-toc-hechos-v1, sin cambios
```

- Las listas se ordenan **antes** de `hashHechos`, porque `jsonEstricto` ordena las claves de los
  objetos pero no las listas. Así «extranjeros y nacionales» y «nacionales y extranjeros» dan el
  mismo hash.
- Fuera de `hechos` quedan: el texto de «Dirigido a:», la evidencia, las fechas, la URL final, el
  status HTTP y el hash del HTML.
- Un valor fuera de dominio, por ejemplo 800 horas, da `ambiguo` con motivo `<campo>:fuera_de_dominio`.
- `diagnostico.contenido_sha256` es el sha256 del cuerpo completo decodificado como UTF-8. Es
  **solo diagnóstico**: no se compara con nada.
- **Dónde se calcula `fuente_cambio`:** sin cambios, en `verificarRevalidaciones`
  (`plan-aplicacion-requisito-v2.js`). Compara `hashHechos(r.hechos)` con el `hechos_hash` guardado
  y luego hace una igualdad canónica. Entran en la comparación exactamente las seis hojas de
  `hechos`: `esquema`, `obligatoriedad`, `viajeros`, `sentidos`, `maximo_horas_antes` y
  `minimo_horas_antes`.

## 5. Cambio confirmado frente a lectura incompleta

- **Lectura incompleta:** cualquier resultado que no sea `hechos`. Nunca llega al verificador y
  nunca produce `fuente_cambio`.
- **Cambio detectado:** un resultado `hechos` cuyo `hechos_hash` difiere del guardado en la
  propuesta. `verificarRevalidaciones` lanza `fuente_cambio`.
- **Orquestación** (implementada en H3.3, `orquestar-aplicacion-v2.js` y `registrar-revalidacion-v2.js`):
  - antes de registrar `fuente_cambio`, lo que deja la propuesta en `obsoleta`, se pide una
    **segunda lectura válida**, en otra invocación de `revalidar()`;
  - esa segunda lectura debe devolver `hechos` con **el mismo `hechos_hash` cambiado**;
  - si la segunda lectura es `ambiguo` o `no_disponible`, o da otros hechos, no se marca la
    propuesta como obsoleta;
  - cada invocación del adaptador hace una sola lectura; la orquestación decide cuándo repetir;
  - H3.2 probaba solo la detección; H3.3 prueba el flujo completo con Mongo efímero.

## 6. Lectura de la ficha

- Una petición `GET` con `redirect: 'manual'`, un solo `AbortSignal.timeout(20 s)` para toda la
  lectura y `user-agent: buscador-requisitos-viaje/adaptador-checkmig`. No envía cookies ni datos
  del usuario.
- **Redirecciones** (301, 302, 303, 307, 308):
  - el destino se resuelve contra la URL actual y se valida **antes de seguirlo**: HTTPS, host
    exactamente `www.migracioncolombia.gov.co`, sin credenciales y sin puerto;
  - un destino ajeno nunca se consulta;
  - el diagnóstico de un destino rechazado guarda solo el origen y la ruta, sin query ni credenciales;
  - se siguen como máximo 3 redirecciones y se descarta el fragmento.
- **Tamaño:**
  - un `content-length` mayor que 3 MiB se rechaza sin leer el cuerpo;
  - sin ese encabezado, el cuerpo se lee por partes y se cancela en cuanto supera 3 MiB;
  - exactamente 3 MiB se acepta.
- El cuerpo se decodifica como UTF-8 con reemplazo, igual que `Response.text()`. Un charset
  distinto en `content-type` no se interpreta.

## 7. Parser: específico de CheckMig

La decisión de generalizarlo queda para el segundo adaptador.

- **Contenido:** solo se lee el único `<main>`, sin comentarios ni scripts. Sin `<main>`, o con
  dos, los tres campos quedan `ambiguo`.
- **Obligatoriedad:** solo cuenta una afirmación **atribuible al prerregistro y completa**. Se
  valida la **oración entera**, incluida su continuación, contra una de tres redacciones admitidas:
  - **A.** En la ficha de CheckMig (el primer `<h1>` del `<main>` es «CheckMig»), la oración del
    servicio tal como la publica la ficha: «Servicio gratuito y en línea, de uso (no)
    obligatorio que permite a los viajeros precargar la información relacionada con (o: de) su
    viaje [hasta con N horas de anticipación[, o hasta N hora(s) antes del mismo]].»
  - **B.** La oración entera es «CheckMig | El uso de CheckMig | El prerregistro… (no) es
    obligatorio | opcional | voluntario[ para todos los viajeros].»
  - **C.** La oración entera es «(No) es obligatorio diligenciar / usar / … CheckMig | el
    prerregistro | el formulario de CheckMig[ para todos los viajeros].»

  El esquema no representa condiciones ni fechas de vigencia. Si la afirmación tiene algo antes o
  después de la redacción admitida, queda `condicionada`. Ejemplos: «CheckMig es obligatorio si el
  viaje es por vía aérea», «CheckMig no es obligatorio desde el 1 de diciembre», «Desde el 1 de
  diciembre, CheckMig es obligatorio», «…a partir de 2027», o una condición agregada a la oración
  de la ficha. **No hay una lista de palabras prohibidas**: lo que no está admitido no se
  interpreta.
- **Menciones que se ignoran:** las que tienen como sujeto u objeto otro documento, como
  «El pasaporte es obligatorio para usar CheckMig», «Para usar CheckMig es obligatorio el
  pasaporte» o «Es obligatorio presentar el pasaporte».
- **Motivos de ambigüedad de la obligatoriedad:**
  - `no_atribuible`: cualquier otra mención, por ejemplo «El formulario es obligatorio» (también
    referido a otro trámite), una redacción distinta o «de uso» fuera de la ficha.
  - `condicionada`: la afirmación atribuible no es una redacción admitida entera (condición,
    vigencia, grupo, excepción u otro agregado), o la oración tiene ambas polaridades.
  - `contradiccion`: afirmaciones atribuibles de polaridad opuesta.
  - `sin_evidencia`: ninguna afirmación atribuible.
- **Alcance:**
  - se lee el bloque «Dirigido a:»;
  - una negación o exclusión da `exclusion`;
  - varios bloques distintos dan `contradiccion`.
- **Ventana:**
  - «hasta con N horas de anticipación» da el máximo;
  - «hasta N hora(s) antes del mismo» da el mínimo;
  - varias ventanas, o un mínimo mayor o igual que el máximo, dan `contradiccion`.

## 8. Muestra mínima del marcado oficial

Archivos: `scripts/fixtures/checkmig/oficial-muestra.html`, con sus metadatos en `oficial-muestra.json`.

- URL: la de §1. Capturada el **2026-11-12T01:37:02.406Z**, HTTP 200, `text/html; charset=utf-8`,
  sin redirección.
- Contenido: líneas copiadas sin cambios del único `<main id="main-content">`:
  - el marco `c1969`: h1 «CheckMig», «Dirigido a:» y «Servicio gratuito…»;
  - el marco `c5605`: «Requisitos y documentación», «Costos» y «Aspectos importantes».

  Se omiten los medios, el paso a paso y la encuesta. El comentario de procedencia queda fuera del `<main>`.
- Alcance de cada hash:
  - página completa: 272 782 bytes, `35aa8d4b6b6531bacfe12b1850f218b6cc99af6a28cd95b34d57c89d289102c6`.
    Cubre el cuerpo de la respuesta decodificado como UTF-8.
  - `<main>`: 21 977 bytes, `1c051265e8df0c3ec258572eb2568a8f4d41f596cbf68ef4affe181c5483d092`.
    Cubre desde `<main` hasta `</main>` inclusive.
  - muestra: 3 105 bytes, `4b6db5255080c7862885f219454d7bfa415bff4194c0112c4f6e6b2e33b7bfeb`.
    Cubre los bytes del fixture en UTF-8 después de normalizar CRLF a LF, porque con
    `core.autocrlf=true` el checkout puede dejar CRLF.
- Ninguno de esos hashes entra en `hechos`. Hechos de la muestra: no_obligatorio, extranjeros y
  nacionales, ingreso y salida, de 72 h a 1 h. `hechos_hash`:
  `f7becb92dcc9ba36dd6ca53a0218bab24e4a450eac17f7abcef931035c055321`, el mismo que `valida.html`.

## 9. Pruebas

Las tres suites corren sin red (`preload-solo-loopback`) y forman parte de `npm test`:
`test-adaptador-v2-checkmig.js`, `test-prototipo-checkmig.js` y `test-mutaciones-checkmig.js`.

- **Terminación:** las dos suites funcionales arrancan con `process.exitCode = 1` y lo ponen en 0
  solo después de la última aserción. Sin esa guarda, una promesa colgada sin temporizadores deja
  salir el proceso con exit 0 sin terminar las aserciones. Ese verde falso se reprodujo en
  `test-prototipo-checkmig.js` con un cuelgue inyectado en la lectura, antes de agregarle la guarda.
- **Plazo con `fetch` simulado:**
  - `test-adaptador-v2-checkmig.js` lo prueba de dos maneras: un `TimeoutError` lanzado y un plazo
    real (`timeoutMs: 20`, con un `fetch` que espera el abort). En el segundo caso la prueba
    sostiene el event loop con un temporizador propio, porque `AbortSignal.timeout` no lo hace.
  - `test-prototipo-checkmig.js` solo prueba el `TimeoutError` lanzado.

- **Hechos:** `valida.html`, la muestra oficial y `cambio.html` dan hechos y `hechos_hash` fijados,
  con URL, fecha, evidencia por campo y el hash del HTML solo en el diagnóstico.
- **P1:** la muestra comparada con una variante que cambia el `id` del marco, el texto de
  «Costos», los espacios y el orden de viajeros y sentidos. El HTML es distinto, el `hechos_hash`
  es el mismo y el verificador real acepta la revalidación.
- **P2:** la propuesta piloto (hechos de la ficha) comparada con `cambio.html`: el verificador real
  lanza `fuente_cambio`. El mismo cambio con una exclusión en «Dirigido a:» da `ambiguo`, sin
  hechos, y no llega al verificador.
- **Ambigüedad:** `ambiguo` por campo, con las dos frases del pasaporte, el formulario de otro
  trámite, las dos frases con condición y con vigencia, un valor fuera de dominio y la ficha sin
  `<main>`. En todos los casos se comprueba que no hay ninguna clave `hechos`, `hechos_hash` ni
  `valor` a ninguna profundidad, y que `proyectarRevalidacion` rechaza el resultado.
- **Incompatibilidad:** un caso por código cerrado, sin ninguna llamada a `fetch`. Incluye las dos
  propuestas de §2.
- **Lectura:**
  - opciones de la consulta;
  - una redirección interna que se sigue;
  - redirecciones rechazadas antes de seguirlas (otro host, http, credenciales, puerto, subdominio,
    URL inválida);
  - un bucle de redirecciones y una redirección sin destino;
  - HTTP 404, 410, 429, 500 y 503; respuesta que no es HTML; red; tiempo agotado (también con un
    plazo real); cuerpo ilegible;
  - tamaño: por `content-length`, cortado durante la lectura y exactamente en el límite.
- **Parser:**
  - las regresiones de obligatoriedad;
  - diez afirmaciones con condición o vigencia en las redacciones A, B y C, antes o después de la
    afirmación;
  - el cambio real a obligatorio con las redacciones A, B y C;
  - los globales que siguen `ok`: la ficha observada, «para todos los viajeros» y «de su viaje».
- **Mutaciones** (`test-mutaciones-checkmig.js`):
  - Cada mutación se compila en memoria, en un proceso hijo, sin modificar archivos, y debe hacer
    caer al menos una suite por una aserción.
  - Como control del mecanismo, la base y una mutación identidad en cada archivo deben pasar.
  - M1 a M16 cubren: el texto de «Dirigido a:» o el hash del HTML dentro de `hechos`, listas sin
    ordenar, hechos en `ambiguo`, redirección sin validar, sin límite de tamaño, el respaldo «la
    oración nombra CheckMig», sin chequeo de varias fuentes, consultar aunque la propuesta sea
    incompatible, «de uso» fuera de la ficha, un 404 como respuesta, continuación o prefijo de B
    sin validar, continuación de C sin validar, la oración A sin validar entera y la URL por
    prefijo.
  - M17 es un cuelgue sin temporizadores: las dos suites deben salir con exit 1 sin su línea final.

La consulta real va por separado: `node scripts/prototipo-checkmig.js` (exit 0 `ok`, 2 `ambiguo`,
3 `no_disponible`). Nunca corre dentro de `npm test`.

## 10. Fuera de alcance y límites

- **Fuera de alcance:** las propuestas con varias fuentes, Atlas, el contrato HTTP, el frontend y
  el push. La orquestación y la integración con el aplicador 2.0 son de H3.3.
- `fuente_cambio` deja la propuesta en `obsoleta`, que es terminal. Por eso se exige la segunda
  lectura de §5.
- `AbortSignal.timeout` no mantiene vivo el proceso: con red real lo mantiene el socket. Una
  prueba con un `fetch` simulado que espera el abort tiene que sostener el event loop (§9).
- Quedan para entregas separadas: el cambio general de `.gitattributes` y la auditoría del runner,
  es decir, si las demás suites tienen la misma guarda de terminación.
