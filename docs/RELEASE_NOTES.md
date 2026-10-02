# ThreadCrew release notes

中文说明在每个版本的英文部分之后。

## 0.3.3

Claude keeps receiving under Claude Code's time limit, work sessions can get more time, and direct
messages coordinate the agents.

- **Claude stays in the room.** With its default settings, Claude Code now stops a background
  command after two hours at most. Claude's wait ends by itself just before that, and the join,
  reconnect and resume lines tell Claude to start a new one at once, without asking you. While a
  room is quiet, Claude's session wakes for one short turn about every two hours. These brief wakes
  consume Claude usage; the amount depends on conversation length and caching. Before, Claude could
  stop receiving after 30 minutes to 2 hours of quiet, or stop to ask you.
- **Stopped rooms keep Claude reachable.** A stopped room accepts Claude's wait, and offers
  **Copy reconnect line** for a member who needs it. Before, you had to send a message first.
- **More time for a work session.** **Time left** sits beside the requests and wake-ups in the
  header. Its **+** adds an hour; the work panel offers 1, 2 or 5 more hours, up to 24 hours in all.
- **The agents talk with messages.** During a work session they tell each other things only with
  requests and answers, which are delivered to the other agent. A status change shows in the room but
  wakes no one, so each hands its finished part over with a request before marking itself completed.
- **Work requests still reach Codex after a Codex update.** An update of the Codex desktop app or
  its adapter could stop work requests from being delivered to Codex at all. Now they are still
  delivered; only the promise to reach Codex in the middle of a reply depends on the latest check. If
  Codex can't receive, the request stays queued, the room asks for your attention and offers
  Codex's reconnect line.
- A Claude session that joined before this update hasn't seen the new instruction. If it stops to
  ask whether to wait again, tell it to rearm its ThreadCrew wait without asking.
- Update from 0.3.0 or later in **Settings → Updates**.

**中文：** Claude 在 Claude Code 的时间限制下照样收消息，开工可以加时间，两位代理之间直接用消息协调。
- **Claude 一直在群里**：按默认设置，Claude Code 的后台命令现在最长运行 2 小时。Claude 的等待会在这之前
  自己结束；进群、重连和恢复口令都告诉 Claude 马上重新挂上，不用问你。群里没动静时，Claude 的会话大约
  每 2 小时醒来一个很短的回合。这些短暂的唤醒会消耗 Claude 用量，多少取决于对话长度和缓存。以前，群里
  安静 30 分钟到 2 小时后，Claude 可能就收不到消息，或者停下来问你。
- **停止的群里也能找到 Claude**：停止的群接受 Claude 的等待，需要时也提供 **复制重连口令**。以前要先发一条
  消息才行。
- **开工可以加时间**：顶栏在请求和唤醒旁边显示 **时间余量**，它的 **＋** 加 1 小时；协作任务面板里可以选加
  1、2 或 5 小时，一项任务总共最多 24 小时。
- **代理之间用消息交流**：开工期间，它们只用请求和答复互相传话，这两种会送到对方那里。状态变化会显示在
  群里，但不会唤醒任何一方，所以每位做完自己的部分，会先用一个请求交给对方，再标记完成。
- **Codex 更新后照样收到协作请求**：以前 Codex 桌面应用或它的适配器更新后，协作请求可能完全送不到 Codex。
  现在照样送达，只有"在回复中途也能收到"要看最新的检查结果。Codex 收不到时，请求留在队列里，群里会提示你
  处理，并给出 Codex 的重连口令。
- 更新前就进群的 Claude 会话没看过新的说明。如果它停下来问要不要继续等，告诉它不用问，直接重挂 ThreadCrew
  的等待。
- 从 0.3.0 及以后的版本，可在 **设置 → 更新** 升级。

## 0.3.2

Remove a member with a clear warning about unfinished collaborative work.

- **Removal includes work sessions.** The confirmation now covers work that is stopped but still
  holds a session, and work that was released while an agent might still be running. Previously,
  these cases could fail with `POSSIBLE_RUNNING_ACK_REQUIRED` after you confirmed removal.
