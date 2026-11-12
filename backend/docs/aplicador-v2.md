# Aplicador 2.0 — H1 (servicio aislado), H2.1 (persistencia de auditoría), H2.2 (evento) y H3.1 (inicio)

Estado: servicio local `services/propuestas/aplicar-propuesta-v2.js`, probado solo en
Mongo efímero con replica set. **No es un flujo operativo**: no tiene rutas, CLI ni
panel; el registro 2.0 sigue cerrado y el aplicador 1.0 no cambia.

## Qué hace

- Entrada cerrada del 1.0 (`validarEntrada`): nunca acepta payload ni identidades.
- Trabaja con la propuesta GUARDADA: estado, versión de coordinación, hash esperado y
  recalculado, evento de aprobación vigente (reutiliza `verificarPrecondicionesPropuesta`),
  contrato 2.0 y `advertencias_aceptadas` del evento iguales a `payload.advertencias`.
- Una transacción (opción A): relee y valida propuesta y aprobación, reconstruye el plan
  con `plan-aplicacion-requisito-v2.js`, CAS de la propuesta, lee el destino en la sesión,
  clasifica el requisito y escribe con `Destino.collection` (sin casting del modelo, que
  declara `fecha_verificacion` como Date). Exige `matchedCount` y `modifiedCount` iguales a 1
  y persiste historial, intento y evento con persistidores inyectados en la misma sesión.
- Conflicto (destino inexistente, requisito ausente, sin `_id` ObjectId, duplicado,
  identidad distinta, claves desconocidas, instantánea distinta): transición existente
  `conflicto`, sin escribir el destino.
- Relectura ante error o respuesta incierta: confirma solo si propuesta, evento, intento,
  historial y requisito coinciden; rastro parcial → inconsistencia; relectura fallida →
  resultado incierto, sin registrar más ni reintentar.
- Aprobador (evento) y aplicador (auditoría) quedan por separado aunque sean la misma persona.

## H2.1 — Intento e historial 2.0

- `contexto` exige `adaptador: { nombre, version }` con nombre técnico cerrado
  (`/^[a-z0-9][a-z0-9._-]{0,63}$/`), sin default. Su selección autenticada es de H3.
- Intento e historial se escriben con `version_contrato: '2.0'` y se validan con los
  modelos existentes **antes** de abrir la transacción (`validarIntento`,
  `validarHistorial`, `validarEvento`); un documento inválido es `ErrorInconsistencia` y
  no se escribe nada.
- Errores externos: el intento abortado guarda solo un código cerrado (`error_externo`:
  `red`, `clave_duplicada`, `servidor`, `inconsistencia`, `desconocido`) y un mensaje fijo,
  nunca el texto del error. Una transición por fallo de conflicto lleva
  `resultado_no_registrado` y el `conflicto`.

### Compatibilidad con 1.0

- Sin `version_contrato` el documento es 1.0, también los históricos: rigen exactamente
  las reglas anteriores. No hay default de versión ni migración; `'2.0'` es el único valor
  admitido y es inmutable.
- Mezclas rechazadas en ambos sentidos: un 1.0 con campos 2.0 (`revalidaciones`,
  `aprobacion`, `conflicto`, `precondiciones`, `fecha_verificacion`, `error_externo`,
  `identidad_operador`; en historial `cambios`, `fecha_verificacion`) o un 2.0 con campos
  1.0 (`evidencia_fresca`, `revalidacion`, `precondicion`, `valor_observado`,
  `identidad_esperada_no_coincide`; en historial `valor_anterior`, `valor_nuevo`,
  `revalidacion_id`).
