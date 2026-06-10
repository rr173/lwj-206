const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, '..', 'data', 'timeline.db');

let db;

function uuidv4() {
  return crypto.randomUUID();
}

async function getDb() {
  if (!db) {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const SQL = await initSqlJs();
    if (fs.existsSync(DB_PATH)) {
      const data = fs.readFileSync(DB_PATH);
      db = new SQL.Database(data);
    } else {
      db = new SQL.Database();
    }
    initSchema();
    seedDemoIfEmpty();
    saveDb();
    setInterval(saveDb, 5000);

    process.on('SIGINT', () => { saveDb(); process.exit(0); });
    process.on('SIGTERM', () => { saveDb(); process.exit(0); });
    process.on('exit', () => { saveDb(); });
  }
  return { db, uuidv4 };
}

function saveDb() {
  if (!db) return;
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH + '.tmp', buffer);
    fs.renameSync(DB_PATH + '.tmp', DB_PATH);
  } catch (e) {
    console.error('save db error:', e);
  }
}

function initSchema() {
  db.run(`
    CREATE TABLE IF NOT EXISTS incidents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      severity TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      owner_id TEXT,
      room_code TEXT UNIQUE NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS participants (
      id TEXT PRIMARY KEY,
      incident_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      joined_at TEXT DEFAULT (datetime('now')),
      UNIQUE(incident_id, user_name)
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS timeline_nodes (
      id TEXT PRIMARY KEY,
      incident_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      description TEXT NOT NULL,
      source_type TEXT NOT NULL,
      service_name TEXT NOT NULL,
      created_by TEXT NOT NULL,
      is_locked INTEGER NOT NULL DEFAULT 0,
      is_excluded INTEGER NOT NULL DEFAULT 0,
      sequence INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS duplicate_markers (
      id TEXT PRIMARY KEY,
      incident_id TEXT NOT NULL,
      node_id_a TEXT NOT NULL,
      node_id_b TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'suspected',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS causal_links (
      id TEXT PRIMARY KEY,
      incident_id TEXT NOT NULL,
      from_node_id TEXT NOT NULL,
      to_node_id TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(from_node_id, to_node_id)
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS operation_logs (
      id TEXT PRIMARY KEY,
      incident_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      detail TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS sync_buffer (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS incident_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source_incident_id TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS template_nodes (
      id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL,
      offset_seconds INTEGER NOT NULL,
      source_type TEXT NOT NULL,
      service_name TEXT NOT NULL,
      description_template TEXT NOT NULL,
      sequence INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS incident_reviews (
      id TEXT PRIMARY KEY,
      incident_id TEXT NOT NULL UNIQUE,
      response_speed INTEGER NOT NULL,
      collaboration INTEGER NOT NULL,
      root_cause_accuracy INTEGER NOT NULL,
      improvement_suggestions TEXT,
      summary TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

function rowToObject(row, columns) {
  const obj = {};
  columns.forEach((c, i) => { obj[c] = row[i]; });
  return obj;
}

function runQuery(db, sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const result = { rows: [], columns: [] };
  while (stmt.step()) {
    result.rows.push(stmt.getAsObject());
  }
  stmt.free();
  return result.rows;
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
  saveDb();
}

function seedDemoIfEmpty() {
  const count = runQuery(db, 'SELECT COUNT(*) as c FROM incidents')[0].c;
  if (count > 0) return;

  const incidentId = uuidv4();
  const roomCode = 'DEMO-P1-2026';
  const baseTime = '2026-06-10T14:00:00';

  runExec(db, `
    INSERT INTO incidents (id, title, severity, start_time, end_time, status, owner_id, room_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [incidentId, '支付服务大规模超时事故', 'P1', baseTime, '2026-06-10T14:45:00', 'open', 'alice', roomCode]);

  const participants = [
    { name: 'alice', role: 'owner' },
    { name: 'bob', role: 'member' },
    { name: 'carol', role: 'member' }
  ];
  for (const p of participants) {
    runExec(db, `INSERT INTO participants (id, incident_id, user_name, role) VALUES (?, ?, ?, ?)`,
      [uuidv4(), incidentId, p.name, p.role]);
  }

  const nodes = [
    { id: uuidv4(), time: '2026-06-10T14:00:00', desc: '支付网关响应时间从50ms飙升至2000ms', src: 'monitor', svc: 'payment-gateway', by: 'alice' },
    { id: uuidv4(), time: '2026-06-10T14:00:05', desc: '网关日志出现大量connection timeout错误', src: 'log', svc: 'payment-gateway', by: 'bob' },
    { id: uuidv4(), time: '2026-06-10T14:02:30', desc: '数据库连接池耗尽，等待连接数超过100', src: 'log', svc: 'order-db', by: 'carol' },
    { id: uuidv4(), time: '2026-06-10T14:02:35', desc: 'DBA在群里报告主库CPU达到95%', src: 'chat', svc: 'order-db', by: 'bob' },
    { id: uuidv4(), time: '2026-06-10T14:05:00', desc: '订单服务开始返回503错误', src: 'monitor', svc: 'order-service', by: 'alice' },
    { id: uuidv4(), time: '2026-06-10T14:05:15', desc: '订单服务日志显示下游支付调用失败', src: 'log', svc: 'order-service', by: 'carol' },
    { id: uuidv4(), time: '2026-06-10T14:08:00', desc: '开始执行数据库主从切换', src: 'manual', svc: 'order-db', by: 'carol' },
    { id: uuidv4(), time: '2026-06-10T14:10:00', desc: '主从切换完成，新主库上线', src: 'manual', svc: 'order-db', by: 'carol' },
    { id: uuidv4(), time: '2026-06-10T14:12:00', desc: '支付网关响应时间开始下降至200ms', src: 'monitor', svc: 'payment-gateway', by: 'alice' },
    { id: uuidv4(), time: '2026-06-10T14:15:00', desc: '订单服务错误率恢复至0.1%以下', src: 'monitor', svc: 'order-service', by: 'bob' },
    { id: uuidv4(), time: '2026-06-10T14:20:00', desc: '全链路指标恢复正常，确认故障解除', src: 'manual', svc: 'payment-gateway', by: 'alice' },
    { id: uuidv4(), time: '2026-06-10T14:25:00', desc: '事后复盘会议开始', src: 'chat', svc: 'order-service', by: 'bob' }
  ];

  const nodeIds = [];
  nodes.forEach((n, i) => {
    runExec(db, `
      INSERT INTO timeline_nodes (id, incident_id, occurred_at, description, source_type, service_name, created_by, sequence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [n.id, incidentId, n.time, n.desc, n.src, n.svc, n.by, i]);
    nodeIds.push(n.id);
  });

  runExec(db, `INSERT INTO duplicate_markers (id, incident_id, node_id_a, node_id_b, status) VALUES (?, ?, ?, ?, ?)`,
    [uuidv4(), incidentId, nodeIds[0], nodeIds[1], 'suspected']);
  runExec(db, `INSERT INTO duplicate_markers (id, incident_id, node_id_a, node_id_b, status) VALUES (?, ?, ?, ?, ?)`,
    [uuidv4(), incidentId, nodeIds[2], nodeIds[3], 'suspected']);

  runExec(db, `INSERT INTO causal_links (id, incident_id, from_node_id, to_node_id, created_by) VALUES (?, ?, ?, ?, ?)`,
    [uuidv4(), incidentId, nodeIds[2], nodeIds[4], 'alice']);
  runExec(db, `INSERT INTO causal_links (id, incident_id, from_node_id, to_node_id, created_by) VALUES (?, ?, ?, ?, ?)`,
    [uuidv4(), incidentId, nodeIds[4], nodeIds[9], 'bob']);
  runExec(db, `INSERT INTO causal_links (id, incident_id, from_node_id, to_node_id, created_by) VALUES (?, ?, ?, ?, ?)`,
    [uuidv4(), incidentId, nodeIds[0], nodeIds[4], 'alice']);
}

module.exports = { getDb, saveDb, runQuery, runExec };
