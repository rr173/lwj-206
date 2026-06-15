const { runQuery, runExec } = require('./db');

const MAX_NOTIFICATIONS_PER_USER = 500;
const MAX_SUBSCRIPTIONS_PER_USER = 10;

function getUserSubscriptions(db, userName) {
  return runQuery(db, `
    SELECT * FROM subscriptions
    WHERE user_name = ?
    ORDER BY created_at DESC
  `, [userName]);
}

function getSubscribersForService(db, serviceName) {
  return runQuery(db, `
    SELECT DISTINCT user_name FROM subscriptions
    WHERE service_name = ?
  `, [serviceName]);
}

function addSubscription(db, uuidv4, userName, serviceName) {
  const existing = runQuery(db, `
    SELECT * FROM subscriptions
    WHERE user_name = ? AND service_name = ?
  `, [userName, serviceName]);
  if (existing.length > 0) {
    throw new Error('已订阅该服务');
  }

  const count = runQuery(db, `
    SELECT COUNT(*) as c FROM subscriptions
    WHERE user_name = ?
  `, [userName])[0].c;
  if (count >= MAX_SUBSCRIPTIONS_PER_USER) {
    throw new Error(`最多只能订阅 ${MAX_SUBSCRIPTIONS_PER_USER} 个服务`);
  }

  const id = uuidv4();
  runExec(db, `
    INSERT INTO subscriptions (id, user_name, service_name)
    VALUES (?, ?, ?)
  `, [id, userName, serviceName]);

  return runQuery(db, 'SELECT * FROM subscriptions WHERE id = ?', [id])[0];
}

function removeSubscription(db, userName, serviceName) {
  runExec(db, `
    DELETE FROM subscriptions
    WHERE user_name = ? AND service_name = ?
  `, [userName, serviceName]);
}

function updateSubscriptions(db, uuidv4, userName, serviceNames) {
  const uniqueNames = [...new Set(serviceNames)];
  if (uniqueNames.length > MAX_SUBSCRIPTIONS_PER_USER) {
    throw new Error(`最多只能订阅 ${MAX_SUBSCRIPTIONS_PER_USER} 个服务`);
  }

  runExec(db, `
    DELETE FROM subscriptions
    WHERE user_name = ?
  `, [userName]);

  for (const serviceName of uniqueNames) {
    const id = uuidv4();
    runExec(db, `
      INSERT INTO subscriptions (id, user_name, service_name)
      VALUES (?, ?, ?)
    `, [id, userName, serviceName]);
  }

  return getUserSubscriptions(db, userName);
}

function getAllServices(db) {
  const result = runQuery(db, `
    SELECT DISTINCT service_name FROM (
      SELECT service_name FROM timeline_nodes
      UNION
      SELECT service_name FROM service_health
      UNION
      SELECT service_name FROM subscriptions
    )
    ORDER BY service_name
  `);
  return result.map(r => r.service_name);
}

function getUserNotifications(db, userName, limit = 50) {
  return runQuery(db, `
    SELECT * FROM notifications
    WHERE user_name = ?
    ORDER BY created_at DESC
    LIMIT ?
  `, [userName, limit]);
}

function getUnreadCount(db, userName) {
  return runQuery(db, `
    SELECT COUNT(*) as c FROM notifications
    WHERE user_name = ? AND is_read = 0
  `, [userName])[0].c;
}

function markNotificationRead(db, notificationId, userName) {
  runExec(db, `
    UPDATE notifications
    SET is_read = 1
    WHERE id = ? AND user_name = ?
  `, [notificationId, userName]);
}

function markAllNotificationsRead(db, userName) {
  runExec(db, `
    UPDATE notifications
    SET is_read = 1
    WHERE user_name = ? AND is_read = 0
  `, [userName]);
}

function cleanupOldNotifications(db, userName) {
  const count = runQuery(db, `
    SELECT COUNT(*) as c FROM notifications
    WHERE user_name = ?
  `, [userName])[0].c;

  if (count > MAX_NOTIFICATIONS_PER_USER) {
    const toDelete = count - MAX_NOTIFICATIONS_PER_USER;
    runExec(db, `
      DELETE FROM notifications
      WHERE user_name = ?
      AND id IN (
        SELECT id FROM notifications
        WHERE user_name = ?
        ORDER BY created_at ASC
        LIMIT ?
      )
    `, [userName, userName, toDelete]);
  }
}

function createNotification(db, uuidv4, userName, title, body, incidentId, serviceName) {
  const id = uuidv4();
  runExec(db, `
    INSERT INTO notifications (id, user_name, title, body, incident_id, service_name, is_read)
    VALUES (?, ?, ?, ?, ?, ?, 0)
  `, [id, userName, title, body, incidentId, serviceName]);

  cleanupOldNotifications(db, userName);

  return runQuery(db, 'SELECT * FROM notifications WHERE id = ?', [id])[0];
}

function notifySubscribersForNewIncident(db, uuidv4, wss, incident, services) {
  const uniqueServices = [...new Set(services)];
  const notifiedUsers = new Set();

  for (const serviceName of uniqueServices) {
    const subscribers = getSubscribersForService(db, serviceName);
    for (const sub of subscribers) {
      const userName = sub.user_name;
      if (notifiedUsers.has(userName)) continue;
      if (userName === incident.owner_id) continue;

      notifiedUsers.add(userName);

      const title = `新事故：${incident.title}`;
      const body = `${incident.severity}级事故已创建，涉及服务：${serviceName}`;

      const notification = createNotification(
        db, uuidv4, userName, title, body, incident.id, serviceName
      );

      if (wss && wss.broadcastToUser) {
        wss.broadcastToUser(userName, {
          type: 'new_notification',
          notification
        });
      }
    }
  }
}

function notifySubscribersForNewNode(db, uuidv4, wss, incident, node) {
  const serviceName = node.service_name;
  const subscribers = getSubscribersForService(db, serviceName);
  const incidentParticipants = runQuery(db, `
    SELECT user_name FROM participants WHERE incident_id = ?
  `, [incident.id]).map(p => p.user_name);

  for (const sub of subscribers) {
    const userName = sub.user_name;
    if (incidentParticipants.includes(userName)) continue;
    if (userName === node.created_by) continue;

    const title = `事故更新：${node.description.substring(0, 30)}${node.description.length > 30 ? '...' : ''}`;
    const body = `事故「${incident.title}」有新的节点更新`;

    const notification = createNotification(
      db, uuidv4, userName, title, body, incident.id, serviceName
    );

    if (wss && wss.broadcastToUser) {
      wss.broadcastToUser(userName, {
        type: 'new_notification',
        notification
      });
    }
  }
}

function getIncidentServices(db, incidentId) {
  const result = runQuery(db, `
    SELECT DISTINCT service_name FROM timeline_nodes
    WHERE incident_id = ? AND is_excluded = 0
  `, [incidentId]);
  return result.map(r => r.service_name);
}

module.exports = {
  MAX_NOTIFICATIONS_PER_USER,
  MAX_SUBSCRIPTIONS_PER_USER,
  getUserSubscriptions,
  getSubscribersForService,
  addSubscription,
  removeSubscription,
  updateSubscriptions,
  getAllServices,
  getUserNotifications,
  getUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
  createNotification,
  notifySubscribersForNewIncident,
  notifySubscribersForNewNode,
  getIncidentServices
};
