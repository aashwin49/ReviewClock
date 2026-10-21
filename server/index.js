const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
require('dotenv').config();

const Delivery = require('./models/Delivery');

const app=express()

//Connect to MongoDB Atlas
mongoose.connect(process.env.MONGODB_URI)
.then(()=>console.log('Connected to MongoDB Atlas'))
.catch(err => console.error('MongoDB connection error:', err))

//Function verifies that a GitHub webhook request is authentic and has not been modified.
function verifyGitSignature(req){
    const signatureHeader=req.headers['x-hub-signature-256'];
    if(!signatureHeader) return false;

    const secret = process.env.WEBHOOK_SECRET;
    const hmac = crypto.createHmac('sha256', secret);
    const digest = 'sha256='+ hmac.update(req.rawBody).digest('hex');

    const signatureBuffer = Buffer.from(signatureHeader);
    const digestBuffer = Buffer.from(digest);

    if (signatureBuffer.length !== digestBuffer.length) return false;
    return crypto.timingSafeEqual(signatureBuffer, digestBuffer);

}

//Tells Express to read incoming JSON payloads from GitHub
app.use(express.json({
    verify: (req,res, buf) => {
        req.rawBody=buf;
    }
}));


app.get('/', (req, res) => {
  res.send('ReviewClock server is running!');
});

// Webhook ingestion
app.post('/hooks/github/:sourceId', async (req, res) => {
  const { sourceId } = req.params;
  const deliveryId = req.headers['x-github-delivery'];
  const event = req.headers['x-github-event'] || 'unknown';

  if (!verifyGitSignature(req)) {
    console.log('Invalid or missing webhook signature!');
    return res.status(401).send('Unauthorized: Invalid signature');
  }

  try {
    await Delivery.create({
      sourceId,
      deliveryID:deliveryId,
      event,
      rawPayload: req.body
    });

    console.log(`Valid delivery saved: ${deliveryId} (${event})`);

    return res.status(202).send('Accepted');

  } catch (error) {
    if (error.code === 11000) { //Mongodb error 11000 means a unique index was violated
      console.log(`Duplicate delivery ignored: ${deliveryId}`);
      return res.status(202).send('Duplicate delivery accepted and ignored');
    }

    console.error(error);
    return res.status(500).send('Internal Server Error');
  }

});


app.listen(process.env.PORT || 3000, ()=>{
    console.log(`ReviewClock secure server running on port ${process.env.PORT || 3000}`);
});