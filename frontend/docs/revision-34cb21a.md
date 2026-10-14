# Revisión correctiva de 34cb21a

## Contrato de auditoría

Cada inicio e intento nuevo persiste `auditoria`; el evento final, si existe, guarda el mismo contexto en `detalle.auditoria`. Se conserva `detalle.auditoria_panel` para reconocer los reenvíos existentes.

Lista cerrada del panel:

- `origen`: `panel`.
- `request_id`: UUID generado por el servidor.
- `operador`: identificador lógico autenticado.
- `identidad`: exclusivamente `metodo: oidc_google` y `sub`.
- `comando`: exclusivamente `nombre: panel-propuestas` y `version: 1`.
- `instantanea`: exclusivamente `propuesta_id`, `estado_esperado`, `payload_hash_esperado`, `version_coordinacion_esperada` y `decision_aprobacion_id_esperado`; debe coincidir con la entrada del servicio.

No se copia token, email, headers ni otros datos del operador. `aplicarPropuesta` valida el contexto antes de cualquier dependencia o escritura, realiza una copia defensiva congelada y rechaza extras, símbolos, getters, prototipos distintos, identidades incompletas, origen, comando, UUID o instantánea inválidos. Los modelos validan también la estructura al persistir. El campo es opcional en los modelos por compatibilidad con documentos históricos; el servicio actual siempre lo construye.

La CLI usa `origen: comando_administrativo`, `comando: {nombre: aplicar-propuesta, version: 1}` e identidad `{metodo: connection_status, usuario_atlas, db_autenticacion}`, resuelta contra la allowlist existente. No se modifica la autenticación administrativa.

`panel_aplicacion` registra `intento_id` y `evento_id` disponibles. Los errores inesperados posteriores al inicio conservan el identificador del intento. Los 500 públicos mantienen solamente código, mensaje fijo y request_id; se eliminó el dato de aplicación que el middleware descartaba.

## Carrera, disponibilidad y bloqueo

| Situación | Respuesta y escrituras |
| --- | --- |
| Reenvío idéntico detectado antes de entrar al servicio | 200, `ya_aplicada: true`, sin nuevas escrituras. |
| Solicitud que ya registró inicio/intento y pierde el CAS | 409, conserva su intento y auditoría. Nunca se anuncia como reenvío sin escrituras. |
| Fuente temporalmente indisponible después del inicio | 422 con `fuente_temporalmente_no_disponible` e intento; no modifica destino. |
| Servicio/configuración/índices indisponibles antes de escribir | 503; el frontend conserva confirmación, permite un nuevo envío explícito y no reintenta automáticamente. |
| Error de red dentro del servicio con escritura potencial | 500 incierto; no se degrada a 503. |
| 409, 422, 500, red, timeout de 30 segundos o respuesta inválida | El frontend bloquea otro POST. Recarga fallida conserva el bloqueo; solo una recarga completa válida lo libera. |

La integración con Mongo 8.0.32 usa una barrera después de ambos inicios: verifica dos inicios, dos intentos, una aplicación, un historial, los request_id distintos y un perdedor 409. Un reenvío posterior devuelve 200 sin aumentar ninguna colección.

La CLI en modo real rechaza una vista no aprobada o sin decisión de aprobación antes de confirmar o registrar un intento. En solo lectura conserva el diagnóstico sin escribir. El filtro mostrado incluye tanto `decision_aprobacion_id` como `ultimo_evento_id`, tomados de `decision_aprobacion_id_esperado`.

## Verificación

- TypeScript: `node node_modules/typescript/bin/tsc -b`.
- Oxlint: `npm.cmd run lint`.
- Frontend: `npm.cmd run test:panel`: **140/140**, incluidos builds normal/estricto y huella pública.
- Backend: **21 suites** `test-*.js` sin Mongo, con `--require ./scripts/preload-solo-loopback.js`.
- Mongo: `test-integracion-aplicacion-propuesta.js`: **19 escenarios**; además `test-panel-propuestas-mongo.js` y `test-panel-decisiones-mongo.js` con preload solo-loopback. Todos pasan y limpian procesos/datos efímeros.
- Mutaciones frontend: `npm.cmd run test:panel:mutaciones`: **54/54** detectadas por aserciones, incluidas **21 nuevas**.
- Mutaciones backend: `node scripts/test-mutaciones-panel-aplicacion.js`: **14/14** nuevas detectadas por aserciones.
- Build local: `npm.cmd run build`, correcto con las advertencias existentes de configuración local HTTP/client ID ausente. El build estricto exitoso se ejecuta con los valores de prueba aislados del harness, sin cambiar variables ni archivos de configuración del proyecto.
- Huella pública: los cuatro assets de referencia y el HTML permanecen idénticos con el mismo entorno controlado; la comparación no mezcla el build local HTTP con el de referencia.
- `git diff --check`: correcto. CSP, dependencias y variables sin cambios. Sin push, squash ni amend.

