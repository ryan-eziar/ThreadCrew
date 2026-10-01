# ThreadCrew · AI 同席

**你、Claude Code 和 Codex，在同一个本地群里。** · [English](README.md)

[![45 秒了解 ThreadCrew：点开看视频](docs/media/threadcrew-poster.png)](https://github.com/ryan-eziar/ThreadCrew/releases/download/v0.2.0/threadcrew-main.mp4)

ThreadCrew 是一个跑在你自己电脑上的小群聊。你在一个窗口里同时和 Claude Code、Codex 说话，
它们的回复并排出现；需要两位一起干活时，它们可以直接互相请求和审查。两位代理继续在你原来的会话里
工作，用它们自己的工具、项目和权限；ThreadCrew 只在你的电脑上替它们传话，自己从不调用模型 API，
也不需要 API key。

> 早期版本（0.3.2）。面向 Windows 10 和 11，目前在 Windows 11 上用 Node.js 22 和 24 验证过。

## 能做什么

（截图是英文界面；界面可以切换成中文。）

### 同时问两位

![一个群：一个问题，下面是 Codex 和 Claude 的回复](docs/media/screenshot-room.png)

默认发给两位，输入 `@` 可以只发给一位。每条回复出现在你的消息下面，带送达状态；
一个项目或话题一个群，各有各的记录。

### 先讨论

![让他们讨论：选好轮数，开始讨论](docs/media/screenshot-discuss.png)

新需求先讨论；你明确同意（用自己的话，或者开工）之后，代理才动手改。两位都回复后，
可以用 **让他们讨论**（在「开工」旁边）让两位看到对方的回复再回应，最多三轮。如果你的消息里
已经说了“商量好就开始”，两位确认同一份方案后，群会自己进入开工，用标准额度；随时可以停止。

### 在额度内一起干活

![协作任务：顶栏是剩余额度，下面是审查请求和答复](docs/media/screenshot-work.png)

**开工** 给两位一个目标、额度和期限，或者直接按你认可的那条代理方案开工。之后它们在群里直接
互相请求、审查，并汇报进度。顶栏显示剩余额度，点 **＋** 可以追加。**停止** 会取消还没送达的
消息；已经在生成的回复，要到代理自己的应用里停。

### 一句话重连

![代理需要重新连接：复制口令，贴回它的会话](docs/media/screenshot-reconnect.png)

代理的会话收不到消息时（比如重启之后），你打开的群会提示，并给出一句口令，贴回那个原来的会话
就能接上。发给它的消息会先保存，等它回来再送达。

如果代理忘了还欠着哪条回复（比如它的应用压缩了对话之后），等了一阵的消息旁边会出现
**复制恢复口令**。贴回同一个会话，它会列出这个代理还没回复的消息。

### 还有

- **附件**：选择文件、拖进来或粘贴截图。支持 PNG、JPEG、WebP、PDF、TXT、MD、CSV、JSON、LOG，
  每个最大 10 MB，每条消息最多 20 个。代理收到的是本地文件。
- **群说明**：一个群的背景和约定，新进群的会话会先读到。
- **搜索和导出**：搜索群里的历史并跳过去；把一个群导出成 Markdown。
- **默认英文界面，可切换中文；浅色和深色主题。**
- **用完可以退出**：关掉窗口时 ThreadCrew 在后台继续运行；**退出 ThreadCrew** 会停下所有群，
  退出前先告诉你还有哪些事没处理完。
- **一键更新**：有新版本时 ThreadCrew 会告诉你，你点一下就安装。见[更新](#更新)。

## 需要什么

- Windows 10 或 11（目前只在 Windows 11 上验证过），其他系统还没有验证。
- [Node.js](https://nodejs.org/) 24 LTS（推荐），或 22 系列的 22.16 及以上。启动器会在启动前检查版本
  和内置的 SQLite 支持，缺什么会告诉你装什么。
- Claude Code（Claude 桌面版的 Code 标签，或终端）和 Codex 桌面版，各自登录你自己的账号。
  只有其中一个也能先用起来。

## 安装和启动

**下载安装（不需要 Git）**：在[最新版本](https://github.com/ryan-eziar/ThreadCrew/releases/latest)页面下载
`ThreadCrew-<版本号>.zip`，解压到一个会一直保留的文件夹，比如 `Documents\ThreadCrew`。然后在这个文件夹里运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-shortcut.ps1
```

**或者用 Git：**

```powershell
git clone https://github.com/ryan-eziar/ThreadCrew.git
cd ThreadCrew
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-shortcut.ps1
```

两种方式运行后，桌面上都会出现 **ThreadCrew** 快捷方式。双击它会启动本地服务并打开窗口；服务已经在运行时，
会直接复用。群、消息和文件都保存在安装目录下的 `runtime` 文件夹里。

不用快捷方式的话，运行 `npm start` 会走同一个 Windows 启动器，并打印要打开的本地地址。
启动器随后退出，服务继续在后台运行。关机或强制结束后，如果旧进程已退出，启动器会自动备份、
校验 v2 数据再恢复，证据保存在 `runtime/recovery-evidence`。进程仍在、身份冲突或数据损坏时仍会
停止并要求检查；不要手动删除锁或数据库文件。

## 把代理连进来

1. 点 **新建群聊**。
2. 群里会显示 Claude Code 和 Codex 两张卡片。点卡片上的 **复制进群口令**，贴到你想用的那个会话里，
   比如已经打开你项目的 Claude Code 会话。两条口令可以同时复制：一位先进群，不会让另一位的口令失效。
3. 会话会自己进群。口令会让它先读 `docs/AGENT_PROTOCOL.md`，所以就算是全新的会话，
   也知道怎么收消息、怎么回复。
4. 两张卡片都显示已连接后，就可以发第一条消息了。

一个会话同一时间只在一个群里；不同的群可以用不同的会话。

开工期间，只有在你的电脑上确认过可行之后，ThreadCrew 才会自动唤醒 Codex。在那之前，
Codex 会在它下一次自己检查时再取工作请求，所以可能慢一些。

## 更新

ThreadCrew 启动时和之后每 6 小时向 GitHub 查一次有没有新的正式版本。有的话，窗口顶部会有一行提示。
打开 **设置 → 更新** 看新版本的说明，再点 **更新到 v…**。ThreadCrew 会等到没有待处理的消息和任务，
校验下载的文件，给当前版本留一份备份，然后重新启动，并自己打开新窗口。如果新版本没能启动，会退回
原来的版本。群、消息、文件和设置都会保留，代理也不用重新进群。

- **用 ZIP 装的**：按上面的方式更新。
- **用 Git 装的**：在 `main` 分支上、没有本地改动的 clone 也一样更新；有本地改动、本地提交或者在别的
  分支上的，不会被动，请自己用 Git 更新。
- **从 0.2.x 升级**：0.3.0 是第一个能自己更新的版本，需要手动升级这一次：先退出 ThreadCrew，在 ThreadCrew
  文件夹里运行 `git pull --ff-only`，再从快捷方式打开。
- 不想让它检查，在设置里关掉 **自动检查更新**。
- 每次更新都会在安装目录的 `runtime\updates` 里留一份旧版本和数据的备份。目前不会自动清理；每份可能
  比较大，因为包含群数据库的副本。更新进行中时不要删除。

## 兼容性

- Claude Code 通过它公开文档里的功能进群：命令行和后台等待。
- Codex 通过一个非官方的适配器连接 Codex 桌面应用。它依赖这个应用目前的行为，Codex 更新后可能失效。
  每次安装都会检查 Codex 能不能收到消息，收不到时窗口会说明。
- ThreadCrew 不是 Anthropic 或 OpenAI 的产品，也没有得到它们的认可或支持；这里不保证它能兼容
  这两个应用以后的版本。

### 可选：给 Codex 的恢复 hook

Codex 压缩了很长的对话之后，这个 hook 会提醒它还欠着群里哪些回复。默认不装。要装的话，在 ThreadCrew
文件夹里运行：

```powershell
node scripts\configure-codex-recovery.mjs install --config (Join-Path $HOME '.codex\hooks.json') --runtime-dir .\runtime
```

如果你设置过 `CODEX_HOME`，把前面换成 `(Join-Path $env:CODEX_HOME 'hooks.json')`。然后在 Codex CLI 里用
`/hooks` 审查并确认这个新 hook；确认之前 Codex 不会运行它。它在 Codex 桌面版的会话里能不能生效，取决于你装的
Codex 版本，装上并不保证一定生效。你原有的其他 hook 会保留，并且会先备份。要拿掉，
把命令里的 `install` 换成 `remove` 再运行一次。不装也可以，代理忘了回复时用 **复制恢复口令**。

## 隐私

- ThreadCrew 自己的部分都留在你的电脑上：消息和文件在本地中转，保存在 `runtime` 文件夹里；
  服务只监听 `127.0.0.1`，窗口的密钥只放在内存里。
- ThreadCrew 没有自己的服务器，也不调用任何模型 API。代理照常通过它们自己的应用、账号和服务商
  处理你的消息和附件，和不用 ThreadCrew 时一样。
- 检查更新只向 GitHub 查这个仓库的最新版本号，不会发送你的群、消息或文件。只有你点了更新，才会下载
  和安装。可以在设置里关掉检查。
- 代理把对方的消息当作信息，而不是命令。开工有额度和截止时间，随时可以停止。

## 更多

- [使用指南](docs/USER_GUIDE.zh-CN.md)：窗口里每个部分怎么用。
- [版本说明](docs/RELEASE_NOTES.md)：每个版本带来了什么、有哪些限制，以及视频字幕（中英文）。
- [代理协议](docs/AGENT_PROTOCOL.md)：进群的会话会先读这份（英文）。
- [helper 命令](docs/V2_HELPER_USAGE.md)：代理用的 `chat.mjs` 命令（英文）。

## 贡献者

- [ryan-eziar](https://github.com/ryan-eziar) — 产品方向和验收。
- Claude — 界面、文档和宣传媒体。
- [Codex](https://github.com/codex) — broker、原会话接入、可靠性验证和发布。

Claude 和 Codex 以 AI 编程助手的身份参与构建。

## 许可证

MIT © 2026 Ryan Zhang。由 Claude 和 Codex 一起参与构建。

ThreadCrew 是独立项目，与 Anthropic、OpenAI 没有关联。
