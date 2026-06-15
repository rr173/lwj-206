const { runQuery, runExec } = require('./db');
const oncallEngine = require('./oncallEngine');

const STAGE_FIRST_RESPONSE = 'first_response';
const STAGE_ESCALATION = 'escalation';
const STAGE_CLOSURE = 'closure';

const STAGE_LABELS = {
  [STAGE_FIRST_RESPONSE]: '首次响应',
  [STAGE_ESCALATION]: '阶段升级',
  [STAGE_CLOSURE]: '关闭时限'
};

function getAllRules(db) {
  return runQuery(db, 'SELECT * FROM sla_rules ORDER BY severity ASC');
}

function getRuleBySeverity(db, severity) {
  return runQuery(db, 'SELECT * FROM sla_rules WHERE severity = ?', [severity])[0] || null;
}

function createRule(db, uuidv4, { severity, firstResponseMinutes, escalationMinutes, closureMinutes }) {
  if (!['P0', 'P1', 'P2', 'P3'].includes(severity)) {
    throw new Error('severity must be P0-P3');
  }
  if (!Number.isInteger(firstResponseMinutes) || firstResponseMinutes <= 0) {
    throw new Error('firstResponseMinutes must be positive integer');
  }
  if (!Number.isInteger(escalationMinutes) || escalationMinutes <= 0) {
    throw new Error('escalationMinutes must be positive integer');
  }
  if (!Number.isInteger(closureMinutes) || closureMinutes <= 0) {
    throw new Error('closureMinutes must be positive integer');
  }
  const existing = getRuleBySeverity(db, severity);
  if (existing) {
    throw new Error(`rule for ${severity} already exists`);
  }
  const id = uuidv4();
  runExec(db, `
    INSERT INTO sla_rules (id, severity, first_response_minutes, escalation_minutes, closure_minutes)
    VALUES (?, ?, ?, ?, ?)
  `, [id, severity, firstResponseMinutes, escalationMinutes, closureMinutes]);
  return getRuleBySeverity(db, severity);
}

function updateRule(db, severity, { firstResponseMinutes, escalationMinutes, closureMinutes }) {
  const existing = getRuleBySeverity(db, severity);
  if (!existing) {
    throw new Error(`rule for ${severity} not found`);
  }
  if (firstResponseMinutes !== undefined) {
    if (!Number.isInteger(firstResponseMinutes) || firstResponseMinutes <= 0) {
      throw new Error('firstResponseMinutes must be positive integer');
    }
  }
  if (escalationMinutes !== undefined) {
    if (!Number.isInteger(escalationMinutes) || escalationMinutes <= 0) {
      throw new Error('escalationMinutes must be positive integer');
    }
  }
  if (closureMinutes !== undefined) {
    if (!Number.isInteger(closureMinutes) || closureMinutes <= 0) {
      throw new Error('closureMinutes must be positive integer');
    }
  }
  const finalFirst = firstResponseMinutes !== undefined ? firstResponseMinutes : existing.first_response_minutes;
  const finalEscalation = escalationMinutes !== undefined ? escalationMinutes : existing.escalation_minutes;
  const finalClosure = closureMinutes !== undefined ? closureMinutes : existing.closure_minutes;

  runExec(db, `
    UPDATE sla_rules SET
      first_response_minutes = ?,
      escalation_minutes = ?,
      closure_minutes = ?,
      updated_at = datetime('now')
    WHERE severity = ?
  `, [finalFirst, finalEscalation, finalClosure, severity]);
  return getRuleBySeverity(db, severity);
}

function deleteRule(db, severity) {
  if (!['P0', 'P1', 'P2', 'P3'].includes(severity)) {
    throw new Error('cannot delete non-standard severity rule');
  }
  const count = runQuery(db, 'SELECT COUNT(*) as c FROM sla_rules')[0].c;
  if (count <= 4) {
    throw new Error('at least P0-P3 four rules must remain');
  }
  runExec(db, 'DELETE FROM sla_rules WHERE severity = ?', [severity]);
  return { ok: true };
}

