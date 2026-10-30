const crypto = require('crypto');
const { isSupportedPullRequestEvent, validatePullRequestPayload } = require('./logic/webhookValidation');

function createGitHubWebhookHandler({ Source, Delivery, processNextDelivery }) {
  return async function receiveGitHubWebhook(req, res, next) {
    try {
      const source = await Source.findOne({ endpointId: req.params.endpointId }).select('+endpointId +webhookSecret');
      if (!source) return res.status(404).send('Unknown webhook endpoint');

      const signature = req.get('x-hub-signature-256') || '';
      const supplied = /^sha256=([a-f0-9]{64})$/i.exec(signature);
      const expected = crypto.createHmac('sha256', source.webhookSecret).update(req.rawBody || Buffer.alloc(0)).digest();
      const actual = supplied ? Buffer.from(supplied[1], 'hex') : Buffer.alloc(0);
      if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
        return res.status(401).send('Unauthorized: Invalid signature');
      }

      const deliveryId = req.get('x-github-delivery');
      const event = req.get('x-github-event');
      if (!deliveryId || !event) return res.status(400).send('Missing GitHub delivery headers');

      if (event === 'ping') {
        await Source.updateOne({ _id: source._id }, { $set: { status: 'connected', lastDeliveryAt: new Date() } });
        return res.status(202).send('Ping accepted');
      }

      if (!isSupportedPullRequestEvent(event)) {
        await Source.updateOne({ _id: source._id }, { $set: { lastDeliveryAt: new Date() } });
        return res.status(202).send(`Ignored unsupported event: ${event}`);
      }

      const payloadError = validatePullRequestPayload(event, req.body);
      if (payloadError) return res.status(400).send(payloadError);

      let inserted = false;
      try {
        await Delivery.create({ sourceId: String(source._id), deliveryID: deliveryId, event, rawPayload: req.body });
        inserted = true;
      } catch (error) {
        if (error.code !== 11000) throw error;
        console.info(`Duplicate GitHub delivery ignored: ${deliveryId}`);
      }
      await Source.updateOne({ _id: source._id }, { $set: { lastDeliveryAt: new Date() } });
      if (inserted) setImmediate(() => processNextDelivery().catch(error => console.error('Could not process webhook delivery:', error.message)));
      return res.status(202).send('Accepted');
    } catch (error) { return next(error); }
  };
}

module.exports = { createGitHubWebhookHandler };
