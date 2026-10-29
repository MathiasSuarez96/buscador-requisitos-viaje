# Operación controlada del índice transversal

Estado: código local pendiente de revisión, sin ejecución de estos ejecutores en Atlas.
No implica push, apertura del registro 2.0 ni cambios de permisos.

## Archivos y trazabilidad

- `scripts/generar-plan-indice-transversal.js`: genera un bundle local sin conectarse.
- `scripts/crear-indice-transversal.js`: operación explícita de creación.
- `scripts/revertir-indice-transversal.js`: operación separada de reversión.
- `scripts/lib/operacion-indice-transversal.js`: controles compartidos.
- `scripts/test-operacion-indice-transversal.js`: prueba autenticada en Mongo efímero 8.0.32.
- `scripts/test-mutaciones-operacion-indice.js`: mutaciones de los controles, solo en procesos hijos.
- `scripts/test-cli-indice-transversal.js`: cuerpos fuente de los tres CLI en procesos
  hijos, sustituyendo la biblioteca delegada para forzar éxito, aborto, fallo e incierto.
  Comprueba argumentos y exit codes; no se presenta como prueba de bootstrap nativo
  del CLI con la biblioteca real y un checkout Git independiente.
- `scripts/test-mutaciones-cli-indice.js`: modifica copias **en disco** de los CLI para
  comprobar que las pruebas detectan la eliminación de exit 1 en sus resultados/errores.

`capturarCodigo()` exige árbol limpio y registra HEAD más SHA-256 de los blobs Git
de los archivos operativos, sus dependencias locales relevantes, el test y el lockfile.
Compara esos blobs con las fuentes locales normalizando exclusivamente CRLF/LF.
El ejecutor exige el mismo commit y huellas; no basta con que HEAD sea descendiente.
Por eso el bundle real se genera DESPUÉS del commit y se regenera si cambia el código.

El informe v1 real se conserva como evidencia de una foto, con su hash validado,
sin atribuirle retroactivamente un commit ni una versión de servidor que no registró.
El ejecutor hace un prechequeo nuevo y lee buildInfo antes de escribir.

## Hash y bundle

La confirmación de creación es SHA-256 de los bytes UTF-8 exactos de `plan.json`,
incluyendo su salto final. No hay campo autoexcluido ni serialización implícita.
El orden y los espacios afectan al hash; el orden de la clave del índice además
se valida explícitamente contra SPEC.

El JSON contiene el host SRV de destino (sin credenciales), los argumentos de creación y reversión, el inventario completo,
la captura de activas esperada, vencimiento, identidad, controles y huellas de código.
Vincula por SHA de bytes `informe-base.json` y `simulacion.json`; la evidencia de
simulación debe identificar el mismo código y script versionado. No contiene URI.
El hash comprueba integridad, no es firma digital ni autorización por sí mismo.

No hay comandos para copiar desde Markdown. El ejecutor SOLO consume los argumentos
del JSON hasheado y reconstruye el contrato permitido. `LEEME.txt` y `hashes.json`
son informativos; no hacen falta para ejecutar ni pueden ampliar el alcance.

## Preparación local (sin Atlas)

1. Commit limpio con todos los archivos operativos.
2. Ejecutar el test con `--evidencia RUTA_NUEVA_PRIVADA` y preload-solo-loopback.
   La evidencia se guarda solo tras pasar el recorrido completo; no se usa el
   fixture interno del test como evidencia real.
3. Generar bundle con `--informe RUTA --simulacion EVIDENCIA --carpeta CARPETA_NUEVA --host HOST_SRV`.
4. Revisar código/bundle. No usar la cuenta read para crear índices.

El generador actual exige un informe con el índice en estado `crear`: **no permite
generar un plan nuevo cuando el índice ya existe**. Tampoco hay, por lo tanto, un
plan nuevo de reversión para un índice ya creado; ver «Reversión separada».

Los CLI sin argumentos solo muestran ayuda. No cargan `.env` ni usan la URI de la app.

## Creación, solo tras confirmación explícita

- URI exclusiva mediante `MONGODB_INDICE_OPERADOR_URI` solo en esa sesión.
- Usuario exacto `mathias-operador`, autenticado en `admin`, único rol `readWrite`
  sobre `buscador_requisitos`, y privilegios efectivos find/listIndexes/createIndex.
  Se rechazan tanto la cuenta read como `buscador-backend-app`.
- Plan vigente: 24 horas desde su generación. No se acepta fecha futura ni plan alterado.
- El comprobante se reserva con open `wx` real ANTES del cliente: verifica permisos
  efectivos del SO y no sobrescribe. Se escribe una marca inicial durable por descriptor.
- Antes del cliente, host SRV y base de la URI deben coincidir con el plan.
  La base devuelta por el cliente también se comprueba, sin sustituirla silenciosamente.
- Se registra buildInfo; esta versión acepta solo servidores 8.x con versión numérica válida.
  La versión real de Atlas no se da por conocida a partir de la del efímero.
- Prechequeo nuevo: inventario completo y activas iguales a la foto, cero inválidas o duplicadas.
  Se comparan índices por nombre, preservando el orden de sus claves.
