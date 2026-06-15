const API = '/api';
const SRC_COLORS = { log: '#3b82f6', chat: '#a855f7', monitor: '#f59e0b', manual: '#22c55e' };
const SRC_LABELS = { log: '日志', chat: '聊天', monitor: '监控', manual: '人工标注' };

let state = {
  view: 'list',
  incidents: [],
  currentIncident: null,
  nodes: [],
  causalLinks: [],
  duplicates: [],
  participants: [],
  logs: [],
  keyPath: [],
  onlineUsers: new Set(),
  userName: localStorage.getItem('tl_username') || '',
  ws: null,
  notifyWs: null,
  lastSyncId: 0,
  selectedNodeId: null,
  connectionMode: false,
  connectionFrom: null,
  showKeyPath: false,
  detailNode: null,
  showAddNode: false,
  showCreateIncident: false,
  templates: [],
  selectedTemplateId: null,
  showTemplateList: false,
  currentReview: null,
  showReviewForm: false,
  reviewStats: null,
  similarIncidents: {
    matches: [],
    kbEmpty: false,
    needsMoreNodes: false,
    currentNodeCount: 0,
    requiredNodeCount: 3,
    generatedAt: null
  },
  similarPanelCollapsed: false,
  similarPanelFlash: false,
  expandedSimilarId: null,
  similarSummaries: {},
  loadingSummaryId: null,
  serviceNetwork: { nodes: [], edges: [] },
  selectedService: null,
  selectedServiceDetail: null,
  highlightServiceName: null,
  serviceGraphAnimId: null,
  oncallServices: [],
  oncallSchedules: {},
  oncallWeekStart: null,
  oncallSelectedService: null,
  oncallPlans: [],
  showOncallPlanModal: false,
  editingPlanId: null,
  showSwapModal: false,
  swapData: null,
  slaRules: [],
  slaEditingSeverity: null,
  slaEditDraft: {},
  slaStatuses: {},
  slaFilter: 'all',
  slaSortKey: null,
  slaSortAsc: true,
  currentSlaStatus: null,
  slaCountdownTimer: null,
  subscriptions: [],
  allServices: [],
  notifications: [],
  unreadCount: 0,
  showNotificationPanel: false
};

function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }

function render() {
  const app = document.getElementById('app');
  if (state.view === 'list') {
    app.innerHTML = renderNotificationCenter() + renderIncidentList();
  } else if (state.view === 'stats') {
    app.innerHTML = renderNotificationCenter() + renderStatsPage();
  } else if (state.view === 'services') {
    app.innerHTML = renderNotificationCenter() + renderServicesPage();
    setTimeout(() => {
      renderServiceGraph();
      if (state.selectedServiceDetail) {
        renderServiceTrendChart();
      }
    }, 0);
  } else if (state.view === 'oncall') {
    app.innerHTML = renderNotificationCenter() + renderOncallPage();
  } else if (state.view === 'sla') {
    app.innerHTML = renderNotificationCenter() + renderSlaPage();
  } else if (state.view === 'subscriptions') {
    app.innerHTML = renderNotificationCenter() + renderSubscriptionsPage();
  } else {
    app.innerHTML = renderNotificationCenter() + renderTimeline();
    renderTimelineGraphics();
    setTimeout(updateSlaCountdownDisplay, 0);
  }
  bindEvents();
}

function renderIncidentList() {
  let incidents = [...state.incidents];
  if (state.slaFilter !== 'all') {
    incidents = incidents.filter(i => {
      const s = state.slaStatuses[i.id];
      if (!s) return state.slaFilter === 'normal';
      return s.overallStatus === state.slaFilter ||
        (state.slaFilter === 'violated' && s.slaViolated) ||
        (state.slaFilter === 'warning' && (s.overallStatus === 'warning' || s.overallStatus === 'caution'));
    });
  }
  if (state.slaSortKey) {
    incidents.sort((a, b) => {
      let va, vb;
      if (state.slaSortKey === 'sla') {
        const order = { violated: 0, warning: 1, caution: 2, normal: 3 };
        va = order[(state.slaStatuses[a.id] || {}).overallStatus] ?? 99;
        vb = order[(state.slaStatuses[b.id] || {}).overallStatus] ?? 99;
        if ((state.slaStatuses[a.id] || {}).slaViolated) va = -1;
        if ((state.slaStatuses[b.id] || {}).slaViolated) vb = -1;
      } else if (state.slaSortKey === 'severity') {
        const order = { P0: 0, P1: 1, P2: 2, P3: 3 };
        va = order[a.severity] ?? 99;
        vb = order[b.severity] ?? 99;
      } else if (state.slaSortKey === 'created') {
        va = new Date(a.created_at || a.start_time).getTime();
        vb = new Date(b.created_at || b.start_time).getTime();
      }
      return state.slaSortAsc ? va - vb : vb - va;
    });
  }

  function slaBadge(incidentId) {
    const s = state.slaStatuses[incidentId];
    if (!s) return '<span class="sla-badge sla-normal">正常</span>';
    if (s.slaViolated) return '<span class="sla-badge sla-violated" title="SLA已违规">⚠ 已违规</span>';
    if (s.overallStatus === 'warning') return '<span class="sla-badge sla-warning">即将超时</span>';
    if (s.overallStatus === 'caution') return '<span class="sla-badge sla-caution">注意</span>';
    return '<span class="sla-badge sla-normal">正常</span>';
  }

  const rows = incidents.map(i => `
    <tr class="incident-row" data-action="open-incident" data-id="${i.id}">
      <td>
        ${i.sla_violated ? '<span class="sla-warn-icon" title="SLA已违规">⚠️</span>' : ''}
        ${escapeHtml(i.title)}
      </td>
      <td><span class="severity-badge severity-${i.severity}">${i.severity}</span></td>
      <td><span class="status-tag ${i.status === 'open' ? 'status-open' : 'status-closed'}">${i.status === 'open' ? '进行中' : '已关闭'}</span></td>
      <td>${slaBadge(i.id)}</td>
      <td style="font-family:monospace;font-size:12px;">${i.room_code}</td>
      <td style="font-size:12px;color:var(--text2);">${(i.start_time || '').slice(0, 16)}<br>${i.end_time ? (i.end_time.slice(0, 16)) : '未结束'}</td>
    </tr>
  `).join('');

  const sortArrow = (key) => state.slaSortKey === key ? (state.slaSortAsc ? ' ↑' : ' ↓') : '';

  return `
  <div class="incident-list">
    <h1>故障时间线还原工具</h1>
    <p style="color:var(--text2);margin-bottom:8px;">选择一个事故进入协作房间，或创建新事故</p>
    <div style="margin-bottom:16px;display:flex;gap:8px;flex-wrap:wrap;">
      <button class="btn btn-primary" data-action="create-incident">+ 创建事故</button>
      <button class="btn btn-outline" data-action="show-template-list">📋 模板管理</button>
      <button class="btn btn-outline" data-action="go-stats">📊 评分统计</button>
      <button class="btn btn-outline" data-action="go-services">🌐 服务健康度</button>
      <button class="btn btn-outline" data-action="go-oncall">📅 值班排班</button>
      <button class="btn btn-outline" data-action="go-sla">⏱ SLA规则</button>
      <button class="btn btn-outline" data-action="go-subscriptions">🔔 订阅管理</button>
      <div style="flex:1"></div>
      <div style="display:flex;align-items:center;gap:8px;">
        <label style="font-size:12px;color:var(--text2);">SLA筛选:</label>
        <select id="sla-filter" style="background:var(--bg2);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:4px 8px;">
          <option value="all" ${state.slaFilter === 'all' ? 'selected' : ''}>全部</option>
          <option value="normal" ${state.slaFilter === 'normal' ? 'selected' : ''}>正常</option>
          <option value="warning" ${state.slaFilter === 'warning' ? 'selected' : ''}>即将超时/注意</option>
          <option value="violated" ${state.slaFilter === 'violated' ? 'selected' : ''}>已违规</option>
        </select>
      </div>
    </div>
    <div class="incident-table-wrap">
      <table class="incident-table">
        <thead>
          <tr>
            <th style="cursor:pointer;" data-action="sort-incidents" data-key="created">事故标题${sortArrow('created')}</th>
            <th style="cursor:pointer;" data-action="sort-incidents" data-key="severity">等级${sortArrow('severity')}</th>
            <th>状态</th>
            <th style="cursor:pointer;" data-action="sort-incidents" data-key="sla">SLA状态${sortArrow('sla')}</th>
            <th>房间号</th>
            <th>时间</th>
          </tr>
        </thead>
        <tbody>
          ${rows || '<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--text2);">暂无事故记录</td></tr>'}
        </tbody>
      </table>
    </div>
    ${state.showCreateIncident ? renderCreateIncidentModal() : ''}
    ${state.showTemplateList ? renderTemplateListModal() : ''}
  </div>`;
}

function renderCreateIncidentModal() {
  const templateOptions = state.templates.map(t =>
    `<option value="${t.id}">${t.name} (${t.node_count}个节点)</option>`
  ).join('');

  return `
  <div class="modal-overlay" data-action="close-modal">
    <div class="modal" onclick="event.stopPropagation()">
      <h2>创建新事故</h2>
      <div class="form-group">
        <label>使用模板</label>
        <select id="ci-template">
          <option value="">不使用模板</option>
          ${templateOptions}
        </select>
      </div>
      <div class="form-group">
        <label>事故标题</label>
        <input id="ci-title" placeholder="例如：支付服务大规模超时">
      </div>
      <div class="form-group">
        <label>严重等级</label>
        <select id="ci-severity">
          <option value="P0">P0 - 紧急</option>
          <option value="P1" selected>P1 - 严重</option>
          <option value="P2">P2 - 较重</option>
          <option value="P3">P3 - 一般</option>
        </select>
      </div>
      <div class="form-group">
        <label>起始时间</label>
        <input id="ci-start" type="datetime-local" step="1">
      </div>
      <div class="form-group">
        <label>结束时间(可选)</label>
        <input id="ci-end" type="datetime-local" step="1">
      </div>
      <div class="form-group">
        <label>你的姓名</label>
        <input id="ci-owner" value="${state.userName}" placeholder="输入你的姓名">
      </div>
      <div class="modal-actions">
        <button class="btn btn-outline" data-action="close-modal">取消</button>
        <button class="btn btn-primary" data-action="submit-create-incident">创建</button>
      </div>
    </div>
  </div>`;
}

