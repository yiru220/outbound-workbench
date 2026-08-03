// 本地测试用代理（Node 18+，零依赖）。
// 当你还没部署 Cloudflare Worker、只想先在电脑上验证回传是否成功时用。
//
// 运行:  node local-proxy.js
// 然后浏览器「⚙️上传设置 → 回传代理地址」填 http://localhost:8787
// 注意：localhost 只对你自己这台电脑有效，同事访问不了；正式给团队用请部署 Worker。

const http = require('http');

const TARGET =
  'https://qyapi.weixin.qq.com/cgi-bin/wedoc/smartsheet/webhook?key=13q3vpbak4k1uyFxoToaopH15jRjtaPaQ3LH74X7z3KRp7nLRZlCUVGk1T8OJc6AWGfXV3uIfbqfMb3t1ExEov1MaCgqwFX2dQHTShxleZ2r';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }
  if (req.method !== 'POST') {
    res.writeHead(405, CORS);
    return res.end('Method Not Allowed');
  }
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', async () => {
    try {
      const upstream = await fetch(TARGET, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: data,
      });
      const text = await upstream.text();
      res.writeHead(upstream.status, {
        'Content-Type': 'application/json; charset=utf-8',
        ...CORS,
      });
      res.end(text);
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
      res.end(JSON.stringify({ errcode: -1, errmsg: 'proxy error: ' + e.message }));
    }
  });
});

server.listen(8787, () => console.log('回传代理已启动: http://localhost:8787'));
