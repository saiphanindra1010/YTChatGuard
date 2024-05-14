const express = require('express');
const path = require('path');

const googleService = require('./src/features/auth.js');

const app = express();
// app.use('/css',express.static(__dirname +'/src/public/'));
app.use(express.static('src/public'));
app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname + '/src/public/index.html'))
);

app.get('/authorize', (request, response) => {
  googleService.getCode(response);
});

app.get('/callback', (req, response) => {
  const { code } = req.query;
  googleService.getTokensWithCode(code);
  response.redirect('/');
});

// app.get('/find-active-chat', (req, res) => {
//   googleService.findActiveChat();
//   res.redirect('/');
// });

app.get('/start',async (req, res) => {
  await googleService.findActiveChat();
  await googleService.startTrackingChat();
  res.redirect('/');
});

app.get('/kill', (req, res) => {
  googleService.stopTrackingChat();
  res.redirect('/');
});

app.get('/check', (req, res) => {
  googleService.insertMessage('AI MOD initiated');
  res.redirect('/');
});

app.listen(3000, function() {
  console.log('app is Ready');
});