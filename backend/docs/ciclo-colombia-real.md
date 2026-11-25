# Ciclo real de Colombia (CheckMig): de la simulación a la ejecución diaria

Estado (17/11/2026): **listo para activar, pendiente de autorizaciones**.

- La corrección puntual de CO/Check-Mig se aplicó el 18/11 a las 02:00:07Z (plan `0fb5e707…`).
- Prechequeo de solo lectura en Atlas: identidad, destino, Check-Mig y 10 de 11 índices OK.
  **Falta solo el índice transversal**.
- El registro real de Atlas, comparado con la ficha en vivo, da `sin_cambio`.
- `--ejecutar` en modo informe se detiene en el prechequeo hasta que exista el índice.

Nada de esta página escribió en Atlas ni cambió Render.

## Comando

```
node scripts/ciclo-checkmig-v2.js --simular                  # ficha oficial + registro de prueba
node scripts/ciclo-checkmig-v2.js --simular --registro R.json --html F.html   # sin red
node scripts/ciclo-checkmig-v2.js --ejecutar [--registro-local RUTA_NUEVA]    # tarea diaria
```

**`--simular`:** consulta la ficha con el adaptador real y la compara con un registro de prueba.
No conecta a ninguna base, no lee `.env` y no escribe. Informa la acción y, aparte, la fecha de
verificación.

**`--ejecutar`:** prechequeo de solo lectura (identidad, índices, destino) y después el ciclo
compartido con H3.3.

- **Modo informe** (sin `CICLO_V2_AUTORIZACION_JSON` vigente): lee y compara, no propone ni
  escribe. Si en la conexión aparece un comando que no es de lectura (fuera de
  `connectionStatus`, `listIndexes`, `find`, `getMore`, `killCursors`, `endSessions` y los del
  handshake), la corrida termina con exit 1.
- **Política automática** (autorización vigente): aplica con H3.3 los cambios confirmados de
  los campos autorizados (`obligatorio`). Antes de escribir revalida la ficha, y registra el
  intento, el CAS, la transacción y la auditoría. Los casos dudosos van a revisión humana y no
  se escriben.

**Registro de cada corrida:** una línea en stdout,
`REGISTRO_EJECUCION {json}` (versión `registro-ciclo-v1`), con:

- `iniciado_en` y `terminado_en`, el modo y la política (persona y vencimiento);
- el proceso y el objetivo (`_id` de destino y requisito);
- `fuente`: `url`, `consultado_en`, `http_status`, `hechos_hash` y `contenido_sha256`;
- el resultado, el motivo, `codigo_salida`, la propuesta y el intento si se aplicó, y lo
  pendiente;
- `fecha_verificacion`: actual, días y efecto;
- los comandos enviados a Mongo.

Nunca incluye la URI. `--registro-local` guarda el mismo JSON en un archivo nuevo (`wx`). En
Render el registro queda en los logs de cada corrida del Cron Job.

**Códigos de salida (ambos modos):**

| código | significado |
|---|---|
| 0 | `sin_cambio`, o cambio aplicado (`exito`) |
| 2 | cambio aplicable sin política |
| 3 | revisión humana, propuesta activa existente o resultado no exitoso de H3.3 |
| 4 | fuente no disponible (se reintenta al día siguiente) |
| 1 | error de configuración, prechequeo o escritura en modo informe |

Render marca como fallida toda salida distinta de 0: ese es el aviso de fallos.

## Evidencia del 17/11/2026 (hora de Montevideo)

**Prechequeo de solo lectura** (2026-11-18T02:04:59Z):

- driver nativo y monitor de comandos; se enviaron solo `connectionStatus`, `find` y
  `listIndexes`;
- conexión local `MONGODB_URI_DECISION`. Las dos URI de la app del `.env` local
  (`MONGODB_URI` y `MONGODB_URI_BACKEND_NUEVA`) fallaron con `bad auth`.

| control | resultado |
|---|---|
| identidad | `mathias-operador@admin`, rol `readWrite@buscador_requisitos` |
| destino CO | 1 documento, `6a87828da8282a4aa6ddfbd4`, `updatedAt` 2026-11-18T02:00:07.056Z |
| Check-Mig | 1, `_id` `6aaddd0e9f54309f9d82727b` (ObjectId); todos los campos son texto: obligatorio `no`, fuente = ficha, link `/pre-registro/`, `fecha_verificacion` `2026-11-17` |
| índices de decisión y aplicación (10) | presentes con forma exacta, incluido `inicios_intento_aplicacion.intento_id_1` |
| índice transversal `propuestas_cambio.uniq_propuesta_activa_por_destino_requisito` | **falta** |
| propuestas activas | 0 en total; 0 grupos duplicados que bloqueen el índice transversal |

