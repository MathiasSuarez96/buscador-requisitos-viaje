# Ciclo real de Colombia (CheckMig): de la simulación a la ejecución diaria

Estado (12/11/2026): la simulación funciona contra la ficha oficial. La ejecución real está
implementada y probada **solo en Mongo efímero**. Nada de esta página se ejecutó contra Atlas
ni en Render.

## Comando

```
node scripts/ciclo-checkmig-v2.js --simular                  # ficha oficial + registro de prueba
node scripts/ciclo-checkmig-v2.js --simular --registro R.json --html F.html   # sin red
node scripts/ciclo-checkmig-v2.js --ejecutar                 # tarea diaria; requiere autorización (abajo)
```

**`--simular`:**

- Consulta la ficha con el adaptador real y la compara con un registro de prueba. Por defecto
  es `scripts/fixtures/checkmig/registro-publicado-2026-10-21.json`, una copia local del
  Check-Mig publicado, tomada de un respaldo.
- No conecta a ninguna base, no lee `.env` y no escribe nada.
- Informa **por separado** la acción y la fecha de verificación.
- Códigos de salida: 0 sin cambio · 2 cambio aplicable · 3 revisión humana · 4 fuente no
  disponible · 1 error.

**Resultado de la consulta real** (12/11/2026, 03:41Z): HTTP 200, `hechos_hash f7becb92…`. La
ficha dice «de uso no obligatorio».

- **Acción:** `revision_humana (descripcion_contradice)`. La ficha confirma `obligatorio: "no"`,
  pero la descripción publicada («Formulario migratorio digital **obligatorio** antes de cada
  vuelo…») afirma lo contrario, y la política solo puede cambiar `obligatorio`.
- **Observación:** `fuente_no_es_la_ficha`. El campo `fuente` apunta al formulario.
- **Fecha:** `2026-08-18`, 86 días. No se renueva: el caso va a revisión.

Es decir: **hoy la ejecución real no escribiría nada**. Primero hace falta la corrección humana
del punto 1.

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

| Variable | Qué es |
|---|---|
| `MONGODB_URI_CICLO` | Credencial **propia** del proceso: usuario de Atlas `ciclo-checkmig`, rol `readWrite@buscador_requisitos`. No es la de la app (`MONGODB_URI`) ni la del operador de índices. |
| `OPERADORES_AUTORIZADOS_JSON` | `[{"usuario_atlas":"ciclo-checkmig","db":"admin","identificador":"proceso.ciclo-checkmig"}]`. `connectionStatus` identifica al proceso; nadie lo declara a mano. |
| `CICLO_V2_AUTORIZACION_JSON` | `{"politica":"checkmig-colombia-obligatoriedad@1","autorizada_por":"<persona>","autorizada_en":"<ISO>","vence_en":"<ISO ≤ 90 días>"}`. **Habilita la política automática.** Sin esta variable, o vencida, el ciclo lee y compara, pero solo informa. |

**Identidad registrada:**

- **Aplicación (H3.3):** auditoría `comando_administrativo` con `usuario_atlas` y `db` reales de
  `connectionStatus`.
- **Aprobación:** el contrato exige un actor humano. Es `autorizada_por`, con
  `identidad_operador { metodo: "politica_automatica", politica, autorizada_en, vence_en,
  proceso, usuario_atlas, db_autenticacion }`. Así queda a la vista que la aprobación sale de la
  política vigente y qué proceso la ejecutó.
- **Decisión pendiente:** si preferís un aprobador `sistema` bajo política, hace falta cambiar
  el contrato de transiciones. Esa decisión es tuya.

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

## Paso a la ejecución real

1. **Ficha como fuente, formulario como enlace.** El ciclo lee la ficha
   (`https://www.migracioncolombia.gov.co/tramites-y-servicios/aplicativos/checkmig`). El `link`
   del requisito sigue siendo el formulario (`https://apps.migracioncolombia.gov.co/check-mig/`).
   Hay que corregir a mano el registro publicado, porque excede la política:
   - `fuente` → la ficha;
   - `descripcion`, sin afirmar obligatoriedad, por ejemplo: «Prerregistro migratorio digital,
     de uso no obligatorio; se completa entre 72 h y 1 h antes del vuelo de entrada o salida.»;
   - `obligatorio: "no"`.

   Después, `--simular` contra el registro corregido debe dar `sin_cambio`.
2. **Prechequeo e índice transversal en Atlas**, según `docs/indice-transversal.md` y
   `docs/operacion-indice-v2.md`. Sin el índice, `--ejecutar` se detiene en el prechequeo.
3. **Usuario de Atlas del proceso** y configuración en Render (tabla de arriba).
4. **Primera ejecución manual sin `CICLO_V2_AUTORIZACION_JSON`:** solo informa. Se espera
   `sin_cambio` tras el paso 1.
5. **Autorizar la política** (`CICLO_V2_AUTORIZACION_JSON`) y **activar la tarea diaria**:

```
Render Cron Job  ·  comando: node scripts/ciclo-checkmig-v2.js --ejecutar
                 ·  directorio: backend  ·  programación: 0 11 * * *  (08:00 Montevideo)
```

Render marca como fallida toda salida distinta de 0, así que los códigos 2, 3 y 4 avisan que
hay algo pendiente.

## Acciones que necesitan tu autorización (no ejecutadas)

1. **Push del commit:** `git push origin main`.
2. **Corrección humana del Check-Mig publicado** (paso 1): decidir el texto y el método (panel o
   corrección manual revisada), y luego verificar con `node scripts/ciclo-checkmig-v2.js --simular`
   sobre el registro corregido.
3. **Prechequeo de solo lectura en Atlas:**
   `MONGODB_PRECHEQUEO_URI=<uri de lectura> node scripts/prechequear-indice-transversal-lectura.js --solo-lectura --salida <ruta privada>`
4. **Plan y creación del índice transversal:**
   - `node scripts/generar-plan-indice-transversal.js --informe <ruta> --simulacion <evidencia> --carpeta <carpeta nueva> --host <host SRV>`
   - `MONGODB_INDICE_OPERADOR_URI=<uri de mathias-operador> node scripts/crear-indice-transversal.js --plan <ruta> --confirmo <sha256> --salida <comprobante nuevo>`
5. **Crear el usuario de Atlas `ciclo-checkmig`** con `readWrite@buscador_requisitos`, en la UI
   de Atlas o con `atlas dbusers create readWrite@buscador_requisitos --username ciclo-checkmig`.
6. **Configurar en Render** `MONGODB_URI_CICLO` y `OPERADORES_AUTORIZADOS_JSON` para el Cron Job.
7. **Primera ejecución real sin política** (solo informa): `node scripts/ciclo-checkmig-v2.js --ejecutar`.
8. **Habilitar la política:** `CICLO_V2_AUTORIZACION_JSON` en Render, con la persona, la fecha y el
   vencimiento.
9. **Desplegar y activar el Cron Job** en Render (programación de arriba).
