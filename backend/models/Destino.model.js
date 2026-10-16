const mongoose = require('mongoose');
const { TIPOS_REQUISITO } = require('../services/propuestas/contrato-requisito-v2');

const requisitoSchema = new mongoose.Schema({
  tipo: {
    type: String,
    required: true,
    enum: TIPOS_REQUISITO
  },
  nombre: { type: String },
  obligatorio: { type: String, required: true, enum: ['si', 'no', 'verificar'] },
  recomendado: {
    type: String,
    enum: ['si', 'no', 'verificar'],
    validate: {
      validator: (valor) => valor !== null,
      message: 'recomendado no admite null; omití el campo si no hay dato'
    }
  },
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
});

requisitoSchema.pre('validate', function() {
  if (this.obligatorio === 'si' && ['si', 'verificar'].includes(this.recomendado)) {
    this.invalidate('recomendado', 'un requisito obligatorio no puede tener una recomendación positiva o pendiente', this.recomendado);
  }
});

const destinoSchema = new mongoose.Schema({
  pais: { type: String, required: true, unique: true },
  codigo_iso: { type: String, required: true, unique: true },
  requisitos: [requisitoSchema]
}, { timestamps: true });

module.exports = mongoose.model('Destino', destinoSchema);
