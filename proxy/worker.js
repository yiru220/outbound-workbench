// Cloudflare Worker：双用途代理
//   POST /            → 转发到企业微信智能表格 webhook（回传客户信息，解决浏览器跨域）
//   POST /github      → 转发到 GitHub Contents API 上传文件（录音等）
//
// 关于 GitHub Token（重要）：
//   不在代码里写死 Token，而是从 Cloudflare Secret 环境变量 GITHUB_TOKEN 读取。
//   这样 Token 只存在 Cloudflare 侧，不会进入 Git 仓库（避免 GitHub secret scanning 拦截），
//   也不会出现在前端 HTML 里（避免对访客暴露可写 token）。
//   设置方式：Cloudflare 控制台 → Workers & Pages → outbound-webhook-proxy
//            → Settings → Variables and Secrets → Add → 名称 GITHUB_TOKEN，值填 Fine-grained PAT。
//
// 部署方式与之前一致（Git 连接，推送到仓库即自动重新部署）。

// 企微智能表格 webhook（含 key）。浏览器不再直接持有该地址，由 Worker 代发。
const WEBHOOK_TARGET =
  'https://qyapi.weixin.qq.com/cgi-bin/wedoc/smartsheet/webhook?key=13q3vpbak4k1uyFxoToaopH15jRjtaPaQ3LH74X7z3KRp7nLRZlCUVGk1T8OJc6AWGfXV3uIfbqfMb3t1ExEov1MaCgqwFX2dQHTShxleZ2r';

// GitHub 上传目标（仓库与分支，与前端 GITHUB_REPO / GITHUB_BRANCH 保持一致）
const GITHUB_REPO = 'yiru220/outbound-workbench';
const GITHUB_BRANCH = 'main';

// Worker 代码版本。改动代码时同步 +1，方便判断 Cloudflare 是否已部署最新版。
// 自检：浏览器直接打开 https://outbound-webhook-proxy.yiru220.workers.dev/health
const WORKER_VERSION = '2026-08-04l-siliconflow';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // 健康检查（GET 即可）：返回当前 Worker 版本与各转写后端是否就绪。
    // 若返回 404 或没有 version 字段，说明 Cloudflare 上仍是旧版代码，需要重新部署。
    if (url.pathname === '/health') {
      return json({
        ok: true,
        version: WORKER_VERSION,
        backends: {
          siliconflow: !!env.SILICONFLOW_API_KEY,
          workersai: !!env.AI,
          openai: !!env.OPENAI_API_KEY,
        },
        github_token: !!env.GITHUB_TOKEN,
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: CORS });
    }

    // /github 走 GitHub 上传代理；/transcribe 走录音转写+AI 分析；其余走企微 webhook 代理
    if (url.pathname === '/github') {
      return handleGitHub(request, env);
    }
    if (url.pathname === '/transcribe') {
      return handleTranscribe(request, env);
    }
    return handleWebhook(request);
  },
};

// ---------- 企微 webhook 代理（原有功能） ----------
async function handleWebhook(request) {
  try {
    const body = await request.text();
    const upstream = await fetch(WEBHOOK_TARGET, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ errcode: -1, errmsg: 'proxy error: ' + e.message }),
      { status: 502, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } }
    );
  }
}