function renderTimeline() {
  const inc = state.currentIncident;
  if (!inc) return '';

  const services = [...new Set(state.nodes.filter(n => !n.is_excluded).map(n => n.service_name))].sort();
  const serviceColors = {};
  services.forEach((s, i) => {
    const hues = [210, 280, 50, 140, 350, 170, 30, 320];
    serviceColors[s] = `hsl(${hues[i % hues.length]}, 70%, 55%)`;
  });

  const isClosed = inc.status === 'closed';

  const slaWarnIcon = inc.sla_violated ? '<span class="sla-title-warn" title="SLA已违规">⚠️</span>' : '';

  return `
  <div id="app" style="display:flex;flex-direction:column;height:100vh;">
    ${renderSlaCountdownBar()}
    <header>
      <h1>
        <span style="cursor:pointer" data-action="go-back">←</span>
        ${slaWarnIcon}
        ${escapeHtml(inc.title)}
        <span class="severity-badge severity-${inc.severity}">${inc.severity}</span>
        <span class="status-tag ${isClosed ? 'status-closed' : 'status-open'}">${isClosed ? '已关闭(只读)' : '进行中'}</span>
      </h1>
      <div class="header-actions">
        <div class="legend">
          ${Object.entries(SRC_LABELS).map(([k, v]) => `<div class="legend-item"><div class="legend-dot" style="background:${SRC_COLORS[k]}"></div>${v}</div>`).join('')}
        </div>
        <div class="user-info">
          <input id="username-input" value="${state.userName}" placeholder="你的姓名" style="width:80px">
        </div>
        ${!isClosed ? `
        <button class="btn btn-primary btn-sm" data-action="add-node">+ 添加事件</button>
        <button class="btn btn-outline btn-sm" data-action="toggle-connection" style="${state.connectionMode ? 'background:var(--primary);color:white' : ''}">🔗 因果链</button>
        ` : `
        <button class="btn btn-outline btn-sm" data-action="save-as-template">📋 另存为模板</button>
        `}
        <button class="btn btn-outline btn-sm ${state.showKeyPath ? 'active' : ''}" data-action="toggle-keypath" style="${state.showKeyPath ? 'background:var(--warning);color:#1a1a1a' : ''}">⚡ 关键路径</button>
        <button class="btn btn-outline btn-sm" data-action="export-md">导出 MD</button>
        ${!isClosed ? `<button class="btn btn-danger btn-sm" data-action="close-incident">关闭事故</button>` : ''}
      </div>
    </header>

    <div class="main-layout">
      <div class="timeline-container">
        <div class="toolbar">
          <span style="font-size:12px;color:var(--text2)">房间: ${inc.room_code}</span>
          <span style="font-size:12px;color:var(--text2)">事件: ${state.nodes.filter(n => !n.is_excluded).length}/500</span>
          ${state.connectionMode ? '<span style="font-size:12px;color:#f472b6">🔗 点击两个节点创建因果链 (按 Esc 取消)</span>' : ''}
          <div class="spacer"></div>
        </div>
        <div class="timeline-scroll" id="timeline-scroll">
          <div class="timeline-canvas" id="timeline-canvas">
            <div class="timeline-axis"><canvas id="axis-canvas"></canvas></div>
            <svg class="causal-svg" id="causal-svg">
              <defs>
                <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
                  <polygon points="0 0, 8 3, 0 6" fill="#f472b6"/>
                </marker>
                <marker id="arrowhead-kp" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
                  <polygon points="0 0, 8 3, 0 6" fill="#fbbf24"/>
                </marker>
              </defs>
            </svg>
            <div class="swim-lanes" id="swim-lanes">
              ${services.map(svc => `
                <div class="swim-lane" data-service="${svc}">
                  <div class="lane-label">
                    <div class="dot" style="background:${serviceColors[svc]}"></div>
                    <span class="service-link" data-action="go-services-detail" data-service="${escapeHtml(svc)}" title="点击查看服务健康度" onclick="event.stopPropagation(); goServicesDetail('${escapeHtml(svc).replace(/'/g, "\\'")}')">${escapeHtml(svc)}</span>
                  </div>
                  <div class="lane-content" data-service="${svc}"></div>
                </div>
              `).join('')}
              ${services.length === 0 ? '<div class="empty-state">暂无事件节点</div>' : ''}
            </div>
          </div>
        </div>
      </div>

      <div class="right-panel">
        <div class="panel-section">
          <div class="panel-header">在线协作者</div>
          <div class="panel-body" id="collab-list">
            ${state.participants.map(p => `
              <div class="collab-item">
                <div class="collab-avatar" style="background:${stringToColor(p.user_name)}">${p.user_name[0].toUpperCase()}</div>
                <span>${p.user_name}</span>
                ${p.role === 'owner' ? '<span style="font-size:10px;color:var(--warning)">负责人</span>' : ''}
                ${state.onlineUsers.has(p.user_name) ? '<div class="online-dot"></div>' : ''}
              </div>
            `).join('')}
          </div>
        </div>
        <div class="panel-section" style="flex:1;display:flex;flex-direction:column;">
          <div class="panel-header">操作日志</div>
          <div class="panel-body" id="log-list" style="flex:1;max-height:none;overflow-y:auto;">
            ${state.logs.map(l => `
              <div class="log-item">
                <span class="log-user">${l.user_name}</span>
                ${formatLogAction(l)}
                <span class="log-time">${formatTime(l.created_at)}</span>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    </div>

    ${isClosed ? renderReviewPanel() : ''}
    ${state.detailNode ? renderDetailCard() : ''}
    ${state.showAddNode ? renderAddNodeModal() : ''}
    ${renderSimilarIncidentsPanel()}
  </div>`;
}

function renderSimilarIncidentsPanel() {
  const si = state.similarIncidents;
  const collapsed = state.similarPanelCollapsed;
  const flashClass = state.similarPanelFlash ? 'flash' : '';

  let content = '';
  if (!collapsed) {
    if (si.kbEmpty) {
      content = `<div class="si-empty">暂无历史数据</div>`;
    } else if (si.needsMoreNodes) {
      content = `<div class="si-empty">积累 ${si.requiredNodeCount} 个节点后开始匹配 (当前 ${si.currentNodeCount}/${si.requiredNodeCount})</div>`;
    } else if (si.matches.length === 0) {
      content = `<div class="si-empty">暂无匹配的相似事故</div>`;
    } else {
      content = si.matches.map(m => {
        const isExpanded = state.expandedSimilarId === m.incidentId;
        const summary = state.similarSummaries[m.incidentId];
        const loading = state.loadingSummaryId === m.incidentId;
        const pct = Math.round(m.similarity * 100);

        return `
          <div class="si-item ${isExpanded ? 'expanded' : ''}">
            <div class="si-item-header" data-action="toggle-similar-expand" data-id="${m.incidentId}">
              <div class="si-item-title-row">
                <span class="si-expand-arrow">${isExpanded ? '▼' : '▶'}</span>
                <span class="si-item-title">${escapeHtml(m.title)}</span>
              </div>
              <div class="si-item-meta">
                <span class="severity-badge severity-${m.severity}" style="padding:1px 6px;font-size:10px;">${m.severity}</span>
                <span class="si-score" style="--pct:${pct}%;background-size:${pct}% 100%;"></span>
                <span class="si-score-text">${pct}%</span>
              </div>
              <div class="si-item-services">
                ${m.services.slice(0, 4).map(s => `<span class="si-service-tag">${escapeHtml(s)}</span>`).join('')}
                ${m.services.length > 4 ? `<span class="si-more-tags">+${m.services.length - 4}</span>` : ''}
              </div>
            </div>
            ${isExpanded ? `
              <div class="si-item-detail">
                <div class="si-detail-section">
                  <div class="si-detail-label">相似度构成</div>
                  <div class="si-score-breakdown">
                    <div class="si-bd-item"><span>服务</span><span>${Math.round(m.serviceScore * 100)}%</span></div>
                    <div class="si-bd-item"><span>来源类型</span><span>${Math.round(m.sourceScore * 100)}%</span></div>
                    <div class="si-bd-item"><span>关键词</span><span>${Math.round(m.keywordScore * 100)}%</span></div>
                  </div>
                </div>
                <div class="si-detail-section">
                  <div class="si-detail-label">因果链摘要</div>
                  ${loading ? `<div class="si-loading">加载中...</div>` : summary ? `
                    <div class="si-causal-summary">
                      <div class="si-structure-note">${summary.structureNote}</div>
                      <div class="si-causal-chain">
                        ${summary.causalSummary.map((cs, idx) => `
                          <div class="si-chain-node">
                            ${idx > 0 ? '<div class="si-chain-arrow">↓</div>' : ''}
                            <div class="si-chain-content">
                              <span class="src-badge src-${cs.sourceType}" style="margin-right:4px;">${SRC_LABELS[cs.sourceType] || cs.sourceType}</span>
                              <span class="si-chain-svc">[${escapeHtml(cs.service)}]</span>
                              <span class="si-chain-desc">${escapeHtml(cs.description)}</span>
                            </div>
                          </div>
                        `).join('')}
                      </div>
                    </div>
                  ` : ''}
                </div>
                <div class="si-detail-section">
                  <div class="si-detail-label">根因描述</div>
                  <div class="si-rootcause">
                    ${summary?.rootCauseDesc ? escapeHtml(summary.rootCauseDesc) : (loading ? '加载中...' : '（未标注）')}
                  </div>
                </div>
                <div class="si-marker-row">
                  <div class="si-marker-counts">
                    <span class="si-marker-helpful">👍 ${m.markers?.helpful || 0}</span>
                    <span class="si-marker-irrelevant">👎 ${m.markers?.irrelevant || 0}</span>
                  </div>
                  <div class="si-marker-btns">
                    <button class="btn btn-outline btn-sm" data-action="mark-similar" data-id="${m.incidentId}" data-type="helpful">👍 有帮助</button>
                    <button class="btn btn-outline btn-sm" data-action="mark-similar" data-id="${m.incidentId}" data-type="irrelevant">👎 无关</button>
                  </div>
                </div>
              </div>
            ` : ''}
          </div>
        `;
      }).join('');
    }
  }

  const countBadge = si.matches && si.matches.length > 0 && !collapsed ?
    `<span class="si-count-badge">${si.matches.length}</span>` : '';

  return `
    <div class="similar-incidents-panel ${flashClass}" id="similar-panel">
      <div class="si-header" data-action="toggle-similar-panel">
        <span class="si-title">
          ${collapsed ? '▶' : '▼'} 相似事故
          ${countBadge}
        </span>
        ${si.generatedAt && !collapsed ? `<span class="si-gen-time">${formatTime(si.generatedAt)}</span>` : ''}
      </div>
      ${!collapsed ? `<div class="si-body">${content}</div>` : ''}
    </div>
  `;
}

function escapeHtml(s) {
  if (!s) return '';
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function renderDetailCard() {
  const n = state.detailNode;
  const inc = state.currentIncident;
  const isOwner = state.userName === inc.owner_id;
  const isCreator = state.userName === n.created_by;
  const canLock = isOwner || isCreator;
  const isClosed = inc.status === 'closed';

  return `
  <div class="detail-card" id="detail-card" style="top:${Math.min(n._cardY || 100, window.innerHeight - 350)}px;left:${Math.min(n._cardX || 200, window.innerWidth - 360)}px">
    <div class="card-header">
      <h3>${n.description}</h3>
      <button class="close-btn" data-action="close-detail">&times;</button>
    </div>
    <div class="card-field"><label>时间:</label>${n.occurred_at}</div>
    <div class="card-field"><label>服务:</label><span class="service-link" data-action="go-services-detail" data-service="${escapeHtml(n.service_name)}" onclick="event.stopPropagation(); goServicesDetail('${escapeHtml(n.service_name).replace(/'/g, "\\'")}')">${escapeHtml(n.service_name)}</span></div>
    <div class="card-field"><label>来源:</label><span class="src-badge src-${n.source_type}">${SRC_LABELS[n.source_type]}</span></div>
    <div class="card-field"><label>创建者:</label>${n.created_by}</div>
    <div class="card-field"><label>状态:</label>
      ${n.is_locked ? '🔒 已锁定' : '未锁定'}
      ${n.is_excluded ? ' ❌ 已排除' : ''}
    </div>
    <div class="card-actions">
      ${!isClosed ? `
        ${canLock ? `<button class="btn btn-outline btn-sm" data-action="toggle-lock" data-id="${n.id}">${n.is_locked ? '🔓 解锁' : '🔒 锁定'}</button>` : ''}
        <button class="btn btn-outline btn-sm" data-action="toggle-exclude" data-id="${n.id}">${n.is_excluded ? '↩ 恢复' : '❌ 排除'}</button>
        ${!n.is_locked ? `<button class="btn btn-outline btn-sm" data-action="edit-node" data-id="${n.id}">✏ 编辑</button>` : ''}
      ` : ''}
      <button class="btn btn-outline btn-sm" data-action="start-connection-from" data-id="${n.id}" style="color:#f472b6">🔗 设为因果起点</button>
    </div>
  </div>`;
}

function renderAddNodeModal() {
  const inc = state.currentIncident;
  return `
  <div class="modal-overlay" data-action="close-modal">
    <div class="modal" onclick="event.stopPropagation()">
      <h2>添加事件节点</h2>
      <div class="form-group">
        <label>发生时间</label>
        <input id="an-time" type="datetime-local" step="1" value="${inc.start_time.slice(0, 19)}">
      </div>
      <div class="form-group">
        <label>事件描述</label>
        <textarea id="an-desc" placeholder="描述发生了什么..."></textarea>
      </div>
      <div class="form-group">
        <label>来源类型</label>
        <select id="an-src">
          <option value="log">日志</option>
          <option value="chat">聊天</option>
          <option value="monitor">监控</option>
          <option value="manual">人工标注</option>
        </select>
      </div>
      <div class="form-group">
        <label>服务名称</label>
        <input id="an-svc" placeholder="例如: payment-gateway">
      </div>
      <div class="modal-actions">
        <button class="btn btn-outline" data-action="close-modal">取消</button>
        <button class="btn btn-primary" data-action="submit-add-node">添加</button>
      </div>
    </div>
  </div>`;
}

function renderTimelineGraphics() {
  const nodes = state.nodes;
  if (nodes.length === 0) return;

  const activeNodes = nodes.filter(n => !n.is_excluded);
  if (activeNodes.length === 0) return;

  const times = activeNodes.map(n => new Date(n.occurred_at).getTime());
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const range = maxTime - minTime || 60000;

  const services = [...new Set(activeNodes.map(n => n.service_name))].sort();
  const laneMap = {};
  services.forEach((s, i) => laneMap[s] = i);

  const PADDING_LEFT = 180;
  const PADDING_RIGHT = 60;
  const LANE_HEIGHT = 90;
  const NODE_Y_OFFSET = 45;
  const TIMELINE_WIDTH = Math.max(window.innerWidth - 280 - PADDING_LEFT - PADDING_RIGHT, range / 1000 * 8);

  const canvas = document.getElementById('timeline-canvas');
  if (canvas) canvas.style.width = TIMELINE_WIDTH + PADDING_LEFT + PADDING_RIGHT + 'px';

  const scrollEl = document.getElementById('timeline-scroll');
  const axisCanvas = document.getElementById('axis-canvas');
  if (axisCanvas) {
    axisCanvas.width = (TIMELINE_WIDTH + PADDING_LEFT + PADDING_RIGHT) * window.devicePixelRatio;
    axisCanvas.height = 36 * window.devicePixelRatio;
    axisCanvas.style.width = (TIMELINE_WIDTH + PADDING_LEFT + PADDING_RIGHT) + 'px';
    axisCanvas.style.height = '36px';
    const ctx = axisCanvas.getContext('2d');
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    ctx.clearRect(0, 0, axisCanvas.width, axisCanvas.height);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px sans-serif';

    const tickCount = Math.max(Math.floor(TIMELINE_WIDTH / 100), 4);
    for (let i = 0; i <= tickCount; i++) {
      const x = PADDING_LEFT + (i / tickCount) * TIMELINE_WIDTH;
      const t = new Date(minTime + (i / tickCount) * range);
      ctx.fillText(t.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }), x, 22);
      ctx.strokeStyle = '#334155';
      ctx.beginPath();
      ctx.moveTo(x, 30);
      ctx.lineTo(x, 36);
      ctx.stroke();
    }
  }

  activeNodes.forEach(n => {
    const frac = (new Date(n.occurred_at).getTime() - minTime) / range;
    n._x = PADDING_LEFT + frac * TIMELINE_WIDTH;
    n._laneY = (laneMap[n.service_name] || 0) * LANE_HEIGHT + NODE_Y_OFFSET;
  });

  document.querySelectorAll('.lane-content').forEach(el => {
    const svc = el.dataset.service;
    el.innerHTML = '';
    const laneNodes = activeNodes.filter(n => n.service_name === svc);
    laneNodes.forEach(n => {
      const nodeEl = document.createElement('div');
      nodeEl.className = `tl-node src-${n.source_type}${n.is_locked ? ' locked' : ''}${n.is_excluded ? ' excluded' : ''}${state.keyPath.includes(n.id) && state.showKeyPath ? ' key-path' : ''}${state.selectedNodeId === n.id ? ' selected' : ''}`;
      nodeEl.dataset.id = n.id;
      nodeEl.style.left = n._x + 'px';
      nodeEl.style.top = n._laneY + 'px';
      if (!n.is_excluded && !n.is_locked && state.currentIncident?.status !== 'closed') {
        nodeEl.draggable = true;
      }
      nodeEl.title = `${n.occurred_at} - ${n.description}`;

      const label = document.createElement('div');
      label.className = 'node-label';
      label.style.left = n._x + 'px';
      label.style.top = (n._laneY + 8) + 'px';
      label.textContent = n.description.substring(0, 15) + (n.description.length > 15 ? '...' : '');
      el.appendChild(label);
      el.appendChild(nodeEl);
    });
  });

  renderCausalArrows(activeNodes);
  renderDuplicateConnectors(activeNodes);
}

function renderCausalArrows(nodes) {
  const svg = document.getElementById('causal-svg');
  if (!svg) return;
  const existingDefs = svg.querySelector('defs');
  svg.innerHTML = '';
  if (existingDefs) svg.appendChild(existingDefs);

  const nodeMap = {};
  nodes.forEach(n => nodeMap[n.id] = n);

  state.causalLinks.forEach(link => {
    const from = nodeMap[link.from_node_id];
    const to = nodeMap[link.to_node_id];
    if (!from || !to) return;

    const isKP = state.showKeyPath && isLinkOnKeyPath(link);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const x1 = from._x || 0;
    const y1 = from._laneY || 0;
    const x2 = to._x || 0;
    const y2 = to._laneY || 0;

    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2 - 20;
    line.setAttribute('d', `M${x1},${y1} Q${midX},${midY} ${x2},${y2}`);
    line.setAttribute('class', `causal-arrow${isKP ? ' key-path' : ''}`);
    line.setAttribute('marker-end', isKP ? 'url(#arrowhead-kp)' : 'url(#arrowhead)');
    line.dataset.linkId = link.id;
    svg.appendChild(line);
  });
}

function renderDuplicateConnectors(nodes) {
  const svg = document.getElementById('causal-svg');
  if (!svg) return;
  const nodeMap = {};
  nodes.forEach(n => nodeMap[n.id] = n);

  state.duplicates.filter(d => d.status === 'suspected').forEach(dup => {
    const a = nodeMap[dup.node_id_a];
    const b = nodeMap[dup.node_id_b];
    if (!a || !b) return;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', a._x || 0);
    line.setAttribute('y1', a._laneY || 0);
    line.setAttribute('x2', b._x || 0);
    line.setAttribute('y2', b._laneY || 0);
    line.setAttribute('stroke', '#f59e0b');
    line.setAttribute('stroke-width', '1.5');
    line.setAttribute('stroke-dasharray', '4 3');
    svg.appendChild(line);

    const midX = ((a._x || 0) + (b._x || 0)) / 2;
    const midY = ((a._laneY || 0) + (b._laneY || 0)) / 2 - 12;
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', midX);
    text.setAttribute('y', midY);
    text.setAttribute('fill', '#f59e0b');
    text.setAttribute('font-size', '10');
    text.setAttribute('text-anchor', 'middle');
    text.textContent = '疑似重复';
    svg.appendChild(text);
  });
}

function isLinkOnKeyPath(link) {
  const kp = state.keyPath;
  for (let i = 0; i < kp.length - 1; i++) {
    if (kp[i] === link.from_node_id && kp[i + 1] === link.to_node_id) return true;
  }
  return false;
}

function renderTemplateListModal() {
  const items = state.templates.map(t => `
    <div class="template-item">
      <div class="template-info">
        <div class="template-name">${t.name}</div>
        <div class="template-meta">来源事故: ${t.source_incident_id.substring(0,8)}... | ${t.node_count}个节点 | ${t.created_at}</div>
      </div>
      <button class="btn btn-danger btn-sm" data-action="delete-template" data-id="${t.id}">删除</button>
    </div>
  `).join('');

  return `
  <div class="modal-overlay" data-action="close-modal">
    <div class="modal" onclick="event.stopPropagation()" style="width:560px;">
      <h2>事故模板管理</h2>
      <div class="template-list">
        ${items || '<div class="empty-state">暂无模板</div>'}
      </div>
      <div class="modal-actions">
        <button class="btn btn-outline" data-action="close-modal">关闭</button>
      </div>
    </div>
  </div>`;
}

function renderReviewPanel() {
  const review = state.currentReview;
  if (review) {
    return `
    <div class="review-panel">
      <div class="review-panel-header">复盘评分</div>
      <div class="review-scores">
        <div class="review-score-item">
          <label>响应速度</label>
          <div class="score-stars">${renderStars(review.response_speed)}</div>
        </div>
        <div class="review-score-item">
          <label>协作效率</label>
          <div class="score-stars">${renderStars(review.collaboration)}</div>
        </div>
        <div class="review-score-item">
          <label>根因定位准确度</label>
          <div class="score-stars">${renderStars(review.root_cause_accuracy)}</div>
        </div>
      </div>
      ${review.improvement_suggestions ? `<div class="review-text-field"><label>改进建议</label><p>${review.improvement_suggestions}</p></div>` : ''}
      ${review.summary ? `<div class="review-text-field"><label>总结</label><p>${review.summary}</p></div>` : ''}
      <div class="review-footer">评分已提交，不可修改</div>
    </div>`;
  }

  if (state.showReviewForm) {
    return `
    <div class="review-panel">
      <div class="review-panel-header">提交复盘评分</div>
      <div class="form-group">
        <label>响应速度 (1-5)</label>
        <div class="score-input" id="rv-speed">
          ${[1,2,3,4,5].map(n => `<span class="star-btn" data-score="${n}" data-dim="speed">★</span>`).join('')}
        </div>
      </div>
      <div class="form-group">
        <label>协作效率 (1-5)</label>
        <div class="score-input" id="rv-collab">
          ${[1,2,3,4,5].map(n => `<span class="star-btn" data-score="${n}" data-dim="collab">★</span>`).join('')}
        </div>
      </div>
      <div class="form-group">
        <label>根因定位准确度 (1-5)</label>
        <div class="score-input" id="rv-root">
          ${[1,2,3,4,5].map(n => `<span class="star-btn" data-score="${n}" data-dim="root">★</span>`).join('')}
        </div>
      </div>
      <div class="form-group">
        <label>改进建议</label>
        <textarea id="rv-suggestions" placeholder="对后续改进的建议..."></textarea>
      </div>
      <div class="form-group">
        <label>总结</label>
        <textarea id="rv-summary" placeholder="事故复盘总结..."></textarea>
      </div>
      <div class="review-form-actions">
        <button class="btn btn-outline" data-action="cancel-review">取消</button>
        <button class="btn btn-primary" data-action="submit-review">提交评分</button>
      </div>
    </div>`;
  }

  return `
  <div class="review-panel">
    <div class="review-panel-header">复盘评分</div>
    <div class="review-empty">
      <p>该事故尚未提交复盘评分</p>
      <button class="btn btn-primary btn-sm" data-action="show-review-form">填写评分</button>
    </div>
  </div>`;
}

function renderStars(score) {
  return [1,2,3,4,5].map(n =>
    `<span class="star ${n <= score ? 'star-filled' : ''}">★</span>`
  ).join('');
}

function renderStatsPage() {
  const stats = state.reviewStats;
  if (!stats) return '<div class="stats-page"><h1>加载中...</h1></div>';

  const overall = stats.overall;
  const monthly = stats.monthly || [];

  return `
  <div class="stats-page">
    <header>
      <h1>
        <span style="cursor:pointer" data-action="go-back-list">←</span>
        复盘评分统计
      </h1>
    </header>
    <div class="stats-content">
      ${overall && overall.total_count > 0 ? `
      <div class="stats-overview">
        <div class="stat-card">
          <div class="stat-value">${overall.avg_overall || '-'}</div>
          <div class="stat-label">综合平均分</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${overall.avg_response_speed || '-'}</div>
          <div class="stat-label">响应速度</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${overall.avg_collaboration || '-'}</div>
          <div class="stat-label">协作效率</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${overall.avg_root_cause_accuracy || '-'}</div>
          <div class="stat-label">根因定位</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${overall.total_count}</div>
          <div class="stat-label">已评分事故数</div>
        </div>
      </div>
      <div class="stats-chart-container">
        <h2>各维度月度趋势</h2>
        <canvas id="stats-chart" width="800" height="350"></canvas>
      </div>
      ` : '<div class="empty-state">暂无评分数据</div>'}
    </div>
  </div>`;
}

function bindEvents() {
  document.querySelectorAll('[data-action]').forEach(el => {
    el.onclick = handleAction;
  });

  const slaFilterEl = document.getElementById('sla-filter');
  if (slaFilterEl) {
    slaFilterEl.onchange = (e) => {
      state.slaFilter = e.target.value;
      render();
    };
  }

  document.querySelectorAll('.star-btn').forEach(el => {
    el.onclick = (e) => {
      e.stopPropagation();
      const score = parseInt(el.dataset.score);
      const dim = el.dataset.dim;
      const container = el.parentElement;
      container.querySelectorAll('.star-btn').forEach(s => {
        s.classList.toggle('star-btn-selected', parseInt(s.dataset.score) <= score);
      });
      container.dataset.value = score;
    };
  });

  document.querySelectorAll('.tl-node').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = el.dataset.id;
      if (state.connectionMode) {
        handleConnectionClick(id);
        return;
      }
      state.selectedNodeId = id;
      state.detailNode = state.nodes.find(n => n.id === id);
      if (state.detailNode && state.detailNode._x) {
        state.detailNode._cardX = Math.min(state.detailNode._x + 20, window.innerWidth - 360);
        state.detailNode._cardY = 80;
      }
      render();
    });

    el.addEventListener('mouseenter', () => {
      el.style.zIndex = '9';
    });

    el.addEventListener('mouseleave', () => {
      el.style.zIndex = '6';
    });

    if (el.draggable) {
      el.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', el.dataset.id);
        el.classList.add('dragging');
      });
      el.addEventListener('dragend', () => {
        el.classList.remove('dragging');
      });
    }
  });

  document.querySelectorAll('.lane-content').forEach(el => {
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      const nodeId = e.dataTransfer.getData('text/plain');
      if (!nodeId) return;
      const rect = el.getBoundingClientRect();
      const dropX = e.clientX - rect.left + el.scrollLeft;
      handleNodeDrop(nodeId, dropX);
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      state.connectionMode = false;
      state.connectionFrom = null;
      state.detailNode = null;
      render();
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.detail-card') && !e.target.closest('.tl-node')) {
      state.detailNode = null;
      state.selectedNodeId = null;
    }
  });

  const selectAllBtn = document.getElementById('sub-select-all');
  if (selectAllBtn) {
    selectAllBtn.onclick = () => {
      document.querySelectorAll('.subscription-checkbox').forEach(cb => cb.checked = true);
    };
  }

  const selectNoneBtn = document.getElementById('sub-select-none');
  if (selectNoneBtn) {
    selectNoneBtn.onclick = () => {
      document.querySelectorAll('.subscription-checkbox').forEach(cb => cb.checked = false);
    };
  }
}

function handleAction(e) {
  const action = e.currentTarget.dataset.action;
  const id = e.currentTarget.dataset.id;

  switch (action) {
    case 'open-incident': openIncident(id); break;
    case 'go-back': leaveIncident(); break;
    case 'create-incident': state.showCreateIncident = true; render(); break;
    case 'close-modal': state.showCreateIncident = false; state.showAddNode = false; state.showTemplateList = false; state.showReviewForm = false; render(); break;
    case 'submit-create-incident': submitCreateIncident(); break;
    case 'add-node': state.showAddNode = true; render(); break;
    case 'submit-add-node': submitAddNode(); break;
    case 'toggle-connection':
      state.connectionMode = !state.connectionMode;
      state.connectionFrom = null;
      document.body.classList.toggle('connection-mode', state.connectionMode);
      render();
      break;
    case 'toggle-keypath': toggleKeyPath(); break;
    case 'export-md': exportMarkdown(); break;
    case 'close-incident': closeIncident(); break;
    case 'close-detail': state.detailNode = null; state.selectedNodeId = null; render(); break;
    case 'toggle-lock': toggleLock(id); break;
    case 'toggle-exclude': toggleExclude(id); break;
    case 'start-connection-from':
      state.connectionMode = true;
      state.connectionFrom = id;
      document.body.classList.add('connection-mode');
      state.detailNode = null;
      render();
      break;
    case 'save-as-template': saveAsTemplate(); break;
    case 'show-template-list': loadAndShowTemplates(); break;
    case 'delete-template': deleteTemplate(id); break;
    case 'go-stats': goStats(); break;
    case 'go-services': goServices(); break;
    case 'go-services-detail': goServicesDetail(e.currentTarget.dataset.service); break;
    case 'go-oncall': goOncall(); break;
    case 'oncall-prev-week': oncallPrevWeek(); break;
    case 'oncall-next-week': oncallNextWeek(); break;
    case 'oncall-show-plan-modal': state.showOncallPlanModal = true; state.editingPlanId = null; render(); break;
    case 'oncall-edit-plan': state.showOncallPlanModal = true; state.editingPlanId = e.currentTarget.dataset.id; render(); break;
    case 'oncall-delete-plan': deleteOncallPlan(e.currentTarget.dataset.id); break;
    case 'oncall-close-plan-modal': state.showOncallPlanModal = false; state.editingPlanId = null; render(); break;
    case 'oncall-save-plan': saveOncallPlan(); break;
    case 'oncall-show-swap-modal': showSwapModal(e.currentTarget.dataset); break;
    case 'oncall-close-swap-modal': state.showSwapModal = false; state.swapData = null; render(); break;
    case 'oncall-save-swap': saveSwap(); break;
    case 'go-back-list': leaveToStatsOrList(); break;
    case 'show-review-form': state.showReviewForm = true; render(); break;
    case 'cancel-review': state.showReviewForm = false; render(); break;
    case 'submit-review': submitReview(); break;
    case 'toggle-similar-panel':
      state.similarPanelCollapsed = !state.similarPanelCollapsed;
      state.similarPanelFlash = false;
      render();
      break;
    case 'toggle-similar-expand':
      toggleSimilarExpand(id);
      break;
    case 'mark-similar':
      markSimilarRecommendation(id, e.currentTarget.dataset.type);
      break;
    case 'refresh-service-graph':
      loadServiceNetwork();
      break;
    case 'recalculate-services':
      recalculateServices();
      break;
    case 'open-service-incident':
      openIncidentFromService(e.currentTarget.dataset.id);
      break;
    case 'go-sla':
      goSla();
      break;
    case 'sla-edit':
      startSlaEdit(e.currentTarget.dataset.severity);
      break;
    case 'sla-cancel-edit':
      state.slaEditingSeverity = null;
      render();
      break;
    case 'sla-save':
      saveSlaRule(e.currentTarget.dataset.severity);
      break;
    case 'sort-incidents':
      setIncidentsSort(e.currentTarget.dataset.key);
      break;
    case 'go-subscriptions':
      goSubscriptions();
      break;
    case 'toggle-notification-panel':
      toggleNotificationPanel();
      break;
    case 'mark-notification-read':
      markNotificationRead(e.currentTarget.dataset.id);
      break;
    case 'mark-all-notifications-read':
      markAllNotificationsRead();
      break;
    case 'open-notification-incident':
      openNotificationIncident(e.currentTarget.dataset.id, e.currentTarget.dataset.notifid);
      break;
    case 'save-subscriptions':
      saveSubscriptions();
      break;
  }
}

async function openIncident(id) {
  const userName = document.getElementById('username-input')?.value || state.userName;
  if (!userName) { showToast('请输入你的姓名'); return; }
  state.userName = userName;
  localStorage.setItem('tl_username', userName);

  stopSlaCountdownTimer();

  const [incRes, nodesRes, linksRes, dupsRes, partsRes, logsRes, slaRes] = await Promise.all([
    fetch(`${API}/incidents/${id}`),
    fetch(`${API}/incidents/${id}/nodes`),
    fetch(`${API}/incidents/${id}/causal-links`),
    fetch(`${API}/incidents/${id}/duplicates`),
    fetch(`${API}/incidents/${id}/participants`),
    fetch(`${API}/incidents/${id}/logs`),
    fetch(`${API}/sla/incidents/${id}/status`),
  ]);

  state.currentIncident = await incRes.json();
  state.nodes = await nodesRes.json();
  state.causalLinks = await linksRes.json();
  state.duplicates = await dupsRes.json();
  state.participants = await partsRes.json();
  state.logs = await logsRes.json();
  try {
    const slaStatus = await slaRes.json();
    slaStatus._lastFetched = Date.now();
    state.currentSlaStatus = slaStatus;
  } catch (e) {
    state.currentSlaStatus = null;
  }

  await fetch(`${API}/incidents/${id}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userName: state.userName })
  });

  const kpRes = await fetch(`${API}/incidents/${id}/key-path`);
  const kpData = await kpRes.json();
  state.keyPath = kpData.path || [];

  const reviewRes = await fetch(`${API}/incidents/${id}/reviews`);
  state.currentReview = await reviewRes.json();

  try {
    const similarRes = await fetch(`${API}/incidents/${id}/similar`);
    state.similarIncidents = await similarRes.json();
  } catch (e) {
    console.warn('load similar incidents failed:', e);
  }
  state.similarSummaries = {};
  state.expandedSimilarId = null;
  state.similarPanelFlash = false;

  state.view = 'timeline';
  state.detailNode = null;
  state.selectedNodeId = null;
  state.connectionMode = false;
  state.showReviewForm = false;

  connectWS(id);
  startSlaCountdownTimer();
  render();
}