- **Fresh confirmation when state changes.** ThreadCrew checks the current member before showing
  the dialog. If the room changes before removal, it asks you to review and confirm again.
  Switching rooms or replacing the member cannot redirect your original removal action.
- Removing a member does not stop execution in the original apps or delete history. A held work
  session must still be released separately in its details before reusing the native session.
- Update from 0.3.0 or 0.3.1 in **Settings → Updates**.

**中文：** 移除成员时，正确确认未结束的协作任务。
- 移除弹窗现在包含已经停止但仍占用会话的任务，以及已解除占用但成员可能仍在运行的任务，修复确认后仍报
  `POSSIBLE_RUNNING_ACK_REQUIRED` 的问题。
- 操作前读取最新状态；状态变化后要求重新确认。切换房间或更换成员不会让旧的确认误操作新对象。
- 移出不会停止原生应用里的执行或删除记录。仍占用会话的任务，需要在详情中另行解除，才能复用该会话。
- 从 0.3.0 或 0.3.1 可在 **设置 → 更新** 升级。

## 0.3.1

Unread replies that clear as you read, and a way to find them.

- **The unread count clears as you read.** A reply counts as read once you've seen its end, however
  long it is, and so does a work session's "completed" update. Before, those could leave a room
  showing unread replies for good.
- **Jump to the first unread.** While a room has unread replies, **N unread · Jump to the first** at
  the top takes you there, even when it is further back than what is loaded. A room with unread
  replies opens at the first of them, under a **New since you last read** line.
- **Updating from 0.3.0:** in **Settings → Updates**, click **Update to v0.3.1…**. From 0.2.x, see the
  0.3.0 notes below.

**中文：** 未读会随着阅读清掉，也能直接跳到未读。
- **未读会清掉**：看到一条回复的末尾就算读过，不管它多长；协作任务里“完成”的更新也一样。以前这些会让群一直
  显示有未读。
- **跳到第一条未读**：群里有未读时，顶部有 **N 条未读 · 跳到第一条**，点一下就过去，还没加载到的也能到。打开
  有未读的群，会直接停在第一条未读，上面有 **以下是新消息** 的分隔线。
- **从 0.3.0 升级**：在 **设置 → 更新** 里点 **更新到 v0.3.1…**。从 0.2.x 升级，见下面 0.3.0 的说明。

## 0.3.0

Updates from the window, and fewer ways to get stuck.

- **One-click updates.** ThreadCrew checks GitHub for a new stable release when it starts and every
  six hours, and a line at the top of the window says when one is out. **Settings → Updates** shows
  what's new and installs it when you click. ThreadCrew waits until nothing is pending, verifies the
  download, keeps a backup, restarts and opens a new window; if the new version does not start, it
  goes back to the previous one. Rooms, messages, files, settings and the agents' seats are kept.
  ZIP installs and clean Git clones on `main` update this way; a clone with local changes is left
  alone. The check can be turned off in Settings.
- **Copy both join lines at once.** One agent joining first no longer spoils the other's line. A
  line still stops working when the room is stopped or restored, or when its own seat changes.
- **Resume after an agent loses track.** If an agent forgets a reply it still owes, for example after
  its app compacted the conversation, a reply that has waited a while offers **Copy resume line**.
  Pasted into the same session, it lists exactly what that agent still has to answer.
- **Starting work when both agree.** If your message already says to go ahead once they agree, both
  agents confirm the same plan and the room starts a work session by itself, with the standard budget.
  Kick off still works as before, and Stop is always available.
- The README starts with a download that needs no Git.

**Updating from 0.2.x:** 0.3.0 is the first version that can update itself, so update to it once by
hand: quit ThreadCrew, run `git pull --ff-only` in your ThreadCrew folder, then open it again from the
shortcut.

