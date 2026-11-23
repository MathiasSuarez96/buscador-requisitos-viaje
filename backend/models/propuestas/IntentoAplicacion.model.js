/**
 * intentos_aplicacion: cada intento de aplicar una PropuestaCambio,
 * exitoso o no. Cada documento representa un intento YA TERMINADO — no
 * existe un estado "en curso" persistido acá (el arranque de cada
 * intento se registra aparte en inicios_intento_aplicacion, ver
 * InicioIntentoAplicacion.model.js).
 *
 * `_id` es el ObjectId por defecto de Mongo; la identidad de negocio es
 * `intento_id` (UUID), campo propio y único — no un alias de `_id`.
 * El mismo intento_id se usa en inicios_intento_aplicacion, en el
 * intento terminado y en HistorialCambio/EventoPropuesta. Como es
 * único, cada intento tiene A LO SUMO UN resultado terminal registrado.
 *
 * `propuesta_id` referencia el `propuesta_id` (no el `_id`) de
 * PropuestaCambio.
 *
 * CÓMO SE ESCRIBE: ver "PERSISTENCIA DE CADA RESULTADO" en
 * ../../services/propuestas/contrato-propuestas.js. En resumen: exito y
 * los resultados semánticos (con transición de estado) se insertan
 * dentro de la transacción que mueve el estado; los demás, y todo
 * escritura_abortada, como insert independiente fuera de transacción.
 *
 * Roles separados (ver contrato):
 *  - `operador`: el humano que lanzó el intento (evidencia operativa,
 *    no no repudio — ver nota en EventoPropuesta.model.js).
 *  - `proceso_aplicador`: {nombre, version} del proceso que escribe; es
 *    el actor 'sistema' de los eventos que produce este intento.
 *  - el aprobador NO se copia: se referencia por `decision_aprobacion_id`
 *    (evento_id de la aprobación). Puede ser null SOLO en
 *    propuesta_no_aplicable (p. ej. propuesta no aprobada).
 *
 * Otros campos siempre presentes: `hash_contenido_referenciado` (el
 * payload_hash leído), `version_coordinacion_esperada`, `adaptador`
 * ({nombre, version} del adaptador de revalidación) y `evidencia_fresca`
 * (Mixed, aunque sea parcial; nunca un valor inventado).
 *
 * `etapa_fallo` (ETAPAS_POR_RESULTADO): obligatoria en todo resultado
 * salvo exito, donde no se admite.
 *
 * `resultado_no_registrado`: solo en escritura_abortada con etapa
 * transicion_por_fallo — el resultado semántico cuya transacción falló
 * y que por lo tanto NO quedó registrado (ni su intento, ni el cambio de
 * estado, ni el evento).
 *
 * RESULTADO EFECTIVO: el resultado de negocio que describe la evidencia
 * del intento. Es `resultado_no_registrado` en ese caso de
 * escritura_abortada, y `resultado` en cualquier otro. Los campos
 * condicionales siguen al resultado efectivo, así el intento abortado
 * conserva la misma evidencia que habría tenido el resultado semántico:
 *  - `revalidacion` (con revalidacion_id y revalidada_en): obligatoria
 *    si la revalidación externa terminó correctamente con un valor
 *    inequívoco — resultado efectivo en RESULTADOS_CON_REVALIDACION, o
 *    etapa_fallo escritura_aplicacion (a esa etapa solo se llega con la
 *    revalidación terminada). NO se admite en ningún otro caso.
 *    `coincide_con_propuesta` es false solo si el resultado efectivo es
 *    fuente_cambio.
 *  - `precondicion`: valor ESPERADO en Mongo (payload.valor_anterior) —
 *    resultado efectivo exito o valor_actual_cambio.
 *  - `valor_observado`: valor encontrado realmente — solo resultado
 *    efectivo valor_actual_cambio.
 *  - `identidad_esperada_no_coincide`: solo resultado efectivo
 *    identidad_requisito_cambio.
 *  - `historial_id`: solo (y obligatorio en) exito.
 *
 * Defensa contra mutaciones (auxiliar, no garantía — ver nota extendida
 * en EjecucionLectura.model.js): el hook `pre('validate')` bloquea
 * cualquier modificación posterior a la inserción.
 *
 * Política de timestamps: no se usa `{ timestamps: true }` —
 * iniciado_en/finalizado_en ya cubren el ciclo de vida del intento.
 *
 * VERSIONES: sin `version_contrato` el documento es 1.0 y rigen
 * exactamente las reglas de arriba (también para históricos). Con
 * `version_contrato: '2.0'` rigen las reglas 2.0 (validarV2): los campos
 * exclusivos del 1.0 se rechazan, la evidencia sale del payload aprobado
 * (revalidaciones[] ya validadas, conflicto, precondiciones, fecha) y los
 * errores externos solo se guardan como código cerrado. No hay default
 * de versión ni migración.
 */

