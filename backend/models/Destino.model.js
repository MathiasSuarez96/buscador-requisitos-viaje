const mongoose = require('mongoose');

const requisitoSchema = new mongoose.Schema({
  tipo: {
    type: String,
    required: true,
    enum: ['visa', 'formulario_digital', 'vacuna', 'validez_pasaporte',
           'documentacion_menor', 'tasa_aeropuerto', 'seguro_medico']
  },
  nombre: { type: String },
  obligatorio: { type: String, required: true, enum: ['si', 'no', 'verificar'] },
  descripcion: { type: String, required: true },
  fuente: {
    type: String,
    // Exigido solo si el requisito ya está confirmado. Red de seguridad
    // para futuras ediciones vía .save() (Fase 3) — con updateOne +
    // arrayFilters este validador NO se ejecuta (ver scripts de migración).
    required: function() { return this.estado === 'confirmado'; }
  },
  link: { type: String },
  plazo_antes_del_vuelo: { type: String },
  costo: { type: String },
  fecha_verificacion: {
    type: Date,
    // Misma regla condicional que fuente; misma limitación con updateOne.
    required: function() { return this.estado === 'confirmado'; }
  },
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
