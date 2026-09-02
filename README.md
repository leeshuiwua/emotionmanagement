# 观心镜

TypeScript 实现的个人微信情绪记录与觉知回复系统。管理后台通过 HTTPS `3002` 访问，业务数据使用本地 SQLite，不依赖 Redis 或消息队列。

## 功能

- 微信个人号扫码登录（ilink bot HTTP 协议，无需浏览器）
- 本地保存登录凭据并在重启后自动恢复长轮询
- 仅处理好友文本私聊，忽略群聊和媒体消息
- 情绪安全分流与五镜结构化回复
- 模型 API 配置（日常 + 安全两个 role）、密钥加密、审计日志
- 中文默认、英文切换的响应式管理后台

> 个人微信没有官方机器人 API。本功能存在账号兼容性和风控风险，建议使用专用微信号，不要用于营销或群控。

## 本地开发

```bash
npm install
npm run dev
```

应用 API 默认监听 `127.0.0.1:3102`。Vite 开发页按现有配置访问。

## 生产环境变量

复制 `.env.example` 并至少设置：

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=3102
PUBLIC_BASE_URL=https://your-domain.example:3002
DATABASE_PATH=./data/guanxinjing.db
MASTER_KEY=<32字节随机值的Base64>
COOKIE_SECURE=auto
BOOTSTRAP_ADMIN_USERNAME=admin
BOOTSTRAP_ADMIN_PASSWORD=<至少12位强密码>
```

构建并启动：

```bash
npm ci
npm run build
npm start
```

使用 `deploy/nginx.conf.example` 将公网 HTTPS `3002` 反向代理到 `127.0.0.1:3102`。不要直接把 Express 端口暴露到公网。

`COOKIE_SECURE=auto` 会在 HTTPS 反向代理访问时设置 `Secure` Cookie，在受信网络内通过 HTTP 直连时使用普通 Cookie。若服务只允许 HTTPS，可设为 `true`；仅本机开发也可设为 `false`。修改后需重启服务，并清除浏览器中旧的 `gxj_session` Cookie 后重新登录。

## 验证

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

真实联调必须额外验证：

1. 添加个人微信渠道并生成二维码；
2. 手机扫码及确认后显示正确账号；
3. 好友文本能生成且只生成一次回复；
4. 群聊、图片和自己发送的消息被忽略；
5. 服务重启后凭据恢复、长轮询继续；
6. 退出微信后本地凭据被清除。
