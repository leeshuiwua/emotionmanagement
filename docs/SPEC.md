# 观心镜技术 SPEC

版本：V1.2  
适用实现：微信个人号 Web Puppet

## 1. 技术边界

单进程 Fastify 同时提供管理 API、静态后台和 Wechaty 生命周期管理。SQLite 是唯一业务数据库；个人微信登录凭据由 Wechaty MemoryCard 保存为本地文件。公网仅开放反向代理后的 HTTPS `3002` 管理入口，应用默认监听 `127.0.0.1:3102`。

## 2. 组件

| 组件 | 职责 |
| --- | --- |
| Admin SPA | 渠道创建、扫码、状态轮询、启停、退出、模型配置 |
| Fastify API | 管理认证、CSRF、状态合同、审计、静态资源 |
| `WechatyPersonalGateway` | Chromium/Wechaty 生命周期、二维码、登录恢复、消息过滤和回复 |
| Coach | 安全分流与五镜回复 |
| SQLite | 配置版本、运行状态、用户、入站消息、对话、审计 |
| MemoryCard 文件 | 微信 Web 登录 Cookie；不通过管理 API 返回 |

## 3. 微信状态机

```text
OFFLINE -> STARTING -> WAITING_SCAN -> SCANNED -> CONNECTED
                  \-> FAILED
WAITING_SCAN -> OFFLINE (timeout/cancel)
CONNECTED -> OFFLINE (logout/session invalid)
```

- 添加渠道只创建 `DRAFT`。
- `login` 事件在一个事务中退休旧 ACTIVE、激活当前渠道并启用 runtime。
- 只有 `CONNECTED` 状态允许切换 runtime。
- QR 在内存中保存，约 2 分钟失效；二维码内容不写 SQLite。
- `logout` 删除该渠道精确对应的 MemoryCard 文件。
- 扫码启动请求立即返回 `STARTING`，Chromium/Wechaty 在后台启动，SPA 每 2 秒轮询状态。
- 60 秒未收到首个二维码时进入 `FAILED`；启动阶段保留首个根错误，忽略 Wechaty 清理阶段的 `Timeout after 5000 ms`，避免次生错误覆盖根因。

## 4. 管理 API

所有 `/admin-api/v1` 接口要求管理员 Cookie；GET 以外操作还要求 `x-csrf-token`。

| 方法与路径 | 输入 | 输出/错误 |
| --- | --- | --- |
| `GET /settings/wechat/channel` | 无 | 渠道、连接状态、昵称、启用状态；不返回凭据 |
| `POST /settings/wechat/channel` | `{name: 1..80}` | 201 DRAFT；空名称 400 |
| `POST /settings/wechat/qr-sessions` | 无 | 201 `STARTING`；无渠道 409；Chromium 路径缺失等同步校验失败 502 |
| `GET /settings/wechat/qr-sessions/:id` | setting id | 当前扫码/登录状态；不存在 404 |
| `PUT /settings/wechat/channel/runtime` | `{enabled}` | 已登录时 200；未登录 409 |
| `DELETE /settings/wechat/session` | 无 | 停止、删除凭据并返回 204 |

扫码创建接口限流为每管理员每分钟 3 次。

## 5. 数据

新增表 `wechat_personal_sessions`：

```sql
setting_id TEXT PRIMARY KEY,
status TEXT CHECK(status IN (
  'OFFLINE','STARTING','WAITING_SCAN','SCANNED','CONNECTED','FAILED'
)),
account_id TEXT,
display_name TEXT,
connected_at TEXT,
last_error TEXT,
updated_at TEXT NOT NULL
```

旧版公众号表保留在数据库迁移中，仅用于兼容已有 SQLite 文件和回滚，不再被运行时代码读取。后续稳定版本可用独立迁移清理。

入站文本使用 `wechat-personal:{settingId}:{messageId}` 作为唯一 `dedupe_key`。联系人内部 ID 为 `sha256(settingId + ':' + contactId)`，避免在业务关联键中直接暴露微信联系人 ID。

## 6. 消息处理

```text
Wechaty message
 -> self/room/non-text? ignore
 -> runtime disabled? ignore
 -> INSERT OR IGNORE inbound
 -> duplicate? stop
 -> upsert local user
 -> safety + coach reply
 -> persist conversation
 -> message.say(reply)
 -> audit
```

模型调用和微信发送期间不持有 SQLite 事务。失败写审计事件，不记录 Cookie、二维码原文、模型密钥或完整异常对象。

## 7. 本地文件与权限

- `WECHAT_SESSION_DIR` 默认 `./data/wechat-sessions`，启动时创建为 `0700`。
- `WECHAT_CHROME_EXECUTABLE_PATH` 默认 `/usr/bin/chromium`。
- MemoryCard 文件名为 `personal-{settingId}.memory-card.json`。
- 生产数据库、会话目录、`.env` 应仅允许服务用户读取。
- 备份若包含会话文件，必须按敏感凭据处理；默认只备份 SQLite。

## 8. 依赖与残余风险

- `wechaty@1.20.2`
- `wechaty-puppet-wechat@1.18.4`
- `qrcode@1.5.4`

Web Puppet 不是微信官方接口，并依赖已停止维护的 Puppeteer 13。可能出现账号无法登录、会话失效或账号风控。不得加入绕过风控、自动营销或群控能力；生产建议使用专用微信号、最小权限 Linux 用户和网络出站限制。

2026-08-30 的 `npm audit --omit=dev` 结果为 29 项（17 moderate、10 high、2 critical）。其中 `wechaty-puppet-wechat -> request -> form-data` 的 critical 链没有上游修复版本，直接 Puppet 也被标记为 high 且 `fixAvailable=false`。在更换受维护的 Puppet、隔离进程并完成风险接受之前，公网生产发布必须保持 `NO-GO`。

## 9. 可验证性

自动化测试使用 `PersonalWechatGateway` 内存替身，覆盖认证/CSRF、渠道创建、二维码合同、未登录禁止启用和退出清理调用；Gateway 单元测试额外覆盖异步启动、清理超时不误判及根错误保留。自动化测试不会证明真实微信兼容性。真实联调清单见 README。

## 10. 追踪矩阵

| 需求 | 代码 | 测试 | 状态 |
| --- | --- | --- | --- |
| AC-WX-01 | `http/wechat-channel.ts` POST channel | `app.test.ts` draft | PASS |
| AC-WX-02/04/08 | Gateway + channel routes | QR/runtime/logout tests | PASS（替身） |
| AC-WX-03/05/06/07 | `personal-wechat.ts` events/message filter | 类型/构建通过 | BLOCKED：需真实账号集成测试 |
| AC-WX-09 | `startLogin` Chromium 校验 | 代码路径可复现 | PASS（静态）；待 Linux 验证 |