**中文：** 可以在窗口里一键更新，卡住的情况也更少了。
- **一键更新**：ThreadCrew 启动时和之后每 6 小时向 GitHub 查一次新的正式版本，有的话窗口顶部会提示。
  在 **设置 → 更新** 里看新版本的说明，点一下就安装。它会等到没有待处理的事，校验下载的文件，留一份备份，
  重新启动并打开新窗口；新版本没能启动时会退回原来的版本。群、消息、文件、设置和代理的座位都会保留。
  ZIP 安装和 `main` 分支上干净的 Git clone 都能这样更新；有本地改动的 clone 不会被动。可以在设置里关掉检查。
- **两条进群口令可以同时复制**：一位先进群，不会让另一位的口令失效。群停止或恢复、或者这个座位本身变了，
  口令才会失效。
- **代理忘了回复时可以恢复**：代理欠着回复却忘了（比如它的应用压缩了对话之后），等了一阵的消息旁边会出现
  **复制恢复口令**。贴回同一个会话，它会列出这个代理还没回复的消息。
- **两位都同意就开工**：如果你的消息里已经说了“商量好就开始”，两位确认同一份方案后，群会自己进入开工，
  用标准额度。手动开工照常可用，随时可以停止。
- README 的第一种安装方式是下载 ZIP，不需要 Git。

**从 0.2.x 升级：** 0.3.0 是第一个能自己更新的版本，需要手动升级这一次：先退出 ThreadCrew，在 ThreadCrew
文件夹里运行 `git pull --ff-only`，再从快捷方式打开。

## 0.2.1

An easier install, and small fixes on top of 0.2.0.

- **Node.js 24 LTS, or 22.16 and later in the 22 line, now works.** 0.2.0 required exactly 24.14.1. Before it starts, the
  launcher checks the Node version and the built-in SQLite support, and says what to install if
  something is missing. The automated tests pass on Windows 11 with Node.js 22.16.0, 22.23.3,
  24.0.0 and 24.21.0.
- The README shows real screenshots of the window, and the release package now includes them.
- **Let them discuss:** when the popover opens, the keyboard focus is on **Start discussion**, and it
  stays there while the room updates.
- A bug-report template for installation, connection and chat problems.
- The README credits the project's contributors.

The videos and the poster stay attached to the 0.2.0 release.

**中文：** 安装更容易，另有几处小修复。
- Node.js 24 LTS，或 22 系列的 22.16 及以上，都可以用了（0.2.0 必须是 24.14.1）。启动前会检查 Node 版本和内置的
  SQLite 支持，缺什么会告诉你装什么。自动化测试在 Windows 11 上用 Node.js 22.16.0、22.23.3、24.0.0、
  24.21.0 都通过。
- README 加了真实的窗口截图，发布包也包含这些截图。
- 打开「让他们讨论」弹层时，键盘焦点落在「开始讨论」，群里有更新时也不会丢。
- 加了问题反馈模板，用于安装、连接和聊天方面的问题。
- README 加了项目贡献者说明。

视频和海报仍然附在 0.2.0 的 release 上。

## 0.2.0

The first public release: one local room for you, Claude Code and Codex.

### What's in it

- **One room, three voices.** Talk to Claude Code and Codex in one window; their answers arrive
  side by side under your message, each with its delivery state. Type `@` to send to one of them.
- **Discuss first.** New requirements are discussed first. The agents change things once you
  approve, in your own words or with a kickoff. **Let them discuss** (beside Kick off) lets each see
  the other's answer and reply, for up to three rounds.
- **Work sessions.** **Kick off** gives the two a goal, a budget and a time limit; they then ask each
  other for work and reviews directly. **Kick off with this plan** starts from the full text of one
  agent reply you agree with. **Stop** cancels what has not been delivered yet.
- **Reconnect with one paste.** When an agent's session stops receiving, the room you are in shows a
  banner with a line to paste back into that same session. Messages wait until it is back.
- **Attachments, room notes, search and Markdown export.** Exports follow the window's language.
- **Quit from the window.** Closing the window keeps ThreadCrew running in the background; **Quit
  ThreadCrew** stops it for every room and first tells you what is still pending.
