const mongoose = require('mongoose');

const activitySchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  sequence: { type: Number, required: true },
  type: { type: String, required: true },
  sourceId: { type: String, required: true },
  pullRequest: { type: mongoose.Schema.Types.Mixed, default: null },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });

activitySchema.index({ userId: 1, sequence: 1 }, { unique: true });
module.exports = mongoose.model('Activity', activitySchema);