async function refreshCurrentSlaStatus() {
  if (!state.currentIncident) return;
  try {
    const res = await fetch(`${API}/sla/incidents/${state.currentIncident.id}/status`);
    const slaStatus = await res.json();
    slaStatus._lastFetched = Date.now();
    state.currentSlaStatus = slaStatus;
    if (state.currentIncident) {
      state.currentIncident.sla_violated = slaStatus.slaViolated ? 1 : 0;
    }
  } catch (e) {}
}

function handleSlaBreachPush(payload) {
  showToast(`⚠️ SLA 超时：${payload.stageLabel}（${payload.thresholdMinutes}分钟）`);
  if (payload.markedViolated && state.currentIncident) {
    state.currentIncident.sla_violated = 1;
  }
  refreshCurrentSlaStatus();
  refreshLogs();
  if (state.view === 'timeline') render();
}

function handleSimilarIncidentsPush(payload) {
  const before = JSON.stringify(state.similarIncidents.matches.map(m => m.incidentId).sort());
  state.similarIncidents = { ...state.similarIncidents, ...payload };
  const after = JSON.stringify(payload.matches.map(m => m.incidentId).sort());
  if (before !== after || payload.matches.length > 0) {
    state.similarPanelFlash = true;
    showToast('已为你推荐相似历史事故');
    setTimeout(() => {
      state.similarPanelFlash = false;
      if (state.view === 'timeline') render();
    }, 4000);
  }
  if (state.view === 'timeline') render();
}