**`--ejecutar` en modo informe** (2026-11-18T02:09:48Z, sin política): exit 1 en el
prechequeo, `falta propuestas_cambio.uniq_propuesta_activa_por_destino_requisito`. No consultó
la fuente. Comandos: `connectionStatus` y `listIndexes`.

**Clasificación del registro real** (2026-11-18T02:10:04Z): el Check-Mig leído de Atlas con
`find`, pasado por `--simular` contra la ficha en vivo (HTTP 200,
`hechos_hash f7becb92…`, «de uso no obligatorio»):

- **`ACCIÓN: sin_cambio`**, exit 0;
- fecha `2026-11-17`, efecto `no_se_renueva`: la ficha no respalda `descripcion`, `fuente`,
  `link`, `plazo_antes_del_vuelo` ni `costo`.

**Fuente:** `robots.txt` de `www.migracioncolombia.gov.co` responde 404, así que no publica
restricciones. El ciclo hace una consulta por día a una página pública (dos, si aplica un
cambio). La ficha dice «Servicio gratuito».

## Piezas reutilizadas (también para el siguiente país)

- `services/propuestas/ciclo/ciclo-revalidacion-v2.js`:
  - `clasificar`: sin cambio, cambio aplicable, revisión humana o fuente no disponible, con la
    fecha aparte;
  - `ejecutarCicloV2`: propuesta 2.0, aprobación y aplicación con **H3.3**, que revalida,
    inicia el intento, hace el CAS, la transacción y la auditoría.
- `services/propuestas/ciclo/perfil-checkmig-colombia.js`: qué requisito cubre, con qué
  adaptador y qué autoriza la política.
- **Otro país:** se agrega un adaptador y un perfil, y una entrada en `POLITICAS` de
  `config-ciclo-real.js`. El ciclo, H3.3 y el comando no cambian.
- **Piloto:** `scripts/piloto-checkmig-v2.js` usa el mismo ciclo con identidades que valen
  **solo** en su Mongo efímero. `config-ciclo-real.js` las rechaza.

## Configuración y credenciales del proceso (ejecución real)

**Credencial:** se reutiliza la de la app (`buscador-backend-app`, `readWrite@buscador_requisitos`).
Ese permiso alcanza para el ciclo y H3.3 (lecturas, transacción e inserts de auditoría), así
que no hace falta crear otro usuario de Atlas. El Cron Job es otro servicio de Render: allí se
define `MONGODB_URI_CICLO` y **no** se define `MONGODB_URI`. `connectionStatus` identifica al
proceso; si la URI fuera de otro usuario, el prechequeo se detiene sin escribir.

| Variable (Cron Job) | Valor |
|---|---|
| `MONGODB_URI_CICLO` | secreto: el mismo valor que `MONGODB_URI` del servicio web |
| `OPERADORES_AUTORIZADOS_JSON` | `[{"usuario_atlas":"buscador-backend-app","db":"admin","identificador":"proceso.ciclo-checkmig"}]` |
| `CICLO_V2_AUTORIZACION_JSON` | **solo para activar la política**: `{"politica":"checkmig-colombia-obligatoriedad@1","autorizada_por":"<identificador de quien autoriza>","autorizada_en":"<ISO UTC>","vence_en":"<ISO UTC, ≤ 90 días>"}` |

**Identidad registrada:**

- **Aplicación (H3.3):** auditoría `comando_administrativo` con `usuario_atlas` y `db` reales de
  `connectionStatus`, y operador `proceso.ciclo-checkmig`.
- **Aprobación:** es `autorizada_por`, con `identidad_operador { metodo: "politica_automatica",
  politica, autorizada_en, vence_en, proceso, usuario_atlas, db_autenticacion }`.
- Al compartir el usuario de Atlas con la app, lo que distingue una escritura del ciclo es el
  operador `proceso.ciclo-checkmig` y el método `politica_automatica` de la auditoría, no el
  usuario de Atlas. Si después hace falta separarlos, basta con un usuario propio y cambiar las
  dos variables, sin tocar el código.

**Prechequeo de `--ejecutar`, solo lectura, antes de leer la fuente:**

- identidad en la allowlist;
- índices de decisión, de aplicación y el **transversal**, presentes (no los crea);
- un único destino `CO` con un único Check-Mig con `_id`.

**Casos que van a revisión humana** (no se escribe en destinos):

- lectura ambigua, con los campos sin confirmar;
- cambio que deja la descripción contradiciendo el valor;
- obligatorio que exigiría cambiar `recomendado`;
- requisito fuera del perfil;
- sin evidencia de obligatoriedad;
- en H3.3: cambio no confirmado por la segunda lectura, o revalidación ambigua
  (`revision_requerida`).

