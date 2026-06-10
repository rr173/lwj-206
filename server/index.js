const express = require('express');
const http = require('http');
const path = require('path');
const setupWebSocket = require('./ws');
const createApiRouter = require('./api');
const { getDb } = require('./db');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3033;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const wss = setupWebSocket(server);
app.use('/api', createApiRouter(wss));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

getDb();

server.listen(PORT, () => {
  console.log(`Incident Timeline server running on http://localhost:${PORT}`);
});
