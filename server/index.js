const express = require('express')
const app=express()

//Tells Express to read incoming JSON payloads from GitHub
app.use(express.json());

app.get('/', (req, res) => {
  res.send('ReviewClock server is running!');
});

app.post('/webhook', (req,res)=>{
    console.log('Webhook arrived from GitHub!');
    console.log('Headers:', req.headers);
    console.log('Body:', req.body);

// Send a 202 status back so GitHub knows we received it successfully
res.status(202).send('Accepted');
});

app.listen(3000, ()=>{
    console.log('Test server is running on http://localhost:3000');
});