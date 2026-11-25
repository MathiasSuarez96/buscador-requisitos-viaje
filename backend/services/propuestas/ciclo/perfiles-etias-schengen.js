/**
 * Lote ETIAS: el requisito «ETIAS (Schengen)» (formulario_digital) de los seis destinos Schengen del
 * catálogo que lo publican (AT, HR, FI, FR, IT, PT). Hoy figura 'verificar', con Wikipedia como fuente
 * y una fecha estimada que la fuente oficial no da.
 *
 * Fuente: página ETIAS de la Comisión Europea (comision-europea-etias.js). Respalda que el ETIAS NO
 * está en funcionamiento y no se reciben solicitudes, y que la fecha de inicio se anunciará con meses
 * de antelación. El hecho vale igual para todos los destinos y nacionalidades: no se deduce nada del
 * país ni de la ausencia de un dato. Si la página anuncia el inicio, una fecha o la obligatoriedad, la
 * lectura queda ambigua y el caso va a revisión humana (no se publica).
 *
 * Cada perfil migra la procedencia del requisito COMPLETO (perfil-procedencia.js): obligatorio 'no',
 * descripción de redacción propia, fuente oficial y estado 'confirmado'. Es la única ampliación del
 * contrato del perfil: admite un requisito en 'verificar' y lo confirma (estados_admitidos). La fecha
 * se fija al aplicar, sobre un requisito cuyos campos publicados respalda todos la fuente; si tiene
 * link, costo, plazo o recomendado, va a revisión.
 *
 * Política única comision-europea-etias-uy@1 para los seis (mismo requisito, misma fuente, mismo hecho):
 * no habilita ningún otro requisito ni destino.
 */
const { crearPerfilProcedencia } = require('./perfil-procedencia');
const adaptador = require('../adaptadores/v2/comision-europea-etias');
const { URL_PAGINA } = require('../fuentes/comision-europea-etias');

const NOMBRE_REQUISITO = 'ETIAS (Schengen)';
const DESTINOS = Object.freeze(['AT', 'HR', 'FI', 'FR', 'IT', 'PT']);

// Pura. Descripción canónica (también la usan las pruebas).
// La afirmación queda atada a la fecha de verificación del requisito (no lleva la fecha en el texto:
// así la repetición no cambia la descripción). No es una exención permanente ni da fecha de inicio.
const descripcionEtias = h => `A la fecha de verificación indicada, según la Comisión Europea, el ETIAS todavía no está en funcionamiento y no recibe solicitudes, por lo que no había que tramitarlo. No es una exención permanente: el ETIAS es un requisito previsto para los viajeros exentos de visa en estadías cortas (hasta ${h.estancia_corta.dias} días en cualquier período de ${h.estancia_corta.periodo_dias} días), y la Unión Europea anunciará la fecha de inicio con varios meses de antelación. Para viajes futuros, consultar la información oficial actualizada.`;

const PERFILES_ETIAS = Object.freeze(DESTINOS.map(iso => crearPerfilProcedencia({
  nombre: `comision-etias-${iso.toLowerCase()}`,
  politica: { nombre: 'comision-europea-etias-uy', version: '1' },
  adaptador,
  destino: { codigo_iso: iso },
  requisito: { tipo: 'formulario_digital', nombre: NOMBRE_REQUISITO },
  contexto_viajero: { nacionalidad: 'cualquiera (el sistema no funciona para nadie)', documento: 'pasaporte', motivo: 'estadía corta', duracion: 'hasta 90 días en 180 (según la fuente)' },
  campo_evidencia: 'etias',
  estados_admitidos: ['verificar', 'confirmado'],
  canonico: h => ({ obligatorio: 'no', descripcion: descripcionEtias(h), fuente: URL_PAGINA, estado: 'confirmado' })
})));

module.exports = { PERFILES_ETIAS, DESTINOS, NOMBRE_REQUISITO, descripcionEtias };