const mongoose = require('mongoose');
const { validarAuditoria } = require('../../services/propuestas/auditoria-aplicacion');
const { canonicalizarValor } = require('../../services/propuestas/canonicalizacion-propuestas');
const { esFechaCalendario } = require('../../services/propuestas/contrato-requisito-v2');
const crypto = require('crypto');
const {
  RESULTADOS_INTENTO,
  RESULTADOS_CON_TRANSICION,
  ETAPAS_INTENTO,
  ETAPAS_POR_RESULTADO,
  CATEGORIAS_IDENTIDAD_NO_COINCIDE
} = require('../../services/propuestas/contrato-propuestas');

const SHA256_HEX = /^[0-9a-f]{64}$/;

// Resultados efectivos a los que solo se llega con la revalidación
// externa terminada y un valor inequívoco de la fuente.
const RESULTADOS_CON_REVALIDACION = ['exito', 'fuente_cambio', 'valor_actual_cambio', 'identidad_requisito_cambio', 'revalidacion_vencida'];
// Etapas a las que solo se llega con la revalidación terminada correctamente.
const ETAPAS_CON_REVALIDACION = ['escritura_aplicacion'];

const RESULTADOS_CON_PRECONDICION = ['exito', 'valor_actual_cambio'];
const RESULTADOS_CON_VALOR_OBSERVADO = ['valor_actual_cambio'];
const RESULTADOS_CON_IDENTIDAD_ESPERADA = ['identidad_requisito_cambio'];
const RESULTADOS_SIN_DECISION_OBLIGATORIA = ['propuesta_no_aplicable'];

// ---- Contrato 2.0 (solo con version_contrato: '2.0') ----
const VERSIONES_CONTRATO = ['2.0'];
const esV2 = (doc) => doc.version_contrato === '2.0';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NOMBRE_TECNICO = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PROCESO_V2 = Object.freeze({ nombre: 'aplicar-propuesta-v2', version: '1' });
const RESULTADOS_V2 = ['exito', 'valor_actual_cambio', 'identidad_requisito_cambio', 'propuesta_no_aplicable', 'escritura_abortada',
  // H3.3: resultados de la revalidación externa con el adaptador 2.0.
  'fuente_temporalmente_no_disponible', 'extraccion_ambigua', 'fuente_cambio', 'revalidacion_vencida'];
// H3.3: lecturas de la fuente que hizo el orquestador (evidencia para revisión humana).
// Obligatorias en los resultados efectivos que nacen de la lectura; opcionales en una revalidación
// vencida (puede venir de un cambio que no llegó a registrarse a tiempo); prohibidas en el resto.
const RESULTADOS_CON_LECTURAS = ['fuente_temporalmente_no_disponible', 'extraccion_ambigua', 'fuente_cambio'];
const RESULTADOS_LECTURAS_OPCIONALES = ['revalidacion_vencida'];
// Sin revalidación validada contra lo aprobado: la lectura no dio hechos confirmados.
const RESULTADOS_SIN_REVALIDACIONES = ['fuente_temporalmente_no_disponible', 'extraccion_ambigua'];
const TIPOS_LECTURA = ['hechos', 'ambiguo', 'no_disponible'];
const CODIGOS_FALLO_LECTURA = ['red', 'tiempo_agotado', 'http', 'redireccion_fuera_del_sitio', 'redireccion_sin_destino', 'demasiadas_redirecciones', 'no_html', 'cuerpo_ilegible', 'demasiado_grande'];
// Campos y motivos de cada adaptador 2.0 (listas cerradas; ampliarlas no cambia documentos guardados).
//   CheckMig: obligatoriedad, alcance, ventana_horas_antes.   GOV.UK check-uk-visa: resultado, contexto.
const CAMPOS_LECTURA = ['obligatoriedad', 'alcance', 'ventana_horas_antes', 'resultado', 'contexto'];
const MOTIVOS_CAMPO_LECTURA = ['sin_evidencia', 'contradiccion', 'condicionada', 'no_atribuible', 'exclusion', 'fuera_de_dominio',
  'contexto_no_coincide', 'no_reconocido'];
