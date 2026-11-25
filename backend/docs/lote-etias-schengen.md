# Lote ETIAS (Comisión Europea): seis destinos Schengen

Código: `services/propuestas/fuentes/comision-europea-etias.js`,
`services/propuestas/adaptadores/v2/comision-europea-etias.js`,
`services/propuestas/ciclo/perfiles-etias-schengen.js`. Pruebas: `scripts/test-lote-etias-v2.js`.

## Inventario de cobertura (24/11/2026, API pública y lectura de solo lectura en Atlas)

- Hoy hay **7 requisitos automatizados** (CO Check-Mig; GB visa, ETA y pasaporte; DE visa; IT
  visa y pasaporte).
- Si se activa este lote serían **13**. Los seis nuevos son el mismo requisito («ETIAS
  (Schengen)») en seis destinos y comparten **una sola fuente y una sola regla**: no son seis
  coberturas independientes.
- Siguen pendientes los otros 156 requisitos, incluidos los 123 aún atribuidos a IATA. Sobre la
  licencia o los términos de esa procedencia no se concluye nada sin revisarla.

En Atlas, las seis `fecha_verificacion` son texto `"2026-08-18"`; la API las serializa con hora.
Se comprobó con `inspeccionar-tipo-fecha-verificacion.js` (un único `find`) y la cuenta de solo
lectura.

## Fuente y extracción

La página ETIAS de la Comisión Europea (home-affairs.ec.europa.eu) es HTML servido por el
servidor y robots.txt permite la ruta. Cuentan dos textos con su gramática:

- **Aviso (N), anclado completo:** el ETIAS no funciona, no se reciben solicitudes y la fecha de
  inicio se anunciará con meses de antelación. Tiene que estar una sola vez en `<main>` y dentro
  del único bloque «Important notice».
- **Definición de estadía corta (E):** solo se valida su **primera oración** (N países, D días en P).

Todo el resto del texto de `<main>`, dentro o fuera del bloque y en cualquier etiqueta, se revisa.
Si habla de funcionamiento, inicio, fechas, solicitudes u obligatoriedad y no es uno de los cuatro
textos conocidos, la lectura queda ambigua. Eso incluye **lo que sigue a la primera oración de E**.
Las exclusiones se hacen por posición, no por igualdad de texto: un aviso o una definición
repetidos en otro lugar también dejan la lectura ambigua.

**Corrección de la revisión de Codex (falso confirmado).** En `4626a8a`, agregar «ETIAS will
become mandatory on 1 May 2027.» dentro del párrafo de definición daba `ok`. Pasaba porque E solo
validaba el prefijo y se excluía el párrafo entero. Ahora:

- ese caso es ambiguo, igual que las variantes al comienzo, en medio y al final del resto del
  párrafo, y que un inicio anunciado fuera del bloque;
- la primera lectura ambigua no publica nada;
- una condición que aparece recién en la segunda lectura de H3.3 deja la propuesta en revisión,
  sin publicar;
- el fixture y la página oficial vigente siguen dando `ok`.

La suite falla con el extractor de `4626a8a` y pasa con el corregido.

## Descripción publicada

Antes (Wikipedia, `verificar`):

> Aún no está vigente. Fecha estimada de entrada en vigor: 2027. Cuando entre en vigor, será
> obligatorio para uruguayos.

Después (idéntica en los seis destinos, `confirmado`, fuente de la Comisión):

> A la fecha de verificación indicada, según la Comisión Europea, el ETIAS todavía no está en
> funcionamiento y no recibe solicitudes, por lo que no había que tramitarlo. No es una exención
> permanente: el ETIAS es un requisito previsto para los viajeros exentos de visa en estadías
> cortas (hasta 90 días en cualquier período de 180 días), y la Unión Europea anunciará la fecha
> de inicio con varios meses de antelación. Para viajes futuros, consultar la información oficial
> actualizada.

- Se retiran la «fecha estimada 2027» y «será obligatorio para uruguayos»: la fuente no los dice.
  Eso no significa que sean falsos.
- La tasa de EUR 20 no se publica porque todavía no rige.
- La afirmación queda atada a la fecha de verificación del requisito. El texto no lleva la fecha,
  así que la repetición no cambia la descripción.

## Ampliación mínima del contrato del perfil

`crearPerfilProcedencia` admite `estados_admitidos`; por defecto `['confirmado']`, como antes.

- Los perfiles ETIAS admiten `verificar`. Su requisito canónico fija `estado: 'confirmado'`, así
  que también autorizan el campo `estado`.
- Los siete perfiles anteriores no cambian.
- `IntentoAplicacion` agrega el campo de lectura `etias`.

