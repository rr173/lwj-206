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
  lastSyncId: 0,
  selectedNodeId: null,
  connectionMode: false,
  connectionFrom: null,
  showKeyPath: false,
  detailNode: null,
  showAddNode: false,
  showCreateIncident: false,
};

function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }

function render() {
  const app = document.getElementById('app');
  if (state.view === 'list') {
    app.innerHTML = renderIncidentList();
  } else {
    app.innerHTML = renderTimeline();
    renderTimelineGraphics();
  }
  bindEvents();
}

function renderIncidentList() {
  const cards = state.incidents.map(i => `
    <div class="incident-card" data-action="open-incident" data-id="${i.id}">
      <h3>${i.title}</h3>
      <div class="meta">
        <span class="severity-badge severity-${i.severity}">${i.severity}</span>
        <span class="status-tag ${i.status === 'open' ? 'status-open' : 'status-closed'}">${i.status === 'open' ? '进行中' : '已关闭'}</span>
        <br>房间: ${i.room_code}<br>
        ${i.start_time} ~ ${i.end_time || '未结束'}
      </div>
    </div>
  `).join('');

  return `
  <div class="incident-list">
    <h1>故障时间线还原工具</h1>
    <p style="color:var(--text2);margin-bottom:8px;">选择一个事故进入协作房间，或创建新事故</p>
    <div style="margin-bottom:16px;display:flex;gap:8px;">
      <button class="btn btn-primary" data-action="create-incident">+ 创建事故</button>
    </div>
    <div class="incident-cards">${cards || '<div class="empty-state">暂无事故记录</div>'}</div>
    ${state.showCreateIncident ? renderCreateIncidentModal() : ''}
  </div>`;
}

function renderCreateIncidentModal() {
  return `
  <div class="modal-overlay" data-action="close-modal">
    <div class="modal" onclick="event.stopPropagation()">
      <h2>创建新事故</h2>
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

  return `
  <div id="app" style="display:flex;flex-direction:column;height:100vh;">
    <header>
      <h1>
        <span style="cursor:pointer" data-action="go-back">←</span>
        ${inc.title}
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
        ` : ''}
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
                    ${svc}
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

    ${state.detailNode ? renderDetailCard() : ''}
    ${state.showAddNode ? renderAddNodeModal() : ''}
  </div>`;
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
    <div class="card-field"><label>服务:</label>${n.service_name}</div>
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

function bindEvents() {
  document.querySelectorAll('[data-action]').forEach(el => {
    el.onclick = handleAction;
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
}

function handleAction(e) {
  const action = e.currentTarget.dataset.action;
  const id = e.currentTarget.dataset.id;

  switch (action) {
    case 'open-incident': openIncident(id); break;
    case 'go-back': leaveIncident(); break;
    case 'create-incident': state.showCreateIncident = true; render(); break;
    case 'close-modal': state.showCreateIncident = false; state.showAddNode = false; render(); break;
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
  }
}

async function openIncident(id) {
  const userName = document.getElementById('username-input')?.value || state.userName;
  if (!userName) { showToast('请输入你的姓名'); return; }
  state.userName = userName;
  localStorage.setItem('tl_username', userName);

  const [incRes, nodesRes, linksRes, dupsRes, partsRes, logsRes] = await Promise.all([
    fetch(`${API}/incidents/${id}`),
    fetch(`${API}/incidents/${id}/nodes`),
    fetch(`${API}/incidents/${id}/causal-links`),
    fetch(`${API}/incidents/${id}/duplicates`),
    fetch(`${API}/incidents/${id}/participants`),
    fetch(`${API}/incidents/${id}/logs`),
  ]);

  state.currentIncident = await incRes.json();
  state.nodes = await nodesRes.json();
  state.causalLinks = await linksRes.json();
  state.duplicates = await dupsRes.json();
  state.participants = await partsRes.json();
  state.logs = await logsRes.json();

  await fetch(`${API}/incidents/${id}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userName: state.userName })
  });

  const kpRes = await fetch(`${API}/incidents/${id}/key-path`);
  const kpData = await kpRes.json();
  state.keyPath = kpData.path || [];

  state.view = 'timeline';
  state.detailNode = null;
  state.selectedNodeId = null;
  state.connectionMode = false;

  connectWS(id);
  render();
}

function leaveIncident() {
  if (state.ws) { state.ws.close(); state.ws = null; }
  state.view = 'list';
  state.currentIncident = null;
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
  if (!title || !startTime) { showToast('请填写标题和起始时间'); return; }
  state.userName = ownerName || state.userName;
  localStorage.setItem('tl_username', state.userName);

  const res = await fetch(`${API}/incidents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, severity, startTime: new Date(startTime).toISOString(), endTime: endTime ? new Date(endTime).toISOString() : null, ownerName })
  });
  if (res.ok) {
    state.showCreateIncident = false;
    loadIncidents();
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
  }
}

async function loadIncidents() {
  const res = await fetch(`${API}/incidents`);
  state.incidents = await res.json();
  render();
}

function stringToColor(s) {
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = s.charCodeAt(i) + ((hash << 5) - hash);
  const h = Math.abs(hash) % 360;
  return `hsl(${h}, 65%, 50%)`;
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
  };
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

loadIncidents();