const CATEGORIAS_CONFLICTO_V2 = {
  identidad_requisito_cambio: ['destino_no_encontrado', 'requisito_id_no_encontrado', 'requisito_id_duplicado', 'identidad_semantica_no_coincide'],
  valor_actual_cambio: ['claves_desconocidas', 'valor_no_capturable', 'instantanea_no_coincide']
};
const CODIGOS_ERROR_EXTERNO = ['red', 'clave_duplicada', 'servidor', 'inconsistencia', 'desconocido'];
// Campos que solo existen en una versión: su presencia en la otra es una mezcla.
const CAMPOS_SOLO_V1 = ['evidencia_fresca', 'revalidacion', 'precondicion', 'valor_observado', 'identidad_esperada_no_coincide'];
const CAMPOS_SOLO_V2 = ['identidad_operador', 'aprobacion', 'revalidaciones', 'conflicto', 'precondiciones', 'fecha_verificacion', 'error_externo', 'lecturas_fuente'];
const canonico = (v) => JSON.stringify(canonicalizarValor(v ?? null));
const presenteEn = (doc, campo) => doc.get(campo) !== undefined;

function registraTransicionFallida(doc) {
  return doc.resultado === 'escritura_abortada' && doc.etapa_fallo === 'transicion_por_fallo';
}

function resultadoEfectivo(doc) {
  return registraTransicionFallida(doc) ? doc.resultado_no_registrado : doc.resultado;
}

function exigeRevalidacion(doc) {
  return RESULTADOS_CON_REVALIDACION.includes(resultadoEfectivo(doc)) || ETAPAS_CON_REVALIDACION.includes(doc.etapa_fallo);
}

const valorConPresenciaSchema = new mongoose.Schema(
  {
    presente: { type: Boolean, required: true },
    valor: { type: mongoose.Schema.Types.Mixed, default: null }
  },
  { _id: false }
);

// Humano autenticado por OIDC (panel) o connection_status (comando administrativo).
const operadorSchema = new mongoose.Schema(
  {
    tipo: { type: String, required: true, enum: ['humano'] },
    identificador: { type: String, required: true }
  },
  { _id: false }
);

const nombreVersionSchema = new mongoose.Schema(
  {
    nombre: { type: String, required: true },
    version: { type: String, required: true }
  },
  { _id: false }
);

const revalidacionSchema = new mongoose.Schema(
  {
    // Id propio de esta revalidación puntual — HistorialCambio lo
    // referencia por id en vez de copiar el contenido.
    revalidacion_id: {
      type: String,
      required: true,
      default: () => crypto.randomUUID()
    },
    revalidada_en: { type: Date, required: true },
    fuente_nombre: { type: String, required: true },
    url: { type: String, required: true },
    valor_revalidado: { type: mongoose.Schema.Types.Mixed, required: true },
    coincide_con_propuesta: { type: Boolean, required: true }
  },
  { _id: false }
);

// Subesquemas 2.0 con strict por defecto: con strict 'throw' en un subdocumento, el abort
// de connection.transaction (rollback o reintento) restaura __v y lanza StrictModeError,
// que tapa el error original. Los descartes anidados los detecta la persistencia 2.0
// comparando entrada y documento construido.
const revalidacionV2Schema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    fuente_nombre: { type: String, required: true },
    hechos_hash: { type: String, required: true, match: SHA256_HEX },
    revalidada_en: { type: Date, required: true }
  },
  { _id: false }
);

// H3.3: una lectura de la fuente. Solo códigos cerrados, hashes, fechas y evidencia breve
// (oraciones de la ficha, ≤ 240 caracteres); nunca el HTML ni el error crudo.
const campoSinConfirmarSchema = new mongoose.Schema(
  {
    campo: { type: String, required: true },
    motivo: { type: String, required: true }
  },
  { _id: false }
);
const lecturaFuenteV2Schema = new mongoose.Schema(
  {
    orden: { type: Number, required: true },
    tipo: { type: String, required: true },
    url: { type: String, required: true },
    fuente_nombre: { type: String, required: true },
    consultado_en: { type: Date, required: true },
    revalidada_en: { type: Date },
    hechos_hash: { type: String },
    codigo_fallo: { type: String },
    http_status: { type: Number },
    campos_sin_confirmar: { type: [campoSinConfirmarSchema], default: undefined },
    evidencia: { type: mongoose.Schema.Types.Mixed },
    // Diagnóstico: hash del HTML recibido. Nunca se compara ni decide nada.
    contenido_sha256: { type: String }
  },
  { _id: false, minimize: false }
);

