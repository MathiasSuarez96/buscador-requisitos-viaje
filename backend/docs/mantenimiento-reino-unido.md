# Mantenimiento automático del Reino Unido (GB) con el ciclo 2.0

Segundo país del ciclo compartido. Reutiliza detección (`clasificar`), propuesta 2.0, aprobación por
política (`decidirPropuesta`), revalidación y aplicación H3.3 (`aplicarConRevalidacionV2`), auditoría
(inicio, intento, historial, evento) y el comando `scripts/ciclo-checkmig-v2.js --ejecutar`.

## Por qué GB

- Fuente oficial accesible y estable: la herramienta «Check if you need a UK visa» de GOV.UK da un
  resultado para el contexto exacto del buscador (`/check-uk-visa/y/uruguay/no/tourism`: pasaporte de
  Uruguay, sin doble ciudadanía británica o irlandesa, turismo). Es una afirmación positiva para ese
  contexto. No se usa la ausencia de Uruguay en ninguna lista.
- Condiciones de uso: contenido Crown copyright publicado bajo la Open Government Licence v3.0
  (GOV.UK, «Terms and conditions»), que permite reproducirlo citando la fuente. Se consulta a lo sumo
  dos veces por perfil y por día (detección, más una revalidación si hay un cambio).
- Ya había un caso real: en producción, la visa de GB figura `obligatorio: "si"` con la descripción «No
  requiere visa para estadías de hasta 6 meses…» y la fuente IATA. GOV.UK responde «You'll need an
  electronic travel authorisation (ETA) or a visa»: la visa no es obligatoria.

## Perfiles y política

`services/propuestas/ciclo/perfil-govuk-reino-unido.js`, política `govuk-reino-unido-turismo-uy@1`:

| Perfil | Requisito | `eta_o_visa` | `visa` |
|---|---|---|---|
| `govuk-gb-visa` | `visa` (sin nombre) | `obligatorio: "no"` | `obligatorio: "si"` |
| `govuk-gb-eta` | `formulario_digital` «UK ETA» | `obligatorio: "si"` | revisión humana |

- La política solo cambia `obligatorio` y, **junto con ese cambio**, `fuente` = URL del resultado oficial.
  Nunca cambia la fuente sola: aplicar fija `fecha_verificacion`, y eso renovaría la fecha sin un valor
  nuevo confirmado. Por eso el UK ETA hoy queda `sin_cambio` con la observación `fuente_no_es_la_oficial`.
- Revisión humana: título de resultado no admitido, resumen de respuestas distinto del contexto,
  lista de opciones que contradice el título, descripción publicada que contradice el valor nuevo o
  afirma y niega a la vez, `recomendado` incompatible, segunda lectura ambigua o con otros hechos.
- `fecha_verificacion` se fija al aplicar (núcleo 2.0, igual que en Colombia). Sin cambio no se renueva.
  `descripcion`, `link`, `plazo_antes_del_vuelo` y `costo` no los confirma esta fuente.

## Ejecución

```
node scripts/ciclo-checkmig-v2.js --ejecutar --perfil govuk-gb-visa
node scripts/ciclo-checkmig-v2.js --ejecutar --perfil govuk-gb-eta
```

Sin `--perfil`, Colombia (comportamiento anterior). `CICLO_V2_AUTORIZACION_JSON` admite el objeto original
o una lista; cada perfil usa solo la entrada de su política. Todas las entradas se validan siempre.
El workflow (`.github/workflows/colombia-diario.yml`) corre un proceso por perfil de la variable de
repositorio `PERFILES_CICLO` (sin ella, solo `checkmig-colombia`), escribe una fila por perfil en el resumen
del job y falla al final si algún perfil no terminó en 0, lo que dispara el aviso por correo de GitHub.

## Credencial

La misma del ciclo de Colombia: secreto `MONGODB_URI_CICLO` (usuario de Atlas `buscador-backend-app`,
`readWrite@buscador_requisitos`), identificada por `connectionStatus` contra `OPERADORES_AUTORIZADOS_JSON`
(`proceso.ciclo-checkmig`). No se amplían permisos ni se cambia la lista de acceso de red de Atlas.

## Activación pendiente (requiere autorización)

1. Push de los commits a `main`.
2. Primera corrida en modo informe: variable `PERFILES_CICLO="checkmig-colombia govuk-gb-visa govuk-gb-eta"` y
   `workflow_dispatch` con `solo_informe=true`. Esperado: GB visa `cambio_aplicable` (exit 2), GB ETA
   `sin_cambio`, CO `sin_cambio`.
3. Política nueva: reemplazar el secreto `CICLO_V2_AUTORIZACION_JSON` por una LISTA con la entrada vigente de
   Colombia sin cambios y una entrada nueva `govuk-reino-unido-turismo-uy@1` (máximo 90 días). La
   autorización de CheckMig no cubre GB.
4. Corrida con política: GB visa pasa a `obligatorio: "no"` con fuente GOV.UK. Se verifica en `GET /api/destinos`.
