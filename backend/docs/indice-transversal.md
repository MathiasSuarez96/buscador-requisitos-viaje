# Preparación del índice transversal

Estado: preparación local. No se accedió a Atlas ni se cambiaron los gates publicados.

El índice actual incluye `campo`. El nuevo índice limita a una propuesta activa
por `destino_id + requisito_id`, incluso si una modifica costo y otra el requisito
completo. Los estados activos siguen siendo los del contrato compartido:
pendiente_aprobacion, aprobada y revision_requerida.

## Verificación local

Desde backend:

```text
node scripts/preparar-indice-transversal.js
node --require ./scripts/preload-solo-loopback.js scripts/test-indice-transversal-mongo.js
```

La prueba crea y elimina índices únicamente en Mongo efímero. Demuestra conflictos
entre campos, concurrencia, historial no activo y conservación del índice anterior.
El prechequeo rechaza también identificadores de destino/requisito que no sean ObjectId.

## Operación pendiente en Atlas

1. Revisar estos archivos antes de cualquier operación de producción.
2. Autorizar por separado una lectura con la cuenta del operador. Guardar el inventario
   de índices y ejecutar `prechequear(db)` en la base esperada. El módulo no abre
   conexiones ni lee credenciales. Guardar el informe privado con su hash y fecha.
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
