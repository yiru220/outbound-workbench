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

    // /github 走 GitHub 上传代理；其余（含根路径）走企微 webhook 代理
    if (url.pathname === '/github') {
      return handleGitHub(request, env);
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

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
}