- Los arrays 2.0 tienen `default: undefined`: un 1.0 guardado por el modelo no gana `[]`.
- Intento 2.0: reglas por resultado y etapa (`validarV2`). Revalidaciones solo ya
  validadas y nunca en el rechazo de etapa 0; conflicto con categoría coherente con el
  resultado efectivo; precondiciones solo en `propuesta_no_aplicable`; `fecha_verificacion`
  solo en éxito, como string `YYYY-MM-DD` de calendario (path Mixed: un path String
  convertiría a texto un Date, un `String` objeto o cualquier objeto con `toString`).
- Los hooks 2.0 rechazan por regla, nunca por un `TypeError` accidental: `fuente_nombre`
  ausente, null o no string y los elementos vacíos de `revalidaciones[]` o `cambios[]`
  tienen guardia propia (barrido de ausente/null sobre cada ruta de los fixtures 2.0).
- Historial 2.0: `campo: 'requisito'`, `cambios[]` ordenados sin repetidos con valores
  capturados `{presente, bson_tipo, valor}` y `fecha_verificacion {anterior, nueva}`. Las
  revalidaciones se leen del intento referenciado, no se copian.

- `EventoPropuesta` no cambia en H2.1 (ver H2.2).

### Persistencia (`services/propuestas/persistencia-aplicacion-v2.js`)

- Siempre una instancia NUEVA del modelo por llamada, con `strict: 'throw'`: validación y
  hooks reales en cada intento del callback. Con `connection.transaction` Mongoose
  restaura el estado de los documentos al reintentar; con `withTransaction` del driver no,
  y una instancia reutilizada llegaría con `isNew=false` (el historial la rechaza por
  append-only). La prueba cubre ambos caminos.
- Escrituras transaccionales: exigen la sesión de una transacción activa (`TypeError` si
  falta o no está en transacción) y la pasan explícitamente a `save({ session })`.
- Registro independiente del intento abortado: sin sesión, `writeConcern` majority.
- Nunca `collection.insertOne` para auditoría. Las relecturas sí son nativas.
- Tipos persistibles, antes de construir el documento: solo null, string, boolean,
  número finito, Date válido, ObjectId y objetos/arrays planos. Funciones, símbolos,
  BigInt, NaN/Infinity, Date inválidos y objetos no planos (`String`, `Map`, `RegExp`…)
  se rechazan con `StrictModeError` en cualquier nivel, también dentro de Mixed, donde
  Mongoose los conservaría pero Mongo los descartaría o cambiaría al guardar.
- Comparación anidada entrada/documento: cada hoja de la entrada debe sobrevivir con el
  mismo tipo y valor en el documento construido. La única conversión admitida es string
  hex → ObjectId (`destino_id`/`requisito_id`, como en el 1.0). Se rechazan con
  `StrictModeError` las claves descartadas en cualquier nivel, ISO → Date,
  ObjectId → String y número ↔ string. Date, ObjectId, objetos vacíos y claves con punto
  dentro de Mixed se conservan con su tipo BSON.
- `undefined` distingue ruta presente de ruta ausente: solo se admite en un campo
  opcional declarado por el esquema (no una subruta de Mixed ni una clave desconocida) y
  que siga ausente en el documento (sin que un default lo complete). El servicio no
  produce `undefined`: omite los campos opcionales.

### strict 'throw' en subdocumentos

`strict: 'throw'` del constructor solo cubre el primer nivel; los subesquemas 2.0 quedan
con strict por defecto (descartan en silencio, y por eso existe la comparación anterior).
No se declara `strict: 'throw'` en los subesquemas porque, al abortar
`connection.transaction` (rollback o reintento por `TransientTransactionError`), Mongoose
restaura el estado de los documentos guardados, incluido `__v`. En un subdocumento con
`strict: 'throw'` eso lanza `StrictModeError: Field __v is not in schema`, que reemplaza al
error original (comprobado con Mongoose 9.9.4 y Mongo 8.0.32 efímero).

## H2.2 — Evento de aplicación y conflicto 2.0

