# dsh-msg-hub

[English](README.en.md) | [简体中文](README.md)

![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)
![Node](https://img.shields.io/badge/node-%3E%3D22.13-blue)

> dsh（DeepSeek Harness）IM 渠道桥插件：把微信（ilinkai）/ QQ（开放平台）/ 飞书（开放平台）的消息接入 dsh agent 会话，并支持**主动推送**（供定时任务等场景唤醒 bot 并把 AI 回复回传手机）。

## 功能

- **📱 微信**：ilinkai 模拟协议（扫码登录），收发文本 / 图片 / 语音
- **💬 QQ**：腾讯开放平台官方 WebSocket 通道，收发文本 / 图片 / 语音（C2C 私聊 / 群聊）
- **📡 飞书**：飞书开放平台官方 API（应用凭证），收发文本 / 图片 / 语音（P2P 私聊 / 群聊）
- **🖼️ 图片与语音**（三渠道均已支持）：
  - **图片**：下载后存到工作区 `.im-media/<渠道>/<日期>/`，会话里只带路径，由 agent 用 `read_image` 自行查看——dsh 原生支持图片输入，纯文本模型会自动降级；默认保留 7 天（`DSH_MSG_HUB_MEDIA_KEEP_DAYS` 可调）
  - **语音**：转成文字后注入会话（模型听不了音频）。QQ 直接用官方给的 `asr_refer_text`（免费、即时、比自建更准），为空才回退自建 ASR
  - **微信语音**：官方 CDN 下载 → AES-128-ECB 解密 → silk→WAV 转码（`silk-wasm`）→ 自建 ASR
  - **自建 ASR 需配置**：`state/asr.env` 写 `DASHSCOPE_API_KEY`；未配置时语音自动跳过，不影响文本与图片
  - **清理策略**：媒体按日期分目录，写入时每天最多清理一次超期文件
- **🩺 诊断日志**：`state/logs/bridge-debug.log`，内置大小轮转（默认 5MB × 3 份）与每日日志清理（默认 14 天），可用 `DSH_MSG_HUB_LOG_MAX_BYTES` / `DSH_MSG_HUB_LOG_KEEP` / `DSH_MSG_HUB_LOG_KEEP_DAYS` 调整
- **🧩 主动推送服务**（`dsh-channels-push` cordis 服务）：
  - `push({channel, peerId, text})`：直接向 IM 发文本
  - `task({channel, peerId, prompt})`：唤醒渠道 agent 执行任务，AI 回复自动回传 IM
  - 供 dsh-toolbox-web 定时心跳等插件调用（未安装本插件时渠道推送自动不可用，不影响其他功能）
- **📡 远程监控**（离开电脑也能盯任务）：
  - **审批远程批准**：绑定会话的 agent 请求批准时推送到 IM（含工具名/原因/命令详情），回复「批准」或「拒绝」应答；5 分钟超时按拒绝处理（安全默认）
  - **turn 状态推送**：绑定会话的任务开始 / 完成 / 出错 / 被阻塞时实时推送
  - **会话命令**：`/sessions` 列出最近 5 个会话（名称+ID）、`/bind <会话ID>` 绑定、`/status` 查看绑定状态

## 环境要求

- **dsh** 运行时（cordis 插件，需在 dsh web profile 注册）
- **Node.js ≥ 22.13**
- 各渠道凭证：微信扫码 / QQ 开放平台 AppID+Secret / 飞书 AppID+Secret

## 安装

```bash
# 方式一：npm 包（推荐）
dsh plugin --profile web add dsh-msg-hub

# 方式二：GitHub 仓库
dsh plugin --profile web add github:AbcdefgXW/dsh-msg-hub

# 方式三：手动（本地开发/内网）
git clone https://github.com/AbcdefgXW/dsh-msg-hub.git
cd dsh-msg-hub && npm install
# 软链进 profile 并加入 bundles：
cd $DSH_HOME/profiles/web && pnpm link /路径/dsh-msg-hub
# 然后确认 package.json 的 dsh.profile.bundles 包含 dsh-msg-hub
```

> `dsh plugin add` 会自动将本插件加入 profile 的 `dsh.profile.bundles` 并挂载插件自带的注册行（`cordis.patch.yml`），**无需也不应手动修改任何配置文件**。
>
> ⚠️ 排查注册问题时请检查 `package.json` 的 `dsh.profile.bundles` 是否包含 `dsh-msg-hub`；**切勿**再在 profile 的 `cordis.patch.yml` 里手动 `insert` 本插件——bundles 已挂载时手动 insert 会导致 `duplicate loader entry id` 启动崩溃。

重启 `dsh web`。

### 渠道连接指南

**微信（ilinkai 扫码登录）**

```bash
node scripts/weixin-login.mjs login
```

1. 终端显示二维码 → 用微信「扫一扫」扫码确认
2. 登录成功自动保存 token 到 `state/weixin/`，**重启 dsh** 生效
3. 建议使用专用微信号（模拟协议登录，存在风控风险，见「安全提示」）

**QQ（开放平台官方机器人，两种方式）**

先到 [QQ 开放平台](https://q.qq.com) 注册机器人应用，拿到 AppID 与 AppSecret：

```bash
# 方式 A：凭证直填（推荐，机器人已创建时）
node scripts/qq-login.mjs --appid <AppID> --secret <AppSecret>

# 方式 B：扫码绑定（要求该 QQ 账号下已存在机器人应用）
node scripts/qq-login.mjs
```

配置后**重启 dsh** 生效。⚠️ 定时主动推送还需在开放平台**申请「主动消息权限」**，否则推送会静默失败（被动回复不受影响）。

**飞书（开放平台企业自建应用）**

1. 到[飞书开放平台](https://open.feishu.cn)创建「企业自建应用」→ 开启「机器人」能力 → 发布应用
2. 在应用「凭证与基础信息」页复制 AppID 与 AppSecret（需应用管理员权限）

```bash
node scripts/feishu-login.mjs --appid <AppID> --secret <AppSecret>
```

配置后**重启 dsh** 生效。

> 凭证全部保存在插件 `state/` 目录（已 gitignore，不会提交）；三个渠道可同时启用。

### 微信长消息分段（可配置）

微信单条消息有长度上限（实测 1280 字符完整、1380 被拒），超长自动分段发送。**分段上限可配置**（默认 1200 字符/条，留余量）：

```bash
# 方式一：dsh-toolbox-web 设置页 → 定时任务下方「微信消息分段上限」输入框（改动即时生效）
# 方式二：直接改配置文件
vi state/weixin/config.json   # {"segmentLimit": 1200}
```

改后即时生效，无需重启。

## 卸载

```bash
# 方式一：dsh 命令
dsh plugin --profile web remove dsh-msg-hub

# 方式二：手动
# 1. 编辑 profile 的 package.json，从 dsh.profile.bundles 移除 "dsh-msg-hub"
# 2. rm -rf $DSH_HOME/profiles/web/node_modules/dsh-msg-hub
# 3. rm -rf <插件目录>/state   # 凭证/日志/会话 token
# 4. 重启 dsh web
```

> 卸载后 dsh-toolbox-web 的定时心跳 IM 渠道推送自动不可用（回退主工作区心跳），其余功能不受影响。

## 崩溃恢复（vi 应急手册）

**① `duplicate loader entry id: dsh-msg-hub`（最常见）**——被注册两次（bundles + 手动 insert）：

```bash
vi /home/dsh/profiles/web/cordis.patch.yml
# 删除形如以下的手动 insert 块（bundles 会自动挂载，不需要它）：
#   - insert:
#       - id: dsh-msg-hub
#         name: 'dsh-msg-hub'
# 保留 sandbox-policy / approval 等系统配置不动
```

**② `cannot resolve profile bundle "dsh-msg-hub"`（依赖缺失）**

```bash
vi /home/dsh/profiles/web/package.json   # 检查 bundles 与 dependencies 对应
ls -la /home/dsh/profiles/web/node_modules/ | grep dsh-
ln -s /path/to/插件目录 /home/dsh/profiles/web/node_modules/dsh-msg-hub   # 恢复软链
```

**通用救急（备份回滚）**：

```bash
ls /home/dsh/profiles/web/cordis.patch.yml.bak-*   # patch 备份
ls /home/dsh/profiles/web/package.json.bak-*       # package.json 备份
cp 备份名 /home/dsh/profiles/web/cordis.patch.yml  # 覆盖回去
```

修改后**重启 dsh** 生效；仍失败看日志：`docker logs deepseek-harness`。

> ⚠️ 本插件自带 `cordis.patch.yml` 注册行，由 `dsh plugin add` 自动挂载，**切勿**在 profile 的 `cordis.patch.yml` 手动 insert（见「安装」警示）。

## 扩展新 IM 渠道（适配器注册表，预留给第三方插件）

内置微信 / QQ / 飞书三个渠道；**其他渠道通过适配器注册表接入**，无需改本插件代码：

```js
// 第三方插件（如 dsh-telegram-bridge）在启动时注册：
const api = ctx.get("dsh-channels-push"); // 服务 id：dsh-channels-push
api.registerChannel("telegram", {
  // 必选：向 peerId 发送文本（peerId 为渠道侧的用户/群标识）
  send: async (peerId, text) => { /* 调 Telegram Bot API 发送 */ },
  // 可选：自定义会话 ID 匹配（默认按 ch-<channel>- 前缀解析）
  matchSessionId: (sessionId) => sessionId.startsWith("ch-telegram-"),
});
```

注册后自动获得完整能力：

- **主动推送**：`push({ channel: "telegram", peerId, text })` —— 定时心跳等可直接推到新渠道
- **任务下发**：`task({ channel, peerId, prompt })` —— 唤醒渠道 agent 执行并把回复回传
- **会话解析**：`resolveChannel("ch-telegram-<peerId>")` —— 与内置渠道一致

会话 ID 规范：`ch-<channel>-<peerId>`（如 `ch-weixin-xxx`、`ch-telegram-xxx`）。

## 环境变量

| 变量 | 用途 | 默认 |
|---|---|---|
| `DSH_CHANNELS_STATE_DIR` | 渠道状态目录（凭证/日志/数据） | 插件 `state/` 目录 |
| `DSH_CHANNELS_CWD` | 渠道 agent 工作区根 | `/workspace` |

## 安全提示

- **微信（ilinkai）为模拟网页协议**，非官方 API——**主动频繁发消息存在账号风控风险**，建议仅低频推送（定时任务间隔 ≥ 15 分钟）
- **QQ 主动消息需在开放平台申请「主动消息权限」**，未开通时主动推送会静默失败（被动回复不受影响）
- **飞书**为官方 API，合规无风险
- 凭证存储于 `state/` 目录（`.gitignore` 已排除），请勿提交

## License

MIT