function getViolationsForIncident(db, incidentId) {
  return runQuery(db, 'SELECT * FROM sla_violations WHERE incident_id = ? ORDER BY created_at ASC', [incidentId]);
}

function hasViolation(db, incidentId, stage) {
  const row = runQuery(db, `
    SELECT COUNT(*) as c FROM sla_violations
    WHERE incident_id = ? AND stage = ?
  `, [incidentId, stage])[0];
  return row.c > 0;
}

function recordViolation(db, uuidv4, { incidentId, stage, thresholdMinutes, breachedAt }) {
  const existing = hasViolation(db, incidentId, stage);
  if (existing) return null;
  const id = uuidv4();
  runExec(db, `
    INSERT INTO sla_violations (id, incident_id, stage, threshold_minutes, breached_at)
    VALUES (?, ?, ?, ?, ?)
  `, [id, incidentId, stage, thresholdMinutes, breachedAt]);

  runExec(db, `
    INSERT INTO operation_logs (id, incident_id, user_name, action, target_type, target_id, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    uuidv4(),
    incidentId,
    'system',
    'sla_breach',
    'incident',
    incidentId,
    JSON.stringify({ stage, stageLabel: STAGE_LABELS[stage], thresholdMinutes })
  ]);
  return id;
}

function safeDateToISO(ts) {
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch (e) {
    return null;
  }
}

function parseDbTime(raw) {
  if (!raw) return Date.now();
  if (typeof raw === 'number') return raw;
  const s = String(raw).trim();
  const isoLike = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s);
  const ts = isoLike ? s.replace(' ', 'T') + 'Z' : s;
  const d = new Date(ts);
  return isNaN(d.getTime()) ? Date.now() : d.getTime();
}

function getIncidentSlaStatus(db, incident) {
  const rule = getRuleBySeverity(db, incident.severity);
  if (!rule) {
    return { rule: null, stages: {}, violations: [], slaViolated: !!incident.sla_violated };
  }

  const violations = getViolationsForIncident(db, incident.id);
  const violationMap = {};
  violations.forEach(v => { violationMap[v.stage] = v; });

  const now = Date.now();
  const createdAt = parseDbTime(incident.created_at || incident.start_time);

  const nodeCount = runQuery(db, `
    SELECT COUNT(*) as c FROM timeline_nodes
    WHERE incident_id = ? AND is_excluded = 0
  `, [incident.id])[0].c;

  const firstNode = runQuery(db, `
    SELECT MIN(created_at) as t FROM timeline_nodes
    WHERE incident_id = ? AND is_excluded = 0
  `, [incident.id])[0];
  const firstNodeAt = firstNode && firstNode.t ? parseDbTime(firstNode.t) : null;

  const linkCount = runQuery(db, `
    SELECT COUNT(*) as c FROM causal_links WHERE incident_id = ?
  `, [incident.id])[0].c;

  const firstLink = runQuery(db, `
    SELECT MIN(created_at) as t FROM causal_links WHERE incident_id = ?
  `, [incident.id])[0];
  const firstLinkAt = firstLink && firstLink.t ? parseDbTime(firstLink.t) : null;

  const isClosed = incident.status === 'closed';
  const closedAt = isClosed && incident.end_time ? parseDbTime(incident.end_time) : null;

  function calcStage(stage, thresholdMin, achievedAt, stopAt) {
    const thresholdMs = thresholdMin * 60 * 1000;
    const effectiveStop = stopAt || now;
    const deadline = createdAt + thresholdMs;
    const deadlineISO = safeDateToISO(deadline) || safeDateToISO(Date.now() + thresholdMs);

    if (violationMap[stage]) {
      return {
        stage,
        label: STAGE_LABELS[stage],
        thresholdMinutes: thresholdMin,
        status: 'violated',
        breachedAt: violationMap[stage].breached_at,
        remainingMs: 0,
        deadline: deadlineISO
      };
    }

    if (achievedAt) {
      return {
        stage,
        label: STAGE_LABELS[stage],
        thresholdMinutes: thresholdMin,
        status: 'achieved',
        achievedAt: safeDateToISO(achievedAt),
        remainingMs: Math.max(0, deadline - achievedAt),
        deadline: deadlineISO
      };
    }

    if (isClosed) {
      return {
        stage,
        label: STAGE_LABELS[stage],
        thresholdMinutes: thresholdMin,
        status: 'closed_unfinished',
        remainingMs: Math.max(0, deadline - effectiveStop),
        deadline: deadlineISO
      };
    }

    const remainingMs = deadline - now;
    return {
      stage,
      label: STAGE_LABELS[stage],
      thresholdMinutes: thresholdMin,
      status: remainingMs <= 0 ? 'pending_breach' : 'pending',
      remainingMs: Math.max(0, remainingMs),
      deadline: deadlineISO
    };
  }

  const stages = {
    [STAGE_FIRST_RESPONSE]: calcStage(
      STAGE_FIRST_RESPONSE,
      rule.first_response_minutes,
      firstNodeAt,
      null
    ),
    [STAGE_ESCALATION]: calcStage(
      STAGE_ESCALATION,
      rule.escalation_minutes,
      firstLinkAt,
      null
    ),
    [STAGE_CLOSURE]: calcStage(
      STAGE_CLOSURE,
      rule.closure_minutes,
      closedAt,
      closedAt
    )
  };

  function getOverallStatus() {
    const s = stages;
    const anyViolated = [STAGE_FIRST_RESPONSE, STAGE_ESCALATION, STAGE_CLOSURE]
      .some(st => s[st].status === 'violated');
    if (anyViolated || incident.sla_violated) return 'violated';
    const pendingStages = [s[STAGE_FIRST_RESPONSE], s[STAGE_ESCALATION], s[STAGE_CLOSURE]]
      .filter(st => st.status === 'pending' || st.status === 'pending_breach');
    if (pendingStages.length === 0) return 'normal';
    for (const st of pendingStages) {
      const pct = st.remainingMs / (st.thresholdMinutes * 60 * 1000);
      if (pct < 0.2 || st.status === 'pending_breach') return 'warning';
    }
    for (const st of pendingStages) {
      const pct = st.remainingMs / (st.thresholdMinutes * 60 * 1000);
      if (pct < 0.5) return 'caution';
    }
    return 'normal';
  }

  function getActiveCountdown() {
    const order = [STAGE_FIRST_RESPONSE, STAGE_ESCALATION, STAGE_CLOSURE];
    for (const stage of order) {
      const s = stages[stage];
      if (s.status === 'pending' || s.status === 'pending_breach') {
        return {
          stage,
          label: s.label,
          thresholdMinutes: s.thresholdMinutes,
          remainingMs: s.remainingMs,
          deadline: s.deadline,
          isBreaching: s.status === 'pending_breach'
        };
      }
    }
    return null;
  }

  return {
    rule,
    stages,
    violations,
    slaViolated: !!incident.sla_violated || violations.length > 0,
    overallStatus: getOverallStatus(),
    activeCountdown: getActiveCountdown(),
    firstResponseAchieved: nodeCount > 0,
    escalationAchieved: linkCount > 0,
    closureAchieved: isClosed
  };
}

function addParticipantsToIncident(db, uuidv4, wss, incidentId, usersToAdd) {
  const added = [];
  for (const { userName, role, serviceName } of usersToAdd) {
    const existing = runQuery(db, `
      SELECT * FROM participants WHERE incident_id = ? AND user_name = ?
    `, [incidentId, userName])[0];
    if (existing) continue;

    const participantId = uuidv4();
    runExec(db, `
      INSERT INTO participants (id, incident_id, user_name, role)
      VALUES (?, ?, ?, ?)
    `, [participantId, incidentId, userName, role]);

    added.push({
      id: participantId,
      incidentId,
      userName,
      role,
      serviceName
    });

    if (wss && wss.broadcast) {
      wss.broadcast(incidentId, {
        type: 'participant_joined',
        participant: {
          id: participantId,
          incidentId,
          userName,
          role
        }
      });
    }
  }
  return added;
}

function scanAndCheckSla(db, uuidv4, wss) {
  const openIncidents = runQuery(db, `
    SELECT * FROM incidents WHERE status != 'closed' ORDER BY created_at ASC
  `);

  for (const incident of openIncidents) {
    checkAndProcessIncident(db, uuidv4, wss, incident);
  }
}

function checkAndProcessIncident(db, uuidv4, wss, incident) {
  const rule = getRuleBySeverity(db, incident.severity);
  if (!rule) return;

  const now = new Date();
  const nowStr = now.toISOString();
  const createdAt = parseDbTime(incident.created_at || incident.start_time);

  const firstNode = runQuery(db, `
    SELECT MIN(created_at) as t FROM timeline_nodes
    WHERE incident_id = ? AND is_excluded = 0
  `, [incident.id])[0];
  const firstNodeAt = firstNode && firstNode.t ? parseDbTime(firstNode.t) : null;

  const firstLink = runQuery(db, `
    SELECT MIN(created_at) as t FROM causal_links WHERE incident_id = ?
  `, [incident.id])[0];
  const firstLinkAt = firstLink && firstLink.t ? parseDbTime(firstLink.t) : null;

  let triggeredAny = false;

  const firstRespThreshold = rule.first_response_minutes * 60 * 1000;
  if (!firstNodeAt && (now.getTime() - createdAt) > firstRespThreshold) {
    if (!hasViolation(db, incident.id, STAGE_FIRST_RESPONSE)) {
      recordViolation(db, uuidv4, {
        incidentId: incident.id,
        stage: STAGE_FIRST_RESPONSE,
        thresholdMinutes: rule.first_response_minutes,
        breachedAt: nowStr
      });
      triggeredAny = true;

      const dispatches = oncallEngine.getDispatchesForIncident(db, incident.id);
      const services = [...new Set(dispatches.map(d => d.service_name))];
      const backupUsers = [];

      for (const serviceName of services) {
        const oncall = oncallEngine.getOncallPersonForService(db, serviceName, now);
        if (!oncall || !oncall.backupUser) continue;
        if (oncall.backupUser === oncall.userName) continue;

        backupUsers.push({
          userName: oncall.backupUser,
          role: 'backup',
          serviceName
        });

        oncallEngine.recordDispatch(db, uuidv4, {
          incidentId: incident.id,
          serviceName,
          userName: oncall.backupUser,
          dispatchType: 'sla_upgrade_backup'
        });
      }

      const added = addParticipantsToIncident(db, uuidv4, wss, incident.id, backupUsers);
      if (added.length > 0) {
        runExec(db, `
          INSERT INTO operation_logs (id, incident_id, user_name, action, target_type, target_id, detail)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [
          uuidv4(),
          incident.id,
          'system',
          'sla_upgrade_backup',
          'incident',
          incident.id,
          JSON.stringify({ addedUsers: added, reason: 'first_response_timeout' })
        ]);
      }

      if (wss && wss.broadcast) {
        wss.broadcast(incident.id, {
          type: 'sla_breach',
          incidentId: incident.id,
          stage: STAGE_FIRST_RESPONSE,
          stageLabel: STAGE_LABELS[STAGE_FIRST_RESPONSE],
          thresholdMinutes: rule.first_response_minutes,
          addedParticipants: added
        });
      }
    }
  }

  const escThreshold = rule.escalation_minutes * 60 * 1000;
  if (!firstLinkAt && (now.getTime() - createdAt) > escThreshold) {
    if (!hasViolation(db, incident.id, STAGE_ESCALATION)) {
      recordViolation(db, uuidv4, {
        incidentId: incident.id,
        stage: STAGE_ESCALATION,
        thresholdMinutes: rule.escalation_minutes,
        breachedAt: nowStr
      });
      triggeredAny = true;

      const dispatches = oncallEngine.getDispatchesForIncident(db, incident.id);
      const services = [...new Set(dispatches.map(d => d.service_name))];
      const planOwners = [];

      for (const serviceName of services) {
        const plan = oncallEngine.getActivePlanForService(db, serviceName, now);
        if (!plan) continue;

        const planCreatorName = plan.created_at ? 'admin' : null;
        const members = oncallEngine.getPlanMembers(db, plan.id);
        const ownerName = members.length > 0 ? members[0].user_name : null;
        const toAdd = ownerName || planCreatorName;
        if (toAdd) {
          planOwners.push({
            userName: toAdd,
            role: 'escalation_owner',
            serviceName
          });

          oncallEngine.recordDispatch(db, uuidv4, {
            incidentId: incident.id,
            serviceName,
            userName: toAdd,
            dispatchType: 'sla_upgrade_owner'
          });
        }
      }

      const added = addParticipantsToIncident(db, uuidv4, wss, incident.id, planOwners);
      if (added.length > 0) {
        runExec(db, `
          INSERT INTO operation_logs (id, incident_id, user_name, action, target_type, target_id, detail)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [
          uuidv4(),
          incident.id,
          'system',
          'sla_upgrade_owner',
          'incident',
          incident.id,
          JSON.stringify({ addedUsers: added, reason: 'escalation_timeout' })
        ]);
      }

      if (wss && wss.broadcast) {
        wss.broadcast(incident.id, {
          type: 'sla_breach',
          incidentId: incident.id,
          stage: STAGE_ESCALATION,
          stageLabel: STAGE_LABELS[STAGE_ESCALATION],
          thresholdMinutes: rule.escalation_minutes,
          addedParticipants: added
        });
      }
    }
  }

  const closureThreshold = rule.closure_minutes * 60 * 1000;
  if ((now.getTime() - createdAt) > closureThreshold) {
    if (!hasViolation(db, incident.id, STAGE_CLOSURE)) {
      recordViolation(db, uuidv4, {
        incidentId: incident.id,
        stage: STAGE_CLOSURE,
        thresholdMinutes: rule.closure_minutes,
        breachedAt: nowStr
      });
      triggeredAny = true;

      runExec(db, `
        UPDATE incidents SET sla_violated = 1, updated_at = datetime('now')
        WHERE id = ?
      `, [incident.id]);

      runExec(db, `
        INSERT INTO operation_logs (id, incident_id, user_name, action, target_type, target_id, detail)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        uuidv4(),
        incident.id,
        'system',
        'sla_violated_mark',
        'incident',
        incident.id,
        JSON.stringify({ thresholdMinutes: rule.closure_minutes })
      ]);

      if (wss && wss.broadcast) {
        wss.broadcast(incident.id, {
          type: 'sla_breach',
          incidentId: incident.id,
          stage: STAGE_CLOSURE,
          stageLabel: STAGE_LABELS[STAGE_CLOSURE],
          thresholdMinutes: rule.closure_minutes,
          markedViolated: true
        });
      }
    }
  }

  return triggeredAny;
}

function getBatchSlaStatus(db, incidents) {
  return incidents.map(inc => {
    const rule = getRuleBySeverity(db, inc.severity);
    if (!rule) {
      return {
        incidentId: inc.id,
        overallStatus: 'normal',
        slaViolated: !!inc.sla_violated,
        activeCountdown: null
      };
    }
    const status = getIncidentSlaStatus(db, inc);
    return {
      incidentId: inc.id,
      overallStatus: status.overallStatus,
      slaViolated: status.slaViolated,
      activeCountdown: status.activeCountdown
    };
  });
}

module.exports = {
  STAGE_FIRST_RESPONSE,
  STAGE_ESCALATION,
  STAGE_CLOSURE,
  STAGE_LABELS,
  getAllRules,
  getRuleBySeverity,
  createRule,
  updateRule,
  deleteRule,
  getViolationsForIncident,
  hasViolation,
  recordViolation,
  getIncidentSlaStatus,
  scanAndCheckSla,
  checkAndProcessIncident,
  getBatchSlaStatus
};
