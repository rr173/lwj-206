const express = require('express');
const { getDb } = require('./db');

function runQuery(db, sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function runExec(db, sql, params = []) {
  if (params.length === 0) {
    db.run(sql);
  } else {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    stmt.step();
    stmt.free();
  }
}

function createApiRouter(wss) {
  const router = express.Router();

  function broadcast(incidentId, msg) {
    if (!wss) return;
    const payload = JSON.stringify(msg);
    wss.clients.forEach(client => {
      if (client.readyState === 1 && client.incidentId === incidentId) {
        client.send(payload);
      }
    });
  }

  function addLog(db, incidentId, userName, action, targetType, targetId, detail) {
    const crypto = require('crypto');
    runExec(db, `
      INSERT INTO operation_logs (id, incident_id, user_name, action, target_type, target_id, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [crypto.randomUUID(), incidentId, userName, action, targetType, targetId, detail || null]);
  }

  function pushSync(db, incidentId, eventType, payload) {
    runExec(db, `
      INSERT INTO sync_buffer (incident_id, event_type, payload) VALUES (?, ?, ?)
    `, [incidentId, eventType, JSON.stringify(payload)]);
  }

  function isIncidentClosed(db, incidentId) {
    const inc = runQuery(db, 'SELECT status FROM incidents WHERE id = ?', [incidentId])[0];
    return inc && inc.status === 'closed';
  }

  function checkDuplicates(db, incidentId, nodeId) {
    const node = runQuery(db, 'SELECT occurred_at, service_name FROM timeline_nodes WHERE id = ?', [nodeId])[0];
    if (!node) return;
    const ts = new Date(node.occurred_at).getTime();
    const existing = runQuery(db, `
      SELECT id, occurred_at FROM timeline_nodes
      WHERE incident_id = ? AND id != ? AND is_excluded = 0 AND service_name = ?
    `, [incidentId, nodeId, node.service_name]);
    const crypto = require('crypto');
    for (const ex of existing) {
      const exTs = new Date(ex.occurred_at).getTime();
      if (Math.abs(ts - exTs) < 10000) {
        const exists = runQuery(db, `
          SELECT id FROM duplicate_markers
          WHERE incident_id = ? AND ((node_id_a = ? AND node_id_b = ?) OR (node_id_a = ? AND node_id_b = ?))
        `, [incidentId, nodeId, ex.id, ex.id, nodeId]);
        if (exists.length === 0) {
          runExec(db, `
            INSERT INTO duplicate_markers (id, incident_id, node_id_a, node_id_b) VALUES (?, ?, ?, ?)
          `, [crypto.randomUUID(), incidentId, nodeId < ex.id ? nodeId : ex.id, nodeId < ex.id ? ex.id : nodeId]);
        }
      }
    }
  }

  function hasCycle(db, incidentId, fromId, toId) {
    const links = runQuery(db, 'SELECT from_node_id, to_node_id FROM causal_links WHERE incident_id = ?', [incidentId]);
    const adj = {};
    for (const l of links) {
      if (!adj[l.from_node_id]) adj[l.from_node_id] = [];
      adj[l.from_node_id].push(l.to_node_id);
    }
    if (!adj[fromId]) adj[fromId] = [];
    adj[fromId].push(toId);

    const visited = new Set();
    const stack = new Set();
    function dfs(n) {
      if (stack.has(n)) return true;
      if (visited.has(n)) return false;
      visited.add(n);
      stack.add(n);
      for (const next of (adj[n] || [])) {
        if (dfs(next)) return true;
      }
      stack.delete(n);
      return false;
    }
    return dfs(fromId);
  }

  router.use(async (req, res, next) => {
    try {
      const { db: database, uuidv4 } = await getDb();
      req.db = database;
      req.uuidv4 = uuidv4;
      next();
    } catch (e) {
      next(e);
    }
  });

  router.post('/incidents', (req, res) => {
    const { title, severity, startTime, endTime, ownerName } = req.body;
    const db = req.db;
    const crypto = require('crypto');
    if (!title || !severity || !startTime) return res.status(400).json({ error: 'title, severity, startTime required' });
    if (!['P0','P1','P2','P3'].includes(severity)) return res.status(400).json({ error: 'severity must be P0-P3' });
    const id = crypto.randomUUID();
    const roomCode = 'RM-' + Math.random().toString(36).substring(2, 8).toUpperCase();
    runExec(db, `
      INSERT INTO incidents (id, title, severity, start_time, end_time, owner_id, room_code)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [id, title, severity, startTime, endTime || null, ownerName || null, roomCode]);
    if (ownerName) {
      runExec(db, `INSERT INTO participants (id, incident_id, user_name, role) VALUES (?, ?, ?, 'owner')`,
        [crypto.randomUUID(), id, ownerName]);
    }
    const incident = runQuery(db, 'SELECT * FROM incidents WHERE id = ?', [id])[0];
    res.status(201).json(incident);
  });

  router.get('/incidents', (req, res) => {
    const list = runQuery(req.db, 'SELECT * FROM incidents ORDER BY created_at DESC');
    res.json(list);
  });

  router.get('/incidents/:id', (req, res) => {
    const inc = runQuery(req.db, 'SELECT * FROM incidents WHERE id = ?', [req.params.id])[0];
    if (!inc) return res.status(404).json({ error: 'not found' });
    res.json(inc);
  });

  router.put('/incidents/:id/close', (req, res) => {
    const db = req.db;
    runExec(db, "UPDATE incidents SET status = 'closed', updated_at = datetime('now') WHERE id = ?", [req.params.id]);
    addLog(db, req.params.id, req.body.userName || 'system', 'close_incident', 'incident', req.params.id, null);
    broadcast(req.params.id, { type: 'incident_closed', incidentId: req.params.id });
    pushSync(db, req.params.id, 'incident_closed', { incidentId: req.params.id });
    res.json({ ok: true });
  });

  router.get('/incidents/:id/participants', (req, res) => {
    const list = runQuery(req.db, 'SELECT * FROM participants WHERE incident_id = ?', [req.params.id]);
    res.json(list);
  });

  router.post('/incidents/:id/join', (req, res) => {
    const { userName } = req.body;
    const db = req.db;
    const crypto = require('crypto');
    if (!userName) return res.status(400).json({ error: 'userName required' });
    const existing = runQuery(db, 'SELECT * FROM participants WHERE incident_id = ? AND user_name = ?', [req.params.id, userName])[0];
    if (existing) return res.json(existing);
    const id = crypto.randomUUID();
    runExec(db, 'INSERT INTO participants (id, incident_id, user_name) VALUES (?, ?, ?)', [id, req.params.id, userName]);
    addLog(db, req.params.id, userName, 'join', 'participant', id, null);
    broadcast(req.params.id, { type: 'participant_joined', participant: { id, incidentId: req.params.id, userName } });
    pushSync(db, req.params.id, 'participant_joined', { participant: { id, incidentId: req.params.id, userName } });
    res.status(201).json({ id, incidentId: req.params.id, userName, role: 'member' });
  });

  router.get('/incidents/:incidentId/nodes', (req, res) => {
    const nodes = runQuery(req.db, 'SELECT * FROM timeline_nodes WHERE incident_id = ? ORDER BY occurred_at ASC, sequence ASC', [req.params.incidentId]);
    res.json(nodes);
  });

  router.post('/incidents/:incidentId/nodes', (req, res) => {
    const { occurredAt, description, sourceType, serviceName, createdBy } = req.body;
    const db = req.db;
    const crypto = require('crypto');
    if (!occurredAt || !description || !sourceType || !serviceName || !createdBy) {
      return res.status(400).json({ error: 'all fields required' });
    }
    if (!['log','chat','monitor','manual'].includes(sourceType)) {
      return res.status(400).json({ error: 'invalid sourceType' });
    }
    if (isIncidentClosed(db, req.params.incidentId)) {
      return res.status(403).json({ error: 'incident is closed' });
    }
    const nodeCount = runQuery(db, 'SELECT COUNT(*) as c FROM timeline_nodes WHERE incident_id = ? AND is_excluded = 0', [req.params.incidentId])[0].c;
    if (nodeCount >= 500) return res.status(400).json({ error: 'max 500 nodes' });
    const id = crypto.randomUUID();
    const seqRes = runQuery(db, 'SELECT COALESCE(MAX(sequence),0)+1 as s FROM timeline_nodes WHERE incident_id = ?', [req.params.incidentId]);
    const seq = seqRes[0].s;
    runExec(db, `
      INSERT INTO timeline_nodes (id, incident_id, occurred_at, description, source_type, service_name, created_by, sequence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, req.params.incidentId, occurredAt, description, sourceType, serviceName, createdBy, seq]);
    checkDuplicates(db, req.params.incidentId, id);
    const node = runQuery(db, 'SELECT * FROM timeline_nodes WHERE id = ?', [id])[0];
    addLog(db, req.params.incidentId, createdBy, 'add_node', 'node', id, description);
    broadcast(req.params.incidentId, { type: 'node_added', node });
    pushSync(db, req.params.incidentId, 'node_added', { node });
    res.status(201).json(node);
  });

  router.put('/incidents/:incidentId/nodes/:nodeId', (req, res) => {
    const db = req.db;
    if (isIncidentClosed(db, req.params.incidentId)) return res.status(403).json({ error: 'incident is closed' });
    const existing = runQuery(db, 'SELECT * FROM timeline_nodes WHERE id = ? AND incident_id = ?', [req.params.nodeId, req.params.incidentId])[0];
    if (!existing) return res.status(404).json({ error: 'node not found' });
    if (existing.is_locked) {
      const { userName } = req.body;
      const inc = runQuery(db, 'SELECT owner_id FROM incidents WHERE id = ?', [req.params.incidentId])[0];
      if (userName !== existing.created_by && userName !== inc.owner_id) {
        return res.status(403).json({ error: 'node is locked' });
      }
    }
    const { occurredAt, description, sourceType, serviceName } = req.body;
    const newTime = occurredAt || existing.occurred_at;
    const newDesc = description || existing.description;
    const newSrc = sourceType || existing.source_type;
    const newSvc = serviceName || existing.service_name;
    runExec(db, `
      UPDATE timeline_nodes SET occurred_at = ?, description = ?, source_type = ?, service_name = ?, updated_at = datetime('now')
      WHERE id = ?
    `, [newTime, newDesc, newSrc, newSvc, req.params.nodeId]);
    if (occurredAt && occurredAt !== existing.occurred_at) {
      checkDuplicates(db, req.params.incidentId, req.params.nodeId);
    }
    const node = runQuery(db, 'SELECT * FROM timeline_nodes WHERE id = ?', [req.params.nodeId])[0];
    addLog(db, req.params.incidentId, req.body.userName || 'unknown', 'update_node', 'node', req.params.nodeId, newDesc);
    broadcast(req.params.incidentId, { type: 'node_updated', node });
    pushSync(db, req.params.incidentId, 'node_updated', { node });
    res.json(node);
  });

  router.put('/incidents/:incidentId/nodes/:nodeId/lock', (req, res) => {
    const db = req.db;
    const node = runQuery(db, 'SELECT * FROM timeline_nodes WHERE id = ? AND incident_id = ?', [req.params.nodeId, req.params.incidentId])[0];
    if (!node) return res.status(404).json({ error: 'node not found' });
    const { userName } = req.body;
    const inc = runQuery(db, 'SELECT owner_id FROM incidents WHERE id = ?', [req.params.incidentId])[0];
    if (userName !== node.created_by && userName !== inc.owner_id) {
      return res.status(403).json({ error: 'only creator or owner can lock/unlock' });
    }
    const newLock = node.is_locked ? 0 : 1;
    runExec(db, 'UPDATE timeline_nodes SET is_locked = ? WHERE id = ?', [newLock, req.params.nodeId]);
    addLog(db, req.params.incidentId, userName, newLock ? 'lock_node' : 'unlock_node', 'node', req.params.nodeId, null);
    const updatedNode = { ...node, is_locked: newLock };
    broadcast(req.params.incidentId, { type: 'node_updated', node: updatedNode });
    pushSync(db, req.params.incidentId, 'node_updated', { node: updatedNode });
    res.json({ ok: true, is_locked: newLock });
  });

  router.put('/incidents/:incidentId/nodes/:nodeId/exclude', (req, res) => {
    const db = req.db;
    if (isIncidentClosed(db, req.params.incidentId)) return res.status(403).json({ error: 'incident is closed' });
    const node = runQuery(db, 'SELECT * FROM timeline_nodes WHERE id = ? AND incident_id = ?', [req.params.nodeId, req.params.incidentId])[0];
    if (!node) return res.status(404).json({ error: 'node not found' });
    const newExclude = node.is_excluded ? 0 : 1;
    runExec(db, 'UPDATE timeline_nodes SET is_excluded = ? WHERE id = ?', [newExclude, req.params.nodeId]);
    addLog(db, req.params.incidentId, req.body.userName || 'unknown', newExclude ? 'exclude_node' : 'restore_node', 'node', req.params.nodeId, null);
    const updatedNode = { ...node, is_excluded: newExclude };
    broadcast(req.params.incidentId, { type: 'node_updated', node: updatedNode });
    pushSync(db, req.params.incidentId, 'node_updated', { node: updatedNode });
    res.json({ ok: true, is_excluded: newExclude });
  });

  router.get('/incidents/:incidentId/duplicates', (req, res) => {
    const list = runQuery(req.db, 'SELECT * FROM duplicate_markers WHERE incident_id = ?', [req.params.incidentId]);
    res.json(list);
  });

  router.put('/incidents/:incidentId/duplicates/:dupId', (req, res) => {
    const { status } = req.body;
    if (!['suspected','confirmed_distinct','merged'].includes(status)) return res.status(400).json({ error: 'invalid status' });
    runExec(req.db, 'UPDATE duplicate_markers SET status = ? WHERE id = ?', [status, req.params.dupId]);
    const dup = runQuery(req.db, 'SELECT * FROM duplicate_markers WHERE id = ?', [req.params.dupId])[0];
    broadcast(req.params.incidentId, { type: 'duplicate_updated', duplicate: dup });
    pushSync(req.db, req.params.incidentId, 'duplicate_updated', { duplicate: dup });
    res.json(dup);
  });

  router.get('/incidents/:incidentId/causal-links', (req, res) => {
    const list = runQuery(req.db, 'SELECT * FROM causal_links WHERE incident_id = ?', [req.params.incidentId]);
    res.json(list);
  });

  router.post('/incidents/:incidentId/causal-links', (req, res) => {
    const { fromNodeId, toNodeId, createdBy } = req.body;
    const db = req.db;
    const crypto = require('crypto');
    if (!fromNodeId || !toNodeId || !createdBy) return res.status(400).json({ error: 'all fields required' });
    if (isIncidentClosed(db, req.params.incidentId)) return res.status(403).json({ error: 'incident is closed' });
    if (fromNodeId === toNodeId) return res.status(400).json({ error: 'cannot link to self' });
    if (hasCycle(db, req.params.incidentId, fromNodeId, toNodeId)) {
      return res.status(400).json({ error: 'would create a cycle' });
    }
    const id = crypto.randomUUID();
    try {
      runExec(db, `
        INSERT INTO causal_links (id, incident_id, from_node_id, to_node_id, created_by)
        VALUES (?, ?, ?, ?, ?)
      `, [id, req.params.incidentId, fromNodeId, toNodeId, createdBy]);
    } catch (e) {
      if (e.message.includes('UNIQUE') || (e.message && e.message.includes('constraint'))) {
        return res.status(400).json({ error: 'link already exists' });
      }
      throw e;
    }
    const link = runQuery(db, 'SELECT * FROM causal_links WHERE id = ?', [id])[0];
    addLog(db, req.params.incidentId, createdBy, 'add_causal_link', 'causal_link', id, `${fromNodeId} -> ${toNodeId}`);
    broadcast(req.params.incidentId, { type: 'causal_link_added', link });
    pushSync(db, req.params.incidentId, 'causal_link_added', { link });
    res.status(201).json(link);
  });

  router.delete('/incidents/:incidentId/causal-links/:linkId', (req, res) => {
    const db = req.db;
    if (isIncidentClosed(db, req.params.incidentId)) return res.status(403).json({ error: 'incident is closed' });
    runExec(db, 'DELETE FROM causal_links WHERE id = ? AND incident_id = ?', [req.params.linkId, req.params.incidentId]);
    addLog(db, req.params.incidentId, req.body.userName || 'unknown', 'delete_causal_link', 'causal_link', req.params.linkId, null);
    broadcast(req.params.incidentId, { type: 'causal_link_deleted', linkId: req.params.linkId });
    pushSync(db, req.params.incidentId, 'causal_link_deleted', { linkId: req.params.linkId });
    res.json({ ok: true });
  });

  router.get('/incidents/:incidentId/key-path', (req, res) => {
    const db = req.db;
    const links = runQuery(db, 'SELECT from_node_id, to_node_id FROM causal_links WHERE incident_id = ?', [req.params.incidentId]);
    const nodes = runQuery(db, 'SELECT id, occurred_at FROM timeline_nodes WHERE incident_id = ? AND is_excluded = 0', [req.params.incidentId]);
    if (links.length === 0) return res.json({ path: [], length: 0 });

    const adj = {};
    const inDeg = {};
    const nodeSet = new Set(nodes.map(n => n.id));
    for (const n of nodeSet) { adj[n] = []; inDeg[n] = 0; }
    for (const l of links) {
      if (nodeSet.has(l.from_node_id) && nodeSet.has(l.to_node_id)) {
        adj[l.from_node_id].push(l.to_node_id);
        inDeg[l.to_node_id] = (inDeg[l.to_node_id] || 0) + 1;
      }
    }

    const dist = {};
    const parent = {};
    for (const n of nodeSet) { dist[n] = -Infinity; parent[n] = null; }

    const roots = [...nodeSet].filter(n => (inDeg[n] || 0) === 0);
    for (const r of roots) dist[r] = 0;

    const queue = [...roots];
    while (queue.length > 0) {
      const n = queue.shift();
      for (const next of adj[n]) {
        if (dist[n] + 1 > dist[next]) {
          dist[next] = dist[n] + 1;
          parent[next] = n;
        }
        inDeg[next]--;
        if (inDeg[next] === 0) queue.push(next);
      }
    }

    let endNode = null;
    let maxDist = -1;
    for (const n of nodeSet) {
      if (dist[n] > maxDist) { maxDist = dist[n]; endNode = n; }
    }

    const path = [];
    let cur = endNode;
    while (cur !== null) {
      path.unshift(cur);
      cur = parent[cur];
    }

    res.json({ path, length: maxDist + 1 });
  });

  router.get('/incidents/:incidentId/logs', (req, res) => {
    const list = runQuery(req.db, 'SELECT * FROM operation_logs WHERE incident_id = ? ORDER BY created_at DESC LIMIT 100', [req.params.incidentId]);
    res.json(list);
  });

  router.get('/incidents/:incidentId/since', (req, res) => {
    const db = req.db;
    const { lastId } = req.query;
    if (!lastId) {
      const events = runQuery(db, 'SELECT * FROM sync_buffer WHERE incident_id = ? ORDER BY id ASC', [req.params.incidentId]);
      return res.json(events);
    }
    const row = runQuery(db, 'SELECT id FROM sync_buffer WHERE id = ?', [Number(lastId)]);
    if (row.length === 0) return res.json([]);
    const events = runQuery(db, 'SELECT * FROM sync_buffer WHERE incident_id = ? AND id > ? ORDER BY id ASC', [req.params.incidentId, Number(lastId)]);
    res.json(events);
  });

  router.get('/incidents/:incidentId/export', (req, res) => {
    const db = req.db;
    const inc = runQuery(db, 'SELECT * FROM incidents WHERE id = ?', [req.params.incidentId])[0];
    if (!inc) return res.status(404).json({ error: 'not found' });
    const nodes = runQuery(db, 'SELECT * FROM timeline_nodes WHERE incident_id = ? AND is_excluded = 0 ORDER BY occurred_at ASC', [req.params.incidentId]);
    const links = runQuery(db, 'SELECT * FROM causal_links WHERE incident_id = ?', [req.params.incidentId]);
    const dups = runQuery(db, "SELECT * FROM duplicate_markers WHERE incident_id = ? AND status = 'suspected'", [req.params.incidentId]);

    let md = `# 事故复盘报告: ${inc.title}\n\n`;
    md += `- **严重等级**: ${inc.severity}\n`;
    md += `- **起始时间**: ${inc.start_time}\n`;
    md += `- **结束时间**: ${inc.end_time || '未结束'}\n`;
    md += `- **状态**: ${inc.status === 'closed' ? '已关闭' : '进行中'}\n\n`;
    md += `## 事件时间线\n\n`;
    md += `| 时间 | 服务 | 来源 | 描述 |\n`;
    md += `|------|------|------|------|\n`;
    const srcMap = { log: '日志', chat: '聊天', monitor: '监控', manual: '人工标注' };
    for (const n of nodes) {
      md += `| ${n.occurred_at} | ${n.service_name} | ${srcMap[n.source_type] || n.source_type} | ${n.description} |\n`;
    }
    md += `\n## 因果链\n\n`;
    if (links.length > 0) {
      const nodeMap = {};
      for (const n of nodes) nodeMap[n.id] = n;
      for (const l of links) {
        const from = nodeMap[l.from_node_id];
        const to = nodeMap[l.to_node_id];
        md += `- ${from ? from.description : l.from_node_id} → ${to ? to.description : l.to_node_id}\n`;
      }
    } else {
      md += `_无因果链标注_\n`;
    }
    if (dups.length > 0) {
      md += `\n## 疑似重复\n\n`;
      const nodeMap = {};
      for (const n of nodes) nodeMap[n.id] = n;
      for (const d of dups) {
        const a = nodeMap[d.node_id_a];
        const b = nodeMap[d.node_id_b];
        md += `- ${a ? a.description : d.node_id_a} ↔ ${b ? b.description : d.node_id_b}\n`;
      }
    }
    res.type('text/markdown; charset=utf-8');
    res.send(md);
  });

  return router;
}

module.exports = createApiRouter;
