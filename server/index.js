const express = require('express');
const http = require('http');
const path = require('path');
const setupWebSocket = require('./ws');
const createApiRouter = require('./api');
const { getDb, runQuery, runExec } = require('./db');
const serviceHealthEngine = require('./serviceHealthEngine');
const oncallEngine = require('./oncallEngine');

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

getDb().then(({ db, uuidv4 }) => {
  try {
    serviceHealthEngine.initializeServiceHealth(db);
  } catch (e) {
    console.error('initialize service health error:', e);
  }

  try {
    oncallEngine.seedDemoOncallData(db, uuidv4);
  } catch (e) {
    console.error('seed oncall data error:', e);
  }

  setInterval(() => {
    try {
      oncallEngine.checkAndUpgradeIncidents(db, uuidv4, wss);
    } catch (e) {
      console.error('check and upgrade incidents error:', e);
    }
  }, 60 * 1000);
});

server.listen(PORT, () => {
  console.log(`Incident Timeline server running on http://localhost:${PORT}`);
});