function handleMarkerUpdate(payload) {
  const matches = state.similarIncidents.matches || [];
  const match = matches.find(m => m.incidentId === payload.recommendedIncidentId);
  if (!match) return;
  if (!match.markers) match.markers = { helpful: 0, irrelevant: 0 };
  if (payload.markType === 'helpful') {
    match.markers.helpful = Math.max(0, match.markers.helpful + 1);
  } else if (payload.markType === 'irrelevant') {
    match.markers.irrelevant = Math.max(0, match.markers.irrelevant + 1);
  }
  if (state.view === 'timeline') render();
}

async function toggleSimilarExpand(incidentId) {
  if (state.expandedSimilarId === incidentId) {
    state.expandedSimilarId = null;
    render();
    return;
  }
  state.expandedSimilarId = incidentId;
  if (!state.similarSummaries[incidentId]) {
    state.loadingSummaryId = incidentId;
    render();
    try {
      const current = state.currentIncident;
      const res = await fetch(`${API}/incidents/${current.id}/similar-summary/${incidentId}`);
      state.similarSummaries[incidentId] = await res.json();
    } catch (e) {
      console.warn('load summary failed:', e);
      state.similarSummaries[incidentId] = { causalSummary: [], structureNote: '加载失败', rootCauseDesc: null };
    }
    state.loadingSummaryId = null;
  }
  render();
}

async function markSimilarRecommendation(incidentId, markType) {
  const current = state.currentIncident;
  const userName = state.userName;
  if (!userName) { showToast('请先设置姓名'); return; }
  try {
    const res = await fetch(`${API}/incidents/${current.id}/similar-marker`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recommendedIncidentId: incidentId, markType, userName })
    });
    if (res.ok) {
      showToast(markType === 'helpful' ? '已标记为有帮助' : '已标记为无关');
    }
  } catch (e) {
    console.warn('mark failed:', e);
  }
}

function leaveIncident() {
  if (state.ws) { state.ws.close(); state.ws = null; }
  stopSlaCountdownTimer();
  state.view = 'list';
  state.currentIncident = null;
  state.currentSlaStatus = null;
  state.nodes = [];
  state.causalLinks = [];
  state.duplicates = [];
  state.keyPath = [];
  state.onlineUsers.clear();
  loadIncidents();
}

async function submitCreateIncident() {
  const title = document.getElementById('ci-title').value;
  const severity = document.getElementById('ci-severity').value;
  const startTime = document.getElementById('ci-start').value;
  const endTime = document.getElementById('ci-end').value;
  const ownerName = document.getElementById('ci-owner').value;
  const templateId = document.getElementById('ci-template')?.value;
  if (!title || !startTime) { showToast('请填写标题和起始时间'); return; }
  state.userName = ownerName || state.userName;
  localStorage.setItem('tl_username', state.userName);

  const body = { title, severity, startTime: new Date(startTime).toISOString(), endTime: endTime ? new Date(endTime).toISOString() : null, ownerName };
  const url = templateId ? `${API}/incidents/from-template/${templateId}` : `${API}/incidents`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (res.ok) {
    state.showCreateIncident = false;
    loadIncidents();
  } else {
    const err = await res.json();
    showToast(err.error || '创建失败');
  }
}

async function submitAddNode() {
  const inc = state.currentIncident;
  const time = document.getElementById('an-time').value;
  const desc = document.getElementById('an-desc').value;
  const src = document.getElementById('an-src').value;
  const svc = document.getElementById('an-svc').value;
  if (!time || !desc || !svc) { showToast('请填写所有字段'); return; }

  const res = await fetch(`${API}/incidents/${inc.id}/nodes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      occurredAt: time,
      description: desc,
      sourceType: src,
      serviceName: svc,
      createdBy: state.userName
    })
  });
  if (res.ok) {
    state.showAddNode = false;
    const node = await res.json();
    state.nodes.push(node);
    await refreshDups();
    render();
  }
}

async function toggleLock(nodeId) {
  const inc = state.currentIncident;
  await fetch(`${API}/incidents/${inc.id}/nodes/${nodeId}/lock`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userName: state.userName })
  });
  await refreshNodes();
  state.detailNode = state.nodes.find(n => n.id === nodeId);
  render();
}

async function toggleExclude(nodeId) {
  const inc = state.currentIncident;
  await fetch(`${API}/incidents/${inc.id}/nodes/${nodeId}/exclude`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userName: state.userName })
  });
  await refreshNodes();
  state.detailNode = state.nodes.find(n => n.id === nodeId);
  render();
}

async function handleNodeDrop(nodeId, dropX) {
  const nodes = state.nodes.filter(n => !n.is_excluded);
  if (nodes.length < 2) return;
  const times = nodes.map(n => new Date(n.occurred_at).getTime());
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const range = maxTime - minTime || 60000;

  const scrollEl = document.getElementById('timeline-scroll');
  const PADDING_LEFT = 180;
  const TIMELINE_WIDTH = Math.max(window.innerWidth - 280 - PADDING_LEFT - 60, range / 1000 * 8);
  const frac = Math.max(0, Math.min(1, (dropX - PADDING_LEFT) / TIMELINE_WIDTH));
  const newTime = new Date(minTime + frac * range);

  const inc = state.currentIncident;
  const node = state.nodes.find(n => n.id === nodeId);
  if (!node || node.is_locked) return;

  await fetch(`${API}/incidents/${inc.id}/nodes/${nodeId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      occurredAt: newTime.toISOString(),
      userName: state.userName
    })
  });
  await refreshNodes();
  render();
}

function handleConnectionClick(nodeId) {
  if (!state.connectionFrom) {
    state.connectionFrom = nodeId;
    showToast('已选择起点，请点击目标节点');
    return;
  }
  if (state.connectionFrom === nodeId) {
    showToast('不能连接自身');
    return;
  }
  createCausalLink(state.connectionFrom, nodeId);
  state.connectionFrom = null;
  state.connectionMode = false;
  document.body.classList.remove('connection-mode');
}

async function createCausalLink(fromId, toId) {
  const inc = state.currentIncident;
  const res = await fetch(`${API}/incidents/${inc.id}/causal-links`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fromNodeId: fromId, toNodeId: toId, createdBy: state.userName })
  });
  if (res.ok) {
    const link = await res.json();
    state.causalLinks.push(link);
    await refreshKeyPath();
    render();
  } else {
    const err = await res.json();
    showToast(err.error || '操作失败');
  }
}

async function toggleKeyPath() {
  state.showKeyPath = !state.showKeyPath;
  if (state.showKeyPath) {
    await refreshKeyPath();
  }
  render();
}

async function refreshKeyPath() {
  const inc = state.currentIncident;
  const res = await fetch(`${API}/incidents/${inc.id}/key-path`);
  const data = await res.json();
  state.keyPath = data.path || [];
}

async function exportMarkdown() {
  const inc = state.currentIncident;
  window.open(`${API}/incidents/${inc.id}/export`, '_blank');
}

async function closeIncident() {
  if (!confirm('确认关闭事故？关闭后时间线将变为只读。')) return;
  const inc = state.currentIncident;
  await fetch(`${API}/incidents/${inc.id}/close`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userName: state.userName })
  });
  await refreshIncident();
  render();
}

async function refreshNodes() {
  const inc = state.currentIncident;
  const res = await fetch(`${API}/incidents/${inc.id}/nodes`);
  state.nodes = await res.json();
}

async function refreshDups() {
  const inc = state.currentIncident;
  const res = await fetch(`${API}/incidents/${inc.id}/duplicates`);
  state.duplicates = await res.json();
}

async function refreshIncident() {
  const inc = state.currentIncident;
  const res = await fetch(`${API}/incidents/${inc.id}`);
  state.currentIncident = await res.json();
}

async function refreshLogs() {
  const inc = state.currentIncident;
  const res = await fetch(`${API}/incidents/${inc.id}/logs`);
  state.logs = await res.json();
}

function connectWS(incidentId) {
  if (state.ws) state.ws.close();
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  state.ws = ws;

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', incidentId, userName: state.userName }));
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      handleWSMessage(msg);
    } catch (err) {
      console.error('ws parse error', err);
    }
  };

  ws.onclose = () => {
    setTimeout(() => {
      if (state.currentIncident && state.currentIncident.id === incidentId) {
        connectWS(incidentId);
      }
    }, 2000);
  };
}

function handleWSMessage(msg) {
  switch (msg.type) {
    case 'node_added':
      if (!state.nodes.find(n => n.id === msg.node.id)) {
        state.nodes.push(msg.node);
      }
      refreshDups();
      refreshLogs();
      render();
      break;
    case 'node_updated':
      const idx = state.nodes.findIndex(n => n.id === msg.node.id);
      if (idx >= 0) state.nodes[idx] = { ...state.nodes[idx], ...msg.node };
      refreshLogs();
      render();
      break;
    case 'causal_link_added':
      if (!state.causalLinks.find(l => l.id === msg.link.id)) {
        state.causalLinks.push(msg.link);
      }
      refreshKeyPath();
      refreshLogs();
      render();
      break;
    case 'causal_link_deleted':
      state.causalLinks = state.causalLinks.filter(l => l.id !== msg.linkId);
      refreshKeyPath();
      refreshLogs();
      render();
      break;
    case 'duplicate_updated':
      const di = state.duplicates.findIndex(d => d.id === msg.duplicate.id);
      if (di >= 0) state.duplicates[di] = msg.duplicate;
      else state.duplicates.push(msg.duplicate);
      render();
      break;
    case 'participant_joined':
      if (!state.participants.find(p => p.id === msg.participant.id)) {
        state.participants.push(msg.participant);
      }
      render();
      break;
    case 'user_online':
      state.onlineUsers.add(msg.userName);
      render();
      break;
    case 'user_offline':
      state.onlineUsers.delete(msg.userName);
      render();
      break;
    case 'incident_closed':
      refreshIncident();
      render();
      break;
    case 'review_submitted':
      state.currentReview = msg.review;
      state.showReviewForm = false;
      refreshLogs();
      showToast('收到其他协作者提交的复盘评分');
      render();
      break;
    case 'similar_incidents':
      handleSimilarIncidentsPush(msg.payload);
      break;
    case 'recommendation_marker_updated':
      handleMarkerUpdate(msg.payload);
      break;
    case 'incident_reopened':
      refreshIncident();
      render();
      break;
    case 'sla_breach':
      handleSlaBreachPush(msg);
      break;
    case 'new_notification':
      handleNewNotificationPush(msg.notification);
      break;
  }
}

