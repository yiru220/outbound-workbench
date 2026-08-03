# 回传代理（解决企业微信接口跨域）

外呼工作台网页运行在浏览器里，而企业微信 `qyapi.weixin.qq.com` 接口**不返回 CORS 头**，浏览器会拦截直连请求（报 `Failed to fetch` / 跨域错误）。

解决办法：加一个**轻量转发代理**，浏览器把回传 JSON 发给代理，代理再转发给企微接口，并把结果带回 CORS 头。

---

## 方案 A：Cloudflare Worker（推荐，团队共用，免费）

1. 打开 <https://workers.cloudflare.com/> 登录（免费，无需信用卡）。
2. 点 **Create Worker**，删除默认代码，把 `worker.js` 全部内容粘贴进去。
3. 点 **Deploy**，记下地址，形如：
   `https://outbound-webhook-proxy.<你的子域>.workers.dev`
4. 回到外呼工作台：
   - 点登录页 **⚙️ 上传设置**
   - 在「回传代理地址」里填入上面的 Worker 地址
   - 保存后，点「🚀 回传客户信息」即可正常回传
5. （可选）把地址发给管理员，由他把 `index.html` 里的 `WEBHOOK_PROXY_URL` 常量填上并重新部署，这样 10 个同事**无需各自配置**就能直接回传。

> Worker 代码里已内置 webhook key，浏览器端不再直接持有该地址，更安全。

---

## 方案 B：本地 Node 代理（仅自己电脑测试用）

```bash
node local-proxy.js
```

然后把「回传代理地址」填 `http://localhost:8787`。
注意：localhost 只对当前电脑有效，同事访问不了，正式使用请走方案 A。

---

## 回传的数据格式

代理原样转发前端构造的 JSON，结构如下（字段名见 `WEBHOOK_FIELDS`）：

```json
{
  "add_records": [
    {
      "values": {
        "性别": "男",
        "省": "广东",
        "市": "深圳",
        "是否自有门店": "是",
        "手机号": "138xxxx",
        "回传时间": "2026-08-03 17:25:06"
      }
    }
  ]
}
```

若目标智能表格的列名不同（例如「自有门店」而非「是否自有门店」），只需改 `index.html` 里的 `WEBHOOK_FIELDS` 映射，无需动代理。