- Contrato del `detalle` (solo eventos con intento: `aplicacion`, `conflicto`), validado por
  `EventoPropuesta` cuando `detalle.version_contrato === '2.0'`:
  `{ version_contrato, resultado, auditoria, proceso_aplicador, adaptador, decision_aprobacion_id }`,
  con claves exactas. `resultado` coherente con el tipo (`exito`; `valor_actual_cambio` o
  `identidad_requisito_cambio`), `actor` = sistema `aplicar-propuesta-v2`, proceso y adaptador
  técnicos, auditoría válida (`validarAuditoria`) y, si viene del panel, su instantánea
  corresponde a este evento (propuesta, hash, versión anterior y decisión).
- Tres papeles por separado y sin copias: el proceso en `actor`; el aplicador en
  `detalle.auditoria` (su `origen` distingue panel de comando, por eso en 2.0 no existe
  `auditoria_panel`); el aprobador por referencia (`decision_aprobacion_id`) a su propio
  evento. El intento conserva su copia validada de `aprobacion`; el evento ya no repite
  `propuesta_id`, `operador`, `identidad_operador` ni `aprobacion`.
- Compatibilidad: sin `version_contrato` rigen las reglas de siempre (eventos 1.0, con o sin
  `auditoria_panel`, e históricos sin auditoría). Un detalle con el proceso 2.0 y sin versión
  se rechaza. Los eventos de decisión 2.0 no cambian. No hay eventos 2.0 de aplicación
  persistidos (el aplicador 2.0 no está conectado), así que el cambio de forma no afecta datos.
- Panel (`lectura-propuestas.js`): misma forma JSON de evento, sin campos nuevos. Para
  `aplicacion`/`conflicto` con `detalle.version_contrato: '2.0'`, `origen` y
  `metodo_identidad` salen de `detalle.auditoria.comando.nombre` e
  `detalle.auditoria.identidad.metodo`, con las mismas allowlists. La proyección agrega solo
  esas dos hojas y `detalle.version_contrato`; nunca la auditoría entera, `sub`,
  `usuario_atlas`, `request_id` ni la instantánea. Eventos 1.0, históricos y decisiones
  (también las 2.0) siguen exactamente igual: los de aplicación 1.0 conservan `origen: null`
  (no tienen `detalle.comando`) y su método sale de `identidad_operador`.
- Pendiente de decisión (producto/API, con H3): mostrar aplicador humano, adaptador o
  versión de contrato del evento agregaría campos a todos los eventos de la respuesta.
  `esReenvioIdentico` (reenvío del panel) sigue siendo solo 1.0; el reenvío 2.0 es de H3.

## H3.1 — Inicio durable del intento 2.0

Alcance: modelo, persistencia y adaptación del núcleo. **No es el flujo completo**: no hay
orquestador, adaptador 2.0, clasificador de fuentes, resultados nuevos de revalidación,
CLI, rutas ni contrato HTTP. El aplicador sigue aislado, el registro 2.0 cerrado, y el
inicio no reemplaza la autenticación ni el permiso del operador (pendientes del orquestador).

### Forma del inicio (`InicioIntentoAplicacion`, `version_contrato: '2.0'`)

```
{ version_contrato: '2.0',
  intento_id, evento_id, historial_id,        // UUID distintos: los tres ids del intento quedan reservados acá
  propuesta_id, hash_contenido_referenciado,  // hash esperado de la entrada (el aprobado)
  version_coordinacion_esperada, decision_aprobacion_id_esperado,
  operador: { tipo: 'humano', identificador },  // = auditoria.operador
  auditoria,                                    // obligatoria (validarAuditoria); si es del panel, su instantánea = estos campos
  proceso_aplicador: { nombre: 'aplicar-propuesta-v2', version: '1' },
  adaptador: { nombre, version },               // nombres técnicos
  iniciado_en: Date }
```

- Sin `version_contrato` rigen las reglas 1.0 (también históricos sin auditoría). Sin default
  de versión ni migración; versión desconocida rechazada.