**Casos que se reintentan al día siguiente:** fuente no disponible y revalidación vencida.

### Reintento de una propuesta aprobada (`evaluarReintento`, ciclo-revalidacion-v2.js)

Si la aplicación de H3.3 falla por una caída de la fuente, la propuesta queda `aprobada`. La
corrida siguiente del mismo perfil vuelve a aplicar **esa misma** propuesta. No crea otra
propuesta ni otra aprobación: H3.3 registra un intento nuevo con su inicio durable, revalida la
fuente y escribe solo si los hechos siguen siendo los aprobados. El CAS de versión, la
transacción y el índice de un único éxito por propuesta evitan una escritura doble. Antes de
reintentar, el ciclo solo lee (`find`) y exige todo lo siguiente:

1. La propuesta está `aprobada` y corresponde al destino y al requisito del perfil. También deben
   coincidir el adaptador que elegiría H3.3 y los campos autorizados.
2. La propuesta está íntegra: el hash se recalcula, la aprobación es coherente y el sobre 2.0 es
   válido. La identidad del requisito tiene que ser la del payload.
3. La aprobación se hizo por `politica_automatica` con **la misma** autorización vigente hoy:
   igual política, autorizante, `autorizada_en` y `vence_en`.
   - Con la autorización vencida o ausente, la corrida queda en modo informe: no reintenta y
     solo lee. Exit 3, pendiente `autorizacion`.
   - Si la autorización se renovó, la aprobación anterior no se reutiliza sola: queda para
     revisión humana.
4. No hay un intento en curso, es decir, un inicio sin su intento terminado (`intento_en_curso`).
   Tampoco hay un éxito previo.
5. El último intento terminó en `fuente_temporalmente_no_disponible` y todas sus lecturas
   fallidas son transitorias: red, tiempo agotado, HTTP 5xx, 408 o 429. Un 404, una redirección
   fuera del sitio o un cuerpo ilegible quedan para revisión humana (`fallo_no_admitido`).
6. Quedan reintentos: como máximo **3 automáticos después del intento inicial**. Se cuentan con
   los registros existentes: todo intento terminado de la propuesta en `intentos_aplicacion`.
   - Si el tercer reintento vuelve a fallar, la corrida ya informa revisión humana con el motivo
     `reintentos_agotados`.
   - Las corridas siguientes no consultan ni escriben: devuelven `propuesta_activa_existente`
     con ese motivo y exit 3, así que el job falla y llega el aviso existente.
   - El resumen del job muestra «REINTENTOS AGOTADOS (3 de 3)».
   - No se persiste ningún estado nuevo: la propuesta sigue `aprobada` y una persona decide si la
     cancela o la aplica a mano.

Con HTTP 200 y hechos distintos de los aprobados, H3.3 hace dos lecturas reales y nunca aplica el
contenido anterior. Si las dos lecturas dan los mismos hechos nuevos, la propuesta queda
`obsoleta`; si dan hechos distintos entre sí, queda en revisión.

Las propuestas pendientes, en revisión, rechazadas, canceladas, obsoletas o aplicadas nunca se
reintentan. Si una persona rechazó o canceló una propuesta con los **mismos** hechos y cambios,
el ciclo no vuelve a proponerla: devuelve `revision_humana` con el motivo
`decision_humana_previa` y no escribe. Si la fuente publica hechos nuevos, se propone de nuevo.
El registro de la corrida incluye `reintento` (admitido, motivo e intento previo). Pruebas:
`scripts/test-reintento-aprobada-v2.js`.

## Sin cambio ≠ renovar la fecha de verificación

- **Sin cambio:** los valores guardados coinciden con la ficha. No se escribe nada y **la fecha
  no se toca**.
- **Al aplicar un cambio:** el núcleo fija `fecha_verificacion` al día de Montevideo.
- **Plan para renovar la fecha sin una propuesta de cambio** (no implementado). Debe cumplirse
  todo lo siguiente:
  1. dos lecturas vigentes con los mismos hechos, que coincidan con los aprobados en el último
     cambio aplicado (`hechos_hash`);
  2. cobertura de **todo** lo publicado del requisito:
     - `obligatorio` ↔ obligatoriedad;
     - `descripcion` sin contradicción con los hechos (obligatoriedad, ventana y alcance);
     - `plazo_antes_del_vuelo`, si existe, igual a la ventana (72 h a 1 h);
     - `fuente` igual a la ficha;
     - `link` verificado aparte: el formulario responde 200 en `apps.migracioncolombia.gov.co`;
  3. una operación propia (`renovacion_verificacion`), distinta de `PropuestaCambio`: CAS sobre la
     instantánea completa del requisito, escritura **solo** de `fecha_verificacion` e intento con
     las revalidaciones y un evento propio. Requiere ampliar el contrato de resultados y eventos.

  Hasta entonces, `--simular` informa `efecto=no_se_renueva`.