// ---------- GitHub 上传代理（新增） ----------
async function handleGitHub(request, env) {
  const token = env.GITHUB_TOKEN;
  if (!token) {
    return json({ error: 'GITHUB_TOKEN 未配置：请在 Cloudflare Worker 的 Secrets 中设置' }, 500);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  const { path, content, message, branch, sha } = payload;
  if (!path || !content) {
    return json({ error: 'path 和 content 为必填项' }, 400);
  }

  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`;

  // 未提供 sha 时自动解析（幂等更新：重复上传/重复分析可覆盖，避免 409）
  if (!sha) {
    try {
      const g = await fetch(apiUrl, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'outbound-github-proxy',
        },
      });
      if (g.ok) { const gj = await g.json(); sha = gj.sha; }
    } catch (e) { /* 忽略，按新文件处理 */ }
  }

  const ghBody = JSON.stringify({
    message: message || 'upload',
    content,
    branch: branch || GITHUB_BRANCH,
    ...(sha ? { sha } : {}),
  });

  try {
    const upstream = await fetch(apiUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'outbound-github-proxy',
      },
      body: ghBody,
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
    });
  } catch (e) {
    return json({ error: 'github proxy error: ' + e.message }, 502);
  }
}

// ---------- 录音转写 + AI 分析 ----------
// 接收 { url }（raw.githubusercontent 音频直链）或 { audio }（base64 dataURL，本地未上传的录音）
// 后端优先级（免费优先，自动回退）：
//   1) siliconflow —— SenseVoiceSmall(ASR 免费不限量) + Qwen3-8B(LLM 免费)，中文效果最好，需 SILICONFLOW_API_KEY
//   2) workersai   —— @cf/openai/whisper-large-v3-turbo + @cf/qwen/qwen3-30b-a3b-fp8，零密钥，
//                     Cloudflare 每天赠送 10000 neurons ≈ 240 分钟音频
//   3) openai      —— whisper-1 + gpt-4o-mini，付费兜底，需 OPENAI_API_KEY
const PROVIDER_LABEL = {
  siliconflow: '硅基流动（免费）',
  workersai: 'Cloudflare Workers AI（免费额度）',
  openai: 'OpenAI（付费）',
};

function providerAvailability(env) {
  return {
    siliconflow: !!env.SILICONFLOW_API_KEY,
    workersai: !!env.AI,
    openai: !!env.OPENAI_API_KEY,
  };
}

// 返回按优先级排序的可用后端列表；want 指定时置于首位
function providerChain(env, want) {
  const has = providerAvailability(env);
  const order = ['siliconflow', 'workersai', 'openai'].filter(p => has[p]);
  if (want && has[want]) return [want, ...order.filter(p => p !== want)];
  return order;
}

function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// 去掉推理模型可能输出的 <think>...</think> 段
function stripThink(s) {
  return String(s || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

async function asrSiliconFlow(env, bytes, filename) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'audio/webm' }), filename);
  form.append('model', 'FunAudioLLM/SenseVoiceSmall');
  const r = await fetch('https://api.siliconflow.cn/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.SILICONFLOW_API_KEY },
    body: form,
  });
  const t = await r.text();
  if (!r.ok) throw new Error('硅基流动转写 HTTP ' + r.status + ' ' + t.slice(0, 180));
  let j;
  try { j = JSON.parse(t); } catch { throw new Error('硅基流动转写返回非 JSON: ' + t.slice(0, 120)); }
  return { text: (j.text || '').trim(), model: 'FunAudioLLM/SenseVoiceSmall' };
}

async function asrWorkersAI(env, bytes) {
  // 先试 turbo（中文更准，base64 入参），失败再退基础 whisper（字节数组入参）
  let firstErr = '';
  try {
    const r = await env.AI.run('@cf/openai/whisper-large-v3-turbo', {
      audio: bytesToBase64(bytes),
      language: 'zh',
    });
    const text = String(r?.text || r?.transcription || '').trim();
    if (text) return { text, model: '@cf/openai/whisper-large-v3-turbo' };
    firstErr = 'turbo 返回空文本';
  } catch (e) { firstErr = e.message; }
  try {
    const r2 = await env.AI.run('@cf/openai/whisper', { audio: Array.from(bytes) });
    return { text: String(r2?.text || '').trim(), model: '@cf/openai/whisper' };
  } catch (e) {
    throw new Error('Workers AI 转写失败: ' + e.message + (firstErr ? '（turbo: ' + firstErr + '）' : ''));
  }
}

async function asrOpenAI(env, bytes, filename) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'audio/webm' }), filename);
  form.append('model', 'whisper-1');
  form.append('language', 'zh');
  form.append('response_format', 'json');
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.OPENAI_API_KEY },
    body: form,
  });
  const j = await r.json();
  if (!r.ok) throw new Error('OpenAI 转写: ' + (j.error?.message || r.status));
  return { text: (j.text || '').trim(), model: 'whisper-1' };
}

async function runASR(env, provider, bytes, filename) {
  if (provider === 'siliconflow') return asrSiliconFlow(env, bytes, filename);
  if (provider === 'workersai') return asrWorkersAI(env, bytes);
  return asrOpenAI(env, bytes, filename);
}

async function runChat(env, provider, sys, user) {
  if (provider === 'siliconflow') {
    const r = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + env.SILICONFLOW_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'Qwen/Qwen3-8B',
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
        temperature: 0.3,
        max_tokens: 1400,
        enable_thinking: false,
      }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error('硅基流动分析: ' + (j.message || j.error?.message || r.status));
    return { raw: j.choices?.[0]?.message?.content || '', model: 'Qwen/Qwen3-8B' };
  }
  if (provider === 'workersai') {
    const r = await env.AI.run('@cf/qwen/qwen3-30b-a3b-fp8', {
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      max_tokens: 1400,
      temperature: 0.3,
    });
    return { raw: r?.response || '', model: '@cf/qwen/qwen3-30b-a3b-fp8' };
  }
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.OPENAI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      temperature: 0.3,
      response_format: { type: 'json_object' },
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error('OpenAI 分析: ' + (j.error?.message || r.status));
  return { raw: j.choices?.[0]?.message?.content || '', model: 'gpt-4o-mini' };
}

async function handleTranscribe(request, env) {
  let payload;
  try { payload = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const { url, audio, name, provider: want } = payload;
  if (!url && !audio) return json({ error: 'url 或 audio 至少提供一个' }, 400);

  const chain = providerChain(env, want);
  if (!chain.length) {
    return json({
      error: '没有可用的转写后端。请在 Cloudflare 控制台 → Worker → Settings → Variables and Secrets '
        + '添加 Secret：SILICONFLOW_API_KEY（硅基流动，免费不限量，去 cloud.siliconflow.cn 注册领取），'
        + '保存后点 Deploy 重新部署即可。（可选替代：OPENAI_API_KEY 走付费，'
        + '或在 dashboard 加 Workers AI binding 且变量名为 AI）',
    }, 500);
  }

  // 1) 拿到音频字节
  let audioBytes;
  const filename = name || 'audio.webm';
  if (url) {
    try {
      const r = await fetch(url);
      if (!r.ok) return json({ error: '音频拉取失败: HTTP ' + r.status }, 502);
      audioBytes = new Uint8Array(await r.arrayBuffer());
    } catch (e) { return json({ error: '音频拉取异常: ' + e.message }, 502); }
  } else {
    try {
      const b64 = String(audio).includes(',') ? audio.split(',')[1] : audio;
      audioBytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    } catch (e) { return json({ error: 'audio 解码失败: ' + e.message }, 400); }
  }

  // 2) 转写：沿回退链依次尝试，任一成功即用
  let transcript = '';
  let usedProvider = '';
  let asrModel = '';
  const errors = [];
  for (const p of chain) {
    try {
      const res = await runASR(env, p, audioBytes, filename);
      usedProvider = p;
      asrModel = res.model;
      transcript = res.text;
      break;
    } catch (e) {
      errors.push(PROVIDER_LABEL[p] + ' → ' + e.message);
    }
  }
  if (!usedProvider) {
    return json({ error: '转写失败（已尝试全部后端）：\n' + errors.join('\n') }, 502);
  }

  const meta = { provider: usedProvider, provider_label: PROVIDER_LABEL[usedProvider], asr_model: asrModel };

  if (!transcript) {
    return json({
      ...meta,
      transcript: '',
      score: 0,
      dimensions: [],
      strengths: [],
      weaknesses: ['录音中未识别到有效语音内容，无法分析'],
      summary: '未识别到语音，请确认录音正常或重新录制。',
    });
  }

  // 3) OpenAI 分析 + 打分
  const sys = `你是一名资深销售教练，擅长外呼电话录音的质量评估。请基于给定的外呼录音转写文本，从销售角度进行评分与分析。
要求：
- score 为 0-100 的整数综合得分，客观反映通话质量。
- dimensions 为 5 个维度的 1-10 整数分：开场破冰、需求挖掘、异议处理、成交引导、专业度。
- strengths：2-4 条具体优点（中文，简短）。
- weaknesses：2-4 条具体待改进点（中文，简短，可操作）。
- summary：一句话总体点评（中文）。
只输出严格 JSON，不要代码块、不要解释文字。格式：
{"score":85,"dimensions":[{"name":"开场破冰","score":8},{"name":"需求挖掘","score":9},{"name":"异议处理","score":7},{"name":"成交引导","score":8},{"name":"专业度","score":9}],"strengths":["..."],"weaknesses":["..."],"summary":"..."}`;
  const userMsg = '以下是外呼录音转写文本：\n\n' + transcript;
  const chatErrors = [];
  // 分析同样走回退链：优先与转写相同的后端，失败再换
  for (const p of providerChain(env, usedProvider)) {
    try {
      const { raw, model } = await runChat(env, p, sys, userMsg);
      const analysis = JSON.parse(extractJson(stripThink(raw)));
      return json({ ...meta, llm_provider: p, llm_model: model, transcript, ...analysis });
    } catch (e) {
      chatErrors.push(PROVIDER_LABEL[p] + ' → ' + e.message);
    }
  }
  // 转写成功但分析全部失败：仍返回转写结果，不让用户白跑
  return json({
    ...meta,
    transcript,
    score: null,
    dimensions: [],
    strengths: [],
    weaknesses: [],
    summary: '',
    analysis_error: chatErrors.join('; '),
  });
}

function extractJson(s) {
  if (typeof s !== 'string') return '{}';
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a === -1 || b === -1) return '{}';
  return s.slice(a, b + 1);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
}