- Mezclas rechazadas: un 1.0 con `evento_id`, `historial_id` o `decision_aprobacion_id_esperado`,
  o con el proceso 2.0; un 2.0 con `proceso` (host/pid). En 2.0 no se guarda `proceso` para que el
  núcleo pueda comparar el registro completo (si el orquestador lo necesita, se decidirá ahí).
- Append-only, sin índices nuevos ni cambios de `autoIndex` (usa `intento_id_1` existente).

### Persistencia

- `validarInicio`, `insertarInicio` (independiente, `writeConcern` majority, nunca en una
  transacción) y `leerInicio(intento_id, session?)` (nativo). Sin sesión lee con
  `readConcern: majority`: tras un insert incierto solo confirma un inicio ya confirmado por la
  mayoría. Con sesión exige una transacción activa y solo pasa esa sesión: rige el nivel de
  lectura de la transacción (snapshot). Mismas garantías que H2.1: instancia nueva, modelo y hooks reales, strict,
  comparación tipada, tipos no persistibles rechazados.
- `construirInicioV2(entrada, contexto)` (pura) produce el inicio exacto que el núcleo espera.
- `registrarInicioV2(inicio, deps)`:
  - insertado → confirmado;
  - error al insertar (incluido E11000) → relee: el **mismo documento completo** confirma
    (`causa_relectura: 'duplicado' | 'error_insercion'`); otro documento con ese id →
    `ErrorInconsistencia`; relectura fallida o sin documento → `ErrorInicioInciertoV2`.
  - Nunca sobrescribe, genera otro id ni reintenta. Mientras el inicio no esté confirmado, el
    llamador no debe consultar fuentes ni llamar al núcleo.
  - Mensajes públicos sin la causa ni la auditoría.

### Núcleo (`aplicarPropuestaV2`)

- `contexto` = exactamente `{ adaptador, auditoria, intento, revalidaciones }` con
  `intento = { intento_id, evento_id, historial_id, iniciado_en }`: UUID distintos, `Date`
  válido, copiados antes del primer `await`. El núcleo ya no genera ids (`deps.uuid` no se usa).
- El inicio persistido se compara completo (versión, ids, propuesta, hash, versión de
  coordinación, decisión, operador, auditoría, proceso, adaptador, `iniciado_en`) contra el
  esperado con una firma que conserva el tipo BSON (`firmaBson`): un `iniciado_en` guardado
  como texto ISO no equivale al `Date` del mismo instante, ni un número a su texto. La misma
  comparación rige el registro (`registrarInicioV2`), las verificaciones previas a escribir y la
  relectura de confirmación del cierre:
  - temprano, antes de las precondiciones (también antes del rechazo temprano);
  - dentro de cada transacción (éxito y conflicto) con su sesión, en cada vuelta del callback;
  - antes de cada registro independiente (rechazo, CAS perdido, escritura abortada,
    inconsistencia);
  - en la relectura de confirmación: sin el inicio exacto no se confirma nada.
- Sin inicio o con discrepancias: `ErrorInicioV2` (`inicio_ausente` | `inicio_discrepante`),
  mensaje fijo, cero escrituras en destinos, propuestas, historial, eventos o intentos. Si la
  verificación previa a un registro independiente no puede leerse: `ErrorResultadoIncierto`
  sin registrar.
- Mismos ids e `iniciado_en` en inicio, intento terminado, evento e historial en éxito,
  conflicto, rechazo temprano, CAS perdido, escritura abortada, reintento del callback y
  relectura de confirmación. Un intento ya registrado conserva las garantías existentes: un
  E11000 de intento_id no confirma sin la relectura completa.

### Límites

- `writeConcern` y `readConcern` majority del inicio no se pueden probar con un solo nodo: las
  pruebas comprueban la opción enviada al driver (monitoreo de comandos) y el insert
  independiente, no la replicación ni un rollback entre réplicas.