## Mutaciones nuevas y pruebas que las detectan

Las mutaciones modifican una copia temporal y ejecutan pruebas de comportamiento; exigen fallo por aserción. Un error de sintaxis, importación o timeout del proceso no cuenta como mutación detectada. El runner del frontend imprime los nombres reales de todas las pruebas fallidas para cada mutación.

Pruebas frontend en `tests/panel/decisiones.prueba.tsx`:

| Mutación | Prueba que la detecta |
| --- | --- |
| Envío altera `estado_esperado` | aplicación: CAS visible, body exacto, confirmación accesible, doble clic y reenvío idéntico |
| Envío altera `payload_hash_esperado` | La misma prueba de CAS visible/body exacto |
| Envío altera `version_coordinacion_esperada` | La misma prueba de CAS visible/body exacto |
| Envío altera `decision_aprobacion_id_esperado` | La misma prueba de CAS visible/body exacto |
| Instantánea visible altera estado | La misma prueba de CAS visible/body exacto |
| Instantánea visible altera hash | La misma prueba de CAS visible/body exacto |
| Instantánea visible altera versión | La misma prueba de CAS visible/body exacto |
| Instantánea visible altera decisión | La misma prueba de CAS visible/body exacto |
| Omite permiso aplicar al preparar | aplicación sin permiso o sin acción no permite un POST |
| Difiere el bloqueo síncrono a un microtask | aplicación: CAS visible, body exacto, confirmación accesible, doble clic y reenvío idéntico |
| Timeout pasa de 30 a 60 segundos | aplicación timeout: bloquea sin reintentos; recarga fallida conserva bloqueo y exitosa lo libera |
| Reintenta automáticamente tras fallo de red | aplicación red: bloquea sin reintentos; recarga fallida conserva bloqueo y exitosa lo libera |
| 409 no bloquea | aplicación 409: bloquea sin reintentos; recarga fallida conserva bloqueo y exitosa lo libera |
| 422 no bloquea | aplicación 422: bloquea sin reintentos; recarga fallida conserva bloqueo y exitosa lo libera |
| 500 no bloquea | aplicación 500: bloquea sin reintentos; recarga fallida conserva bloqueo y exitosa lo libera |
| Red no bloquea | aplicación red: bloquea sin reintentos; recarga fallida conserva bloqueo y exitosa lo libera |
| Respuesta inválida no bloquea | aplicación respuesta inválida: bloquea sin reintentos; recarga fallida conserva bloqueo y exitosa lo libera |
| Recarga fallida libera bloqueo | Los seis casos anteriores de fallo de aplicación y recarga |
| Recarga exitosa conserva bloqueo | Los seis casos anteriores de fallo de aplicación y recarga |
| 200 omite validar identidad y versión | aplicación 200 valida todos los campos; destino_modificado exige true literal |
| 200 admite `destino_modificado: false` | La misma prueba de 200 y true literal; también respuesta inválida/bloqueo |

Pruebas backend:

| Mutación | Archivo y caso que la detecta |
| --- | --- |
| Inicio omite auditoría | `test-servicio-aplicacion-propuesta.js`: AUD-INICIO |
| Intento omite auditoría | `test-servicio-aplicacion-propuesta.js`: AUD-INTENTO |
| Evento omite auditoría | `test-servicio-aplicacion-propuesta.js`: AUD-EVENTO |
| Servicio confía solo en wrapper HTTP | `test-servicio-aplicacion-propuesta.js`: AUD-INTERNA, rechazo antes de I/O |
| Identidad permite campos extra | `test-servicio-aplicacion-propuesta.js`: AUD-INTERNA |
| Request_id no validado | `test-servicio-aplicacion-propuesta.js`: AUD-INTERNA |
| Auditoría no copia identidad | `test-servicio-aplicacion-propuesta.js`: AUD-INICIO, copia aislada durante await |
| CAS omite decisión esperada | `test-servicio-aplicacion-propuesta.js`: CAS exacto y aprobación divergente |
| CAS omite último evento esperado | `test-servicio-aplicacion-propuesta.js`: CAS exacto |
| Perdedor de carrera devuelve reenvío 200 | `test-servicio-panel-aplicaciones.js`: CARRERA, exige ErrorAplicacionCambio con intento propio |
| Respuesta 200 con destino_modificado false | `test-servicio-panel-aplicaciones.js`: éxito exige true |
| Respuesta 200 con propuesta no aplicada | `test-servicio-panel-aplicaciones.js`: validación directa de respuestaAplicada |
| Fuente caída después del inicio devuelve 503 | `test-servicio-panel-aplicaciones.js`: fuente caída con intento exige 422 |
| CLI muestra CAS incompleto | `test-aplicar-propuesta.js`: solo lectura, filtro CAS real |
