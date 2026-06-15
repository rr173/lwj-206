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
    if (!globalThis.__timelineDb) globalThis.__timelineDb = {};
    globalThis.__timelineDb.db = db;
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
  db.run(`
    CREATE TABLE IF NOT EXISTS incident_signatures (
      id TEXT PRIMARY KEY,
      incident_id TEXT NOT NULL UNIQUE,
      services TEXT NOT NULL,
      source_type_dist TEXT NOT NULL,
      causal_depth INTEGER NOT NULL DEFAULT 0,
      causal_width INTEGER NOT NULL DEFAULT 0,
      time_span_seconds INTEGER NOT NULL DEFAULT 0,
      keywords TEXT NOT NULL,
      root_cause_desc TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS recommendation_markers (
      id TEXT PRIMARY KEY,
      incident_id TEXT NOT NULL,
      recommended_incident_id TEXT NOT NULL,
      marked_by TEXT NOT NULL,
      mark_type TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(incident_id, recommended_incident_id, marked_by)
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS service_health (
      service_name TEXT PRIMARY KEY,
      health_score INTEGER NOT NULL DEFAULT 100,
      total_incidents INTEGER NOT NULL DEFAULT 0,
      p0_count INTEGER NOT NULL DEFAULT 0,
      p1_count INTEGER NOT NULL DEFAULT 0,
      p2_count INTEGER NOT NULL DEFAULT 0,
      p3_count INTEGER NOT NULL DEFAULT 0,
      avg_mtbf_days REAL,
      avg_recovery_minutes REAL,
      last_incident_time TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS service_incident_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_name TEXT NOT NULL,
      incident_id TEXT NOT NULL,
      severity TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      incident_closed_at TEXT,
      recovery_minutes REAL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(service_name, incident_id)
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS service_cooccurrences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_a TEXT NOT NULL,
      service_b TEXT NOT NULL,
      cooccurrence_count INTEGER NOT NULL DEFAULT 1,
      last_cooccurrence TEXT DEFAULT (datetime('now')),
      UNIQUE(service_a, service_b)
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS oncall_plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      services TEXT NOT NULL,
      start_date TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS oncall_plan_members (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      position INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(plan_id, user_name),
      UNIQUE(plan_id, position)
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS oncall_swaps (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      original_user TEXT NOT NULL,
      substitute_user TEXT NOT NULL,
      shift_date TEXT NOT NULL,
      shift_index INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS oncall_dispatches (
      id TEXT PRIMARY KEY,
      incident_id TEXT NOT NULL,
      service_name TEXT NOT NULL,
      user_name TEXT NOT NULL,
      dispatched_at TEXT NOT NULL,
      dispatch_type TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS sla_rules (
      id TEXT PRIMARY KEY,
      severity TEXT NOT NULL UNIQUE,
      first_response_minutes INTEGER NOT NULL,
      escalation_minutes INTEGER NOT NULL,
      closure_minutes INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS sla_violations (
      id TEXT PRIMARY KEY,
      incident_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      threshold_minutes INTEGER NOT NULL,
      breached_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(incident_id, stage)
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      user_name TEXT NOT NULL,
      service_name TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_name, service_name)
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_name TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      incident_id TEXT NOT NULL,
      service_name TEXT NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  try {
    const colsResult = db.exec("PRAGMA table_info(incidents)");
    const cols = colsResult && colsResult.length > 0 ? colsResult[0].values.map(r => r[1]) : [];
    if (!cols.includes('sla_violated')) {
      db.run(`ALTER TABLE incidents ADD COLUMN sla_violated INTEGER NOT NULL DEFAULT 0`);
    }
  } catch (e) {
    console.warn('check sla_violated column skipped:', e.message);
  }
}

function rowToObject(row, columns) {
  const obj = {};
  columns.forEach((c, i) => { obj[c] = row[i]; });
  return obj;
}

function runQuery(dbOrSql, sqlOrParams, maybeParams) {
  let db, sql, params;
  if (typeof dbOrSql === 'string') {
    db = (globalThis.__timelineDb || { db: null }).db;
    sql = dbOrSql;
    params = sqlOrParams || [];
  } else {
    db = dbOrSql;
    sql = sqlOrParams;
    params = maybeParams || [];
  }
  if (!db) throw new Error('DB not initialized');
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const result = { rows: [], columns: [] };
  while (stmt.step()) {
    result.rows.push(stmt.getAsObject());
  }
  stmt.free();
  return result.rows;
}

function runExec(dbOrSql, sqlOrParams, maybeParams) {
  let db, sql, params;
  if (typeof dbOrSql === 'string') {
    db = (globalThis.__timelineDb || { db: null }).db;
    sql = dbOrSql;
    params = sqlOrParams || [];
  } else {
    db = dbOrSql;
    sql = sqlOrParams;
    params = maybeParams || [];
  }
  if (!db) throw new Error('DB not initialized');
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

function seedDefaultSlaRules() {
  const existing = runQuery(db, 'SELECT COUNT(*) as c FROM sla_rules')[0].c;
  if (existing > 0) return;
  const defaults = [
    { severity: 'P0', firstResponse: 5, escalation: 30, closure: 120 },
    { severity: 'P1', firstResponse: 10, escalation: 60, closure: 240 },
    { severity: 'P2', firstResponse: 30, escalation: 120, closure: 480 },
    { severity: 'P3', firstResponse: 60, escalation: 240, closure: 1440 }
  ];
  for (const r of defaults) {
    runExec(db, `
      INSERT INTO sla_rules (id, severity, first_response_minutes, escalation_minutes, closure_minutes)
      VALUES (?, ?, ?, ?, ?)
    `, [uuidv4(), r.severity, r.firstResponse, r.escalation, r.closure]);
  }
}

function seedDemoIfEmpty() {
  const { seedDemoOncallData } = require('./oncallEngine');
  seedDefaultSlaRules();
  const count = runQuery(db, 'SELECT COUNT(*) as c FROM incidents')[0].c;
  if (count > 0) {
    try {
      seedDemoOncallData(db, uuidv4);
    } catch (e) {
      console.error('seed oncall demo data error:', e);
    }
    return;
  }

  const incidentId = uuidv4();
  const roomCode = 'DEMO-P1-2026';
  const baseTime = '2026-06-10T14:00:00';

  runExec(db, `
    INSERT INTO incidents (id, title, severity, start_time, end_time, status, owner_id, room_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [incidentId, '支付服务大规模超时事故', 'P1', baseTime, '2026-06-10T14:45:00', 'closed', 'alice', roomCode]);

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

  const incident2Id = uuidv4();
  const roomCode2 = 'DEMO-P2-2026';
  runExec(db, `
    INSERT INTO incidents (id, title, severity, start_time, end_time, status, owner_id, room_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [incident2Id, '数据库主从同步延迟导致读取旧数据', 'P2', '2026-06-11T09:00:00', '2026-06-11T09:30:00', 'closed', 'carol', roomCode2]);

  const nodes2 = [
    { id: uuidv4(), time: '2026-06-11T09:00:00', desc: '订单列表出现重复数据', src: 'monitor', svc: 'order-service', by: 'alice' },
    { id: uuidv4(), time: '2026-06-11T09:02:00', desc: '从库同步延迟超过30秒', src: 'monitor', svc: 'order-db', by: 'carol' },
    { id: uuidv4(), time: '2026-06-11T09:05:00', desc: '切换读流量到主库', src: 'manual', svc: 'order-db', by: 'carol' },
    { id: uuidv4(), time: '2026-06-11T09:15:00', desc: '数据一致性恢复正常', src: 'monitor', svc: 'order-service', by: 'bob' },
    { id: uuidv4(), time: '2026-06-11T09:30:00', desc: '问题确认解决', src: 'manual', svc: 'order-db', by: 'carol' }
  ];
  nodes2.forEach((n, i) => {
    runExec(db, `
      INSERT INTO timeline_nodes (id, incident_id, occurred_at, description, source_type, service_name, created_by, sequence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [n.id, incident2Id, n.time, n.desc, n.src, n.svc, n.by, i]);
  });

  const incident3Id = uuidv4();
  const roomCode3 = 'DEMO-P0-SLA';
  const now = new Date();
  const createdTime = new Date(now.getTime() - 48 * 60 * 60 * 1000);
  const createdStr = createdTime.toISOString();
  const startTimeStr = createdTime.toISOString();

  runExec(db, `
    INSERT INTO incidents (id, title, severity, start_time, end_time, status, owner_id, room_code, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [incident3Id, '[演示] 用户登录服务P0级全面故障（SLA违规演示）', 'P0', startTimeStr, null, 'open', 'alice', roomCode3, createdStr]);

  runExec(db, `INSERT INTO participants (id, incident_id, user_name, role) VALUES (?, ?, ?, 'owner')`,
    [uuidv4(), incident3Id, 'alice']);
  runExec(db, `INSERT INTO participants (id, incident_id, user_name, role) VALUES (?, ?, ?, 'member')`,
    [uuidv4(), incident3Id, 'bob']);

  const node3_1 = uuidv4();
  runExec(db, `
    INSERT INTO timeline_nodes (id, incident_id, occurred_at, description, source_type, service_name, created_by, sequence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [node3_1, incident3Id, startTimeStr, '全国各地用户反馈无法登录，错误率100%', 'monitor', 'auth-service', 'alice', 0]);

  const node3_2 = uuidv4();
  runExec(db, `
    INSERT INTO timeline_nodes (id, incident_id, occurred_at, description, source_type, service_name, created_by, sequence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [node3_2, incident3Id, new Date(createdTime.getTime() + 2 * 60 * 1000).toISOString(),
    'Redis认证集群连接数异常飙升，达到连接上限', 'log', 'auth-redis', 'bob', 1]);

  try {
    seedDemoOncallData(db, uuidv4);
  } catch (e) {
    console.error('seed oncall demo data error:', e);
  }

  try {
    seedDemoSubscriptionsAndNotifications(db, uuidv4);
  } catch (e) {
    console.error('seed subscriptions and notifications demo data error:', e);
  }
}

function seedDemoSubscriptionsAndNotifications(db, uuidv4) {
  const subCount = runQuery(db, 'SELECT COUNT(*) as c FROM subscriptions')[0].c;
  if (subCount > 0) return;

  const demoSubscriptions = [
    { userName: 'alice', services: ['payment-gateway', 'order-service', 'auth-service'] },
    { userName: 'bob', services: ['order-db', 'auth-redis', 'order-service'] },
    { userName: 'carol', services: ['payment-gateway', 'order-db', 'auth-service', 'auth-redis'] }
  ];

  for (const sub of demoSubscriptions) {
    for (const service of sub.services) {
      runExec(db, `
        INSERT INTO subscriptions (id, user_name, service_name)
        VALUES (?, ?, ?)
      `, [uuidv4(), sub.userName, service]);
    }
  }

  const notifCount = runQuery(db, 'SELECT COUNT(*) as c FROM notifications')[0].c;
  if (notifCount > 0) return;

  const now = new Date();
  const demoNotifications = [
    {
      userName: 'alice',
      title: '新事故：支付服务大规模超时事故',
      body: 'P1级事故已创建，涉及服务：payment-gateway',
      incidentId: 'demo-incident-1',
      serviceName: 'payment-gateway',
      isRead: 0,
      offsetMinutes: 120
    },
    {
      userName: 'alice',
      title: '事故更新：订单服务开始返回503错误',
      body: '事故「支付服务大规模超时事故」有新的节点更新',
      incidentId: 'demo-incident-1',
      serviceName: 'order-service',
      isRead: 0,
      offsetMinutes: 110
    },
    {
      userName: 'bob',
      title: '新事故：数据库主从同步延迟导致读取旧数据',
      body: 'P2级事故已创建，涉及服务：order-db',
      incidentId: 'demo-incident-2',
      serviceName: 'order-db',
      isRead: 1,
      offsetMinutes: 90
    },
    {
      userName: 'carol',
      title: '新事故：[演示] 用户登录服务P0级全面故障',
      body: 'P0级事故已创建，涉及服务：auth-service',
      incidentId: 'demo-incident-3',
      serviceName: 'auth-service',
      isRead: 1,
      offsetMinutes: 60
    },
    {
      userName: 'carol',
      title: '事故更新：Redis认证集群连接数异常飙升',
      body: '事故「用户登录服务P0级全面故障」有新的节点更新',
      incidentId: 'demo-incident-3',
      serviceName: 'auth-redis',
      isRead: 1,
      offsetMinutes: 45
    }
  ];

  const incidents = runQuery(db, 'SELECT id, title FROM incidents ORDER BY created_at ASC');
  const incidentMap = {};
  incidents.forEach((inc, idx) => {
    incidentMap[`demo-incident-${idx + 1}`] = inc;
  });

  for (const notif of demoNotifications) {
    const incident = incidentMap[notif.incidentId];
    if (!incident) continue;

    const createdAt = new Date(now.getTime() - notif.offsetMinutes * 60 * 1000).toISOString();
    runExec(db, `
      INSERT INTO notifications (id, user_name, title, body, incident_id, service_name, is_read, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [uuidv4(), notif.userName, notif.title, notif.body, incident.id, notif.serviceName, notif.isRead, createdAt]);
  }
}

module.exports = { getDb, saveDb, runQuery, runExec };