async function loadIncidents() {
  const res = await fetch(`${API}/incidents`);
  state.incidents = await res.json();
  const tmplRes = await fetch(`${API}/templates`);
  state.templates = await tmplRes.json();
  try {
    const slaRes = await fetch(`${API}/sla/incidents/batch`);
    const slaStatuses = await slaRes.json();
    state.slaStatuses = {};
    for (const s of slaStatuses) {
      state.slaStatuses[s.incidentId] = s;
    }
  } catch (e) {
    state.slaStatuses = {};
  }
  render();
}

async function goSla() {
  state.view = 'sla';
  state.slaEditingSeverity = null;
  try {
    const res = await fetch(`${API}/sla/rules`);
    state.slaRules = await res.json();
  } catch (e) {
    state.slaRules = [];
  }
  render();
}

function startSlaEdit(severity) {
  const rule = state.slaRules.find(r => r.severity === severity);
  if (!rule) return;
  state.slaEditingSeverity = severity;
  state.slaEditDraft[severity] = {
    firstResponseMinutes: rule.first_response_minutes,
    escalationMinutes: rule.escalation_minutes,
    closureMinutes: rule.closure_minutes
  };
  render();
}

async function saveSlaRule(severity) {
  const frEl = document.getElementById(`sla-in-fr-${severity}`);
  const esEl = document.getElementById(`sla-in-es-${severity}`);
  const clEl = document.getElementById(`sla-in-cl-${severity}`);
  if (!frEl || !esEl || !clEl) return;

  const body = {
    firstResponseMinutes: parseInt(frEl.value),
    escalationMinutes: parseInt(esEl.value),
    closureMinutes: parseInt(clEl.value)
  };
  if ([body.firstResponseMinutes, body.escalationMinutes, body.closureMinutes].some(v => !v || v <= 0)) {
    showToast('时限必须是正整数');
    return;
  }
  try {
    const res = await fetch(`${API}/sla/rules/${severity}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (res.ok) {
      state.slaEditingSeverity = null;
      const rulesRes = await fetch(`${API}/sla/rules`);
      state.slaRules = await rulesRes.json();
      showToast('SLA规则已更新');
    } else {
      const err = await res.json();
      showToast(err.error || '保存失败');
    }
  } catch (e) {
    showToast('保存失败');
  }
  render();
}

function setIncidentsSort(key) {
  if (state.slaSortKey === key) {
    state.slaSortAsc = !state.slaSortAsc;
  } else {
    state.slaSortKey = key;
    state.slaSortAsc = true;
  }
  render();
}

async function saveAsTemplate() {
  const inc = state.currentIncident;
  if (!inc || inc.status !== 'closed') return;
  const name = prompt('请输入模板名称:', inc.title + ' (模板)');
  if (!name) return;
  const res = await fetch(`${API}/templates/from-incident/${inc.id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
  if (res.ok) {
    showToast('模板已保存');
    const tmplRes = await fetch(`${API}/templates`);
    state.templates = await tmplRes.json();
  } else {
    const err = await res.json();
    showToast(err.error || '保存失败');
  }
}

async function loadAndShowTemplates() {
  const res = await fetch(`${API}/templates`);
  state.templates = await res.json();
  state.showTemplateList = true;
  render();
}

async function deleteTemplate(id) {
  if (!confirm('确认删除此模板?')) return;
  await fetch(`${API}/templates/${id}`, { method: 'DELETE' });
  const res = await fetch(`${API}/templates`);
  state.templates = await res.json();
  render();
}

async function goStats() {
  state.view = 'stats';
  const res = await fetch(`${API}/reviews/stats`);
  state.reviewStats = await res.json();
  render();
  renderStatsChart();
}

function leaveToStatsOrList() {
  history.pushState({}, '', '/');
  state.view = 'list';
  state.reviewStats = null;
  state.currentIncident = null;
  if (state.ws) { state.ws.close(); state.ws = null; }
  loadIncidents();
}

async function submitReview() {
  const inc = state.currentIncident;
  const speedVal = parseInt(document.getElementById('rv-speed')?.dataset.value || '0');
  const collabVal = parseInt(document.getElementById('rv-collab')?.dataset.value || '0');
  const rootVal = parseInt(document.getElementById('rv-root')?.dataset.value || '0');
  if (!speedVal || !collabVal || !rootVal) { showToast('请为所有维度打分'); return; }
  const suggestions = document.getElementById('rv-suggestions')?.value || '';
  const summary = document.getElementById('rv-summary')?.value || '';

  const res = await fetch(`${API}/incidents/${inc.id}/reviews`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      responseSpeed: speedVal,
      collaboration: collabVal,
      rootCauseAccuracy: rootVal,
      improvementSuggestions: suggestions,
      summary,
      userName: state.userName
    })
  });
  if (res.ok) {
    state.currentReview = await res.json();
    state.showReviewForm = false;
    showToast('评分已提交');
    render();
  } else {
    const err = await res.json();
    showToast(err.error || '提交失败');
  }
}