const aprobacionV2Schema = new mongoose.Schema(
  {
    evento_id: { type: String, required: true },
    actor: { type: operadorSchema, required: true },
    identidad_operador: { type: mongoose.Schema.Types.Mixed },
    ocurrido_en: { type: Date }
  },
  { _id: false }
);

const conflictoV2Schema = new mongoose.Schema(
  {
    categoria: { type: String, required: true },
    detalle: { type: mongoose.Schema.Types.Mixed }
  },
  { _id: false, minimize: false }
);

const precondicionV2Schema = new mongoose.Schema(
  {
    codigo: { type: String, required: true, match: /^[a-z0-9_]{1,80}$/ },
    detalle: { type: mongoose.Schema.Types.Mixed }
  },
  { _id: false, minimize: false }
);

const identidadEsperadaSchema = new mongoose.Schema(
  {
    categoria: { type: String, required: true, enum: CATEGORIAS_IDENTIDAD_NO_COINCIDE },
    detalle: { type: mongoose.Schema.Types.Mixed, required: false }
  },
  { _id: false }
);

const intentoAplicacionSchema = new mongoose.Schema(
  {
    intento_id: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      default: () => crypto.randomUUID()
    },

    // Ausente = 1.0 (históricos incluidos). Sin default.
    version_contrato: { type: String, enum: VERSIONES_CONTRATO, immutable: true },

    propuesta_id: { type: String, required: true, immutable: true },

    operador: { type: operadorSchema, required: true, immutable: true },
    // Opcional para documentos históricos; toda escritura del servicio actual lo exige.
    auditoria: { type: mongoose.Schema.Types.Mixed, immutable: true, validate: { validator: v => { validarAuditoria(v); return true; }, message: 'Auditoría inválida.' } },
    proceso_aplicador: { type: nombreVersionSchema, required: true, immutable: true },
    adaptador: { type: nombreVersionSchema, required: true, immutable: true },

    hash_contenido_referenciado: { type: String, required: true, match: SHA256_HEX, immutable: true },
    version_coordinacion_esperada: {
      type: Number,
      required: true,
      min: 0,
      immutable: true,
      validate: { validator: Number.isInteger, message: 'version_coordinacion_esperada debe ser entero.' }
    },
    decision_aprobacion_id: {
      type: String,
      default: null,
      required: function () {
        return !RESULTADOS_SIN_DECISION_OBLIGATORIA.includes(this.resultado);
      },
      immutable: true
    },

    iniciado_en: { type: Date, required: true, immutable: true },
    finalizado_en: { type: Date, required: true, immutable: true },

    resultado: { type: String, required: true, enum: RESULTADOS_INTENTO, immutable: true },
    etapa_fallo: {
      type: String,
      enum: ETAPAS_INTENTO,
      required: function () {
        return this.resultado !== 'exito';
      },
      immutable: true
    },
    resultado_no_registrado: {
      type: String,
      enum: RESULTADOS_CON_TRANSICION,
      required: function () {
        return registraTransicionFallida(this);
      },
      immutable: true
    },
    error_mensaje: {
      type: String,
      required: function () {
        return this.resultado !== 'exito';
      },
      immutable: true
    },

    // Solo 1.0. En 2.0 la evidencia se resume en revalidaciones[] ya validadas.
    evidencia_fresca: { type: mongoose.Schema.Types.Mixed, required: function () { return !esV2(this); }, immutable: true },

    // Revalidación externa contra la fuente ORIGINAL, SIEMPRE hecha
    // antes de abrir cualquier transacción de Mongo (nunca HTTP dentro
    // de una transacción). Condicional: ver exigeRevalidacion().
    revalidacion: {
      type: revalidacionSchema,
      required: function () {
        return !esV2(this) && exigeRevalidacion(this);
      },
      immutable: true
    },

    // Valor ESPERADO (payload.valor_anterior) exigido atómicamente en la escritura.
    precondicion: {
      type: valorConPresenciaSchema,
      required: function () {
        return !esV2(this) && RESULTADOS_CON_PRECONDICION.includes(resultadoEfectivo(this));
      },
      immutable: true
    },

    // Valor realmente encontrado dentro de la transacción cuando no
    // coincidía con `precondicion`.
    valor_observado: {
      type: valorConPresenciaSchema,
      required: function () {
        return !esV2(this) && RESULTADOS_CON_VALOR_OBSERVADO.includes(resultadoEfectivo(this));
      },
      immutable: true
    },

    identidad_esperada_no_coincide: {
      type: identidadEsperadaSchema,
      required: function () {
        return !esV2(this) && RESULTADOS_CON_IDENTIDAD_ESPERADA.includes(resultadoEfectivo(this));
      },
      immutable: true
    },

    // Solo si resultado === "exito".
    historial_id: {
      type: String,
      required: function () {
        return this.resultado === 'exito';
      },
      immutable: true
    },

    // ---- Solo 2.0 (validarV2); prohibidos en 1.0 ----
    identidad_operador: { type: mongoose.Schema.Types.Mixed, immutable: true },
    aprobacion: { type: aprobacionV2Schema, immutable: true },
    // default undefined: sin [] implícito (el rechazo temprano no lleva el campo).
    revalidaciones: { type: [revalidacionV2Schema], default: undefined, immutable: true },
    conflicto: { type: conflictoV2Schema, immutable: true },
    precondiciones: { type: [precondicionV2Schema], default: undefined, immutable: true },
    // Mixed: un path String convertiría un Date a texto local; se valida como string.
    fecha_verificacion: { type: mongoose.Schema.Types.Mixed, immutable: true },
    error_externo: { type: String, enum: CODIGOS_ERROR_EXTERNO, immutable: true },
    lecturas_fuente: { type: [lecturaFuenteV2Schema], default: undefined, immutable: true }
  },
  {
    collection: 'intentos_aplicacion',
    timestamps: false,
    autoIndex: false,
    // Ver nota equivalente en PropuestaCambio.model.js: sin esto,
    // Mongoose borraría en silencio un `evidencia_fresca: {}` al serializar.
    minimize: false
  }
);

