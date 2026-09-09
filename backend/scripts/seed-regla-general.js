require('dotenv').config();
const mongoose = require('mongoose');
const ReglaGeneral = require('../models/ReglaGeneral.model');

const doc = {
  _id: 'permiso_menor_uruguay',
  contenido: 'Si el menor viaja sin ambos padres (con uno solo, con tercero, o solo), se requiere Permiso de Menor para viajar al exterior: autorización otorgada por los padres en ejercicio de la patria potestad, por el tutor legal, o mediante autorización judicial. Vigencia: hasta un año. Es posible tramitarlo para más de un viaje, según la voluntad de los padres. Trámite ante la Dirección Nacional de Migración. Costo: 55.70 UI.',
  fuente: 'https://www.gub.uy/tramites/permiso-menor-edad-menor-viaja-sin-padres-acompanado-solo-padre',
  fecha_verificacion: '2026-09-09',
  estado: 'confirmado',
  pendiente_confirmar: ['cantidad_maxima_de_viajes', 'via_consular']
};

async function seed() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Conectado a MongoDB Atlas');

  const result = await ReglaGeneral.updateOne(
    { _id: doc._id },
    { $setOnInsert: doc },
    { upsert: true }
  );

  if (result.upsertedCount > 0) {
    console.log(`Documento "${doc._id}" insertado.`);
  } else {
    console.log(`Documento "${doc._id}" ya existía, no se modificó.`);
  }

  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error('Error al insertar la regla general:', err);
  process.exit(1);
});
