const mongoose = require('mongoose');

const requisitoSchema = new mongoose.Schema({
  tipo: {
    type: String,
    required: true,
    enum: ['visa', 'formulario_digital', 'vacuna', 'validez_pasaporte',
           'documentacion_menor', 'tasa_aeropuerto', 'seguro_medico']
  },
  nombre: { type: String },
  obligatorio: { type: Boolean, required: true },
  descripcion: { type: String, required: true },
  fuente: { type: String, required: true },
  link: { type: String },
  plazo_antes_del_vuelo: { type: String },
  costo: { type: String },
  fecha_verificacion: { type: Date, required: true },
  estado: {
    type: String,
    required: true,
    enum: ['confirmado', 'verificar']
  }
}, { _id: false });

const destinoSchema = new mongoose.Schema({
  pais: { type: String, required: true, unique: true },
  codigo_iso: { type: String, required: true, unique: true },
  requisitos: [requisitoSchema]
}, { timestamps: true });

module.exports = mongoose.model('Destino', destinoSchema);
