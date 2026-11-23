# Lote de procedencia GB/IT (IATA → fuente oficial)

Tercer bloque del ciclo 2.0 gratuito (mismo workflow, mismo ciclo, mismo H3.3). Tres requisitos
publicados como `confirmado` con fuente IATA pasan a una fuente oficial explícita. Cada uno tiene
perfil y política propios.

| Perfil | Requisito | Fuente oficial | Política |
|---|---|---|---|
| `govuk-gb-pasaporte` | GB `validez_pasaporte` | GOV.UK, resultado de «Check if you need a UK visa» (`/check-uk-visa/y/uruguay/no/tourism`), sección «What you need at the UK border» | `govuk-gb-pasaporte-uy@1` |
| `embajada-it-visa` | IT `visa` | Embajada de Italia en Montevideo, página «Visas» (esteri.it) | `embajada-italia-it-visa-uy@1` |
| `embajada-it-pasaporte` | IT `validez_pasaporte` | misma página | `embajada-italia-it-pasaporte-uy@1` |

## Por qué estos tres

- Son datos confirmados que dependían de IATA, y la fuente oficial habla explícitamente del contexto
  del buscador: pasaporte uruguayo y turismo (GOV.UK: sin doble ciudadanía británica o irlandesa;
  Italia: uruguayos naturales residentes en Uruguay, hasta 90 días).
- Reutilizan lo que ya funciona: la página de GOV.UK es la misma que leen a diario los perfiles de visa
  y ETA (un adaptador aparte con esquema propio, para que un cambio en una sección no vuelva ambigua la
  otra); el adaptador de Italia sale de la fábrica común (`fabrica-adaptador-hechos.js`) y de
  `lectura-http-oficial.js`.
- El valor publicado ya coincidía (`obligatorio`). Por eso no se presenta como «migrado»: es un
  **cambio de procedencia** explícito (`tipo_cambio: 'procedencia'`), con propuesta, aprobación por
  política, intento, historial y la fuente y descripción anteriores en la auditoría
  (`instantanea_anterior`, observaciones `cambio_de_procedencia` y `descripcion_reemplazada`).

## Regla de la fecha: el requisito completo o nada

Aplicar un cambio 2.0 siempre fija `fecha_verificacion`. Cambiar solo la fuente renovaría la fecha de
una descripción que la fuente nueva no respalda. El perfil de procedencia
(`services/propuestas/ciclo/perfil-procedencia.js`) publica el requisito CANÓNICO completo: obligatorio,
descripción de redacción propia que repite las condiciones de la fuente (nacionalidad, documento,
duración, motivo) y la URL oficial. Si el requisito tiene campos que la fuente no respalda (`recomendado`,
`link`, `plazo_antes_del_vuelo`, `costo`) o no está confirmado, va a revisión humana.

Consecuencia visible: se dejan de publicar las partes de la descripción IATA que la fuente no dice.

| Requisito | Deja de publicarse |
|---|---|
| GB validez_pasaporte | «(no exige un mínimo de meses adicionales)»: es una deducción por ausencia. |
| IT visa | «dentro de cualquier período de 180 días» y «Requiere pasaje de regreso/continuación». |
| IT validez_pasaporte | «No se aceptan pasaportes emitidos hace más de 10 años». |

Esos datos pueden ser ciertos (reglas Schengen), pero esta fuente no los respalda. Para volver a
publicarlos hace falta otra fuente oficial y otro perfil.

## Ambigüedad, caída y repetición

- Italia: solo se aceptan los dos párrafos con su redacción completa (anclada): el de los uruguayos
  naturales (días y meses capturados, no supuestos) y el de los ciudadanos legales (condición de
  nacionalidad). Si alguno falta, se repite o cambia, o si otro párrafo menciona Uruguay, Schengen,
  el pasaporte, turismo o estadías, los dos campos quedan ambiguos.
- GB: el párrafo exacto «You must provide a valid passport… valid for the whole of your stay in the UK.»
  dentro de la sección de frontera del único resultado, con el resumen de respuestas de Uruguay,
  sin doble ciudadanía y turismo. Si otra frase de la sección habla del pasaporte, la lectura queda
  ambigua.