intentoAplicacionSchema.pre('validate', function () {
  if (!this.isNew) {
    throw new Error('intentos_aplicacion es append-only: no se puede modificar un intento ya insertado.');
  }

  if (this.resultado === 'exito' && this.etapa_fallo != null) {
    throw new Error('intentos_aplicacion: un intento "exito" no admite etapa_fallo.');
  }
  if (this.resultado !== 'exito' && this.etapa_fallo != null) {
    const permitidas = ETAPAS_POR_RESULTADO[this.resultado] ?? [];
    if (!permitidas.includes(this.etapa_fallo)) {
      throw new Error(
        `intentos_aplicacion: resultado "${this.resultado}" admite etapa_fallo en [${permitidas.join(', ')}] (recibido "${this.etapa_fallo}").`
      );
    }
  }
  if (!registraTransicionFallida(this) && this.resultado_no_registrado != null) {
    throw new Error('intentos_aplicacion: resultado_no_registrado solo se admite en escritura_abortada con etapa transicion_por_fallo.');
  }

  if (this.revalidacion != null && !exigeRevalidacion(this)) {
    throw new Error(
      `intentos_aplicacion: resultado "${this.resultado}" en etapa "${this.etapa_fallo}" no admite revalidacion (la revalidación externa no terminó correctamente).`
    );
  }
  if (this.revalidacion) {
    const debeCoincidir = resultadoEfectivo(this) !== 'fuente_cambio';
    if (this.revalidacion.coincide_con_propuesta !== debeCoincidir) {
      throw new Error(
        `intentos_aplicacion: resultado efectivo "${resultadoEfectivo(this)}" exige revalidacion.coincide_con_propuesta === ${debeCoincidir}.`
      );
    }
  }

  if (this.resultado !== 'exito' && this.historial_id != null) {
    throw new Error('intentos_aplicacion: solo un intento "exito" puede referenciar un historial_id.');
  }
  if (!RESULTADOS_CON_VALOR_OBSERVADO.includes(resultadoEfectivo(this)) && this.valor_observado != null) {
    throw new Error(`intentos_aplicacion: resultado efectivo "${resultadoEfectivo(this)}" no admite valor_observado.`);
  }

  if (esV2(this)) validarV2(this);
  else {
    const mezclados = CAMPOS_SOLO_V2.filter((c) => presenteEn(this, c));
    if (mezclados.length) throw new Error(`intentos_aplicacion: un documento 1.0 no admite campos 2.0 (${mezclados.join(', ')}).`);
  }
});

