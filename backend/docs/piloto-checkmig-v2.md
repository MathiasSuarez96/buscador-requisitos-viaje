# Piloto local de CheckMig 2.0

Un solo comando recorre todo el camino: de la ficha de CheckMig al dato que devuelve
`GET /api/destinos`. No hace falta preparar una propuesta aprobada a mano.

```
node scripts/piloto-checkmig-v2.js
```

- **Solo local:** levanta su propio Mongo efímero (`mongodb-memory-server`, 127.0.0.1) y la API
  pública en un puerto efímero de 127.0.0.1. La ficha es simulada, con los fixtures de
  `scripts/fixtures/checkmig`.
- **Sin Atlas ni red:** no acepta URI, no lee `.env` y no consulta la red, así que nunca toca
  Atlas.
- **Prueba reproducible:** `scripts/test-piloto-checkmig-v2.js`, que forma parte de `npm test`.

## Ciclo

1. **Requisito guardado:** lee el destino y el requisito CheckMig. Si ya hay una propuesta
   activa para ese requisito (`pendiente_aprobacion`, `aprobada` o `revision_requerida`), la
   informa y no crea otra, sin consultar la fuente.
2. **Lectura:** lee la ficha con el adaptador 2.0 (`adaptador.leer`, una consulta).
   - Ambigua: no se propone nada y el resultado lista los campos sin confirmar, con su evidencia.
   - Fallida: no se propone nada y el resultado pide reintentar, con el código.
3. **Comparación:** compara los hechos confirmados con el requisito guardado. La obligatoriedad
   del prerregistro corresponde a `obligatorio`: `no_obligatorio` es `no` y `obligatorio` es
   `si`. Si coinciden, el resultado es `sin_cambio` y no se escribe nada.
4. **Política del piloto** (`POLITICA_PILOTO`, `piloto-checkmig-obligatoriedad` v1):
   - autoriza **únicamente** corregir `obligatorio` del requisito «Check-Mig»
     (`formulario_digital`), desde una lectura con hechos y evidencia de obligatoriedad de la
     fuente «Migración Colombia»;
   - cualquier otro requisito, campo o lectura da `cambio_no_autorizado`;
   - también da `cambio_no_autorizado` volver obligatorio un requisito recomendado, que exigiría
     cambiar `recomendado`.
5. **Propuesta, decisión y aplicación:**
   - genera la propuesta 2.0 (`crearSobreRequisitoV2` y el modelo `PropuestaCambio`, con
     validación 2.0);
   - registra la aprobación con `decidirPropuesta`, que escribe el evento real `aprobacion`
     bajo la política;
   - aplica con H3.3 (`aplicarConRevalidacionV2`): permiso, inicio durable, nueva lectura de la
     ficha, CAS, transacción, auditoría y confirmación son los de H3.3. Si esa lectura es ambigua,
     la propuesta queda en `revision_requerida` y el destino no se toca.
   - La lectura del paso 2 y la revalidación de H3.3 son dos consultas que confirman los mismos
     hechos antes de escribir.

## Demostración

La demostración usa dos destinos de prueba, `CO` y `CX`, con CheckMig guardado como
obligatorio. Corre seis ciclos:

1. `CO`, lectura ambigua: no escribe; pendiente de revisión humana, con los campos sin confirmar.
2. `CO`, lectura fallida (HTTP 503): no escribe; pendiente de reintentar (`http_503`).
3. `CO`, cambio confirmado (la ficha dice «de uso no obligatorio»): propuesta, decisión y
   aplicación. `GET /api/destinos` pasa a `obligatorio: "no"` y el link al formulario no cambia.
4. `CO`, segunda ejecución con los mismos datos: `sin_cambio`, sin propuesta nueva ni escritura.
5. `CX`, la revalidación de H3.3 es ambigua: `extraccion_ambigua` y `revision_requerida`, con el
   destino intacto.
6. `CX`, segunda ejecución con la revisión pendiente: `propuesta_activa_existente`, sin consulta
   ni duplicado.

## Identidades del piloto

Este Mongo efímero no tiene autenticación, así que `connectionStatus` no identifica a nadie. Las
identidades son explícitas y valen **solo** en este entorno:

- **Aprobador:** `piloto.local`, con `identidad_operador`
  `{ metodo: 'politica_piloto_local', politica: 'piloto-checkmig-obligatoriedad-v1' }` y comando
  `piloto-checkmig-v2`.
- **Aplicador:** la credencial de comando de H3.3 con la allowlist propia del piloto, que tiene
  un único usuario, `piloto-local`.

No hay un camino para usar estas identidades contra Atlas: el comando no acepta conexión externa.

## Límites

- El `run_id_origen` de la propuesta es un UUID de la corrida. No se registra una
  `EjecucionLectura`, porque ese registro es 1.0 y el registro productivo 2.0 sigue cerrado.
- La política es del piloto. Una política productiva, quién aprueba y el contrato HTTP son
  entregas separadas.
