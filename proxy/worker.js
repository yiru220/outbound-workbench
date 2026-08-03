// Cloudflare Worker：企业微信智能表格 webhook 代理（解决浏览器跨域）
// 作用：前端把回传 JSON 发给本 Worker，Worker 转发到企微接口并返回结果，
//       同时带上 Access-Control-Allow-Origin 头，浏览器就不会再报跨域。
//
// 部署方式 A（仪表盘，最简单）：
//   1. 打开 https://workers.cloudflare.com/ 登录（免费，无需信用卡）
//   2. 点 "Create Worker" → 删除默认代码，把本文件全部内容粘贴进去
//   3. 点 "Deploy" → 记下地址 https://<你的worker名>.<子域>.workers.dev
//   4. 把该地址填进网页「⚙️上传设置 → 回传代理地址」即可
//
// 部署方式 B（wrangler 命令行，见 wrangler.toml）：
//   npm install -g wrangler && wrangler login && wrangler deploy

// 目标 webhook（含 key）。浏览器不再直接持有该地址，由 Worker 代发。
const TARGET =
  'https://qyapi.weixin.qq.com/cgi-bin/wedoc/smartsheet/webhook?key=13q3vpbak4k1uyFxoToaopH15jRjtaPaQ3LH74X7z3KRp7nLRZlCUVGk1T8OJc6AWGfXV3uIfbqfMb3t1ExEov1MaCgqwFX2dQHTShxleZ2r';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: CORS });
    }
    try {
      const body = await request.text();
      const upstream = await fetch(TARGET, {
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
  },
};