## Activación: operaciones que requieren autorización (ninguna ejecutada)

En orden. Cada una se autoriza por separado.

1. **Push** del commit del ciclo: `git push origin main`. El Cron Job construye desde `main`.
2. **Índice transversal en Atlas**, con el procedimiento de `docs/operacion-indice-v2.md`:
   - a. Informe de lectura con la cuenta dedicada `buscador-prechequeo-lectura`, que debe tener
     **solo** `read@buscador_requisitos`. Si no existe, crearla es otra operación autorizada:
     `atlas dbusers create read@buscador_requisitos --username buscador-prechequeo-lectura`.
     Después:
     `MONGODB_PRECHEQUEO_URI=<uri de esa cuenta>/buscador_requisitos node scripts/prechequear-indice-transversal-lectura.js --solo-lectura --salida <ruta privada nueva>/informe.json`
   - b. Evidencia de simulación, local, desde el commit limpio:
     `node --require ./scripts/preload-solo-loopback.js scripts/test-operacion-indice-transversal.js --evidencia <ruta privada nueva>/simulacion.json`
   - c. Plan, sin conexión:
     `node scripts/generar-plan-indice-transversal.js --informe <…>/informe.json --simulacion <…>/simulacion.json --carpeta <carpeta privada nueva> --host cluster0.cqvmpna.mongodb.net`
     Devuelve el SHA-256 de `plan.json`. Vence a las 24 h.
   - d. Creación, solo con la confirmación de ese hash:
     `MONGODB_INDICE_OPERADOR_URI=<uri de mathias-operador> node scripts/crear-indice-transversal.js --plan <carpeta>/plan.json --confirmo <sha256> --salida <comprobante nuevo>`
   - Efecto conocido (decisión C de `docs/indice-transversal.md`): con el índice, el registrador
     1.0 termina en `fallo_registrado` si choca con una activa de otro campo. Hoy hay 0 activas.
3. **Modo informe con la base real**, sin `CICLO_V2_AUTORIZACION_JSON`. Se espera
   `resultado=sin_cambio`, exit 0, y comandos solo de lectura en el registro:
   - local: `node scripts/ciclo-checkmig-v2.js --ejecutar --registro-local <ruta nueva>`, con
     `MONGODB_URI_CICLO` y `OPERADORES_AUTORIZADOS_JSON` en el entorno;
   - o en Render: la primera corrida manual del Cron Job del paso 4 (*Trigger Run*), antes de
     agregar la política.
4. **Crear el Cron Job en Render** (servicio nuevo; revisá su costo en Render antes de crearlo):

   | Campo | Valor |
   |---|---|
   | Tipo | Cron Job, mismo repositorio, rama `main` |
   | Root Directory | `backend` |
   | Build Command | `npm ci --omit=dev --ignore-scripts` |
   | Command | `node scripts/ciclo-checkmig-v2.js --ejecutar` |
   | Schedule | `0 11 * * *` (08:00 de Montevideo) |
   | Node | 24.14.1 (`engines` de `package.json`) |
   | Variables | `MONGODB_URI_CICLO` y `OPERADORES_AUTORIZADOS_JSON` (tabla de arriba); **sin** `MONGODB_URI` ni la política todavía |
   | Aviso de fallos | activar en Render las notificaciones de corridas fallidas del servicio (exit ≠ 0) |

   Sin la política, cada corrida diaria es un modo informe.
5. **Activar la política automática:** agregar en el Cron Job
   `CICLO_V2_AUTORIZACION_JSON={"politica":"checkmig-colombia-obligatoriedad@1","autorizada_por":"<identificador>","autorizada_en":"<ahora, ISO UTC>","vence_en":"<≤ 90 días, ISO UTC>"}`.
   Desde la corrida siguiente, los cambios confirmados de `obligatorio` se aplican solos. Al
   vencer, el ciclo vuelve al modo informe y el registro lo dice (`motivo_sin_politica`).

**Comprobar que la tarea diaria funciona:** cada corrida tiene en sus logs una línea
`REGISTRO_EJECUCION` con `fuente.consultado_en` del día, `resultado` y `codigo_salida`. Una
corrida sin cambios termina en exit 0 (verde en Render).

**Pendiente (no bloquea la activación):** renovar `fecha_verificacion` sin cambio de valores
sigue sin implementarse, porque la ficha no respalda todos los campos. Ver la sección «Sin
cambio ≠ renovar la fecha de verificación».
