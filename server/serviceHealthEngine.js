const { runQuery, runExec } = require('./db');

const SEVERITY_SCORES = { P0: 20, P1: 12, P2: 6, P3: 2 };
const MTBF_THRESHOLD_DAYS = 7;
const RECOVERY_THRESHOLD_MINUTES = 60;
const MTBF_PENALTY = 15;
const RECOVERY_PENALTY = 10;

function calculateHealthScore(stats) {
  let score = 100;

  score -= stats.p0_count * SEVERITY_SCORES.P0;
  score -= stats.p1_count * SEVERITY_SCORES.P1;
  score -= stats.p2_count * SEVERITY_SCORES.P2;
  score -= stats.p3_count * SEVERITY_SCORES.P3;

  if (stats.avg_mtbf_days !== null && stats.avg_mtbf_days !== undefined && stats.avg_mtbf_days < MTBF_THRESHOLD_DAYS) {
    score -= MTBF_PENALTY;
  }

  if (stats.avg_recovery_minutes !== null && stats.avg_recovery_minutes !== undefined && stats.avg_recovery_minutes > RECOVERY_THRESHOLD_MINUTES) {
    score -= RECOVERY_PENALTY;
  }

  return Math.max(0, score);
}

function getServiceStats(db, serviceName) {
  const links = runQuery(db, `
    SELECT sil.*, i.start_time, i.end_time, i.severity, i.status
    FROM service_incident_links sil
    JOIN incidents i ON sil.incident_id = i.id
    WHERE sil.service_name = ? AND i.status = 'closed'
    ORDER BY i.start_time ASC
  `, [serviceName]);

  if (links.length === 0) {
    return {
      total_incidents: 0,
      p0_count: 0, p1_count: 0, p2_count: 0, p3_count: 0,
      avg_mtbf_days: null,
      avg_recovery_minutes: null,
      last_incident_time: null
    };
  }

  const stats = {
    total_incidents: links.length,
    p0_count: 0, p1_count: 0, p2_count: 0, p3_count: 0,
    avg_mtbf_days: null,
    avg_recovery_minutes: null,
    last_incident_time: links[links.length - 1].start_time
  };

  const recoveryTimes = [];
  const incidentTimes = [];

  for (const link of links) {
    const sev = link.severity || 'P3';
    if (stats[sev.toLowerCase() + '_count'] !== undefined) {
      stats[sev.toLowerCase() + '_count']++;
    } else {
      stats.p3_count++;
    }

    if (link.recovery_minutes !== null && link.recovery_minutes !== undefined) {
      recoveryTimes.push(link.recovery_minutes);
    } else if (link.first_seen_at && link.incident_closed_at) {
      const diffMs = new Date(link.incident_closed_at).getTime() - new Date(link.first_seen_at).getTime();
      if (diffMs > 0) {
        recoveryTimes.push(diffMs / 60000);
      }
    }

    if (link.start_time) {
      incidentTimes.push(new Date(link.start_time).getTime());
    }
  }

  if (recoveryTimes.length > 0) {
    stats.avg_recovery_minutes = recoveryTimes.reduce((a, b) => a + b, 0) / recoveryTimes.length;
  }

  if (incidentTimes.length >= 2) {
    const intervals = [];
    for (let i = 1; i < incidentTimes.length; i++) {
      const diffDays = (incidentTimes[i] - incidentTimes[i - 1]) / 86400000;
      if (diffDays > 0) intervals.push(diffDays);
    }
    if (intervals.length > 0) {
      stats.avg_mtbf_days = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    }
  }

  return stats;
}

function updateServiceHealth(db, serviceName) {
  const stats = getServiceStats(db, serviceName);
  const healthScore = calculateHealthScore(stats);

  runExec(db, `
    INSERT INTO service_health (service_name, health_score, total_incidents, p0_count, p1_count, p2_count, p3_count, avg_mtbf_days, avg_recovery_minutes, last_incident_time, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(service_name) DO UPDATE SET
      health_score = excluded.health_score,
      total_incidents = excluded.total_incidents,
      p0_count = excluded.p0_count,
      p1_count = excluded.p1_count,
      p2_count = excluded.p2_count,
      p3_count = excluded.p3_count,
      avg_mtbf_days = excluded.avg_mtbf_days,
      avg_recovery_minutes = excluded.avg_recovery_minutes,
      last_incident_time = excluded.last_incident_time,
      updated_at = datetime('now')
  `, [
    serviceName, healthScore,
    stats.total_incidents, stats.p0_count, stats.p1_count, stats.p2_count, stats.p3_count,
    stats.avg_mtbf_days, stats.avg_recovery_minutes, stats.last_incident_time
  ]);

  return { service_name: serviceName, health_score: healthScore, ...stats };
}

