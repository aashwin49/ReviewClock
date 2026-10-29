const mongoose = require('mongoose');

// Mongo's unique _id makes increments atomic across worker processes.
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  sequence: { type: Number, default: 0 }
}, { versionKey: false });

module.exports = mongoose.model('Counter', counterSchema);
