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

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
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

// ---------- 录音转写 + AI 分析（新增） ----------
// 接收 { url }（raw.githubusercontent 音频直链）或 { audio }（base64 dataURL，本地未上传的录音）
// 流程：OpenAI whisper-1 转写 -> gpt-4o-mini 评分/优缺点分析 -> 返回 JSON
async function handleTranscribe(request, env) {
  const key = env.OPENAI_API_KEY;
  if (!key) {
    return json({ error: 'OPENAI_API_KEY 未配置：请在 Cloudflare Worker 的 Secrets 中增加该密钥' }, 500);
  }

  let payload;
  try { payload = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const { url, audio, name } = payload;
  if (!url && !audio) return json({ error: 'url 或 audio 至少提供一个' }, 400);

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

  // 2) OpenAI 转写
  let transcript;
  try {
    const form = new FormData();
    form.append('file', new Blob([audioBytes], { type: 'audio/webm' }), filename);
    form.append('model', 'whisper-1');
    form.append('language', 'zh');
    form.append('response_format', 'json');
    const tr = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key },
      body: form,
    });
    const tj = await tr.json();
    if (!tr.ok) return json({ error: '转写失败: ' + (tj.error?.message || tr.status) }, 502);
    transcript = (tj.text || '').trim();
  } catch (e) { return json({ error: '转写请求异常: ' + e.message }, 502); }

  if (!transcript) {
    return json({
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
  try {
    const cr = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: '以下是外呼录音转写文本：\n\n' + transcript },
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' },
      }),
    });
    const cj = await cr.json();
    if (!cr.ok) return json({ error: '分析失败: ' + (cj.error?.message || cr.status) }, 502);
    const raw = cj.choices?.[0]?.message?.content || '{}';
    let analysis;
    try { analysis = JSON.parse(extractJson(raw)); }
    catch (e) { return json({ transcript, score: null, dimensions: [], strengths: [], weaknesses: [], summary: '', analysis_error: '分析解析失败: ' + e.message }); }
    return json({ transcript, ...analysis });
  } catch (e) {
    // 转写成功但分析失败：仍返回转写结果
    return json({ transcript, score: null, dimensions: [], strengths: [], weaknesses: [], summary: '', analysis_error: e.message });
  }
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
