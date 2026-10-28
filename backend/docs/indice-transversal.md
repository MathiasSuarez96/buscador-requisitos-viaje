# Preparación del índice transversal

Estado: preparación local. No se accedió a Atlas ni se cambiaron los gates publicados.
Esto no significa que crear el índice sea inocuo para el registrador: ver la política operativa más abajo.

El índice actual incluye `campo`. El nuevo índice limita a una propuesta activa
por `destino_id + requisito_id`, incluso si una modifica costo y otra el requisito
completo. Los estados activos siguen siendo los del contrato compartido:
pendiente_aprobacion, aprobada y revision_requerida.

## Verificación local

Desde backend:

```text
node scripts/preparar-indice-transversal.js
node --require ./scripts/preload-solo-loopback.js scripts/test-indice-transversal-mongo.js
node --require ./scripts/preload-solo-loopback.js scripts/test-prechequeo-indice-lectura.js
node --require ./scripts/preload-solo-loopback.js scripts/test-mutaciones-prechequeo-indice.js
```

La prueba crea y elimina índices únicamente en Mongo efímero. Demuestra conflictos
entre campos, concurrencia, historial no activo y conservación del índice anterior.
El prechequeo rechaza también identificadores de destino/requisito que no sean ObjectId.

## Operación pendiente en Atlas

1. Revisar estos archivos antes de cualquier operación de producción.
2. Autorizar por separado una lectura con la cuenta dedicada `buscador-prechequeo-lectura`,
   con **únicamente** el rol `read` sobre `buscador_requisitos`. No usar la cuenta del backend
   ni una cuenta de operación con escritura. La cuenta debe existir y sus permisos deben
   verificarse antes de ejecutar. Su creación, si hiciera falta, es otra operación autorizada.
   El ejecutor nativo `prechequear-indice-transversal-lectura.js` exige esa identidad y rol,
   monitoriza comandos y expone al prechequeo solo métodos de lectura. Guarda un informe
   con inventario, propuestas activas mínimas, comandos, fecha y hash; no incluye URI ni contraseña.
   Debe guardarse fuera del repositorio, en una carpeta privada existente. En Windows,
   `mode: 0600` no configura ACL: la privacidad depende de los permisos de esa carpeta.
3. Si hay duplicadas, tipos inválidos o conflicto de definición, detenerse. No resolver
   duplicadas eliminando propuestas ni cambiando estados automáticamente.
4. Preparar el comando exacto de creación a partir de SPEC/opciones, el inventario
   respaldado y el plan de rollback. Solicitar confirmación del hash del plan.
5. Repetir el prechequeo justo antes de crear. El prechequeo no bloquea carreras:
   Mongo debe rechazar la creación si aparece un duplicado concurrente.
6. Crear únicamente el índice nuevo, conservar el anterior y releer listIndexes
   para comprobar nombre, clave, unique y filtro parcial exactos. Monitorizar comandos
   para comprobar que no se modificaron documentos ni otros índices.
7. Antes de desplegar servicios que exijan el índice nuevo, el rollback consiste en
   eliminar solo el índice nuevo, tras comprobar su definición y el estado de los
   servicios. Después de desplegar esos servicios, no eliminarlo sin coordinar la
   reversión del código: los gates podrían devolver 503.

No se ofrece aún un comando de creación real: se preparará contra el prechequeo
aprobado. Tampoco se abre el registro 2.0 en este bloque.

## Ejecutor de lectura (solo después de revisión y autorización)

Por defecto muestra ayuda sin conectar. No carga `.env` ni usa `MONGODB_URI`.
Recibe la URI dedicada mediante `MONGODB_PRECHEQUEO_URI`; debe seleccionar
`buscador_requisitos` en la ruta de la URI. No pasar credenciales por argumentos.

```text
node scripts/prechequear-indice-transversal-lectura.js --solo-lectura --salida RUTA_ABSOLUTA_PRIVADA_FUERA_DEL_REPO
```

Antes de construir el cliente o conectar, rechaza salida relativa, dentro del repo,
carpeta inexistente/no escribible o archivo ya existente (incluidos enlaces).
Resuelve la carpeta real para impedir que un enlace apunte dentro del repo.
El `wx` final se conserva contra carreras: si la salida cambia después de la validación,
el guardado aún puede abortar; el prechequeo no garantiza que la carpeta permanezca estable.
La cuenta read es la barrera
de autorización en Mongo. El monitor aborta ante comandos fuera de la lista de lectura;
no se presenta el monitor como sustituto de los permisos del servidor. Si hay fallo de
conexión/permisos/monitor no se guarda un informe exitoso ni se imprimen errores con URI.
La CLI publica solo códigos fijos: `cuenta_de_lectura_incorrecta`,
`se_exige_rol_read_exclusivo`, `base_incorrecta`, `variable_faltante` o
`ruta_de_salida_invalida`. Errores externos quedan como `error_no_clasificado`:
nunca se imprime su mensaje crudo ni se toma un código desde un error del driver.

Cobertura de este ajuste: `test-diagnostico-prechequeo.js` y
`test-mutaciones-diagnostico-prechequeo.js`. Las mutaciones se aplican solo en
memoria de procesos hijos, no al ejecutor del repositorio.

| Archivo y línea del ejecutor | Antes → después | Aserción que detecta |
| --- | --- | --- |
| prechequear-indice-transversal-lectura.js:18-19 | código conocido → código genérico | test-diagnostico-prechequeo.js:15, texto exacto de los cinco códigos |
| prechequear-indice-transversal-lectura.js:19 | fallback fijo → error.message | test-diagnostico-prechequeo.js:18, el error externo se mantiene genérico |
| prechequear-indice-transversal-lectura.js:66 | validarSalida(salida) → salida | test-diagnostico-prechequeo.js:34-36, rechazo de ruta antes del cliente y conexión |

## Política del registrador actual: conservadora, sin cambiar producción

Crear el índice transversal **sí cambia** lo que Mongo acepta. El registrador actual
busca por destino + requisito + campo y solo reconoce E11000 del índice anterior.
Ante una activa de otro campo, el índice nuevo rechaza el insert y el registrador
termina en `fallo_registrado`, etapa `creacion_propuesta`, sin propuesta nueva y
sin vincularse automáticamente a una de otro campo. El fallo queda auditado.
Esta conducta está cubierta explícitamente en `test-servicio-ejecucion-lectura.js`.

Decisión C elegida para esta etapa: conservar esa conducta segura ahora y corregir
el reconocimiento de la colisión transversal **antes de abrir el registro 2.0**.
No se promete disponibilidad normal del registro en esa colisión. No se modifica
el registrador ni se abre 2.0. Esta decisión NO autoriza crear el índice:
la creación requiere revisar el ejecutor y confirmar el hash del plan correspondiente.

Pendiente obligatorio de apertura 2.0: implementar, probar y revisar el tratamiento
de la colisión transversal en el registrador. La única versión de registro
admitida por el código publicado sigue siendo 1.0; este bloque no cambia esa constante.

La prueba de concurrencia cubre inserts simultáneos con el índice ya creado.
No demuestra ambos órdenes posibles de una carrera entre createIndex e insert.

## Plan v2 y ejecutores administrativos (pendientes de revisión)

Ver `operacion-indice-v2.md`. El plan privado anterior 39f87f96… es solo un borrador;
NO debe usarse con el ejecutor nuevo. El generador y los ejecutores ahora están
versionados y separados de los servicios publicados.
