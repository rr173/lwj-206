const { WebSocketServer } = require('ws');
const { runQuery } = require('./db');

function setupWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    ws.incidentId = null;
    ws.userName = null;
    ws.lastSyncId = 0;

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'join') {
          ws.incidentId = msg.incidentId;
          ws.userName = msg.userName;
          broadcast(ws.incidentId, {
            type: 'user_online',
            userName: ws.userName,
            incidentId: ws.incidentId
          });
        } else if (msg.type === 'sync_request') {
          sendMissedEvents(ws);
        }
      } catch (e) {
        console.error('ws message error:', e);
      }
    });

    ws.on('close', () => {
      if (ws.incidentId && ws.userName) {
        broadcast(ws.incidentId, {
          type: 'user_offline',
          userName: ws.userName,
          incidentId: ws.incidentId
        });
      }
    });
  });

  function broadcast(incidentId, msg) {
    const payload = JSON.stringify(msg);
    wss.clients.forEach(client => {
      if (client.readyState === 1 && client.incidentId === incidentId) {
        client.send(payload);
      }
    });
  }

  wss.broadcast = broadcast;

  function sendMissedEvents(ws) {
    if (!ws.incidentId) return;
    try {
      const events = runQuery(
        'SELECT * FROM sync_buffer WHERE incident_id = ? AND id > ? ORDER BY id ASC',
        [ws.incidentId, ws.lastSyncId]
      );
      if (events.length > 0) {
        for (const ev of events) {
          ws.send(JSON.stringify({
            type: ev.event_type,
            payload: JSON.parse(ev.payload),
            syncId: ev.id
          }));
        }
        ws.lastSyncId = events[events.length - 1].id;
      }
    } catch (e) {
      console.error('sendMissedEvents error:', e);
    }
  }

  return wss;
}

module.exports = setupWebSocket;
