# 观心镜

TypeScript 实现的个人微信情绪记录与觉知回复系统。管理后台通过 HTTPS `3002` 访问，业务数据使用本地 SQLite，不依赖 Redis 或消息队列。

## 功能

- 微信个人号扫码登录（ilink bot HTTP 协议，无需浏览器）
- 本地保存登录凭据并在重启后自动恢复长轮询
- 处理好友文本私聊和微信已转写的语音，忽略群聊和其他媒体消息
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
# 必须在 Linux 服务器上安装，不要从 macOS/Windows 复制 node_modules
node --version
npm ci
npm run build
npm start
```

### Linux 启动时提示 `Could not locate the bindings file`

`better-sqlite3` 是原生模块，`node_modules` 不能跨操作系统或 Node.js ABI 复用。仓库使用 Node.js 22 或更高版本，并精确锁定 `better-sqlite3 13.0.3`。在服务器项目目录执行：

```bash
git pull origin main
npm ci
node -e "const Database=require('better-sqlite3'); const db=new Database(':memory:'); console.log(db.prepare('select 1 as ok').get())"
npm run build
npm start
```

`npm ci` 会按 `package-lock.json` 重建整个 `node_modules`。如果安装阶段需要本地编译，Ubuntu/Debian 可先执行 `sudo apt-get install -y python3 make g++`，再重试 `npm ci`。

使用 `deploy/nginx.conf.example` 将公网 HTTPS `3002` 反向代理到 `127.0.0.1:3102`。不要直接把 Express 端口暴露到公网。

`COOKIE_SECURE=auto` 会在 HTTPS 反向代理访问时设置 `Secure` Cookie，在受信网络内通过 HTTP 直连时使用普通 Cookie。旧版的 `true` 值也按 `auto` 处理，避免升级后旧配置继续丢失会话；若服务只允许 HTTPS，可设为 `force`；仅本机开发也可设为 `false`。修改后需重启服务，并清除浏览器中旧的 `gxj_session` Cookie 后重新登录。

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
4. 群聊、图片、未转写语音和自己发送的消息被忽略；
5. 服务重启后凭据恢复、长轮询继续；
6. 退出微信后本地凭据被清除。
