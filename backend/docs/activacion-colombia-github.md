# Colombia diario con GitHub Actions (sin contratar servicios)

Esta opción reemplaza el cron pago de Render. Usa el ciclo existente, sin modificar
su política, revalidación ni auditoría. No crear un Cron Job en Render.

## Costo y horario

El workflow `.github/workflows/colombia-diario.yml` usa un runner Linux estándar,
gratuito para repositorios públicos. Por precaución no corre si el repositorio es
privado. No sube artifacts ni usa runners de pago.

Se programa a las 11:00 UTC (08:00 Uruguay). GitHub puede demorar o descartar una
corrida programada por carga; no garantiza puntualidad. En repositorios públicos
deshabilita las programaciones tras 60 días sin actividad: revisar Actions y
reactivar si corresponde. No se afirma vigilancia ininterrumpida.

## Configuración (secretos fuera del código)

En el repositorio: Settings → Secrets and variables → Actions → New repository secret.

| Nombre | Contenido |
| --- | --- |
| `MONGODB_URI_CICLO` | URI vigente de Atlas con los permisos del ciclo, nunca la cuenta de solo lectura ni el operador personal. |
| `OPERADORES_AUTORIZADOS_JSON` | Allowlist del usuario real de esa URI. Si es `buscador-backend-app`: `[{"usuario_atlas":"buscador-backend-app","db":"admin","identificador":"proceso.ciclo-checkmig"}]`. |
| `CICLO_V2_AUTORIZACION_JSON` | Solo tras confirmar la primera corrida: autorización de la política existente con titular, inicio y vencimiento (máximo 90 días). |

No definir `MONGODB_URI` ni copiar el `.env` completo. Los secretos de Actions no
se publican con el repositorio. No pegar las URI en issues, logs ni chats.

Atlas debe admitir la conexión desde el runner. GitHub usa IPs variables; si la
lista de acceso de Atlas las bloquea, la corrida falla. Revisar la configuración
real antes de activar; este workflow no abre acceso de red ni modifica Atlas.

## Primera corrida y activación

1. Subir el workflow a `main`, tras autorización del push (puede redesplegar la app).
2. Cargar conexión e identidad. Dejar ausente la autorización automática inicialmente.
3. Actions → Colombia - CheckMig diario → Run workflow, con `solo_informe` marcado.
4. Confirmar `REGISTRO_EJECUCION`: identidad esperada, HTTP 200, `sin_cambio`,
   `codigo_salida: 0` y comandos solo de lectura.
5. Tras autorizar la activación, cargar `CICLO_V2_AUTORIZACION_JSON`, con el formato
   definido en `ciclo-colombia-real.md`. No renovar su vencimiento automáticamente.
6. Las corridas diarias usan esa política; las manuales siguen en informe por defecto.
   Para probar manualmente la política, desmarcar `solo_informe` explícitamente.

La política solo puede autoaplicar la obligatoriedad de CheckMig dentro del alcance
actual. Casos dudosos salen para revisión; esto no automatiza aún otros países.
No se renueva la fecha si la fuente no respalda todos los campos del requisito.

## Fallos y desactivación

Los códigos de salida del ciclo se conservan: un error o revisión queda como corrida
fallida. Configurar las notificaciones de GitHub Actions en los ajustes personales
para enterarse de fallos y comprobar su recepción. No hay avisos externos nuevos.
Sin una corrida no se genera un aviso de fallo automáticamente.

Quitar el secreto de autorización vuelve al modo informe. Para detener toda consulta,
usar Disable workflow en Actions. No borra datos ni propuestas.

Fuentes:
- https://docs.github.com/en/actions/concepts/billing-and-usage
- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule
