const { runQuery, runExec } = require('./db');

const SHIFT_HOURS = [
  { index: 0, name: '早班', start: 0, end: 8 },
  { index: 1, name: '中班', start: 8, end: 16 },
  { index: 2, name: '晚班', start: 16, end: 24 }
];

function getShiftIndex(date) {
  const hour = date.getHours();
  for (const shift of SHIFT_HOURS) {
    if (hour >= shift.start && hour < shift.end) {
      return shift.index;
    }
  }
  return 0;
}

function getShiftInfo(index) {
  return SHIFT_HOURS[index] || SHIFT_HOURS[0];
}

function formatDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function daysBetween(date1, date2) {
  const d1 = new Date(date1.getFullYear(), date1.getMonth(), date1.getDate());
  const d2 = new Date(date2.getFullYear(), date2.getMonth(), date2.getDate());
  return Math.floor((d2 - d1) / (1000 * 60 * 60 * 24));
}

function getActivePlanForService(db, serviceName, atTime) {
  const plans = runQuery(db, `
    SELECT p.* FROM oncall_plans p
    WHERE p.is_active = 1
    AND p.start_date <= ?
    ORDER BY p.created_at DESC
  `, [formatDateKey(atTime)]);

  for (const plan of plans) {
    const services = JSON.parse(plan.services || '[]');
    if (services.includes(serviceName)) {
      return plan;
    }
  }
  return null;
}

function getPlanMembers(db, planId) {
  return runQuery(db, `
    SELECT * FROM oncall_plan_members
    WHERE plan_id = ?
    ORDER BY position ASC
  `, [planId]);
}

function getOncallPersonForService(db, serviceName, atTime) {
  const plan = getActivePlanForService(db, serviceName, atTime);
  if (!plan) return null;

  const members = getPlanMembers(db, plan.id);
  if (members.length === 0) return null;

  const startDate = new Date(plan.start_date + 'T00:00:00');
  const days = daysBetween(startDate, atTime);
  const shiftIndex = getShiftIndex(atTime);
  const totalShifts = days * 3 + shiftIndex;
  const memberIndex = totalShifts % members.length;
  const member = members[memberIndex];

  const dateKey = formatDateKey(atTime);
  const swap = runQuery(db, `
    SELECT * FROM oncall_swaps
    WHERE plan_id = ? AND shift_date = ? AND shift_index = ?
  `, [plan.id, dateKey, shiftIndex])[0];

  if (swap) {
    return {
      planId: plan.id,
      planName: plan.name,
      serviceName,
      userName: swap.substitute_user,
      originalUser: swap.original_user,
      shiftIndex,
      shiftName: getShiftInfo(shiftIndex).name,
      isSwapped: true,
      atTime: atTime.toISOString(),
      backupUser: members[(memberIndex + 1) % members.length].user_name
    };
  }

  return {
    planId: plan.id,
    planName: plan.name,
    serviceName,
    userName: member.user_name,
    originalUser: null,
    shiftIndex,
    shiftName: getShiftInfo(shiftIndex).name,
    isSwapped: false,
    atTime: atTime.toISOString(),
    backupUser: members[(memberIndex + 1) % members.length].user_name
  };
}

function getWeeklySchedule(db, serviceName, weekStart) {
  const plan = getActivePlanForService(db, serviceName, weekStart);
  if (!plan) return null;

  const members = getPlanMembers(db, plan.id);
  if (members.length === 0) return null;

  const schedule = [];
  const startDate = new Date(plan.start_date + 'T00:00:00');

  for (let day = 0; day < 7; day++) {
    const currentDate = new Date(weekStart);
    currentDate.setDate(currentDate.getDate() + day);
    const dateKey = formatDateKey(currentDate);
    const days = daysBetween(startDate, currentDate);

    const dayShifts = [];
    for (let shiftIdx = 0; shiftIdx < 3; shiftIdx++) {
      const totalShifts = days * 3 + shiftIdx;
      const memberIndex = totalShifts % members.length;
      const member = members[memberIndex];

      const swap = runQuery(db, `
        SELECT * FROM oncall_swaps
        WHERE plan_id = ? AND shift_date = ? AND shift_index = ?
      `, [plan.id, dateKey, shiftIdx])[0];

      dayShifts.push({
        shiftIndex: shiftIdx,
        shiftName: getShiftInfo(shiftIdx).name,
        date: dateKey,
        originalUser: member.user_name,
        actualUser: swap ? swap.substitute_user : member.user_name,
        isSwapped: !!swap,
        swapId: swap ? swap.id : null
      });
    }
    schedule.push({
      date: dateKey,
      dayOfWeek: currentDate.getDay(),
      shifts: dayShifts
    });
  }

  return {
    planId: plan.id,
    planName: plan.name,
    serviceName,
    schedule
  };
}

function getAllServicesWithPlans(db) {
  const plans = runQuery(db, `
    SELECT * FROM oncall_plans WHERE is_active = 1 ORDER BY created_at DESC
  `);

  const serviceMap = {};
  for (const plan of plans) {
    const services = JSON.parse(plan.services || '[]');
    for (const svc of services) {
      if (!serviceMap[svc]) {
        serviceMap[svc] = plan;
      }
    }
  }

  return Object.keys(serviceMap).map(svc => ({
    serviceName: svc,
    planId: serviceMap[svc].id,
    planName: serviceMap[svc].name
  }));
}

function checkServiceConflicts(db, services, excludePlanId = null) {
  const existingPlans = runQuery(db, `
    SELECT id, name, services FROM oncall_plans
    WHERE is_active = 1
  `);

  const conflicts = [];
  for (const plan of existingPlans) {
    if (excludePlanId && plan.id === excludePlanId) continue;
    const planServices = JSON.parse(plan.services || '[]');
    for (const svc of services) {
      if (planServices.includes(svc)) {
        conflicts.push({ service: svc, planId: plan.id, planName: plan.name });
      }
    }
  }
  return conflicts;
}

function createPlan(db, uuidv4, { name, services, startDate, members }) {
  if (!name || !services || !Array.isArray(services) || services.length === 0) {
    throw new Error('name and services array required');
  }
  if (!members || !Array.isArray(members) || members.length === 0) {
    throw new Error('members array cannot be empty');
  }
  if (!startDate) {
    throw new Error('startDate required');
  }

  const conflicts = checkServiceConflicts(db, services);
  if (conflicts.length > 0) {
    const conflictInfo = conflicts.map(c => `${c.service} (已在计划"${c.planName}"中)`).join(', ');
    throw new Error(`服务冲突: ${conflictInfo}。同一服务同一时间只能有一个生效的值班计划。`);
  }

  const planId = uuidv4();
  runExec(db, `
    INSERT INTO oncall_plans (id, name, services, start_date)
    VALUES (?, ?, ?, ?)
  `, [planId, name, JSON.stringify(services), startDate]);

  members.forEach((userName, idx) => {
    runExec(db, `
      INSERT INTO oncall_plan_members (id, plan_id, user_name, position)
      VALUES (?, ?, ?, ?)
    `, [uuidv4(), planId, userName, idx]);
  });

  return getPlanById(db, planId);
}

function updatePlan(db, planId, { name, services, members, isActive }) {
  const plan = getPlanById(db, planId);
  if (!plan) throw new Error('plan not found');

  const finalServices = services !== undefined && Array.isArray(services) ? services : plan.services;
  const finalIsActive = isActive !== undefined ? isActive : !!plan.is_active;

  if (finalIsActive) {
    const conflicts = checkServiceConflicts(db, finalServices, planId);
    if (conflicts.length > 0) {
      const conflictInfo = conflicts.map(c => `${c.service} (已在计划"${c.planName}"中)`).join(', ');
      throw new Error(`服务冲突: ${conflictInfo}。同一服务同一时间只能有一个生效的值班计划。`);
    }
  }

  if (name !== undefined) {
    runExec(db, `UPDATE oncall_plans SET name = ?, updated_at = datetime('now') WHERE id = ?`, [name, planId]);
  }
  if (services !== undefined && Array.isArray(services)) {
    runExec(db, `UPDATE oncall_plans SET services = ?, updated_at = datetime('now') WHERE id = ?`, [JSON.stringify(services), planId]);
  }
  if (isActive !== undefined) {
    runExec(db, `UPDATE oncall_plans SET is_active = ?, updated_at = datetime('now') WHERE id = ?`, [isActive ? 1 : 0, planId]);
  }
  if (members !== undefined && Array.isArray(members) && members.length > 0) {
    runExec(db, `DELETE FROM oncall_plan_members WHERE plan_id = ?`, [planId]);
    members.forEach((userName, idx) => {
      const crypto = require('crypto');
      runExec(db, `
        INSERT INTO oncall_plan_members (id, plan_id, user_name, position)
        VALUES (?, ?, ?, ?)
      `, [crypto.randomUUID(), planId, userName, idx]);
    });
  }

  return getPlanById(db, planId);
}

function deletePlan(db, planId) {
  runExec(db, `DELETE FROM oncall_plan_members WHERE plan_id = ?`, [planId]);
  runExec(db, `DELETE FROM oncall_swaps WHERE plan_id = ?`, [planId]);
  runExec(db, `DELETE FROM oncall_plans WHERE id = ?`, [planId]);
}

function getPlanById(db, planId) {
  const plan = runQuery(db, `SELECT * FROM oncall_plans WHERE id = ?`, [planId])[0];
  if (!plan) return null;
  const members = getPlanMembers(db, planId);
  return {
    ...plan,
    services: JSON.parse(plan.services || '[]'),
    members: members.map(m => ({ id: m.id, userName: m.user_name, position: m.position }))
  };
}

function getAllPlans(db) {
  const plans = runQuery(db, `SELECT * FROM oncall_plans ORDER BY created_at DESC`);
  return plans.map(p => ({
    ...p,
    services: JSON.parse(p.services || '[]'),
    members: getPlanMembers(db, p.id).map(m => ({ id: m.id, userName: m.user_name, position: m.position }))
  }));
}

function createSwap(db, uuidv4, { planId, originalUser, substituteUser, shiftDate, shiftIndex, createdBy }) {
  if (!planId || !originalUser || !substituteUser || !shiftDate || shiftIndex === undefined || !createdBy) {
    throw new Error('all fields required');
  }
  const swapId = uuidv4();
  runExec(db, `
    INSERT INTO oncall_swaps (id, plan_id, original_user, substitute_user, shift_date, shift_index, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [swapId, planId, originalUser, substituteUser, shiftDate, shiftIndex, createdBy]);

  return runQuery(db, `SELECT * FROM oncall_swaps WHERE id = ?`, [swapId])[0];
}

function getSwapsForPlan(db, planId) {
  return runQuery(db, `
    SELECT * FROM oncall_swaps
    WHERE plan_id = ?
    ORDER BY shift_date DESC, shift_index ASC
  `, [planId]);
}

function recordDispatch(db, uuidv4, { incidentId, serviceName, userName, dispatchType }) {
  const dispatchId = uuidv4();
  const now = new Date().toISOString();
  runExec(db, `
    INSERT INTO oncall_dispatches (id, incident_id, service_name, user_name, dispatched_at, dispatch_type)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [dispatchId, incidentId, serviceName, userName, now, dispatchType]);
  return dispatchId;
}

function getDispatchesForIncident(db, incidentId) {
  return runQuery(db, `
    SELECT * FROM oncall_dispatches
    WHERE incident_id = ?
    ORDER BY dispatched_at ASC
  `, [incidentId]);
}

function hasIncidentActivity(db, incidentId, sinceTime) {
  const nodeCount = runQuery(db, `
    SELECT COUNT(*) as c FROM timeline_nodes
    WHERE incident_id = ? AND created_at >= ?
  `, [incidentId, sinceTime])[0].c;
  if (nodeCount > 0) return true;

  const linkCount = runQuery(db, `
    SELECT COUNT(*) as c FROM causal_links
    WHERE incident_id = ? AND created_at >= ?
  `, [incidentId, sinceTime])[0].c;
  if (linkCount > 0) return true;

  const logCount = runQuery(db, `
    SELECT COUNT(*) as c FROM operation_logs
    WHERE incident_id = ? AND created_at >= ?
    AND action NOT IN ('auto_dispatch', 'auto_upgrade', 'join')
  `, [incidentId, sinceTime])[0].c;
  if (logCount > 0) return true;

  return false;
}

function checkAndUpgradeIncidents(db, uuidv4, wss) {
  const now = new Date();
  const fifteenMinutesAgo = new Date(now.getTime() - 15 * 60 * 1000);

  const openIncidents = runQuery(db, `
    SELECT i.* FROM incidents i
    WHERE i.status = 'open'
    AND i.created_at <= ?
    AND i.id NOT IN (
      SELECT DISTINCT incident_id FROM operation_logs
      WHERE action = 'auto_upgrade'
    )
  `, [fifteenMinutesAgo.toISOString()]);

  for (const incident of openIncidents) {
    const hasActivity = hasIncidentActivity(db, incident.id, fifteenMinutesAgo.toISOString());
    if (hasActivity) continue;

    const dispatches = getDispatchesForIncident(db, incident.id);
    if (dispatches.length === 0) continue;

    const services = [...new Set(dispatches.map(d => d.service_name))];
    const upgradedUsers = [];

    for (const serviceName of services) {
      const oncall = getOncallPersonForService(db, serviceName, new Date(incident.created_at));
      if (!oncall) continue;

      const backupUser = oncall.backupUser;
      const existingParticipant = runQuery(db, `
        SELECT * FROM participants WHERE incident_id = ? AND user_name = ?
      `, [incident.id, backupUser])[0];

      if (!existingParticipant && backupUser !== oncall.userName) {
        const participantId = uuidv4();
        runExec(db, `
          INSERT INTO participants (id, incident_id, user_name, role)
          VALUES (?, ?, ?, 'backup')
        `, [participantId, incident.id, backupUser]);

        recordDispatch(db, uuidv4, {
          incidentId: incident.id,
          serviceName,
          userName: backupUser,
          dispatchType: 'upgrade'
        });

        upgradedUsers.push({ userName: backupUser, serviceName });

        if (wss && wss.broadcast) {
          wss.broadcast(incident.id, {
            type: 'participant_joined',
            participant: {
              id: participantId,
              incidentId: incident.id,
              userName: backupUser,
              role: 'backup'
            }
          });
        }
      }
    }

    if (upgradedUsers.length > 0) {
      runExec(db, `
        INSERT INTO operation_logs (id, incident_id, user_name, action, target_type, target_id, detail)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        uuidv4(),
        incident.id,
        'system',
        'auto_upgrade',
        'incident',
        incident.id,
        JSON.stringify({ upgradedUsers })
      ]);

      if (wss && wss.broadcast) {
        wss.broadcast(incident.id, {
          type: 'incident_upgraded',
          incidentId: incident.id,
          upgradedUsers
        });
      }
    }
  }
}

function seedDemoOncallData(db, uuidv4) {
  const count = runQuery(db, 'SELECT COUNT(*) as c FROM oncall_plans')[0].c;
  if (count > 0) return;

  const services = ['payment-gateway', 'order-service', 'order-db'];
  const members = ['alice', 'bob', 'carol', 'dave'];
  const startDate = '2026-06-01';

  const planId = uuidv4();
  runExec(db, `
    INSERT INTO oncall_plans (id, name, services, start_date, is_active)
    VALUES (?, ?, ?, ?, 1)
  `, [planId, '核心服务值班组', JSON.stringify(services), startDate]);

  members.forEach((name, idx) => {
    runExec(db, `
      INSERT INTO oncall_plan_members (id, plan_id, user_name, position)
      VALUES (?, ?, ?, ?)
    `, [uuidv4(), planId, name, idx]);
  });

  const swapDate = '2026-06-11';
  runExec(db, `
    INSERT INTO oncall_swaps (id, plan_id, original_user, substitute_user, shift_date, shift_index, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [uuidv4(), planId, 'bob', 'dave', swapDate, 1, 'alice']);

  const demoIncidents = runQuery(db, `SELECT id, created_at FROM incidents ORDER BY created_at ASC`);
  for (const inc of demoIncidents) {
    for (const svc of services) {
      const oncall = getOncallPersonForService(db, svc, new Date(inc.created_at));
      if (oncall) {
        recordDispatch(db, uuidv4, {
          incidentId: inc.id,
          serviceName: svc,
          userName: oncall.userName,
          dispatchType: 'auto'
        });
      }
    }
  }
}

module.exports = {
  SHIFT_HOURS,
  getShiftIndex,
  getShiftInfo,
  formatDateKey,
  getActivePlanForService,
  getOncallPersonForService,
  getWeeklySchedule,
  getAllServicesWithPlans,
  checkServiceConflicts,
  createPlan,
  updatePlan,
  deletePlan,
  getPlanById,
  getAllPlans,
  getPlanMembers,
  createSwap,
  getSwapsForPlan,
  recordDispatch,
  getDispatchesForIncident,
  hasIncidentActivity,
  checkAndUpgradeIncidents,
  seedDemoOncallData
};