- `firmaBson` distingue los tipos que el driver entrega al leer (`Date`, `ObjectId`, número,
  texto, booleano, null y los tipos BSON no promovidos por `_bsontype`); Int32 y Double llegan
  ambos como número de JS y no se distinguen.
- Leer el inicio sin la sesión dentro de la transacción es equivalente en comportamiento (el
  inicio es inmutable y anterior); la prueba lo cubre por estructura (registro de lecturas).
- Para bloques posteriores (no implementados): una revalidación vencida no vuelve obsoleta una
  propuesta; superar un plazo indica posible interrupción, no terminación; una respuesta
  inválida del adaptador se distingue de una caída de la fuente; evidencia normalizada,
  motivos de red y límites de respuesta se definirán con el prototipo de solo lectura de
  Colombia, antes de cerrar el contrato del adaptador (H3.2).

## H3.3 — Flujo interno con la lectura de CheckMig

Alcance: **flujo interno**, sin contrato HTTP, CLI, panel ni frontend. Lo prueban Mongo
efímero y la ficha simulada (`scripts/test-orquestar-aplicacion-v2.js`). No hay escrituras
en Atlas.

Archivos:

- `services/propuestas/orquestar-aplicacion-v2.js`: el orquestador (`aplicarConRevalidacionV2`).
- `services/propuestas/registrar-revalidacion-v2.js`: el cierre de los resultados de
  revalidación (`registrarRevalidacionV2`).
- Modelos: `IntentoAplicacion` y `EventoPropuesta`, extendidos para 2.0.

### Piezas reutilizadas

- **Permiso:**
  - panel: el operador ya resuelto (`resolverOperadorPanel`), con el permiso `aplicar` (igual
    que `services/panel/aplicaciones-propuestas.js`) y un `request_id`;
  - comando: `connectionStatus` contra la allowlist (`resolverActor`), igual que el 1.0.
  - Las dos auditorías pasan por `validarAuditoria`.
- **Adaptador:** `elegirAdaptadorV2` (registro 2.0) elige en el servidor.
- **Aprobación vigente:** `verificarPrecondicionesV2` y el sobre 2.0 validado.
- **Inicio durable:** `construirInicioV2` y `registrarInicioV2`. El mismo `intento` (ids e
  `iniciado_en`) se usa hasta el cierre.
- **Escritura y cierre:**
  - el núcleo `aplicarPropuestaV2`, sin cambios, para el éxito, los conflictos y el no aplicable;
  - para los resultados de revalidación, sus piezas internas, exportadas como `interno`: CAS,
    inicio exacto en cada escritura, `escribirConConfirmacionV2` (transacción y relectura) y
    `registrarIndependiente`.
- **Detección del cambio:** `verificarRevalidaciones` sigue siendo el único punto que lo detecta.

### Orden y resultados

1. **Permiso.** Sin permiso no se lee ni se escribe nada (`ErrorPermisoAplicacionV2` o
   `ErrorActorNoAutorizado`).
2. **Índices, propuesta y adaptador.** Si la propuesta es incompatible, se devuelve
   `{ resultado: 'adaptador_incompatible', codigo }` con el código cerrado del adaptador (por
   ejemplo `varias_fuentes` o `fuente_no_soportada`). No hay inicio, consulta ni escritura.
3. **Inicio confirmado ANTES de la primera consulta.** Si no se puede confirmar
   (`ErrorInicioInciertoV2`), no se consulta. Si la aprobación no está vigente, el núcleo cierra
   el intento como `propuesta_no_aplicable` sin consultar la fuente.
