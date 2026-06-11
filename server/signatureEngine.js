const { runQuery, runExec } = require('./db');

const STOPWORDS = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个',
  '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好',
  '自己', '这', '他', '她', '它', '们', '那', '些', '什么', '这个', '那个', '但是',
  '因为', '所以', '如果', '虽然', '而且', '或者', '以及', '还', '能', '可以', '应该',
  '开始', '出现', '发生', '进行', '已经', '正在', '将', '会', '可能', '需要', '通过',
  '使用', '用于', '对', '与', '及', '等', '从', '向', '中', '大', '小', '多', '少',
  'an', 'the', 'a', 'of', 'to', 'in', 'for', 'is', 'are', 'was', 'were', 'be', 'been',
  'and', 'or', 'but', 'if', 'then', 'else', 'with', 'by', 'at', 'from', 'on', 'as',
  'into', 'through', 'during', 'before', 'after', 'above', 'below', 'between', 'under',
  'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would', 'should', 'could', 'may',
  'about', 'against', 'this', 'that', 'these', 'those', 'it', 'its'
]);

function generateIncidentSignature(db, incidentId) {
  const crypto = require('crypto');

  const nodes = runQuery(db, `
    SELECT * FROM timeline_nodes 
    WHERE incident_id = ? AND is_excluded = 0 
    ORDER BY occurred_at ASC
  `, [incidentId]);

  const services = [...new Set(nodes.map(n => n.service_name))].sort();

  const sourceTypeCounts = {};
  let total = 0;
  nodes.forEach(n => {
    sourceTypeCounts[n.source_type] = (sourceTypeCounts[n.source_type] || 0) + 1;
    total++;
  });
  const sourceTypeDist = {};
  Object.keys(sourceTypeCounts).forEach(k => {
    sourceTypeDist[k] = total > 0 ? sourceTypeCounts[k] / total : 0;
  });

  let causalDepth = 0;
  let causalWidth = 0;
  if (nodes.length > 0) {
    const links = runQuery(db, `
      SELECT from_node_id, to_node_id FROM causal_links WHERE incident_id = ?
    `, [incidentId]);

    const nodeIds = new Set(nodes.map(n => n.id));
    const adj = {};
    const inDeg = {};
    nodeIds.forEach(id => { adj[id] = []; inDeg[id] = 0; });

    links.forEach(l => {
      if (nodeIds.has(l.from_node_id) && nodeIds.has(l.to_node_id)) {
        adj[l.from_node_id].push(l.to_node_id);
        inDeg[l.to_node_id] = (inDeg[l.to_node_id] || 0) + 1;
      }
    });

    const dist = {};
    nodeIds.forEach(id => { dist[id] = -Infinity; });
    const roots = [...nodeIds].filter(id => (inDeg[id] || 0) === 0);
    roots.forEach(r => { dist[r] = 0; });

    const queue = [...roots];
    while (queue.length > 0) {
      const n = queue.shift();
      adj[n].forEach(next => {
        if (dist[n] + 1 > dist[next]) {
          dist[next] = dist[n] + 1;
        }
        inDeg[next]--;
        if (inDeg[next] === 0) queue.push(next);
      });
    }

    Object.values(dist).forEach(d => {
      if (d > causalDepth) causalDepth = d;
    });
    if (nodes.length > 0) causalDepth += 1;

    Object.values(adj).forEach(children => {
      if (children.length > causalWidth) causalWidth = children.length;
    });
  }

  let timeSpanSeconds = 0;
  if (nodes.length >= 2) {
    const times = nodes.map(n => new Date(n.occurred_at).getTime());
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);
    timeSpanSeconds = Math.round((maxTime - minTime) / 1000);
  }

  const keywords = extractKeywords(nodes, 12);

  let rootCauseDesc = null;
  if (nodes.length > 0) {
    const links = runQuery(db, `
      SELECT from_node_id, to_node_id FROM causal_links WHERE incident_id = ?
    `, [incidentId]);
    const nodeIds = new Set(nodes.map(n => n.id));
    const nodeMap = {};
    nodes.forEach(n => { nodeMap[n.id] = n; });

    const hasIncoming = new Set();
    const hasOutgoing = new Set();
    links.forEach(l => {
      if (nodeIds.has(l.from_node_id) && nodeIds.has(l.to_node_id)) {
        hasOutgoing.add(l.from_node_id);
        hasIncoming.add(l.to_node_id);
      }
    });

    const onCausalChain = new Set([...hasIncoming, ...hasOutgoing]);
    const rootCauses = nodes.filter(n =>
      onCausalChain.has(n.id) && !hasIncoming.has(n.id)
    );

    rootCauses.sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));

    if (rootCauses.length === 1) {
      rootCauseDesc = rootCauses[0].description;
    } else if (rootCauses.length > 1) {
      const topRoots = rootCauses.slice(0, 3);
      rootCauseDesc = topRoots.map(r => r.description).join(' | ');
    } else if (nodes.length > 0 && onCausalChain.size === 0) {
      const sortedNodes = [...nodes].sort((a, b) =>
        new Date(a.occurred_at) - new Date(b.occurred_at)
      );
      rootCauseDesc = sortedNodes[0].description;
    }
  }

  const existing = runQuery(db, 'SELECT id FROM incident_signatures WHERE incident_id = ?', [incidentId]);
  if (existing.length > 0) {
    runExec(db, `
      UPDATE incident_signatures SET
        services = ?, source_type_dist = ?, causal_depth = ?, causal_width = ?,
        time_span_seconds = ?, keywords = ?, root_cause_desc = ?,
        updated_at = datetime('now')
      WHERE incident_id = ?
    `, [
      JSON.stringify(services),
      JSON.stringify(sourceTypeDist),
      causalDepth,
      causalWidth,
      timeSpanSeconds,
      JSON.stringify(keywords),
      rootCauseDesc,
      incidentId
    ]);
  } else {
    const id = crypto.randomUUID();
    runExec(db, `
      INSERT INTO incident_signatures
      (id, incident_id, services, source_type_dist, causal_depth, causal_width,
       time_span_seconds, keywords, root_cause_desc)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id, incidentId,
      JSON.stringify(services),
      JSON.stringify(sourceTypeDist),
      causalDepth,
      causalWidth,
      timeSpanSeconds,
      JSON.stringify(keywords),
      rootCauseDesc
    ]);
  }

  return {
    services,
    sourceTypeDist,
    causalDepth,
    causalWidth,
    timeSpanSeconds,
    keywords,
    rootCauseDesc
  };
}

function tokenizeChinese(text) {
  if (!text) return [];
  const tokens = [];
  const cnPattern = /[\u4e00-\u9fa5]+/g;
  const enPattern = /[a-zA-Z][a-zA-Z0-9_-]*/g;
  const numPattern = /\d+(?:\.\d+)?/g;

  let m;
  while ((m = cnPattern.exec(text)) !== null) {
    const str = m[0];
    for (let len = Math.min(str.length, 4); len >= 2; len--) {
      for (let i = 0; i + len <= str.length; i++) {
        tokens.push(str.substring(i, i + len));
      }
    }
    for (let i = 0; i < str.length; i++) {
      tokens.push(str[i]);
    }
  }
  while ((m = enPattern.exec(text)) !== null) {
    tokens.push(m[0]);
  }
  while ((m = numPattern.exec(text)) !== null) {
    tokens.push(m[0]);
  }

  return tokens;
}

function extractKeywords(nodes, topN = 12) {
  const wordFreq = {};
  nodes.forEach(n => {
    const desc = n.description || '';
    const tokens = tokenizeChinese(desc);
    tokens.forEach(tok => {
      const lower = tok.toLowerCase();
      if (lower.length >= 2 && !STOPWORDS.has(lower)) {
        wordFreq[lower] = (wordFreq[lower] || 0) + 1;
      }
    });
  });

  const entries = Object.entries(wordFreq).map(([word, freq]) => ({
    word,
    freq,
    score: freq * Math.log2(word.length + 1)
  }));

  entries.sort((a, b) => b.score - a.score || b.freq - a.freq || b.word.length - a.word.length);

  const selected = [];
  for (const candidate of entries) {
    if (selected.length >= topN) break;
    const isRedundant = selected.some(s =>
      s.word.includes(candidate.word) && s.freq >= candidate.freq * 0.5
    );
    if (!isRedundant) {
      selected.push(candidate);
    }
  }

  return selected.map(s => s.word);
}

function buildLiveSignature(db, incidentId) {
  const nodes = runQuery(db, `
    SELECT * FROM timeline_nodes 
    WHERE incident_id = ? AND is_excluded = 0 
    ORDER BY occurred_at ASC
  `, [incidentId]);

  const services = [...new Set(nodes.map(n => n.service_name))].sort();

  const sourceTypeCounts = {};
  let total = 0;
  nodes.forEach(n => {
    sourceTypeCounts[n.source_type] = (sourceTypeCounts[n.source_type] || 0) + 1;
    total++;
  });
  const sourceTypeDist = {};
  Object.keys(sourceTypeCounts).forEach(k => {
    sourceTypeDist[k] = total > 0 ? sourceTypeCounts[k] / total : 0;
  });

  const keywords = extractKeywords(nodes, 12);

  return { services, sourceTypeDist, keywords };
}

function jaccard(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 0;
  let inter = 0;
  setA.forEach(x => { if (setB.has(x)) inter++; });
  let union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

function cosineSimilarity(distA, distB) {
  const allKeys = new Set([...Object.keys(distA), ...Object.keys(distB)]);
  let dot = 0;
  let magA = 0;
  let magB = 0;
  allKeys.forEach(k => {
    const va = distA[k] || 0;
    const vb = distB[k] || 0;
    dot += va * vb;
    magA += va * va;
    magB += vb * vb;
  });
  magA = Math.sqrt(magA);
  magB = Math.sqrt(magB);
  if (magA === 0 || magB === 0) return 0;
  return dot / (magA * magB);
}

function findSimilarIncidents(db, currentIncidentId, liveSig) {
  const signatures = runQuery(db, `
    SELECT s.*, i.title, i.severity, i.start_time, i.end_time, i.status, i.room_code
    FROM incident_signatures s
    JOIN incidents i ON s.incident_id = i.id
    WHERE s.incident_id != ? AND i.status = 'closed'
  `, [currentIncidentId]);

  if (signatures.length === 0) return [];

  const results = signatures.map(sig => {
    let servicesList = [];
    let dist = {};
    let keywordsList = [];
    try {
      servicesList = JSON.parse(sig.services || '[]');
      dist = JSON.parse(sig.source_type_dist || '{}');
      keywordsList = JSON.parse(sig.keywords || '[]');
    } catch (e) { /* ignore parse errors */ }

    const serviceScore = jaccard(liveSig.services, servicesList);
    const sourceScore = cosineSimilarity(liveSig.sourceTypeDist, dist);
    const keywordScore = jaccard(liveSig.keywords, keywordsList);

    const totalScore = serviceScore * 0.4 + sourceScore * 0.3 + keywordScore * 0.3;

    return {
      incidentId: sig.incident_id,
      title: sig.title,
      severity: sig.severity,
      roomCode: sig.room_code,
      startTime: sig.start_time,
      endTime: sig.end_time,
      similarity: Math.round(totalScore * 1000) / 1000,
      serviceScore: Math.round(serviceScore * 1000) / 1000,
      sourceScore: Math.round(sourceScore * 1000) / 1000,
      keywordScore: Math.round(keywordScore * 1000) / 1000,
      services: servicesList,
      keywords: keywordsList,
      rootCauseDesc: sig.root_cause_desc,
      causalDepth: sig.causal_depth,
      causalWidth: sig.causal_width,
      timeSpanSeconds: sig.time_span_seconds
    };
  });

  return results
    .filter(r => r.similarity > 0.3)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 5);
}

function getIncidentSummary(db, incidentId) {
  const links = runQuery(db, `
    SELECT from_node_id, to_node_id FROM causal_links WHERE incident_id = ?
  `, [incidentId]);
  const nodes = runQuery(db, `
    SELECT id, description, occurred_at, service_name, source_type
    FROM timeline_nodes WHERE incident_id = ? AND is_excluded = 0
    ORDER BY occurred_at ASC
  `, [incidentId]);

  if (links.length === 0) {
    return {
      causalSummary: nodes.slice(0, 8).map(n => ({
        description: n.description,
        service: n.service_name,
        sourceType: n.source_type,
        occurredAt: n.occurred_at
      })),
      structureNote: '无因果链标注'
    };
  }

  const nodeMap = {};
  nodes.forEach(n => { nodeMap[n.id] = n; });

  const nodeIds = new Set(nodes.map(n => n.id));
  const adj = {};
  const inDeg = {};
  nodeIds.forEach(id => { adj[id] = []; inDeg[id] = 0; });
  links.forEach(l => {
    if (nodeIds.has(l.from_node_id) && nodeIds.has(l.to_node_id)) {
      adj[l.from_node_id].push(l.to_node_id);
      inDeg[l.to_node_id] = (inDeg[l.to_node_id] || 0) + 1;
    }
  });

  const dist = {};
  const parent = {};
  nodeIds.forEach(id => { dist[id] = -Infinity; parent[id] = null; });
  const roots = [...nodeIds].filter(id => (inDeg[id] || 0) === 0);
  roots.forEach(r => { dist[r] = 0; });

  const queue = [...roots];
  while (queue.length > 0) {
    const n = queue.shift();
    adj[n].forEach(next => {
      if (dist[n] + 1 > dist[next]) {
        dist[next] = dist[n] + 1;
        parent[next] = n;
      }
      inDeg[next]--;
      if (inDeg[next] === 0) queue.push(next);
    });
  }

  let endNode = null;
  let maxDist = -1;
  Object.entries(dist).forEach(([id, d]) => {
    if (d > maxDist) { maxDist = d; endNode = id; }
  });

  const path = [];
  let cur = endNode;
  while (cur !== null) {
    const node = nodeMap[cur];
    if (node) {
      path.unshift({
        description: node.description,
        service: node.service_name,
        sourceType: node.source_type,
        occurredAt: node.occurred_at
      });
    }
    cur = parent[cur];
  }

  return {
    causalSummary: path,
    structureNote: `最长因果链：${path.length} 个节点`
  };
}

module.exports = {
  generateIncidentSignature,
  buildLiveSignature,
  findSimilarIncidents,
  getIncidentSummary,
  jaccard,
  cosineSimilarity,
  tokenizeChinese
};