function renderStatsChart() {
  const canvas = document.getElementById('stats-chart');
  if (!canvas) return;
  const stats = state.reviewStats;
  if (!stats || !stats.monthly || stats.monthly.length === 0) return;

  const container = canvas.parentElement;
  const PADDING_INNER = 48;
  const containerW = container.clientWidth - PADDING_INNER;
  const aspectRatio = 800 / 350;
  const W = Math.max(containerW, 320);
  const H = Math.round(W / aspectRatio);

  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  ctx.scale(dpr, dpr);

  const monthly = stats.monthly;
  const labels = monthly.map(m => m.month);
  const datasets = [
    { key: 'avg_response_speed', label: '响应速度', color: '#3b82f6' },
    { key: 'avg_collaboration', label: '协作效率', color: '#a855f7' },
    { key: 'avg_root_cause_accuracy', label: '根因定位', color: '#f59e0b' },
    { key: 'avg_overall', label: '综合', color: '#22c55e' }
  ];

  const scale = W / 800;
  const PAD_L = Math.round(50 * scale), PAD_R = Math.round(100 * scale);
  const PAD_T = Math.round(30 * scale), PAD_B = Math.round(50 * scale);
  const chartW = W - PAD_L - PAD_R;
  const chartH = H - PAD_T - PAD_B;

  ctx.fillStyle = '#1e293b';
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 0.5;
  const fontSize = Math.max(10, Math.round(11 * scale));
  for (let i = 0; i <= 5; i++) {
    const y = PAD_T + chartH - (i / 5) * chartH;
    ctx.beginPath();
    ctx.moveTo(PAD_L, y);
    ctx.lineTo(PAD_L + chartW, y);
    ctx.stroke();
    ctx.fillStyle = '#94a3b8';
    ctx.font = fontSize + 'px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(i.toString(), PAD_L - 8, y + 4);
  }

  ctx.fillStyle = '#94a3b8';
  ctx.font = fontSize + 'px sans-serif';
  ctx.textAlign = 'center';
  labels.forEach((l, i) => {
    const x = PAD_L + (i / Math.max(labels.length - 1, 1)) * chartW;
    ctx.fillText(l, x, H - 12);
  });

  datasets.forEach(ds => {
    ctx.strokeStyle = ds.color;
    ctx.lineWidth = Math.max(1.5, 2 * scale);
    ctx.beginPath();
    monthly.forEach((m, i) => {
      const x = PAD_L + (i / Math.max(monthly.length - 1, 1)) * chartW;
      const y = PAD_T + chartH - ((m[ds.key] || 0) / 5) * chartH;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    monthly.forEach((m, i) => {
      const x = PAD_L + (i / Math.max(monthly.length - 1, 1)) * chartW;
      const y = PAD_T + chartH - ((m[ds.key] || 0) / 5) * chartH;
      ctx.fillStyle = ds.color;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(3, 4 * scale), 0, Math.PI * 2);
      ctx.fill();
    });
  });

  datasets.forEach((ds, i) => {
    const step = Math.round(20 * scale);
    const y = PAD_T + step + i * step;
    ctx.fillStyle = ds.color;
    ctx.fillRect(PAD_L + chartW + Math.round(15 * scale), y, Math.round(12 * scale), Math.round(12 * scale));
    ctx.fillStyle = '#94a3b8';
    ctx.font = fontSize + 'px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(ds.label, PAD_L + chartW + Math.round(32 * scale), y + Math.round(10 * scale));
  });
}

function stringToColor(s) {
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = s.charCodeAt(i) + ((hash << 5) - hash);
  const h = Math.abs(hash) % 360;
  return `hsl(${h}, 65%, 50%)`;
}

function formatDurationMs(ms) {
  if (ms <= 0) return '0:00';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

function getCountdownColorClass(remainingMs, thresholdMin) {
  if (remainingMs <= 0) return 'sla-countdown-breach';
  const pct = remainingMs / (thresholdMin * 60 * 1000);
  if (pct < 0.2) return 'sla-countdown-red';
  if (pct < 0.5) return 'sla-countdown-yellow';
  return 'sla-countdown-green';
}

function renderSlaCountdownBar() {
  const sla = state.currentSlaStatus;
  if (!sla || sla.slaViolated) {
    if (sla?.slaViolated) {
      return `<div class="sla-countdown-bar sla-countdown-violated-static">
        <div class="sla-countdown-inner">
          <span class="sla-countdown-label">⚠️ SLA 已违规</span>
          <span class="sla-countdown-time">关闭时限已超出</span>
        </div>
      </div>`;
    }
    return '<div class="sla-countdown-bar sla-countdown-hidden"></div>';
  }

  const active = sla.activeCountdown;
  if (!active) {
    return '<div class="sla-countdown-bar sla-countdown-hidden"></div>';
  }

  const colorClass = getCountdownColorClass(active.remainingMs, active.thresholdMinutes);
  const isBreaching = active.isBreaching || active.remainingMs <= 0;

  return `<div class="sla-countdown-bar sla-countdown-active ${colorClass} ${isBreaching ? 'sla-blink' : ''}" id="sla-countdown-bar">
    <div class="sla-countdown-inner">
      <span class="sla-countdown-label">⏱ ${active.label} 剩余</span>
      <span class="sla-countdown-time" id="sla-countdown-time">${formatDurationMs(active.remainingMs)}</span>
      <span class="sla-countdown-threshold">(时限 ${active.thresholdMinutes}分钟)</span>
    </div>
  </div>`;
}

function updateSlaCountdownDisplay() {
  const sla = state.currentSlaStatus;
  if (!sla) return;
  const active = sla.activeCountdown;
  if (!active) return;

  const bar = document.getElementById('sla-countdown-bar');
  const timeEl = document.getElementById('sla-countdown-time');
  if (!bar || !timeEl) return;

  const elapsed = Date.now() - (sla._lastFetched || Date.now());
  const remaining = Math.max(0, active.remainingMs - elapsed);
  timeEl.textContent = formatDurationMs(remaining);

  const colorClass = getCountdownColorClass(remaining, active.thresholdMinutes);
  bar.className = 'sla-countdown-bar sla-countdown-active ' + colorClass +
    ((active.isBreaching || remaining <= 0) ? ' sla-blink' : '');
}

function startSlaCountdownTimer() {
  stopSlaCountdownTimer();
  state.slaCountdownTimer = setInterval(() => {
    if (state.view !== 'timeline') return;
    updateSlaCountdownDisplay();
  }, 1000);
}

function stopSlaCountdownTimer() {
  if (state.slaCountdownTimer) {
    clearInterval(state.slaCountdownTimer);
    state.slaCountdownTimer = null;
  }
}

function renderSlaPage() {
  const rules = state.slaRules || [];
  const rows = rules.map(r => {
    const isEditing = state.slaEditingSeverity === r.severity;
    if (isEditing) {
      const draft = state.slaEditDraft[r.severity] || {
        firstResponseMinutes: r.first_response_minutes,
        escalationMinutes: r.escalation_minutes,
        closureMinutes: r.closure_minutes
      };
      return `
        <tr class="sla-row-editing">
          <td><span class="severity-badge severity-${r.severity}">${r.severity}</span></td>
          <td><input type="number" min="1" class="sla-input" id="sla-in-fr-${r.severity}" value="${draft.firstResponseMinutes}"></td>
          <td><input type="number" min="1" class="sla-input" id="sla-in-es-${r.severity}" value="${draft.escalationMinutes}"></td>
          <td><input type="number" min="1" class="sla-input" id="sla-in-cl-${r.severity}" value="${draft.closureMinutes}"></td>
          <td>
            <button class="btn btn-primary btn-sm" data-action="sla-save" data-severity="${r.severity}">保存</button>
            <button class="btn btn-outline btn-sm" data-action="sla-cancel-edit">取消</button>
          </td>
        </tr>`;
    }
    return `
      <tr>
        <td><span class="severity-badge severity-${r.severity}">${r.severity}</span></td>
        <td>${r.first_response_minutes} 分钟</td>
        <td>${r.escalation_minutes} 分钟</td>
        <td>${r.closure_minutes} 分钟</td>
        <td>
          <button class="btn btn-outline btn-sm" data-action="sla-edit" data-severity="${r.severity}">编辑</button>
        </td>
      </tr>`;
  }).join('');

  return `
  <div class="sla-page">
    <header>
      <h1>
        <span style="cursor:pointer" data-action="go-back-list">←</span>
        SLA 规则配置
      </h1>
    </header>
    <div class="sla-content">
      <div class="sla-info-card">
        <h3>📌 SLA 规则说明</h3>
        <ul style="margin:8px 0 0 20px;color:var(--text2);font-size:13px;line-height:1.8;">
          <li><b>首次响应时限</b>：从事故创建到添加第一个事件节点的允许时间（分钟），超时自动拉入备班人员</li>
          <li><b>阶段升级时限</b>：从事故创建到画出第一条因果链的允许时间（分钟），超时自动拉入值班计划负责人</li>
          <li><b>关闭时限</b>：从事故创建到事故关闭的允许时间（分钟），超时标记事故为 SLA 违规</li>
          <li>后端每 30 秒扫描一次，同一阶段超时只触发一次升级</li>
        </ul>
      </div>
      <div class="sla-table-wrap">
        <table class="sla-table">
          <thead>
            <tr>
              <th>严重等级</th>
              <th>首次响应时限</th>
              <th>阶段升级时限</th>
              <th>关闭时限</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="5" style="text-align:center;padding:40px;color:var(--text2);">暂无规则，请刷新页面</td></tr>'}
          </tbody>
        </table>
      </div>
      <div style="margin-top:16px;color:var(--text2);font-size:12px;">
        * P0-P3 四条规则为内置不可删除，修改后立即对所有未关闭事故生效
      </div>
    </div>
  </div>`;
}

function formatLogAction(l) {
  const map = {
    add_node: '添加了事件节点',
    update_node: '修改了事件节点',
    lock_node: '锁定了事件节点',
    unlock_node: '解锁了事件节点',
    exclude_node: '排除了事件节点',
    restore_node: '恢复了事件节点',
    add_causal_link: '添加了因果链',
    delete_causal_link: '删除了因果链',
    join: '加入了协作房间',
    close_incident: '关闭了事故',
    submit_review: '提交了复盘评分',
    sla_breach: '触发了 SLA 超时',
    sla_upgrade_backup: 'SLA 自动升级：拉入备班人员',
    sla_upgrade_owner: 'SLA 自动升级：拉入值班负责人',
    sla_violated_mark: '标记事故为 SLA 违规',
    auto_dispatch: '自动派发值班人员',
    auto_upgrade: '自动升级：拉入备班人员'
  };
  if (l.action === 'sla_breach' && l.detail) {
    try {
      const d = JSON.parse(l.detail);
      return `触发 SLA 超时：${d.stageLabel} (${d.thresholdMinutes}分钟)`;
    } catch (e) {}
  }
  return map[l.action] || l.action;
}

function formatTime(t) {
  if (!t) return '';
  const d = new Date(t);
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function showToast(msg) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const div = document.createElement('div');
  div.className = 'toast';
  div.textContent = msg;
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 3000);
}

function healthColor(score) {
  if (score >= 80) return '#22c55e';
  if (score >= 60) return '#84cc16';
  if (score >= 40) return '#fbbf24';
  if (score >= 20) return '#f97316';
  return '#ef4444';
}

function nodeRadius(incidentCount, maxCount) {
  const min = 12, max = 40;
  if (!maxCount || maxCount === 0) return min;
  const t = Math.log(incidentCount + 1) / Math.log(maxCount + 1);
  return min + t * (max - min);
}

function renderServicesPage() {
  return `
  <div class="services-page">
    <header>
      <h1>
        <span style="cursor:pointer" data-action="go-back-list">←</span>
        服务健康度与关联网络
        <span style="font-size:12px;font-weight:400;color:var(--text2);">Top ${state.serviceNetwork.nodes.length} 服务</span>
      </h1>
      <div class="header-actions">
        <button class="btn btn-outline btn-sm" data-action="recalculate-services">🔄 重算健康度</button>
        <button class="btn btn-outline btn-sm" data-action="refresh-service-graph">↻ 刷新图表</button>
      </div>
    </header>
    <div class="services-main">
      <div class="services-graph-container" id="services-graph-container">
        <div class="graph-controls">
        </div>
        <svg id="services-svg"></svg>
        <div class="service-legend">
          <h4>健康度分数</h4>
          <div class="legend-gradient"></div>
          <div class="legend-labels">
            <span>100 (健康)</span>
            <span>0 (危险)</span>
          </div>
        </div>
      </div>
      <div class="services-sidebar">
        ${state.selectedServiceDetail ? renderServiceDetail() : `
          <div class="service-detail-empty">
            点击左侧节点查看服务详情<br><br>
            节点大小 = 事故涉及次数<br>
            节点颜色 = 健康度分数<br>
            连接线 = 共同出现在同一事故
          </div>
        `}
      </div>
    </div>
  </div>`;
}

function renderServiceDetail() {
  const d = state.selectedServiceDetail;
  if (!d) return '';
  const h = d.health;
  const incidents = d.incidents || [];
  const trend = d.trend || [];

  return `
  <div class="service-detail">
    <div class="service-detail-header">
      <div>
        <h2>${escapeHtml(h.service_name)}</h2>
        <div style="font-size:12px;color:var(--text2);margin-top:4px;">
          最后事故: ${h.last_incident_time ? h.last_incident_time.slice(0, 10) : '无'}
        </div>
      </div>
      <div class="service-health-score" style="background:${healthColor(h.health_score)}">
        <div class="score">${h.health_score}</div>
        <div class="label">健康度</div>
      </div>
    </div>

    <div class="severity-breakdown">
      <div class="severity-chip severity-P0">P0 ${h.p0_count}</div>
      <div class="severity-chip severity-P1">P1 ${h.p1_count}</div>
      <div class="severity-chip severity-P2">P2 ${h.p2_count}</div>
      <div class="severity-chip severity-P3">P3 ${h.p3_count}</div>
    </div>

    <div class="service-stats-grid">
      <div class="service-stat">
        <div class="service-stat-label">事故总数</div>
        <div class="service-stat-value">${h.total_incidents}</div>
      </div>
      <div class="service-stat">
        <div class="service-stat-label">平均故障间隔</div>
        <div class="service-stat-value small">
          ${h.avg_mtbf_days !== null && h.avg_mtbf_days !== undefined ? h.avg_mtbf_days.toFixed(1) + ' 天' : '-'}
        </div>
      </div>
      <div class="service-stat">
        <div class="service-stat-label">平均恢复时长</div>
        <div class="service-stat-value small">
          ${h.avg_recovery_minutes !== null && h.avg_recovery_minutes !== undefined ? Math.round(h.avg_recovery_minutes) + ' 分钟' : '-'}
        </div>
      </div>
      <div class="service-stat">
        <div class="service-stat-label">健康度</div>
        <div class="service-stat-value" style="color:${healthColor(h.health_score)}">${h.health_score}</div>
      </div>
    </div>

    <div class="section-title">近6个月事故趋势</div>
    <div class="trend-chart-container">
      <canvas id="service-trend-chart"></canvas>
      <div class="trend-labels" id="trend-labels"></div>
    </div>

    <div class="section-title">关联事故 (最近 ${Math.min(10, incidents.length)} 条)</div>
    <div class="service-incident-list">
      ${incidents.length === 0 ? '<div style="color:var(--text2);font-size:12px;text-align:center;padding:16px;">暂无关联事故</div>' :
        incidents.map(i => `
          <div class="service-incident-item" data-action="open-service-incident" data-id="${i.id}">
            <div class="service-incident-title">${escapeHtml(i.title)}</div>
            <div class="service-incident-meta">
              <span class="severity-badge severity-${i.severity}" style="padding:1px 6px;font-size:10px;">${i.severity}</span>
              <span>${i.start_time ? i.start_time.slice(0, 10) : ''}</span>
              <span class="status-tag ${i.status === 'open' ? 'status-open' : 'status-closed'}">${i.status === 'open' ? '进行中' : '已关闭'}</span>
            </div>
          </div>
        `).join('')
      }
    </div>
  </div>`;
}

function renderServiceTrendChart() {
  const canvas = document.getElementById('service-trend-chart');
  const labelsEl = document.getElementById('trend-labels');
  if (!canvas || !labelsEl || !state.selectedServiceDetail) return;

  const d = state.selectedServiceDetail;
  const trend = d.trend || [];

  const now = new Date();
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const dt = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
    const found = trend.find(t => t.month === key);
    months.push({
      key,
      label: `${dt.getMonth() + 1}月`,
      count: found ? found.count : 0
    });
  }

  labelsEl.innerHTML = months.map(m => `<span>${m.label}</span>`).join('');

  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth;
  const H = 120;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.height = H + 'px';
  ctx.scale(dpr, dpr);

  const maxCount = Math.max(1, ...months.map(m => m.count));
  const PAD_L = 28, PAD_R = 8, PAD_T = 12, PAD_B = 8;
  const chartW = W - PAD_L - PAD_R;
  const chartH = H - PAD_T - PAD_B;
  const barW = chartW / months.length * 0.6;
  const gap = chartW / months.length * 0.4;

  ctx.clearRect(0, 0, W, H);

  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 0.5;
  ctx.fillStyle = '#64748b';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'right';
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const y = PAD_T + chartH - (i / ticks) * chartH;
    ctx.beginPath();
    ctx.moveTo(PAD_L, y);
    ctx.lineTo(W - PAD_R, y);
    ctx.stroke();
    const val = Math.round(maxCount * i / ticks);
    ctx.fillText(val, PAD_L - 4, y + 3);
  }

  months.forEach((m, i) => {
    const prev = i > 0 ? months[i - 1].count : 0;
    const worsened = prev > 0 && m.count > prev * 2;
    const x = PAD_L + i * (barW + gap) + gap / 2;
    const h = (m.count / maxCount) * chartH;
    const y = PAD_T + chartH - h;

    ctx.fillStyle = worsened ? '#ef4444' : '#3b82f6';
    ctx.fillRect(x, y, barW, h);

    if (m.count > 0) {
      ctx.fillStyle = worsened ? '#ef4444' : '#f1f5f9';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(m.count, x + barW / 2, y - 3);
    }
  });
}

let forceSim = null;

function renderServiceGraph() {
  const container = document.getElementById('services-graph-container');
  const svgEl = document.getElementById('services-svg');
  if (!container || !svgEl) return;

  if (state.serviceGraphAnimId) {
    cancelAnimationFrame(state.serviceGraphAnimId);
    state.serviceGraphAnimId = null;
  }

  const W = container.clientWidth;
  const H = container.clientHeight;
  svgEl.setAttribute('width', W);
  svgEl.setAttribute('height', H);
  svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const ns = 'http://www.w3.org/2000/svg';
  while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);

  const nodes = state.serviceNetwork.nodes || [];
  const edges = state.serviceNetwork.edges || [];

  if (nodes.length === 0) return;

  const maxIncidents = Math.max(...nodes.map(n => n.total_incidents), 1);

  nodes.forEach(n => {
    if (n.x === undefined) {
      n.x = W / 2 + (Math.random() - 0.5) * W * 0.6;
      n.y = H / 2 + (Math.random() - 0.5) * H * 0.6;
    }
    n.vx = n.vx || 0;
    n.vy = n.vy || 0;
    n._r = nodeRadius(n.total_incidents, maxIncidents);
  });

  const edgeG = document.createElementNS(ns, 'g');
  svgEl.appendChild(edgeG);
  edges.forEach(e => {
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('class', 'service-edge');
    line.setAttribute('stroke-width', Math.max(1, Math.log(e.weight + 1) * 1.2));
    edgeG.appendChild(line);
    e._line = line;
  });

  const nodeG = document.createElementNS(ns, 'g');
  svgEl.appendChild(nodeG);
  nodes.forEach(n => {
    const g = document.createElementNS(ns, 'g');
    g.setAttribute('class', 'service-node');
    g.setAttribute('transform', `translate(${n.x},${n.y})`);

    const circle = document.createElementNS(ns, 'circle');
    circle.setAttribute('r', n._r);
    circle.setAttribute('fill', healthColor(n.health_score));
    circle.setAttribute('stroke', 'rgba(255,255,255,0.2)');
    circle.setAttribute('stroke-width', '2');
    g.appendChild(circle);

    if (n._r >= 18) {
      const text = document.createElementNS(ns, 'text');
      text.setAttribute('y', 4);
      const maxLen = Math.max(4, Math.floor(n._r / 5));
      text.textContent = n.name.length > maxLen ? n.name.slice(0, maxLen) + '…' : n.name;
      g.appendChild(text);
    }

    if (state.highlightServiceName === n.name) {
      circle.classList.add('node-highlight');
    }

    g.title = n.name;
    n._g = g;
    n._circle = circle;

    let dragging = false;
    let dragOffset = { x: 0, y: 0 };

    circle.addEventListener('mouseenter', () => {
      if (!dragging) {
        circle.setAttribute('stroke', 'rgba(255,255,255,0.8)');
        circle.setAttribute('stroke-width', '3');
      }
    });
    circle.addEventListener('mouseleave', () => {
      if (!dragging && state.highlightServiceName !== n.name) {
        circle.setAttribute('stroke', 'rgba(255,255,255,0.2)');
        circle.setAttribute('stroke-width', '2');
      }
    });

    circle.addEventListener('click', (e) => {
      e.stopPropagation();
      selectService(n.name);
    });

    circle.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      dragging = true;
      g.classList.add('dragging');
      const rect = svgEl.getBoundingClientRect();
      dragOffset.x = (e.clientX - rect.left) * (W / rect.width) - n.x;
      dragOffset.y = (e.clientY - rect.top) * (H / rect.height) - n.y;
      n.fx = n.x;
      n.fy = n.y;
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const rect = svgEl.getBoundingClientRect();
      n.fx = Math.max(n._r, Math.min(W - n._r, (e.clientX - rect.left) * (W / rect.width) - dragOffset.x));
      n.fy = Math.max(n._r, Math.min(H - n._r, (e.clientY - rect.top) * (H / rect.height) - dragOffset.y));
      n.x = n.fx;
      n.y = n.fy;
      n.vx = 0;
      n.vy = 0;
      g.setAttribute('transform', `translate(${n.x},${n.y})`);
      updateEdgePositions();
    });

    window.addEventListener('mouseup', () => {
      if (dragging) {
        dragging = false;
        g.classList.remove('dragging');
        n.fx = undefined;
        n.fy = undefined;
      }
    });

    nodeG.appendChild(g);
  });

  function updateEdgePositions() {
    edges.forEach(e => {
      const src = nodes.find(n => n.id === e.source);
      const tgt = nodes.find(n => n.id === e.target);
      if (src && tgt && e._line) {
        e._line.setAttribute('x1', src.x);
        e._line.setAttribute('y1', src.y);
        e._line.setAttribute('x2', tgt.x);
        e._line.setAttribute('y2', tgt.y);
      }
    });
  }

  const nodeMap = {};
  nodes.forEach(n => nodeMap[n.id] = n);

  const centerX = W / 2, centerY = H / 2;
  const alphaDecay = 0.02;
  let alpha = 1;

  function tick() {
    alpha += (0 - alpha) * alphaDecay;
    if (alpha < 0.005) alpha = 0;

    nodes.forEach(n => {
      if (n.fx !== undefined) { n.x = n.fx; n.vx = 0; }
      if (n.fy !== undefined) { n.y = n.fy; n.vy = 0; }
    });

    edges.forEach(e => {
      const a = nodeMap[e.source];
      const b = nodeMap[e.target];
      if (!a || !b) return;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const target = 120;
      const force = (dist - target) * 0.005 * e.weight * alpha;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      if (a.fx === undefined) { a.vx += fx; }
      if (a.fy === undefined) { a.vy += fy; }
      if (b.fx === undefined) { b.vx -= fx; }
      if (b.fy === undefined) { b.vy -= fy; }
    });

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distSq = dx * dx + dy * dy;
        const minDist = (a._r + b._r + 20);
        if (distSq < minDist * minDist && distSq > 0.01) {
          const dist = Math.sqrt(distSq);
          const force = (minDist - dist) * 0.3 * alpha;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          if (a.fx === undefined) { a.vx -= fx; }
          if (a.fy === undefined) { a.vy -= fy; }
          if (b.fx === undefined) { b.vx += fx; }
          if (b.fy === undefined) { b.vy += fy; }
        }
      }
    }

    nodes.forEach(n => {
      if (n.fx === undefined) { n.vx += (centerX - n.x) * 0.001 * alpha; }
      if (n.fy === undefined) { n.vy += (centerY - n.y) * 0.001 * alpha; }
    });

    nodes.forEach(n => {
      n.vx *= 0.85;
      n.vy *= 0.85;
      if (n.fx === undefined) {
        n.x += n.vx;
        n.x = Math.max(n._r, Math.min(W - n._r, n.x));
      }
      if (n.fy === undefined) {
        n.y += n.vy;
        n.y = Math.max(n._r, Math.min(H - n._r, n.y));
      }
    });

    nodes.forEach(n => {
      if (n._g) n._g.setAttribute('transform', `translate(${n.x},${n.y})`);
    });
    updateEdgePositions();

    if (alpha > 0) {
      state.serviceGraphAnimId = requestAnimationFrame(tick);
    } else {
      state.serviceGraphAnimId = null;
    }
  }

  tick();

  if (state.highlightServiceName) {
    const n = nodes.find(nd => nd.name === state.highlightServiceName);
    if (n) {
      setTimeout(() => selectService(n.name), 300);
    }
  }
}