4. **Primera lectura** (una invocación del adaptador hace una sola consulta):
   - `no_disponible` → `fuente_temporalmente_no_disponible`: intento independiente, la propuesta
     sigue `aprobada` y se puede reintentar;
   - `ambiguo` → `extraccion_ambigua`: transacción con CAS `aprobada → revision_requerida` y
     evento `entrada_revision`;
   - hechos iguales a los aprobados → el núcleo existente aplica, con CAS, transacción y
     relectura. Si la revalidación vence antes de escribir, se registra `revalidacion_vencida` y la
     propuesta sigue `aprobada`;
   - hechos distintos → segunda lectura.
5. **Segunda lectura:**
   - los mismos hechos nuevos, con las dos lecturas vigentes al registrar (0 ≤ t − revalidada_en
     ≤ 15 min) → `fuente_cambio`: CAS `aprobada → obsoleta` y evento `obsolescencia`;
   - confirmada pero alguna lectura ya no vigente → `revalidacion_vencida` (sigue `aprobada`);
   - falla → `fuente_temporalmente_no_disponible` (sigue `aprobada`);
   - ambigua, u otros hechos (incluidos los aprobados) → `extraccion_ambigua`, con
     `cambio_no_confirmado` en el motivo (`revision_requerida`).

   `registrarRevalidacionV2` vuelve a exigir las dos lecturas iguales, distintas de lo aprobado y
   vigentes: no se puede marcar obsoleta una propuesta con una sola lectura.

Ningún resultado de revalidación escribe en destinos ni en el historial.

### Lecturas en el intento (`lecturas_fuente`, solo 2.0)

- Una o dos lecturas `{ orden, tipo, url, fuente_nombre, consultado_en, … }`:
  - con hechos: `revalidada_en`, `hechos_hash`, `evidencia` y `contenido_sha256`;
  - ambigua: `revalidada_en`, `campos_sin_confirmar: [{campo, motivo}]`, con campo y motivo de
    listas cerradas, más `evidencia` y `contenido_sha256`;
  - fallo: `codigo_fallo` (lista cerrada: `red`, `tiempo_agotado`, `http`, redirecciones,
    `no_html`, `cuerpo_ilegible`, `demasiado_grande`) y `http_status` si lo hubo. No lleva
    evidencia ni `revalidada_en`.
- La evidencia son oraciones de la ficha de 240 caracteres como máximo, hasta 10 por campo.
  Nunca se guarda el HTML ni el error crudo. `contenido_sha256` es solo diagnóstico.
- **Cuándo van:**
  - obligatorias en `extraccion_ambigua`, `fuente_temporalmente_no_disponible` y
    `fuente_cambio`, también en su `escritura_abortada` por transición;
  - opcionales en `revalidacion_vencida`;
  - prohibidas en el resto.
- `revalidaciones[]`:
  - prohibidas en `extraccion_ambigua` y `fuente_temporalmente_no_disponible`, porque no hubo
    hechos confirmados;
  - en `fuente_cambio`, resumen los hechos nuevos confirmados (el hash nuevo y la lectura más
    antigua).
- Eventos 2.0: `entrada_revision` solo con `extraccion_ambigua` y `obsolescencia` solo con
  `fuente_cambio`. Siempre llevan `motivo`.

### Cómo se revisa un caso ambiguo

1. Buscar la propuesta en `revision_requerida` y su evento `entrada_revision`. El evento lleva
   `intento_aplicacion_id`.
2. Abrir el intento (`intentos_aplicacion`, mismo `intento_id`) y leer `lecturas_fuente`:
   - `campos_sin_confirmar` dice qué campo no se pudo confirmar y por qué (`no_atribuible`,
     `condicionada`, `exclusion`, `sin_evidencia`, `contradiccion` o `fuera_de_dominio`);
   - `evidencia.<campo>` trae las oraciones que leyó el parser;
   - con dos lecturas de hechos distintos, el motivo es `cambio_no_confirmado`: comparar los
     `hechos_hash` y la evidencia de cada una.
3. Revisar la ficha oficial en la `url` de la lectura. Si el HTML cambió, `contenido_sha256`
   lo muestra, pero no prueba que cambiaran los datos.
