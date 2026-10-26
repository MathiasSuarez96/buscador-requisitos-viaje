# Evidencia local del bloque de índice

Este documento describe pruebas locales; no autoriza ni afirma ejecución en Atlas.
Mongo efímero: versión fijada **8.0.32**, solo loopback.

## Estado y alcance

- `159c407`: preparación inicial.
- `2106e8a`: núcleo aislado del aplicador y runner; no revisados dentro de este bloque.
- `9a27cc6`: pasa a `arrayFilters` y agrega pruebas del runner.
- `ef2f81e`: ejecutor read autenticado y correcciones M1/M4/M8/M9.
- Delta posterior: solo añade inventario completo antes/después del rollback y su mutación.

No se modifican registrador, contratos, campos permitidos, modelos ni frontend.
El registro 2.0 permanece cerrado. El comportamiento `fallo_registrado` del
registrador está documentado y probado, no aceptado como decisión operativa por Mathias.
La decisión A/B/C queda pendiente antes de crear el índice. No bloquea revisar
el ejecutor que solo lee.

## Mutaciones

Definiciones exactas: `scripts/test-mutaciones-prechequeo-indice.js`.
Archivo de pruebas: `scripts/test-indice-transversal-mongo.js` (líneas indicadas abajo).
El runner exige exit 1 + AssertionError y rechaza TypeError, ReferenceError,
SyntaxError, módulo faltante, timeout o ancla no única.

| Mutación | Archivo/línea original | Antes → después | Aserción |
| --- | --- | --- | --- |
| M1 | preparar-indice-transversal.js:21 | find con filtro de estados → find({}) | test:57, una sola activa entre los cinco estados inactivos |
| M4 | preparar-indice-transversal.js:27 | clasificación con instanceof ObjectId → if(false) | test:49, resultado clasificado sin excepción |
| M8 | preparar-indice-transversal.js:17 | guardia de databaseName → eliminada | test:26-30, exige Base inesperada antes de pedir colección; el doble también funciona sin guardia, no genera TypeError |
| M9 | preparar-indice-transversal.js:47 | JSON.stringify(plan) → JSON.stringify({...plan, propuestas_activas:[]}) | test:62, cambiar contenido sin cambiar cantidad modifica hash |
| Duplicados | preparar-indice-transversal.js:36 | filter(ids.length>1) → filter(()=>false) | test:37-38, inhabilitado y un grupo duplicado |
| Conflicto | preparar-indice-transversal.js:44 | indice.estado!='conflicto' → true | test:66, índice incompatible inhabilita |
| Rollback equivocado | test-indice-transversal-mongo.js:83 | dropIndex(SPEC.nombre) → dropIndex(anterior) | test:85-86, inventario posterior idéntico al anterior salvo índice nuevo |

La última mutación altera la operación de rollback **en la simulación local**.
No se ofrece ni se ha probado un ejecutor de rollback contra Atlas. El comando
real de creación y su rollback se prepararán con el inventario aprobado.

## Ejecutar y revisar resultados

Desde backend, `npm test` descubre automáticamente todos los `scripts/test-*.js`,
imprime nombres y exit codes y guarda `resumen.json` y logs por suite en una
carpeta temporal que anuncia al comenzar. No depende de una lista fija.

El ejecutor de lectura se prueba con autenticación real en Mongo efímero:
usuario read aceptado, readWrite rechazado y escritura denegada por el servidor.
La CLI sin argumentos solo muestra ayuda. No se ejecutó contra Atlas.

## No verificado

- Cuenta real de Atlas y sus roles efectivos; no se creó ni modificó ningún usuario.
- Inventario/datos reales y versión del servidor de Atlas.
- Restricciones del plan Atlas M0 para índices: no verificadas en este bloque.
- Ambos órdenes de una carrera entre createIndex e insert.
- Estado remoto actualizado mediante fetch durante este bloque (no se hizo fetch).
- Despliegue de estos commits locales (no hubo push).

La segunda copia del backup de Tailandia ya se guardó en el Escritorio y se
compararon sus dos archivos por SHA-256 en una tarea anterior; no es un pendiente
de esta revisión ni un respaldo automático de todos los datos.
