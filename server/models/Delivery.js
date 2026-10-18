//This tells MongoDB how to store incoming webhook deliveries and ensures a delivery ID is never saved twice
const mongoose = require('mongoose');

const deliverySchema = new mongoose.Schema({
  sourceId: {type:String, required:true},
  deliveryID:{type:String, required:true},// From 'x-github-delivery' header
  event:{type:String, required: true},// From 'x-github-event' header
  status:{type: String, default: 'received'},
  rawPayload:{type: Object, required:true},
  receivedAt:{type:Date, default: Date.now}
});

// CRITICAL: Unique index prevents duplicate deliveries from being saved twice[cite: 1]
deliverySchema.index({sourceId:1, deliveryID:1}, {unique: true});

module.exports = mongoose.model('Delivery', deliverySchema);