async function selectService(serviceName) {
  state.selectedService = serviceName;
  try {
    const res = await fetch(`${API}/services/${encodeURIComponent(serviceName)}`);
    if (res.ok) {
      state.selectedServiceDetail = await res.json();
      render();
    }
  } catch (e) {
    console.error('load service detail failed:', e);
    showToast('加载服务详情失败');
  }
}

async function goServices() {
  if (state.ws) { state.ws.close(); state.ws = null; }
  state.view = 'services';
  state.currentIncident = null;
  state.selectedService = null;
  state.selectedServiceDetail = null;
  state.highlightServiceName = null;
  await loadServiceNetwork();
  render();
}

async function goServicesDetail(serviceName) {
  if (state.ws) { state.ws.close(); state.ws = null; }
  state.view = 'services';
  state.currentIncident = null;
  state.selectedService = serviceName;
  state.selectedServiceDetail = null;
  state.highlightServiceName = serviceName;
  await loadServiceNetwork();
  render();
  if (serviceName) {
    try {
      const res = await fetch(`${API}/services/${encodeURIComponent(serviceName)}`);
      if (res.ok) {
        state.selectedServiceDetail = await res.json();
        render();
      }
    } catch (e) {
      console.error('load service detail failed:', e);
    }
  }
}

async function loadServiceNetwork() {
  try {
    const res = await fetch(`${API}/services/network`);
    if (res.ok) {
      state.serviceNetwork = await res.json();
    }
  } catch (e) {
    console.error('load service network failed:', e);
    showToast('加载服务网络失败');
  }
}

async function recalculateServices() {
  try {
    const res = await fetch(`${API}/services/recalculate`, { method: 'POST' });
    if (res.ok) {
      const data = await res.json();
      showToast(`已重新计算 ${data.recalculated} 个服务的健康度`);
      await loadServiceNetwork();
      state.selectedServiceDetail = null;
      state.highlightServiceName = null;
      render();
    }
  } catch (e) {
    console.error('recalculate services failed:', e);
    showToast('重算失败');
  }
}

async function openIncidentFromService(incidentId) {
  if (!state.userName) {
    const name = prompt('请输入你的姓名:');
    if (!name) return;
    state.userName = name;
    localStorage.setItem('tl_username', name);
  }
  await openIncident(incidentId);
}

async function goOncall(updateUrl = true) {
  if (updateUrl) history.pushState({}, '', '/oncall');
  if (state.ws) { state.ws.close(); state.ws = null; }
  state.view = 'oncall';
  state.currentIncident = null;
  state.showOncallPlanModal = false;
  state.editingPlanId = null;
  state.showSwapModal = false;
  state.swapData = null;
  if (!state.oncallWeekStart) {
    const now = new Date();
    const day = now.getDay();
    state.oncallWeekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day);
  }
  await loadOncallData();
  render();
}

async function loadOncallData() {
  try {
    const [servicesRes, plansRes] = await Promise.all([
      fetch(`${API}/oncall/services`),
      fetch(`${API}/oncall/plans`)
    ]);
    state.oncallServices = await servicesRes.json();
    state.oncallPlans = await plansRes.json();

    state.oncallSchedules = {};
    const weekStartStr = formatDate(state.oncallWeekStart);
    for (const svc of state.oncallServices) {
      try {
        const res = await fetch(`${API}/oncall/schedule?service=${encodeURIComponent(svc.serviceName)}&weekStart=${weekStartStr}`);
        const data = await res.json();
        if (data.schedule) {
          state.oncallSchedules[svc.serviceName] = data.schedule;
        }
      } catch (e) {
        console.error(`load schedule for ${svc.serviceName} failed:`, e);
      }
    }
  } catch (e) {
    console.error('load oncall data failed:', e);
    showToast('加载值班数据失败');
  }
}

function oncallPrevWeek() {
  state.oncallWeekStart = new Date(state.oncallWeekStart.getTime() - 7 * 24 * 60 * 60 * 1000);
  loadOncallData().then(render);
}

function oncallNextWeek() {
  state.oncallWeekStart = new Date(state.oncallWeekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
  loadOncallData().then(render);
}

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function renderOncallPage() {
  const weekStart = state.oncallWeekStart;
  const weekEnd = new Date(weekStart.getTime() + 6 * 24 * 60 * 60 * 1000);
  const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  const headerCells = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart.getTime() + i * 24 * 60 * 60 * 1000);
    const isToday = formatDate(d) === formatDate(new Date());
    headerCells.push(`
      <th class="${isToday ? 'oncall-today' : ''}">
        ${dayNames[i]}<br>
        <small>${formatDate(d).slice(5)}</small>
      </th>
    `);
  }

  const serviceRows = state.oncallServices.map(svc => {
    const schedule = state.oncallSchedules[svc.serviceName];
    const shiftRows = [];

    for (let shiftIdx = 0; shiftIdx < 3; shiftIdx++) {
      const shiftName = ['早班(00-08)', '中班(08-16)', '晚班(16-24)'][shiftIdx];
      const cells = [];

      for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
        const d = new Date(weekStart.getTime() + dayIdx * 24 * 60 * 60 * 1000);
        const dateStr = formatDate(d);
        const isToday = dateStr === formatDate(new Date());

        let cellContent = '<span class="oncall-empty">-</span>';
        let cellClass = isToday ? 'oncall-today' : '';

        if (schedule && schedule.schedule[dayIdx]) {
          const shift = schedule.schedule[dayIdx].shifts[shiftIdx];
          if (shift) {
            const swapBadge = shift.isSwapped ? `<span class="swap-badge" title="${shift.originalUser} → ${shift.actualUser}">换班</span>` : '';
            cellContent = `
              <div class="oncall-cell-content">
                <span class="oncall-user ${shift.isSwapped ? 'oncall-swapped' : ''}">${shift.actualUser}</span>
                ${swapBadge}
                <button class="oncall-swap-btn" data-action="oncall-show-swap-modal" 
                  data-service="${svc.serviceName}" 
                  data-plan="${schedule.planId}"
                  data-date="${dateStr}"
                  data-shift="${shiftIdx}"
                  data-original="${shift.originalUser}"
                  title="换班">↔</button>
              </div>
            `;
          }
        }

        cells.push(`<td class="${cellClass}">${cellContent}</td>`);
      }

      shiftRows.push(`
        <tr>
          ${shiftIdx === 0 ? `<td class="oncall-service-cell" rowspan="3">
            <div class="oncall-service-name">${svc.serviceName}</div>
            <div class="oncall-plan-name">${svc.planName}</div>
          </td>` : ''}
          <td class="oncall-shift-cell">${shiftName}</td>
          ${cells.join('')}
        </tr>
      `);
    }

    return shiftRows.join('');
  }).join('');

  const plansList = state.oncallPlans.map(plan => `
    <div class="oncall-plan-card">
      <div class="oncall-plan-header">
        <strong>${plan.name}</strong>
        <span class="oncall-plan-status ${plan.is_active ? 'active' : 'inactive'}">
          ${plan.is_active ? '生效中' : '已停用'}
        </span>
      </div>
      <div class="oncall-plan-services">
        <label>服务:</label> ${plan.services.join(', ')}
      </div>
      <div class="oncall-plan-members">
        <label>人员:</label> ${plan.members.map(m => m.userName).join(' → ')}
      </div>
      <div class="oncall-plan-actions">
        <button class="btn btn-small" data-action="oncall-edit-plan" data-id="${plan.id}">编辑</button>
        <button class="btn btn-small btn-danger" data-action="oncall-delete-plan" data-id="${plan.id}">删除</button>
      </div>
    </div>
  `).join('');

  return `
    <div class="oncall-page">
      <div class="oncall-header">
        <h1>📅 值班排班</h1>
        <div class="oncall-controls">
          <button class="btn btn-outline" data-action="go-back-list">← 返回列表</button>
          <button class="btn btn-outline" data-action="oncall-prev-week">← 上周</button>
          <span class="oncall-week-label">${formatDate(weekStart)} ~ ${formatDate(weekEnd)}</span>
          <button class="btn btn-outline" data-action="oncall-next-week">下周 →</button>
          <button class="btn btn-primary" data-action="oncall-show-plan-modal">+ 新建值班计划</button>
        </div>
      </div>

      <div class="oncall-container">
        <div class="oncall-schedule-section">
          <h2>本周排班</h2>
          ${state.oncallServices.length === 0 ? 
            '<div class="empty-state">暂无值班计划，点击右上角按钮创建</div>' : `
            <table class="oncall-table">
              <thead>
                <tr>
                  <th style="width:80px;">服务</th>
                  <th style="width:100px;">班次</th>
                  ${headerCells.join('')}
                </tr>
              </thead>
              <tbody>
                ${serviceRows}
              </tbody>
            </table>
          `}
        </div>

        <div class="oncall-plans-section">
          <h2>值班计划管理</h2>
          <div class="oncall-plans-list">
            ${plansList || '<div class="empty-state">暂无值班计划</div>'}
          </div>
        </div>
      </div>

      ${state.showOncallPlanModal ? renderOncallPlanModal() : ''}
      ${state.showSwapModal ? renderSwapModal() : ''}
    </div>
  `;
}

function renderOncallPlanModal() {
  const editingPlan = state.editingPlanId ? 
    state.oncallPlans.find(p => p.id === state.editingPlanId) : null;

  const title = editingPlan ? '编辑值班计划' : '新建值班计划';
  const name = editingPlan ? editingPlan.name : '';
  const services = editingPlan ? editingPlan.services.join(', ') : '';
  const members = editingPlan ? editingPlan.members.map(m => m.userName).join(', ') : '';
  const startDate = editingPlan ? editingPlan.start_date : formatDate(new Date());
  const isActive = editingPlan ? editingPlan.is_active : 1;

  return `
    <div class="modal-overlay" data-action="oncall-close-plan-modal">
      <div class="modal" onclick="event.stopPropagation()">
        <div class="modal-header">
          <h3>${title}</h3>
          <button class="modal-close" data-action="oncall-close-plan-modal">×</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>计划名称 *</label>
            <input type="text" id="plan-name" value="${escapeHtml(name)}" placeholder="如：核心服务值班组">
          </div>
          <div class="form-group">
            <label>服务列表 * (逗号分隔)</label>
            <input type="text" id="plan-services" value="${escapeHtml(services)}" placeholder="如：payment-gateway, order-service">
          </div>
          <div class="form-group">
            <label>值班人员 * (逗号分隔，按排班顺序)</label>
            <input type="text" id="plan-members" value="${escapeHtml(members)}" placeholder="如：alice, bob, carol">
          </div>
          <div class="form-group">
            <label>开始日期 *</label>
            <input type="date" id="plan-start-date" value="${startDate}">
          </div>
          ${editingPlan ? `
            <div class="form-group">
              <label>
                <input type="checkbox" id="plan-active" ${isActive ? 'checked' : ''}>
                启用该计划
              </label>
            </div>
          ` : ''}
        </div>
        <div class="modal-footer">
          <button class="btn btn-outline" data-action="oncall-close-plan-modal">取消</button>
          <button class="btn btn-primary" data-action="oncall-save-plan">保存</button>
        </div>
      </div>
    </div>
  `;
}

