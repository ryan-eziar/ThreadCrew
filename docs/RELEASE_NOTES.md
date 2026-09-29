# ThreadCrew 0.2.0

The first public release: one local room for you, Claude Code and Codex. 中文说明在下面。

## What's in it

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

## Requirements and limits

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

## The video

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

## 中文

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
