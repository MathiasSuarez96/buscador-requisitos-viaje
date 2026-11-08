# Aplicador 2.0 — H1 (servicio aislado) y H2.1 (persistencia de auditoría)

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
- Historial 2.0: `campo: 'requisito'`, `cambios[]` ordenados sin repetidos con valores
  capturados `{presente, bson_tipo, valor}` y `fecha_verificacion {anterior, nueva}`. Las
  revalidaciones se leen del intento referenciado, no se copian.
- `EventoPropuesta` no cambia en H2.1.

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
- Comparación anidada entrada/documento: cada hoja de la entrada debe sobrevivir con el
  mismo tipo y valor en el documento construido. La única conversión admitida es string
  hex → ObjectId (`destino_id`/`requisito_id`, como en el 1.0). Se rechazan con
  `StrictModeError` las claves descartadas en cualquier nivel, ISO → Date,
  ObjectId → String, número ↔ string, BigInt → Number y valores función que
  desaparecerían. Date, ObjectId, objetos vacíos y claves con punto dentro de Mixed se
  conservan.

### strict 'throw' en subdocumentos

`strict: 'throw'` del constructor solo cubre el primer nivel; los subesquemas 2.0 quedan
con strict por defecto (descartan en silencio, y por eso existe la comparación anterior).
No se declara `strict: 'throw'` en los subesquemas porque, al abortar
`connection.transaction` (rollback o reintento por `TransientTransactionError`), Mongoose
restaura el estado de los documentos guardados, incluido `__v`. En un subdocumento con
`strict: 'throw'` eso lanza `StrictModeError: Field __v is not in schema`, que reemplaza al
error original (comprobado con Mongoose 9.9.4 y Mongo 8.0.32 efímero).

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
- H2.2: auditoría del evento (`adaptador`, `auditoria_panel` en el detalle de
  `EventoPropuesta`) y sus lectores del panel.
- H3: autenticación y permiso del operador (H1 solo valida la forma de la auditoría ya
  resuelta), selección autenticada del adaptador, InicioIntento antes de revalidar,
  adaptador 2.0 que produce `revalidaciones`, registro de intentos por revalidación
  vencida o fuente cambiada, orquestación y CLI.
- Contrato HTTP del panel al terminar H3. Índice transversal en Atlas: sin él, el servicio
  rechaza con `ErrorPrecondicionIndices` antes de escribir.
- No verificable en un nodo único: el efecto de `writeConcern` majority del registro
  independiente.