async function saveOncallPlan() {
  const name = document.getElementById('plan-name').value.trim();
  const servicesStr = document.getElementById('plan-services').value.trim();
  const membersStr = document.getElementById('plan-members').value.trim();
  const startDate = document.getElementById('plan-start-date').value;

  if (!name || !servicesStr || !membersStr || !startDate) {
    showToast('请填写所有必填项');
    return;
  }

  const services = servicesStr.split(',').map(s => s.trim()).filter(s => s);
  const members = membersStr.split(',').map(s => s.trim()).filter(s => s);

  if (services.length === 0 || members.length === 0) {
    showToast('服务和人员列表不能为空');
    return;
  }

  const payload = { name, services, startDate, members };
  if (state.editingPlanId) {
    const activeCheckbox = document.getElementById('plan-active');
    if (activeCheckbox) {
      payload.isActive = activeCheckbox.checked;
    }
  }

  try {
    const url = state.editingPlanId ? 
      `${API}/oncall/plans/${state.editingPlanId}` : 
      `${API}/oncall/plans`;
    const method = state.editingPlanId ? 'PUT' : 'POST';

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      showToast(state.editingPlanId ? '已更新值班计划' : '已创建值班计划');
      state.showOncallPlanModal = false;
      state.editingPlanId = null;
      await loadOncallData();
      render();
    } else {
      const err = await res.json();
      showToast(err.error || '保存失败');
    }
  } catch (e) {
    console.error('save oncall plan failed:', e);
    showToast('保存失败');
  }
}

async function deleteOncallPlan(planId) {
  if (!confirm('确定要删除这个值班计划吗？')) return;

  try {
    const res = await fetch(`${API}/oncall/plans/${planId}`, { method: 'DELETE' });
    if (res.ok) {
      showToast('已删除值班计划');
      await loadOncallData();
      render();
    } else {
      showToast('删除失败');
    }
  } catch (e) {
    console.error('delete oncall plan failed:', e);
    showToast('删除失败');
  }
}

function showSwapModal(data) {
  state.showSwapModal = true;
  state.swapData = {
    planId: data.plan,
    shiftDate: data.date,
    shiftIndex: parseInt(data.shift),
    originalUser: data.original,
    serviceName: data.service
  };
  render();
}

function renderSwapModal() {
  const data = state.swapData;
  if (!data) return '';

  const shiftName = ['早班(00-08)', '中班(08-16)', '晚班(16-24)'][data.shiftIndex];
  const plan = state.oncallPlans.find(p => p.id === data.planId);
  const members = plan ? plan.members.map(m => m.userName).filter(u => u !== data.originalUser) : [];

  return `
    <div class="modal-overlay" data-action="oncall-close-swap-modal">
      <div class="modal" onclick="event.stopPropagation()">
        <div class="modal-header">
          <h3>临时换班</h3>
          <button class="modal-close" data-action="oncall-close-swap-modal">×</button>
        </div>
        <div class="modal-body">
          <div class="swap-info">
            <p><strong>服务:</strong> ${data.serviceName}</p>
            <p><strong>日期:</strong> ${data.shiftDate}</p>
            <p><strong>班次:</strong> ${shiftName}</p>
            <p><strong>原值班人:</strong> ${data.originalUser}</p>
          </div>
          <div class="form-group">
            <label>替班人员 *</label>
            ${members.length > 0 ? `
              <select id="swap-substitute">
                <option value="">请选择替班人员</option>
                ${members.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('')}
              </select>
            ` : `
              <input type="text" id="swap-substitute" placeholder="输入替班人员姓名">
            `}
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-outline" data-action="oncall-close-swap-modal">取消</button>
          <button class="btn btn-primary" data-action="oncall-save-swap">确认换班</button>
        </div>
      </div>
    </div>
  `;
}

async function saveSwap() {
  const substituteUser = document.getElementById('swap-substitute').value.trim();
  if (!substituteUser) {
    showToast('请选择或输入替班人员');
    return;
  }

  const data = state.swapData;
  try {
    const res = await fetch(`${API}/oncall/swaps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        planId: data.planId,
        originalUser: data.originalUser,
        substituteUser,
        shiftDate: data.shiftDate,
        shiftIndex: data.shiftIndex,
        createdBy: state.userName || 'system'
      })
    });

    if (res.ok) {
      showToast('换班成功');
      state.showSwapModal = false;
      state.swapData = null;
      await loadOncallData();
      render();
    } else {
      const err = await res.json();
      showToast(err.error || '换班失败');
    }
  } catch (e) {
    console.error('save swap failed:', e);
    showToast('换班失败');
  }
}

function renderNotificationCenter() {
  const unreadCount = state.unreadCount;
  const showPanel = state.showNotificationPanel;

  let notificationsHtml = '';
  if (showPanel) {
    const notifs = state.notifications.slice(0, 50);
    notificationsHtml = notifs.map(n => `
      <div class="notification-item ${n.is_read ? 'notification-read' : 'notification-unread'}" 
           data-action="open-notification-incident" 
           data-id="${n.incident_id}" 
           data-notifid="${n.id}">
        <div class="notification-item-header">
          <span class="notification-title">${escapeHtml(n.title)}</span>
          ${!n.is_read ? `<span class="notification-unread-dot"></span>` : ''}
        </div>
        <div class="notification-item-body">${escapeHtml(n.body)}</div>
        <div class="notification-item-footer">
          <span class="notification-time">${formatNotificationTime(n.created_at)}</span>
          <span class="notification-service">${escapeHtml(n.service_name)}</span>
          ${!n.is_read ? `
            <button class="btn btn-outline btn-xs notification-mark-read" 
                    data-action="mark-notification-read" 
                    data-id="${n.id}"
                    onclick="event.stopPropagation();">标记已读</button>
          ` : ''}
        </div>
      </div>
    `).join('');

    if (notifs.length === 0) {
      notificationsHtml = '<div class="notification-empty">暂无通知</div>';
    }
  }

  return `
    <div class="notification-center">
      <div class="notification-bell-container" data-action="toggle-notification-panel">
        <span class="notification-bell">🔔</span>
        ${unreadCount > 0 ? `<span class="notification-badge">${unreadCount > 99 ? '99+' : unreadCount}</span>` : ''}
      </div>
      ${showPanel ? `
        <div class="notification-panel" onclick="event.stopPropagation()">
          <div class="notification-panel-header">
            <span>通知中心</span>
            ${unreadCount > 0 ? `
              <button class="btn btn-outline btn-xs" data-action="mark-all-notifications-read">全部已读</button>
            ` : ''}
          </div>
          <div class="notification-panel-body">
            ${notificationsHtml}
          </div>
          <div class="notification-panel-footer">
            <span style="font-size:12px;color:var(--text2);">最近 50 条通知 · 最多保留 500 条</span>
          </div>
        </div>
      ` : ''}
    </div>
  `;
}

function formatNotificationTime(t) {
  if (!t) return '';
  const d = new Date(t);
  const now = new Date();
  const diff = now - d;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  if (hours < 24) return `${hours}小时前`;
  if (days < 7) return `${days}天前`;
  return d.toLocaleDateString('zh-CN');
}

function renderSubscriptionsPage() {
  const subscribedSet = new Set(state.subscriptions.map(s => s.service_name));
  const services = state.allServices;
  const maxSubs = 10;

  const serviceItems = services.map(svc => `
    <label class="subscription-item">
      <input type="checkbox" 
             class="subscription-checkbox" 
             value="${escapeHtml(svc)}" 
             ${subscribedSet.has(svc) ? 'checked' : ''}>
      <span class="subscription-service-name">${escapeHtml(svc)}</span>
    </label>
  `).join('');

  return `
  <div class="subscriptions-page">
    <header>
      <h1>
        <span style="cursor:pointer" data-action="go-back-list">←</span>
        服务订阅管理
      </h1>
    </header>
    <div class="subscriptions-content">
      <div class="subscriptions-info-card">
        <h3>📌 订阅说明</h3>
        <ul style="margin:8px 0 0 20px;color:var(--text2);font-size:13px;line-height:1.8;">
          <li>订阅后，当有新事故或事故节点更新涉及该服务时，您会收到通知</li>
          <li>通知通过站内信和 WebSocket 实时推送</li>
          <li>每个用户最多可以订阅 <b>${maxSubs}</b> 个服务</li>
          <li>当前已订阅：<b>${state.subscriptions.length}/${maxSubs}</b> 个服务</li>
        </ul>
      </div>

      <div class="subscriptions-username">
        <label>当前用户名：</label>
        <input id="sub-username" value="${state.userName}" placeholder="请输入用户名" style="flex:1;max-width:200px;">
      </div>

      <div class="subscriptions-list-header">
        <h3>可订阅的服务</h3>
        <div style="display:flex;gap:8px;">
          <button class="btn btn-outline btn-sm" id="sub-select-all">全选</button>
          <button class="btn btn-outline btn-sm" id="sub-select-none">取消全选</button>
        </div>
      </div>

      <div class="subscriptions-list">
        ${serviceItems || '<div class="empty-state">暂无服务可订阅</div>'}
      </div>

      <div class="subscriptions-actions">
        <button class="btn btn-primary" data-action="save-subscriptions">保存订阅</button>
        <button class="btn btn-outline" data-action="go-back-list">取消</button>
      </div>
    </div>
  </div>`;
}

async function goSubscriptions() {
  if (!state.userName) {
    const name = prompt('请输入您的用户名：');
    if (!name) return;
    state.userName = name;
    localStorage.setItem('tl_username', name);
  }

  state.view = 'subscriptions';
  history.pushState({}, '', '/subscriptions');
  await Promise.all([
    loadSubscriptions(),
    loadAllServices(),
    loadNotifications(),
    loadUnreadCount()
  ]);
  render();
}

async function loadSubscriptions() {
  if (!state.userName) return;
  try {
    const res = await fetch(`${API}/subscriptions?userName=${encodeURIComponent(state.userName)}`);
    state.subscriptions = await res.json();
  } catch (e) {
    console.error('load subscriptions error:', e);
    state.subscriptions = [];
  }
}

async function loadAllServices() {
  try {
    const res = await fetch(`${API}/subscriptions/services`);
    state.allServices = await res.json();
  } catch (e) {
    console.error('load all services error:', e);
    state.allServices = [];
  }
}

async function loadNotifications() {
  if (!state.userName) return;
  try {
    const res = await fetch(`${API}/notifications?userName=${encodeURIComponent(state.userName)}&limit=50`);
    state.notifications = await res.json();
  } catch (e) {
    console.error('load notifications error:', e);
    state.notifications = [];
  }
}

async function loadUnreadCount() {
  if (!state.userName) return;
  try {
    const res = await fetch(`${API}/notifications/unread-count?userName=${encodeURIComponent(state.userName)}`);
    const data = await res.json();
    state.unreadCount = data.unreadCount || 0;
  } catch (e) {
    console.error('load unread count error:', e);
    state.unreadCount = 0;
  }
}

function toggleNotificationPanel() {
  state.showNotificationPanel = !state.showNotificationPanel;
  if (state.showNotificationPanel) {
    loadNotifications();
  }
  render();
}

async function markNotificationRead(notificationId) {
  if (!state.userName) return;
  try {
    await fetch(`${API}/notifications/${notificationId}/read`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userName: state.userName })
    });
    const notif = state.notifications.find(n => n.id === notificationId);
    if (notif) notif.is_read = 1;
    state.unreadCount = Math.max(0, state.unreadCount - 1);
    render();
  } catch (e) {
    console.error('mark notification read error:', e);
  }
}

async function markAllNotificationsRead() {
  if (!state.userName) return;
  try {
    await fetch(`${API}/notifications/read-all`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userName: state.userName })
    });
    state.notifications.forEach(n => n.is_read = 1);
    state.unreadCount = 0;
    render();
  } catch (e) {
    console.error('mark all notifications read error:', e);
  }
}

async function openNotificationIncident(incidentId, notificationId) {
  if (notificationId) {
    const notif = state.notifications.find(n => n.id === notificationId);
    if (notif && !notif.is_read) {
      await markNotificationRead(notificationId);
    }
  }
  state.showNotificationPanel = false;
  openIncident(incidentId);
}

async function saveSubscriptions() {
  const userName = document.getElementById('sub-username')?.value.trim();
  if (!userName) {
    showToast('请输入用户名');
    return;
  }
  state.userName = userName;
  localStorage.setItem('tl_username', userName);

  const checkboxes = document.querySelectorAll('.subscription-checkbox:checked');
  const serviceNames = Array.from(checkboxes).map(cb => cb.value);

  try {
    const res = await fetch(`${API}/subscriptions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userName, serviceNames })
    });

    if (res.ok) {
      state.subscriptions = await res.json();
      showToast('订阅已保存');
      connectNotifyWS();
    } else {
      const err = await res.json();
      showToast(err.error || '保存失败');
    }
  } catch (e) {
    console.error('save subscriptions error:', e);
    showToast('保存失败');
  }
  render();
}

function handleNewNotificationPush(notification) {
  if (!notification) return;

  const existing = state.notifications.find(n => n.id === notification.id);
  if (!existing) {
    state.notifications.unshift(notification);
    if (state.notifications.length > 50) {
      state.notifications = state.notifications.slice(0, 50);
    }
  }

  if (!notification.is_read) {
    state.unreadCount += 1;
    showToast(`🔔 新通知：${notification.title}`);
  }

  render();
}

function connectNotifyWS() {
  if (!state.userName) return;

  if (state.notifyWs) {
    try { state.notifyWs.close(); } catch (e) {}
    state.notifyWs = null;
  }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  state.notifyWs = ws;

  ws.onopen = () => {
    ws.send(JSON.stringify({ 
      type: 'subscribe_notifications', 
      userName: state.userName 
    }));
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'new_notification') {
        handleNewNotificationPush(msg.notification);
      }
    } catch (err) {
      console.error('notify ws parse error', err);
    }
  };

  ws.onclose = () => {
    setTimeout(() => {
      if (state.userName) {
        connectNotifyWS();
      }
    }, 3000);
  };
}

function handleRoute() {
  const path = window.location.pathname;
  if (path === '/oncall') {
    goOncall(false);
  } else if (path === '/subscriptions') {
    goSubscriptions();
  }
}

window.addEventListener('popstate', handleRoute);

function navigateTo(path) {
  history.pushState({}, '', path);
  handleRoute();
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.notification-center') && state.showNotificationPanel) {
    state.showNotificationPanel = false;
    render();
  }
});

loadIncidents();
handleRoute();

if (state.userName) {
  loadUnreadCount();
  loadNotifications();
  connectNotifyWS();
}