function falla2(mensaje) {
  throw new Error(`intentos_aplicacion 2.0: ${mensaje}`);
}

function urlHttpsSinCredenciales(valor) {
  try {
    const u = new URL(valor);
    return u.protocol === 'https:' && u.username === '' && u.password === '' && u.href === valor;
  } catch {
    return false;
  }
}

// Reglas 2.0 por resultado y etapa; las reglas comunes ya se aplicaron arriba.
function validarV2(doc) {
  const mezclados = CAMPOS_SOLO_V1.filter((c) => presenteEn(doc, c));
  if (mezclados.length) falla2(`campos exclusivos del 1.0 no admitidos (${mezclados.join(', ')}).`);
  if (!RESULTADOS_V2.includes(doc.resultado)) falla2(`resultado "${doc.resultado}" no admitido.`);
  const efectivo = resultadoEfectivo(doc);

  for (const campo of ['intento_id', 'propuesta_id']) if (!UUID.test(doc[campo] ?? '')) falla2(`${campo} debe ser UUID.`);
  if (doc.decision_aprobacion_id != null && !UUID.test(doc.decision_aprobacion_id)) falla2('decision_aprobacion_id debe ser UUID.');
  if (doc.historial_id != null && !UUID.test(doc.historial_id)) falla2('historial_id debe ser UUID.');
  if (doc.proceso_aplicador?.nombre !== PROCESO_V2.nombre || doc.proceso_aplicador?.version !== PROCESO_V2.version) falla2('proceso_aplicador no es el aplicador 2.0.');
  if (!NOMBRE_TECNICO.test(doc.adaptador?.nombre ?? '') || !NOMBRE_TECNICO.test(doc.adaptador?.version ?? '')) falla2('adaptador debe tener nombre y versión técnicos.');

  // Aplicador: auditoría obligatoria y coherente con operador e identidad.
  if (doc.auditoria == null) falla2('auditoria es obligatoria.');
  if (doc.operador?.identificador !== doc.auditoria.operador) falla2('operador no coincide con la auditoría.');
  if (canonico(doc.identidad_operador) !== canonico(doc.auditoria.identidad)) falla2('identidad_operador no coincide con la auditoría.');

  // Aprobador: separado del aplicador y atado a la decisión salvo en no aplicable.
  if (doc.resultado !== 'propuesta_no_aplicable') {
    if (doc.aprobacion == null) falla2('aprobacion es obligatoria.');
    if (doc.aprobacion.evento_id !== doc.decision_aprobacion_id) falla2('aprobacion.evento_id no coincide con decision_aprobacion_id.');
  }
  if (doc.aprobacion != null && !UUID.test(doc.aprobacion.evento_id)) falla2('aprobacion.evento_id debe ser UUID.');

  // Revalidaciones: solo ya validadas; el rechazo temprano no lleva el campo.
  if (doc.etapa_fallo === 'precondiciones_propuesta') {
    if (doc.revalidaciones !== undefined) falla2('el rechazo de etapa 0 no admite revalidaciones.');
  } else if (RESULTADOS_SIN_REVALIDACIONES.includes(efectivo)) {
    if (doc.revalidaciones !== undefined) falla2(`resultado efectivo "${efectivo}" no admite revalidaciones: la lectura no confirmó hechos.`);
  } else {
    if (!Array.isArray(doc.revalidaciones) || doc.revalidaciones.length === 0) falla2('revalidaciones es obligatoria y no vacía.');
    if (doc.revalidaciones.some((r) => r == null)) falla2('revalidaciones[] no admite elementos vacíos.');
    const urls = doc.revalidaciones.map((r) => r.url);
    if (new Set(urls).size !== urls.length) falla2('revalidaciones con URL repetida.');
    for (const r of doc.revalidaciones) {
      if (!urlHttpsSinCredenciales(r.url)) falla2('revalidaciones[].url debe ser https canónica sin credenciales.');
      if (typeof r.fuente_nombre !== 'string' || r.fuente_nombre.trim() === '' || r.fuente_nombre.length > 200) falla2('revalidaciones[].fuente_nombre inválido.');
    }
  }

  // Conflicto: solo y siempre en los resultados de conflicto, con categoría coherente.
  const categorias = CATEGORIAS_CONFLICTO_V2[efectivo];
  if (categorias) {
    if (doc.conflicto == null) falla2(`resultado efectivo "${efectivo}" exige conflicto.`);
    if (!categorias.includes(doc.conflicto.categoria)) falla2(`categoría "${doc.conflicto.categoria}" incoherente con "${efectivo}".`);
  } else if (presenteEn(doc, 'conflicto')) falla2(`resultado efectivo "${efectivo}" no admite conflicto.`);

  // Precondiciones: obligatorias en el rechazo de etapa 0; solo en propuesta_no_aplicable.
  if (doc.resultado === 'propuesta_no_aplicable') {
    if (doc.etapa_fallo === 'precondiciones_propuesta' && (!Array.isArray(doc.precondiciones) || doc.precondiciones.length === 0)) falla2('el rechazo de etapa 0 exige precondiciones.');
  } else if (presenteEn(doc, 'precondiciones')) falla2(`resultado "${doc.resultado}" no admite precondiciones.`);

  // Fecha: solo en exito, string YYYY-MM-DD de calendario; un Date se rechaza sin convertirlo.
  const fecha = doc.get('fecha_verificacion');
  if (doc.resultado === 'exito') {
    if (typeof fecha !== 'string' || !esFechaCalendario(fecha)) falla2('fecha_verificacion debe ser string YYYY-MM-DD válido.');
  } else if (fecha !== undefined) falla2(`resultado "${doc.resultado}" no admite fecha_verificacion.`);

  // Errores externos: solo un código cerrado, y solo en escritura_abortada.
  if (doc.resultado === 'escritura_abortada') {
    if (doc.error_externo == null) falla2('escritura_abortada exige error_externo.');
  } else if (presenteEn(doc, 'error_externo')) falla2(`resultado "${doc.resultado}" no admite error_externo.`);

  validarLecturasV2(doc, efectivo);
}

