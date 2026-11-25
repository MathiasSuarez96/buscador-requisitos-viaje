# Lote ETIAS (Comisión Europea): seis destinos Schengen

Código: `services/propuestas/fuentes/comision-europea-etias.js`,
`services/propuestas/adaptadores/v2/comision-europea-etias.js`,
`services/propuestas/ciclo/perfiles-etias-schengen.js`. Pruebas: `scripts/test-lote-etias-v2.js`.

## Inventario de cobertura (24/11/2026, API pública y lectura de solo lectura en Atlas)

| | Antes | Después de activar este lote |
|---|---|---|
| Destinos publicados | 28 | 28 |
| Requisitos publicados | 169 | 169 |
| Con fuente oficial y automatizados | 7 en 4 países (CO, GB ×3, DE, IT ×2) | 13 en 9 países (+AT, HR, FI, FR, PT y otro de IT) |
| Ligados a IATA | 123 (94 confirmados, 29 en verificar) | 123 |
| En `verificar` | 69 | 63 |
| IATA o `verificar` | 163 | 157 |

Seis requisitos «ETIAS (Schengen)» (`formulario_digital`) de AT, HR, FI, FR, IT y PT figuran en
`verificar`, con Wikipedia como fuente y la descripción «Fecha estimada de entrada en vigor: 2027.
Cuando entre en vigor, será obligatorio para uruguayos». La fuente oficial no da esa fecha. En
Atlas, las seis `fecha_verificacion` son texto `"2026-08-18"`; la API las serializa con hora. Se
comprobó con `inspeccionar-tipo-fecha-verificacion.js` (un único `find`) y la cuenta de solo
lectura.

## Fuente y extracción

La página ETIAS de la Comisión Europea (home-affairs.ec.europa.eu) es HTML servido por el
servidor. robots.txt permite la ruta y el contenido se reutiliza citando la fuente. Solo cuenta el
único bloque «Important notice», y dentro de él la frase oficial completa: el ETIAS no funciona,
no se reciben solicitudes y la fecha de inicio se anunciará con meses de antelación. También se
lee la definición de estadía corta (N países, D días en P). Queda ambiguo, y va a revisión sin
publicar, cualquiera de estos casos:

- otro texto del bloque, en cualquier etiqueta, habla de funcionamiento, inicio, fechas,
  solicitudes u obligatoriedad;
- cambia alguno de los cuatro textos conocidos (qué pasará al funcionar, la tasa futura, eu-LISA,
  antecedentes);
- el aviso falta, se repite o cambia;
- el bloque no cierra.

Que el sistema no funcione vale para todos los destinos y nacionalidades. No se deduce nada del
país ni de la ausencia de un dato. La tasa de EUR 20 no se publica: todavía no rige.

## Ampliación mínima del contrato del perfil

`crearPerfilProcedencia` admite `estados_admitidos` (por defecto `['confirmado']`, como antes).
Los perfiles ETIAS admiten `verificar` y su requisito canónico fija `estado: 'confirmado'`, así
que también autorizan el campo `estado`. Los siete perfiles anteriores no cambian. El contrato 2.0
ya permitía modificar `estado` (`CAMPOS_MODIFICABLES`). `IntentoAplicacion` agrega el campo de
lectura `etias`.

Cada aplicación cambia `descripcion`, `fuente` y `estado`. `obligatorio` sigue en `"no"` y la
fecha se fija al día de Montevideo. Si un requisito tiene `link`, `costo`, `plazo_antes_del_vuelo`
o `recomendado`, el caso va a revisión.

## Política

Una sola política, `comision-europea-etias-uy@1`, cubre los seis perfiles (`comision-etias-at`,
`-hr`, `-fi`, `-fr`, `-it`, `-pt`): mismo requisito, misma fuente y mismo hecho. No habilita
ningún otro requisito ni destino, y ninguna política vigente habilita este lote.

## Candidatos evaluados y descartados (no se completó el cupo con evidencia débil)

- **Visa Schengen de AT, HR, FI, FR y PT** (Delegación de la UE en Uruguay, eeas.europa.eu). La
  página dice que los uruguayos no necesitan visado para estancias turísticas de hasta noventa
  días en el espacio Schengen, pero no nombra los Estados. Aplicarla a un país exigiría deducir
  que es miembro. Además, su texto sobre el ETIAS está desactualizado («a partir de una fecha a
  ser anunciada de 2025») y contradice a la Comisión.
- **travel-europe.europa.eu (sitio oficial ETIAS)**: aplicación de JavaScript; el HTML llega vacío.
- **Lista de exención de visados de la Comisión** (home-affairs …/visa-policy_en): HTTP 404.
  **Consilium**: HTTP 403.
- **Menores en GB** (GOV.UK): «You may need to show a letter…» es condicional; no respalda ni
  «sí» ni «no».
- **Auswärtiges Amt**: la Staatenliste no habla de pasaporte, vacunas ni menores. El resto de los
  requisitos de DE sigue sin fuente.
- **GB ETA** (link y costo): necesita una segunda fuente para el costo (sin cambios desde el lote
  anterior).
- Bloqueos conocidos del lote anterior: EUR-Lex (202), BMEIA (robots), France-Visas, MOFA,
  Cancillería de Colombia y canada.ca.
- **US visa**: la lista del Visa Waiver Program solo permitiría concluir por la ausencia de
  Uruguay; descartada por diseño y no consultada.

## Activación (pendiente de autorización; nada ejecutado)

1. Push de `main` hasta el commit de este lote. Incluye el reintento automático (`2067f0b`). Hoy
   hay 0 propuestas activas en producción: el reintento no actúa sobre nada existente.
2. Agregar a la variable `PERFILES_CICLO` `comision-etias-at comision-etias-hr comision-etias-fi
   comision-etias-fr comision-etias-it comision-etias-pt`, conservando los siete perfiles.
3. Corrida manual en modo informe. Se esperan seis `cambio_aplicable` (exit 2, fallo esperado del
   job) y solo lecturas.
4. Agregar a `CICLO_V2_AUTORIZACION_JSON` una entrada `comision-europea-etias-uy@1`, conservando
   exactas las siete vigentes (8 en total).
5. Corrida de aplicación, verificación por la API y repetición (seis `sin_cambio`).

Sin índices, permisos, servicios ni costos nuevos. Mismo workflow público estándar.