function processIncidentServices(db, incidentId) {
  const incident = runQuery(db, 'SELECT * FROM incidents WHERE id = ?', [incidentId])[0];
  if (!incident) return [];

  const nodes = runQuery(db, `
    SELECT DISTINCT service_name, MIN(occurred_at) as first_seen_at
    FROM timeline_nodes
    WHERE incident_id = ? AND is_excluded = 0
    GROUP BY service_name
  `, [incidentId]);

  if (nodes.length === 0) return [];

  const closedAt = incident.status === 'closed' ? (incident.end_time || incident.updated_at) : null;

  const serviceNames = [];
  for (const node of nodes) {
    const recoveryMinutes = closedAt && node.first_seen_at
      ? Math.max(0, (new Date(closedAt).getTime() - new Date(node.first_seen_at).getTime()) / 60000)
      : null;

    runExec(db, `
      INSERT INTO service_incident_links (service_name, incident_id, severity, first_seen_at, incident_closed_at, recovery_minutes)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(service_name, incident_id) DO UPDATE SET
        severity = excluded.severity,
        first_seen_at = excluded.first_seen_at,
        incident_closed_at = excluded.incident_closed_at,
        recovery_minutes = excluded.recovery_minutes
    `, [node.service_name, incidentId, incident.severity, node.first_seen_at, closedAt, recoveryMinutes]);

    serviceNames.push(node.service_name);
  }

  for (let i = 0; i < serviceNames.length; i++) {
    for (let j = i + 1; j < serviceNames.length; j++) {
      const a = serviceNames[i];
      const b = serviceNames[j];
      const [s1, s2] = a < b ? [a, b] : [b, a];
      runExec(db, `
        INSERT INTO service_cooccurrences (service_a, service_b, cooccurrence_count, last_cooccurrence)
        VALUES (?, ?, 1, datetime('now'))
        ON CONFLICT(service_a, service_b) DO UPDATE SET
          cooccurrence_count = cooccurrence_count + 1,
          last_cooccurrence = datetime('now')
      `, [s1, s2]);
    }
  }

  const results = [];
  for (const svc of serviceNames) {
    results.push(updateServiceHealth(db, svc));
  }

  return results;
}

function recalculateAllServices(db) {
  const services = runQuery(db, 'SELECT DISTINCT service_name FROM service_incident_links');
  const results = [];
  for (const s of services) {
    results.push(updateServiceHealth(db, s.service_name));
  }
  return results;
}

function getTopServices(db, limit = 50) {
  return runQuery(db, `
    SELECT * FROM service_health
    ORDER BY total_incidents DESC, health_score ASC
    LIMIT ?
  `, [limit]);
}

function getServiceCooccurrences(db, serviceNames) {
  if (!serviceNames || serviceNames.length === 0) return [];
  const placeholders = serviceNames.map(() => '?').join(',');
  return runQuery(db, `
    SELECT * FROM service_cooccurrences
    WHERE service_a IN (${placeholders}) AND service_b IN (${placeholders})
  `, [...serviceNames, ...serviceNames]);
}

function getServiceIncidents(db, serviceName, limit = 10) {
  return runQuery(db, `
    SELECT i.id, i.title, i.severity, i.start_time, i.end_time, i.status
    FROM service_incident_links sil
    JOIN incidents i ON sil.incident_id = i.id
    WHERE sil.service_name = ?
    ORDER BY i.start_time DESC
    LIMIT ?
  `, [serviceName, limit]);
}

function getServiceMonthlyTrend(db, serviceName, months = 6) {
  return runQuery(db, `
    SELECT
      strftime('%Y-%m', i.start_time) as month,
      COUNT(DISTINCT i.id) as count
    FROM service_incident_links sil
    JOIN incidents i ON sil.incident_id = i.id
    WHERE sil.service_name = ?
      AND i.start_time >= date('now', '-${months} months')
    GROUP BY strftime('%Y-%m', i.start_time)
    ORDER BY month ASC
  `, [serviceName]);
}

function getAllServiceNetworkData(db) {
  const topServices = getTopServices(db, 50);
  const serviceNames = topServices.map(s => s.service_name);
  const cooccurrences = getServiceCooccurrences(db, serviceNames);

  const nodes = topServices.map(s => ({
    id: s.service_name,
    name: s.service_name,
    health_score: s.health_score,
    total_incidents: s.total_incidents,
    p0_count: s.p0_count,
    p1_count: s.p1_count,
    p2_count: s.p2_count,
    p3_count: s.p3_count,
    avg_mtbf_days: s.avg_mtbf_days,
    avg_recovery_minutes: s.avg_recovery_minutes,
    last_incident_time: s.last_incident_time
  }));

  const edges = cooccurrences.map(c => ({
    source: c.service_a,
    target: c.service_b,
    weight: c.cooccurrence_count
  })).filter(e => serviceNames.includes(e.source) && serviceNames.includes(e.target));

  return { nodes, edges };
}

module.exports = {
  calculateHealthScore,
  getServiceStats,
  updateServiceHealth,
  processIncidentServices,
  recalculateAllServices,
  getTopServices,
  getServiceCooccurrences,
  getServiceIncidents,
  getServiceMonthlyTrend,
  getAllServiceNetworkData,
  SEVERITY_SCORES,
  MTBF_THRESHOLD_DAYS,
  RECOVERY_THRESHOLD_MINUTES,
  MTBF_PENALTY,
  RECOVERY_PENALTY
};
