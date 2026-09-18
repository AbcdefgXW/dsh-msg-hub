# dsh-msg-hub

[English](README.en.md) | [简体中文](README.md)

![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)
![Node](https://img.shields.io/badge/node-%3E%3D22.13-blue)

> An IM channel bridge plugin for dsh (DeepSeek Harness): connects WeChat (ilinkai) / QQ (Open Platform) / Feishu (Open Platform) messages into dsh agent sessions, with **proactive push** support (wake the channel bot and deliver the AI reply back to your phone — for scheduled tasks etc.).

## Features

- **📱 WeChat**: ilinkai simulated protocol (QR login), text / image / voice send/receive
- **💬 QQ**: Tencent Open Platform official WebSocket channel, text / image / voice (C2C / group)
- **📡 Feishu**: Feishu Open Platform official API (app credentials), text / image / voice (P2P / group)
- **🖼️ Images & voice** (supported on all three channels):
  - **Images**: downloaded into `.im-media/<channel>/<date>/` in the workspace; only the path enters the session and the agent views it with `read_image` — dsh natively supports image input and auto-degrades for text-only models; kept 7 days by default (`DSH_MSG_HUB_MEDIA_KEEP_DAYS`)
  - **Voice**: transcribed to text before entering the session (models cannot listen to audio). QQ uses the official `asr_refer_text` (free, instant, more accurate than self-hosted ASR) and falls back to self-hosted ASR when empty
  - **WeChat voice**: official CDN download → AES-128-ECB decrypt → silk→WAV transcode (`silk-wasm`) → self-hosted ASR
  - **Self-hosted ASR setup**: put `DASHSCOPE_API_KEY` in `state/asr.env`; voice is skipped when unset, text and images are unaffected
  - **Retention**: media lives in date-based folders and is swept at most once per day on write
- **🩺 Diagnostic log**: `state/logs/bridge-debug.log` with built-in size rotation (default 5MB × 3) and daily log cleanup (default 14 days); tune via `DSH_MSG_HUB_LOG_MAX_BYTES` / `DSH_MSG_HUB_LOG_KEEP` / `DSH_MSG_HUB_LOG_KEEP_DAYS`
- **🧩 Proactive push service** (`dsh-channels-push` cordis service):
  - `push({channel, peerId, text})`: send text directly to IM
  - `task({channel, peerId, prompt})`: wake the channel agent to run a task; the AI reply is delivered back to the IM automatically
  - Consumed by plugins like dsh-toolbox-web's scheduled heartbeat (channel push is unavailable without this plugin; everything else is unaffected)
- **📡 Remote monitoring** (keep an eye on tasks away from the computer):
  - **Remote approval**: when the bound session's agent requests approval, the request is pushed to IM (tool name / reason / command detail); reply "批准" or "拒绝" to answer; 5-minute timeout falls back to rejected (safe default)
  - **Turn push**: task started / finished / errored / blocked notifications for the bound session
  - **Session commands**: `/sessions` lists the 5 most recent sessions (name+ID), `/bind <sessionId>` binds, `/status` shows the binding

## Requirements

- **dsh** runtime (cordis plugin, registered in the dsh web profile)
- **Node.js ≥ 22.13**
- Per-channel credentials: WeChat QR / QQ AppID+Secret / Feishu AppID+Secret

## Installation

## Installation

```bash
# Option 1: npm package (recommended)
dsh plugin --profile web add dsh-msg-hub

# Option 2: GitHub repository
dsh plugin --profile web add github:AbcdefgXW/dsh-msg-hub

# Option 3: manual
git clone https://github.com/AbcdefgXW/dsh-msg-hub.git
cd dsh-msg-hub && npm install


```bash
git clone https://github.com/USER/dsh-msg-hub.git
cd dsh-msg-hub && npm install
cd $DSH_HOME/profiles/web && pnpm link /path/to/dsh-msg-hub
```

Register in `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-msg-hub
      name: dsh-msg-hub
```

Restart `dsh web`.

### Channel connection guide

**WeChat (ilinkai QR login)**

```bash
node scripts/weixin-login.mjs login
```

1. A QR code appears in the terminal — scan it with the WeChat app
2. On success the token is saved to `state/weixin/`; **restart dsh** to activate
3. A dedicated WeChat account is recommended (simulated protocol — see "Safety Notes" for risk-control warnings)

**QQ (Open Platform official bot, two options)**

First register a bot app on the [QQ Open Platform](https://q.qq.com) to get AppID and AppSecret:

```bash
# Option A: credentials directly (recommended once the bot exists)
node scripts/qq-login.mjs --appid <AppID> --secret <AppSecret>

# Option B: QR binding (requires an existing bot under this QQ account)
node scripts/qq-login.mjs
```

**Restart dsh** after configuring. ⚠️ Proactive pushes additionally require applying for **"proactive message permission"** on the Open Platform, otherwise they fail silently (passive replies are unaffected).

**Feishu (Open Platform enterprise self-built app)**

1. Create an "enterprise self-built app" on the [Feishu Open Platform](https://open.feishu.cn) → enable the **bot** capability → publish the app
2. Copy AppID and AppSecret from the app's "Credentials & Basic Info" page (needs app admin permission)

```bash
node scripts/feishu-login.mjs --appid <AppID> --secret <AppSecret>
```

**Restart dsh** after configuring.

> Credentials are stored under the plugin `state/` dir (gitignored, never committed); all three channels can run simultaneously.

## Environment Variables

| Variable | Purpose | Default |
|---|---|---|
| `DSH_CHANNELS_STATE_DIR` | channel state dir (credentials/logs/data) | plugin `state/` dir |
| `DSH_CHANNELS_CWD` | channel agent workspace root | `/workspace` |

## Safety Notes

- **WeChat (ilinkai) uses a simulated web protocol** (not an official API) — **frequent proactive messaging carries account risk-control risk**; keep push frequency low (scheduled interval ≥ 15 minutes)
- **QQ proactive messages require applying for "proactive message permission"** on the Open Platform; without it, proactive pushes fail silently (passive replies are unaffected)
- **Feishu** uses the official API — compliant and safe
- Credentials live in `state/` (excluded via `.gitignore`) — never commit them

## License

MIT
