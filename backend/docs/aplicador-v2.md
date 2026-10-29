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

## Pendiente fuera de H1

- H2: modelos/esquemas de intento e historial 2.0. Los documentos actuales son provisionales.
- H3: autenticación y permiso del operador (H1 solo valida la forma de la auditoría ya
  resuelta), InicioIntento antes de revalidar, adaptador 2.0 que produce `revalidaciones`,
  registro de intentos por revalidación vencida o fuente cambiada, y CLI.
- Contrato HTTP del panel al terminar H3. Índice transversal en Atlas: sin él, el servicio
  rechaza con `ErrorPrecondicionIndices` antes de escribir.