- Fuente caída o ambigua: no escribe (exit 4 o 3). Segunda lectura de H3.3 caída: la propuesta queda
  `aprobada` y no se publica. Si es ambigua, queda `revision_requerida`. Con hechos nuevos confirmados
  dos veces, queda `obsoleta` y la corrida siguiente propone con los hechos nuevos.
- Repetir no escribe ni renueva fechas: el requisito ya es el canónico (`sin_cambio`).
- Limitación previa del ciclo, común a todos los perfiles y sin cambios en este lote: una propuesta que
  quedó `aprobada` por una caída en la revalidación se informa en las corridas siguientes como
  `propuesta_activa_existente` (exit 3) y el ciclo no la reintenta solo. No publica nada, pero hace
  falta un reintento manual.

## Candidatos evaluados y descartados (no se esquivó ninguna restricción)

| Fuente | Motivo |
|---|---|
| EUR-Lex (Reglamento 2018/1806, Código de Fronteras Schengen) | Responde 202 con cuerpo vacío (desafío anti-bot). |
| BMEIA (Austria) | `robots.txt`: `Disallow: /` para clientes que no son buscadores. |
| France-Visas | 503 «One moment please» (desafío). |
| MOFA Japón | 403 Access Denied (Akamai). |
| Cancillería de Colombia | Desafío de Cloudflare. |
| canada.ca (IRCC) | No responde a clientes automáticos (tiempo agotado). |
| vistos.mne.gov.pt, vistoperitalia.esteri.it | Sin respuesta. |
| um.fi (Finlandia, ficha Uruguay) | Accesible, pero solo dice «Visa free» y los documentos aceptados, sin duración ni motivo: no se pueden representar esas condiciones. |
| Embajada de Alemania en Montevideo (DE pendientes) | Solo dice «pasaporte válido/vigente», sin la regla completa: `validez_pasaporte` sigue en verificar. Sobre menores mezcla «debe comprobarse» con «la embajada recomienda»: es ambiguo, sigue en verificar. Exige seguro médico de 30.000 EUR, pero DE no tiene ese requisito: agregarlo es un alta de requisito, que el contrato 2.0 todavía no cubre. |
| GB UK ETA (fuente IATA) | La misma página respalda `obligatorio`, pero no `costo` (£20) ni «antes de embarcar». Migrarlo renovaría la fecha del costo. Requiere dos fuentes (resultado + `gov.uk/eta`) en una propuesta. |

## Activación (pendiente de autorización)

1. Push de los commits del lote.
2. Corrida manual **solo informe** (`solo_informe: true`) con
   `PERFILES_CICLO="checkmig-colombia govuk-gb-visa govuk-gb-eta auswaertiges-amt-de-visa govuk-gb-pasaporte embajada-it-visa embajada-it-pasaporte"`.
   Resultado esperado: los cuatro activos `sin_cambio` (exit 0) y los tres nuevos `cambio_aplicable`
   (exit 2, `politica_no_habilitada`). Cero escrituras. El job falla por el exit 2, como en la
   activación de GB/DE.
3. Agregar a `CICLO_V2_AUTORIZACION_JSON` tres entradas nuevas, conservando EXACTAS las cuatro vigentes,
   cada una con `autorizada_por`, `autorizada_en` y `vence_en` (90 días como máximo):
   `govuk-gb-pasaporte-uy@1`, `embajada-italia-it-visa-uy@1`, `embajada-italia-it-pasaporte-uy@1`.
4. Corrida manual con `solo_informe: false`: aplica los tres cambios de procedencia.
   Verificación: `GET /api/destinos` (GB e IT con la fuente oficial y la fecha del día).
5. Segunda corrida: los siete perfiles `sin_cambio`, sin escrituras.

No hay índices nuevos ni cambios de permisos o de red de Atlas. Se usan el mismo usuario del ciclo y
el mismo workflow gratuito.
