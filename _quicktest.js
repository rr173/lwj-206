const http = require('http');

function post(path, data) {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(data);
    const req = http.request({
      hostname: 'localhost', port: 3033, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': json.length }
    }, res => {
      let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve({s:res.statusCode, b}));
    });
    req.on('error', reject); req.write(json); req.end();
  });
}
function get(path) {
  return new Promise((resolve, reject) => {
    http.get({hostname:'localhost',port:3033,path},res=>{
      let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve({s:res.statusCode, b}));
    }).on('error', reject);
  });
}

(async () => {
  try {
    let r = await post('/api/incidents', {title:'Demo事故 - 支付大规模超时',severity:'P1',startTime:'2026-06-10T14:00:00.000Z',ownerName:'alice'});
    console.log('Step1 close historic:', r.s);
    const historicId = JSON.parse(r.b).id;
    const nodes = [
      {occurredAt:'2026-06-10T14:00:00.000Z',description:'支付网关响应时间从50ms飙升至2000ms',sourceType:'monitor',serviceName:'payment-gateway',createdBy:'alice'},
      {occurredAt:'2026-06-10T14:00:05.000Z',description:'网关日志出现大量connection timeout错误',sourceType:'log',serviceName:'payment-gateway',createdBy:'bob'},
      {occurredAt:'2026-06-10T14:02:30.000Z',description:'数据库连接池耗尽，等待连接数超过100',sourceType:'log',serviceName:'order-db',createdBy:'carol'},
      {occurredAt:'2026-06-10T14:02:35.000Z',description:'DBA在群里报告主库CPU达到95%',sourceType:'chat',serviceName:'order-db',createdBy:'bob'},
      {occurredAt:'2026-06-10T14:05:00.000Z',description:'订单服务开始返回503错误',sourceType:'monitor',serviceName:'order-service',createdBy:'alice'},
    ];
    for (const n of nodes) { await post(`/api/incidents/${historicId}/nodes`, n); }
    r = await post(`/api/incidents/${historicId}/close`, {userName:'alice'});
    console.log('Step2 close & sign:', r.s);

    r = await post('/api/incidents', {title:'新事故 - 又一个数据库问题',severity:'P2',startTime:'2026-06-11T10:00:00.000Z',ownerName:'bob'});
    const newId = JSON.parse(r.b).id;
    console.log('Step3 create new:', newId);

    const newNodes = [
      {occurredAt:'2026-06-11T10:00:05.000Z',description:'支付网关响应时间飙升至2000ms以上',sourceType:'monitor',serviceName:'payment-gateway',createdBy:'bob'},
      {occurredAt:'2026-06-11T10:01:00.000Z',description:'数据库连接池耗尽，连接等待超过100',sourceType:'log',serviceName:'order-db',createdBy:'carol'},
      {occurredAt:'2026-06-11T10:03:30.000Z',description:'订单服务开始返回大量503错误',sourceType:'monitor',serviceName:'order-service',createdBy:'dave'},
      {occurredAt:'2026-06-11T10:04:00.000Z',description:'DBA报告主库CPU占用率90%',sourceType:'chat',serviceName:'order-db',createdBy:'eve'},
    ];
    for (const n of newNodes) await post(`/api/incidents/${newId}/nodes`, n);
    console.log('Step4 added 4 new nodes');

    await new Promise(r => setTimeout(r, 2500));
    r = await get(`/api/incidents/${newId}/similar`);
    const sim = JSON.parse(r.b);
    console.log('\nStep5 Similar matches (' + sim.matches.length + ' found)');
    sim.matches.forEach(m => {
      console.log(`  [${m.severity}] ${Math.round(m.similarity*100)}% ${m.title}`);
      console.log(`     svc=${Math.round(m.serviceScore*100)}% src=${Math.round(m.sourceScore*100)}% kw=${Math.round(m.keywordScore*100)}%`);
      console.log(`     services: ${m.services.join(', ')}`);
    });

    if (sim.matches.length > 0) console.log('  kbEmpty=',sim.kbEmpty,' needsMore=',sim.needsMoreNodes,' count=',sim.currentNodeCount || '-');

    console.log('\n=== DONE ===');
  } catch(e) { console.error('ERR', e.message, e.stack); }
  process.exit(0);
})();
