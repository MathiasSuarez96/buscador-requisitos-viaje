const Destino = require('../models/Destino.model');
const ReglaGeneral = require('../models/ReglaGeneral.model');

const getDestinos = async (req, res) => {
  try {
    const destinos = await Destino.find().sort({ pais: 1 });
    res.json(destinos);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener los destinos' });
  }
};

const getDestinoPorCodigo = async (req, res) => {
  try {
    const codigo = req.params.codigo.toUpperCase();
    const destino = await Destino.findOne({ codigo_iso: codigo });
    if (!destino) {
      return res.status(404).json({ error: 'Destino no encontrado' });
    }
    const reglaGeneral = await ReglaGeneral.findById('permiso_menor_uruguay');
    res.json({ ...destino.toObject(), regla_general: reglaGeneral });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener el destino' });
  }
};

module.exports = { getDestinos, getDestinoPorCodigo };