Cada aplicación cambia `descripcion`, `fuente` y `estado`; `obligatorio` sigue en `"no"`. Si un
requisito tiene `link`, `costo`, `plazo_antes_del_vuelo` o `recomendado`, el caso va a revisión.

## Política

Una sola política, `comision-europea-etias-uy@1`, cubre los seis perfiles (`comision-etias-at`,
`-hr`, `-fi`, `-fr`, `-it`, `-pt`). No habilita ningún otro requisito ni destino, y ninguna
política vigente habilita este lote.

## Candidatos evaluados y descartados

- **Visa Schengen de AT/HR/FI/FR/PT (Delegación de la UE en Uruguay):** la página no nombra los
  Estados, y su texto sobre el ETIAS contradice a la Comisión.
- **travel-europe.europa.eu:** aplicación de JavaScript; el HTML llega vacío.
- **Visa-policy de la Comisión:** HTTP 404.
- **Consilium:** HTTP 403.
- **Menores en GB:** «may need» es condicional.
- **Auswärtiges Amt:** no menciona pasaporte, vacunas ni menores.
- **GB ETA:** el costo necesita una segunda fuente.
- **US visa:** solo se podría concluir por la ausencia de Uruguay en una lista; descartada sin
  consultar.
- Bloqueos del lote anterior: EUR-Lex, BMEIA, France-Visas, MOFA, Cancillería de Colombia y
  canada.ca.

## Activación (pendiente de autorización; nada ejecutado)

El secreto `CICLO_V2_AUTORIZACION_JSON` no se puede leer desde GitHub. La lista vigente es la
copia privada `backups/activacion-procedencia-gb-it-20261123/autorizaciones.json`: 7 entradas,
sha256 del archivo `ecbe69ad…`, sha256 de las entradas `57fb9918…`.

Para no dejar los perfiles nuevos corriendo a diario sin su autorización, los pasos 3 a 6 se hacen
seguidos en una misma sesión, después de que haya terminado la corrida programada del día. Las
programadas se observaron entre las 17:50Z y las 22:22Z, no a las 11:00Z.

1. **Respaldo** con la cuenta de solo lectura, igual que el 23/11: 28 destinos e índices en
   `backups/activacion-etias-AAAAMMDD/antes.ejson`, con su sha256. Comprobar también que hay 0
   propuestas activas.
2. **Push** de `main` hasta el commit de cierre. Incluye el reintento automático; con 0
   propuestas activas no actúa sobre nada existente. Verificar que la API siga en HTTP 200.
3. **Perfiles:** agregar a `PERFILES_CICLO`
   `comision-etias-at comision-etias-hr comision-etias-fi comision-etias-fr comision-etias-it comision-etias-pt`,
   conservando los siete actuales. Todavía sin política nueva.
4. **Informe:** ejecutar `workflow_dispatch` con `solo_informe=true`.
   - Se esperan seis `cambio_aplicable` (motivo `politica_no_habilitada`, exit 2), los siete
     perfiles anteriores en `sin_cambio` y DE `ya_existe`. Solo comandos de lectura.
   - El job termina en **failure**. Es el código esperado por cambios pendientes sin política: no
     es una falla del extractor. Puede llegar el correo de aviso.
   - Si algo difiere, volver `PERFILES_CICLO` a los siete y detenerse.
5. **Política:** generar la lista nueva fuera del repositorio con
   `node scripts/preparar-autorizaciones-ciclo.js --actuales backups/activacion-procedencia-gb-it-20261123/autorizaciones.json --agregar comision-europea-etias-uy@1 --autorizada-por <persona> --salida <ruta fuera del repo>`.
   - El script valida la lista con el cargador real y confirma que las 7 previas quedan exactas
     (mismo sha256). No conecta ni imprime credenciales.
   - Cargarla con `gh secret set CICLO_V2_AUTORIZACION_JSON < <ruta>` y guardar la copia en la
     carpeta del respaldo.
   - No se renuevan las autorizaciones anteriores.
6. **Aplicación:** ejecutar `workflow_dispatch` con `solo_informe=false`. Se esperan seis `exito`
   (descripción, fuente y estado; `obligatorio` sigue en "no") y los siete anteriores en
   `sin_cambio`.
7. **Verificación** en la API pública:
   - los seis «ETIAS (Schengen)» con `estado: confirmado`, la fuente de la Comisión, la
     descripción exacta de arriba y la fecha del día;
   - el resto de los requisitos y destinos sin cambios, por comparación con `antes.ejson` y una
     lectura de solo lectura.
8. **Repetición:** otro `workflow_dispatch` con `solo_informe=false`. Se esperan seis
   `sin_cambio` y cero escrituras.

Sin índices, permisos, red de Atlas, servicios ni costos nuevos. Mismo workflow público estándar.