// H3.3: lecturas de la fuente, coherentes con el resultado efectivo.
function validarLecturasV2(doc, efectivo) {
  const lecturas = doc.lecturas_fuente;
  if (RESULTADOS_CON_LECTURAS.includes(efectivo)) {
    if (!Array.isArray(lecturas) || lecturas.length === 0) falla2(`resultado efectivo "${efectivo}" exige lecturas_fuente.`);
  } else if (!RESULTADOS_LECTURAS_OPCIONALES.includes(efectivo)) {
    if (lecturas !== undefined) falla2(`resultado efectivo "${efectivo}" no admite lecturas_fuente.`);
    return;
  }
  if (lecturas === undefined) return;
  if (!Array.isArray(lecturas) || lecturas.length === 0 || lecturas.length > 2) falla2('lecturas_fuente admite una o dos lecturas.');
  lecturas.forEach((l, i) => {
    if (l == null) falla2(`lecturas_fuente[${i}] vacía.`);
    if (l.orden !== i + 1) falla2(`lecturas_fuente[${i}].orden debe ser ${i + 1}.`);
    if (!TIPOS_LECTURA.includes(l.tipo)) falla2(`lecturas_fuente[${i}].tipo inválido.`);
    if (!urlHttpsSinCredenciales(l.url)) falla2(`lecturas_fuente[${i}].url debe ser https canónica sin credenciales.`);
    if (typeof l.fuente_nombre !== 'string' || l.fuente_nombre.trim() === '' || l.fuente_nombre.length > 200) falla2(`lecturas_fuente[${i}].fuente_nombre inválido.`);
    if (!(l.consultado_en instanceof Date) || Number.isNaN(l.consultado_en.getTime())) falla2(`lecturas_fuente[${i}].consultado_en inválido.`);
    if (l.contenido_sha256 != null && !SHA256_HEX.test(l.contenido_sha256)) falla2(`lecturas_fuente[${i}].contenido_sha256 inválido.`);
    const conRespuesta = l.tipo !== 'no_disponible';
    if (conRespuesta !== (l.revalidada_en instanceof Date)) falla2(`lecturas_fuente[${i}]: revalidada_en solo y siempre con respuesta de la fuente.`);
    if ((l.tipo === 'hechos') !== (typeof l.hechos_hash === 'string')) falla2(`lecturas_fuente[${i}]: hechos_hash solo y siempre en una lectura con hechos.`);
    if (l.hechos_hash != null && !SHA256_HEX.test(l.hechos_hash)) falla2(`lecturas_fuente[${i}].hechos_hash inválido.`);
    if (l.tipo === 'no_disponible') {
      if (!CODIGOS_FALLO_LECTURA.includes(l.codigo_fallo)) falla2(`lecturas_fuente[${i}].codigo_fallo debe ser un código cerrado.`);
      if (l.http_status != null && !(Number.isInteger(l.http_status) && l.http_status >= 100 && l.http_status <= 599)) falla2(`lecturas_fuente[${i}].http_status inválido.`);
      if (l.evidencia !== undefined || l.campos_sin_confirmar !== undefined) falla2(`lecturas_fuente[${i}]: un fallo de la fuente no tiene evidencia.`);
    } else {
      if (l.codigo_fallo != null || l.http_status != null) falla2(`lecturas_fuente[${i}]: codigo_fallo solo en un fallo de la fuente.`);
      const ev = l.evidencia;
      if (ev === null || typeof ev !== 'object' || Array.isArray(ev) || !Object.keys(ev).every(k => CAMPOS_LECTURA.includes(k))) falla2(`lecturas_fuente[${i}].evidencia debe ser un objeto por campo.`);
      for (const k of Object.keys(ev)) {
        if (!Array.isArray(ev[k]) || ev[k].length > 10 || !ev[k].every(t => typeof t === 'string' && t.length > 0 && t.length <= 240)) falla2(`lecturas_fuente[${i}].evidencia.${k} debe ser una lista breve de textos.`);
      }
    }
    if (l.tipo === 'ambiguo') {
      const c = l.campos_sin_confirmar;
      if (!Array.isArray(c) || c.length === 0) falla2(`lecturas_fuente[${i}]: una lectura ambigua indica qué campo quedó sin confirmar.`);
      if (c.some(x => x == null || !CAMPOS_LECTURA.includes(x.campo) || !MOTIVOS_CAMPO_LECTURA.includes(x.motivo))) falla2(`lecturas_fuente[${i}].campos_sin_confirmar con campo o motivo fuera de la lista cerrada.`);
      if (new Set(c.map(x => x.campo)).size !== c.length) falla2(`lecturas_fuente[${i}].campos_sin_confirmar repite un campo.`);
    } else if (l.campos_sin_confirmar !== undefined) falla2(`lecturas_fuente[${i}]: campos_sin_confirmar solo en una lectura ambigua.`);
  });
  const ultima = lecturas[lecturas.length - 1];
  if (efectivo === 'fuente_temporalmente_no_disponible' && ultima.tipo !== 'no_disponible') falla2('la última lectura debe ser el fallo de la fuente.');
  if (efectivo === 'extraccion_ambigua') {
    const cambioNoConfirmado = lecturas.length === 2 && lecturas.every(l => l.tipo === 'hechos') && lecturas[0].hechos_hash !== lecturas[1].hechos_hash;
    if (ultima.tipo !== 'ambiguo' && !cambioNoConfirmado) falla2('extraccion_ambigua exige una lectura ambigua o dos lecturas con hechos distintos.');
  }
  if (efectivo === 'fuente_cambio') {
    // Solo un cambio confirmado por dos lecturas con los mismos hechos nuevos.
    if (lecturas.length !== 2 || !lecturas.every(l => l.tipo === 'hechos') || lecturas[0].hechos_hash !== lecturas[1].hechos_hash) falla2('fuente_cambio exige dos lecturas con los mismos hechos.');
    if (!Array.isArray(doc.revalidaciones) || doc.revalidaciones.length !== 1 || doc.revalidaciones[0].hechos_hash !== lecturas[0].hechos_hash) falla2('fuente_cambio: revalidaciones debe resumir los hechos nuevos confirmados.');
  }
}

// Integridad: a lo sumo un intento exitoso por propuesta.
intentoAplicacionSchema.index(
  { propuesta_id: 1 },
  { unique: true, partialFilterExpression: { resultado: 'exito' }, name: 'uniq_intento_exitoso_por_propuesta' }
);
// Solo rendimiento.
intentoAplicacionSchema.index({ propuesta_id: 1, finalizado_en: -1 });
intentoAplicacionSchema.index({ resultado: 1, finalizado_en: -1 });

module.exports = mongoose.model('IntentoAplicacion', intentoAplicacionSchema);
module.exports.CODIGOS_ERROR_EXTERNO = CODIGOS_ERROR_EXTERNO;