- **English by default, Chinese optional; light and dark.**

### Requirements and limits

- Windows 10 or 11; verified so far on Windows 11 only.
- Node.js 24.14.1 exactly (the launcher checks the version).
- Claude Code (the Claude desktop app's Code tab, or the terminal) and/or the Codex desktop app, each
  signed in with your own account. ThreadCrew calls no model API and needs no API key.
- The agents keep receiving only while their own sessions stay open and connected.
- Claude Code joins through its documented shell commands and a background wait. Codex joins
  through an unofficial adapter for the Codex desktop app, which may stop working after a Codex
  update; whether Codex receives messages is checked on each installation.
- During a work session, Codex is woken automatically only once that has been confirmed on your
  computer; until then it picks up work requests when it next checks in.
- An answer already being written is stopped in the agent's own app, not by ThreadCrew.
- Whether an agent can read a PDF or an image depends on that agent's own tools.

### The video

`threadcrew-main.mp4` (45 s) and `threadcrew-short.mp4` (15 s): 1920×1080, H.264 and AAC, with
music and no voice. They show the real ThreadCrew window with demo data; the desktop windows around
it are illustrations. ThreadCrew is not affiliated with OpenAI or Anthropic.

On-screen text, 45-second cut:

1. One shared chat for your Codex and Claude desktop sessions.
2. Still copying answers between them?
3. Ask once. Set a budget. Kick off.
4. Both pick it up.
5. Claude writes the code in its own desktop app.
6. Codex reviews it in its own desktop app.
7. The answer comes back. Claude applies the fix.
8. ThreadCrew carries every message between them.
9. Results land back in the room.
10. One local history for the whole job.
11. ThreadCrew. Local relay and history · Your agents keep their own apps and models. Open source · MIT.

On-screen text, 15-second cut: Ask once. · Claude builds, in its own desktop app. · Codex reviews,
in its own desktop app. · ThreadCrew carries every message. · Results come back to the room. · The
same end card.

---

### 中文

第一个公开版本：你、Claude Code 和 Codex 在同一个本地群里。

- **一个群，三方对话。** 回复并排出现在你的消息下面，带送达状态；输入 `@` 可以只发给一位。
- **先讨论。** 新需求先讨论；你用自己的话明确同意，或者开工之后，代理才动手改。**让他们讨论**
  （在「开工」旁边）让两位看到对方的回复再回应，最多三轮。
- **协作任务。** **开工** 给两位一个目标、额度和期限，它们会直接互相请求和审查。
  **按这个方案开工** 用你认可的那条代理回复的全文开工。**停止** 会取消还没送达的消息。
- **一句话重连。** 代理的会话收不到消息时，你打开的群会给出一句口令，贴回原来的会话就能接上。
- **附件、群说明、搜索和 Markdown 导出**（导出跟随界面语言）。
- **从窗口退出。** 关掉窗口时服务在后台继续运行；**退出 ThreadCrew** 会停下所有群，退出前先告诉你还有什么没处理完。
- **默认英文界面，可切换中文；浅色和深色主题。**

要求和限制：Windows 10 或 11（目前只在 Windows 11 上验证过）；Node.js 必须是 24.14.1；
Claude Code 和/或 Codex 桌面应用，用你自己的账号登录。ThreadCrew 不调用任何模型 API，也不需要
API key。代理只有在自己的会话开着并保持连接时才能收消息；已经在生成的回复要到代理自己的应用里停。
Codex 通过非官方的适配器连接 Codex 桌面应用，Codex 更新后可能失效；每次安装都会检查它能不能收到消息。

视频：45 秒和 15 秒两版，1920×1080，有配乐、无人声，画面文字为英文（见上方逐条文字）。画面是真实的
ThreadCrew 窗口和演示数据，周围的桌面窗口是示意图。ThreadCrew 与 OpenAI、Anthropic 没有关联。
