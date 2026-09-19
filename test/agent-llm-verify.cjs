// Agent 团队 LLM 路由验证：确认各角色是否真的走到了外部大模型
// 用法：先启动服务（SITE_PASSWORD= PORT=8899 node server/index.cjs），再 node test/agent-llm-verify.cjs
const http = require('http');

const PORT = Number(process.env.VPORT || 8899);
const SYMBOL = process.argv[2] || 'sh600519';
const MODE = process.argv[3] || 'quick';

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const r = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path,
        method,
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'agent-verify', ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try { resolve(JSON.parse(d)); } catch { reject(new Error('bad json: ' + d.slice(0, 150))); }
        });
      },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

(async () => {
  console.log(`════ Agent 团队 LLM 路由验证 ════`);
  console.log(`标的 ${SYMBOL} · 模式 ${MODE}\n`);

  const t0 = Date.now();
  const start = await req('POST', '/api/agents/analyze', { symbol: SYMBOL, mode: MODE });
  if (!start.jobId) {
    console.log('未创建异步任务（可能是云端未配置或返回同步结果）:', JSON.stringify(start).slice(0, 200));
    return;
  }
  console.log('任务已受理:', start.jobId, '| 名称:', start.name);

  let job = null;
  const deadline = Date.now() + 8 * 60_000;
  let lastStage = '';
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    job = await req('GET', `/api/agents/job/${start.jobId}`);
    if (job.stage && job.stage !== lastStage) {
      lastStage = job.stage;
      console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] ${job.step}/${job.total} ${job.stage}`);
    }
    if (job.status === 'done' || job.status === 'error') break;
  }

  if (!job || job.status !== 'done') {
    console.log('\n❌ 未完成:', job?.status, job?.error || '(超时)');
    return;
  }

  const trace = job.trace || {};
  const roster = trace.llmRoster || [];
  console.log('\n──── 各角色实际执行引擎 ────');
  let llmCount = 0;
  for (const r of roster) {
    const isLlm = r.engine === 'llm';
    if (isLlm) llmCount += 1;
    console.log(`  ${isLlm ? '🛰️ AI ' : '⚙️ 规则'}  ${String(r.seat).padEnd(22)} ${String(r.model || '-').padEnd(40)} ${r.ms != null ? r.ms + 'ms' : ''}`);
  }
  console.log(`\n  AI 参与 ${llmCount}/${roster.length} 个角色`);
  console.log(`  总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (trace.verdict) console.log(`  裁决: ${trace.verdict}`);
  console.log('\n═══════════════════════════════');
})();