4. Decidir con una persona: preparar otra propuesta, o cancelar esta (`revision_requerida`
   admite `cancelacion`). En H3.3 no hay un flujo para volver a `aprobada`.

### Piloto y fuente

- La propuesta piloto de las pruebas es **sintética**. Se arma con `crearSobreRequisitoV2` y la
  aprobación real de `decidir-propuesta`, sin datos de Atlas.
- Su única fuente es la **URL exacta de la ficha informativa**
  (`https://www.migracioncolombia.gov.co/tramites-y-servicios/aplicativos/checkmig`). Es la que
  lee el adaptador.
- El `link` del requisito puede seguir siendo el **enlace al formulario** que abre el viajero
  (`https://apps.migracioncolombia.gov.co/check-mig/`). El éxito no lo cambia. Una propuesta
  cuya fuente fuera el formulario es `fuente_no_soportada`.

### Límites de H3.3

- **Inicio que queda sin cierre:**
  - si el adaptador devolviera algo fuera de contrato (`ErrorInconsistencia`);
  - si el núcleo lanzara otro código de revalidación (revalidaciones incompletas o inválidas).
  Con el adaptador real no ocurre: la proyección sale del mismo adaptador. Queda como
  incertidumbre explícita, igual que `ErrorResultadoIncierto`.
- **Segunda lectura:** el cambio usa dos consultas en el mismo intento. Un `fuente_cambio`
  exige que las dos estén dentro de la ventana de 15 minutos.
- **Panel:** la lectura del panel de los resultados nuevos (`lecturas_fuente`, eventos
  `entrada_revision` y `obsolescencia` 2.0) no se cambió ni se verificó. Queda para el contrato
  HTTP y el frontend.
- **Entregas separadas:** el contrato HTTP, el frontend, la auditoría general del runner y
  `.gitattributes`.

## Errores y datos del llamador

- Los mensajes públicos de error pasan por `sanearMensaje`, pero `cause` (y los extras
  `error_relectura`/`error_registro`) **conservan el error crudo en memoria**, que puede
  incluir URIs, credenciales o tokens. H3 no debe devolver `cause` al cliente, ni
  serializarla, ni registrarla sin tratamiento.
- Las revalidaciones del llamador solo se resumen en el intento DESPUÉS de validarlas
  contra las fuentes del payload aprobado, y los textos (`url`, `fuente_nombre`) salen de
  ese payload. Un rechazo de etapa 0 no persiste `revalidaciones`.

## Supuesto de orden (contrato de sesión)

- Toda operación del callback usa la sesión de la transacción, y el destino se lee DENTRO
  de ella, después de la primera operación (que inicia el snapshot). El filtro del núcleo
  no mira claves desconocidas: si el destino se leyera antes del snapshot, una clave
  agregada en paralelo no se detectaría (comprobado con una sonda de reordenamiento).
  El test cubre ese caso por comportamiento y el uso de la sesión por estructura.

## Pendiente

- Mejora posterior: mover a `services/` y congelar el SPEC del índice transversal, hoy
  importado de `scripts/preparar-indice-transversal.js` (mutable y compartido con el
  ejecutor del índice ya revisado).
- Decidir si el panel muestra más datos del evento de aplicación (ver H2.2) junto con la API de H3.
- H3 (resto): autenticación y permiso del operador (H1 solo valida la forma de la auditoría ya
  resuelta), selección autenticada del adaptador, orquestación del inicio (H3.1 lo deja listo),
  adaptador 2.0 que produce `revalidaciones`, registro de intentos por revalidación
  vencida o fuente cambiada, orquestación y CLI.
- Contrato HTTP del panel al terminar H3. Índice transversal en Atlas: sin él, el servicio
  rechaza con `ErrorPrecondicionIndices` antes de escribir.
- No verificable en un nodo único: el efecto de `writeConcern` majority del registro
  independiente.