- Control adicional de documentos: huella EJSON estricta antes/después, sin guardar sus contenidos.
  Límite de 10 000 documentos; si se supera, se detiene antes de escribir.
- Antes del envío se actualiza el comprobante por el descriptor ya reservado, con fsync:
  identidad del código, `version_servidor`, `indices_antes`, `prechequeo_hash` y estado
  `envio_autorizado_resultado_no_confirmado`. Si esa escritura falla, se aborta sin enviar
  (`comprobante_intermedio_no_escribible`). Aplica igual al dropIndexes de la reversión.
- A lo sumo 60 segundos entre la nueva foto y el envío; el plan tampoco puede vencer.
- Una sola llamada createIndex, sin retry de escritura. No hay transacción ni bucle de reintento.
- Monitor limitado a lecturas/metadata y una creación de la colección/definición exactas.
  El acceso no se amplía por argumentos de consola. No se afirma que el monitor sustituya
  los permisos: mathias-operador conserva su capacidad readWrite y debe usarse solo con
  el ejecutor revisado. No ejecutarlo con preloads desconocidos.
- Relectura: anteriores idénticos más el índice nuevo con forma exacta; documentos iguales.
  Cambios de terceros durante la operación también pueden hacer fallar esa comprobación.

## Comprobante y resultado incierto

El comprobante registra plan/hash, commit/huellas, versión, identidad comprobada,
comandos, inventarios y huellas de documentos. Tiene hash propio sobre JSON compacto
sin `comprobante_hash`, y permanece fuera del repo. No se guardan mensajes crudos del driver.
`codigo` conserva siempre commit y huellas, también en aborto, fallo e incierto.
`codigo_resultado` es otro campo y guarda la causa principal segura del resultado.
Un fallo adicional al cerrar el cliente o en la comprobación final del monitor va en
`codigo_cierre` y no reemplaza la causa principal; si no había causa previa, el cierre
fallido pasa a ser también la causa principal. Un cierre fallido nunca deja un resultado
como `confirmado` ni como `fallo_confirmado_sin_cambio_de_indices`.
El SHA es un control de integridad, no una firma: no autentica a quien redactó el archivo.

Un corte después de enviar createIndexes/dropIndexes queda como incierto. No se
reintenta ni se elimina nada automáticamente. Una respuesta semántica del servidor
(por ejemplo E11000) solo se llama fallo confirmado si una relectura muestra el
inventario anterior intacto. Si esa lectura falla, permanece incierto.
Una marca `iniciado_no_concluyente` que queda por caída del proceso tampoco significa aborto.
Si el proceso muere después del envío, el comprobante queda con el estado intermedio
`envio_autorizado_resultado_no_confirmado`: no afirma éxito ni fallo, y el índice puede existir.

En cualquier resultado incierto (incluido el estado intermedio sin comprobante final):
detenerse y **hacer una lectura independiente con cuenta read antes de decidir** cualquier
paso. Ni el comprobante ni este ejecutor sustituyen esa lectura.
Si falla la escritura final del comprobante, el CLI
devuelve error y no afirma éxito, aunque el índice pueda existir.

## Reversión separada

Requiere hash de creación más SHA-256(bytes_plan + byte NUL + `reversion`), comprobante
de creación exitoso con hash íntegro y confirmación del operador de que no hay servicios
desplegados dependientes. Esa dependencia de despliegues NO puede verificarla este script.
La reversión también exige código/plan vigentes, identidad, privilegio dropIndex,
índice de forma exacta y resto del inventario sin cambios. Borra por nombre uno solo,
relee el inventario completo y conserva documentos. Nunca se llama desde el catch de creación.

**Límite explícito: reversión de puesta en servicio, no reversión permanente.**
No funciona después de vencer el plan de 24 horas, si cambiaron las activas o si no
hay comprobante de creación confirmado. En particular, **este ejecutor sigue sin
soportar** la reversión después de 24 horas, con propuestas activas modificadas o tras
un resultado incierto (que nunca produce comprobante `confirmado`); y como el generador
no admite un índice ya existente, tampoco se puede obtener un plan nuevo para hacerlo.
Antes de autorizar la creación el operador
debe aceptar este alcance. Fuera de él se necesita diseñar y revisar un plan de
reversión independiente; no se recomienda improvisar comandos manuales ni falsear
el estado de un comprobante. Una creación incierta requiere primero lectura independiente.

## Fuentes de compatibilidad y límites de esta evidencia

Documentación consultada el 27/10/2026:
- https://www.mongodb.com/docs/manual/reference/method/db.collection.createindex/
  declara createIndex compatible con todos los clústeres Atlas y admite unique + filtro parcial $in.
- https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/
  excluye rolling index builds en Free; esta operación es una creación ordinaria.

Esto es evidencia documental, no constatación de la versión, capacidad o permisos del
clúster concreto. Antes de ejecutar siguen pendientes la revisión, la confirmación del
hash, los permisos efectivos y el acceso de red. No se modifican reglas de red ni usuarios.
La opción C está registrada en indice-transversal.md; no cambia el registrador publicado.
