const mongoose = require('mongoose');

const reglaGeneralSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  contenido: { type: String, required: true },
  fuente: { type: String, required: true },
  fecha_verificacion: { type: String, required: true },
  estado: { type: String, required: true },
  pendiente_confirmar: { type: [String], default: [] }
}, { collection: 'reglas_generales' });

module.exports = mongoose.model('ReglaGeneral', reglaGeneralSchema);
