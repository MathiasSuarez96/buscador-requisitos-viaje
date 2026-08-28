const express = require('express');
const router = express.Router();
const { getDestinos, getDestinoPorCodigo } = require('../controllers/destinos.controller');

router.get('/', getDestinos);
router.get('/:codigo', getDestinoPorCodigo);

module.exports = router;
