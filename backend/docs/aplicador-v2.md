# Aplicador 2.0 — H1 (servicio aislado)

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

## Pendiente fuera de H1

- Mejora posterior, sin cambiar en H1: mover a `services/` y congelar el SPEC del índice
  transversal, hoy importado de `scripts/preparar-indice-transversal.js` (mutable y
  compartido con el ejecutor del índice ya revisado).

- H2: modelos/esquemas de intento e historial 2.0. Los documentos actuales son provisionales.
- H3: autenticación y permiso del operador (H1 solo valida la forma de la auditoría ya
  resuelta), InicioIntento antes de revalidar, adaptador 2.0 que produce `revalidaciones`,
  registro de intentos por revalidación vencida o fuente cambiada, y CLI.
- Contrato HTTP del panel al terminar H3. Índice transversal en Atlas: sin él, el servicio
  rechaza con `ErrorPrecondicionIndices` antes de escribir.
