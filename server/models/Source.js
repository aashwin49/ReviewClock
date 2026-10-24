//Source represents a GitHub repository connection managed by that user.
const mongoose = require('mongoose');

const sourceSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  repoFullName: { type: String, required: true, trim: true },
  endpointId: { type: String, required: true, unique: true, select: false },
  webhookSecret: { type: String, required: true, select: false },
  stalledThresholdMinutes: { type: Number, default: 1440, min: 1, max: 43200 },
  status: { type: String, enum: ['waiting', 'connected'], default: 'waiting' },
  lastDeliveryAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});

sourceSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('Source', sourceSchema);
