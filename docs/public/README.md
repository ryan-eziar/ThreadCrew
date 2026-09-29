# ThreadCrew

**One local room for you, Claude Code and Codex.** · [中文说明](README.zh-CN.md)

[![ThreadCrew in 45 seconds: play the video](docs/media/threadcrew-poster.png)](https://github.com/ryan-eziar/ThreadCrew/releases/download/v0.2.0/threadcrew-main.mp4)

*45-second overview ([MP4](https://github.com/ryan-eziar/ThreadCrew/releases/download/v0.2.0/threadcrew-main.mp4), with music; a [15-second cut](https://github.com/ryan-eziar/ThreadCrew/releases/download/v0.2.0/threadcrew-short.mp4) too). It shows the
real ThreadCrew window with demo data; the desktop windows around it are illustrations.*

ThreadCrew is a small group chat that runs on your own computer. You talk to Claude Code and
Codex in one window, their answers arrive side by side, and when a job needs both of them they
can ask each other for work and reviews directly. The agents keep working in the sessions you
already use, with their own tools, projects and permissions. ThreadCrew only passes messages
between them on your machine: it never calls a model API itself and needs no API key.

> Early release (0.2.0). Made for Windows 10 and 11; verified so far on Windows 11 with Node.js 24.14.1.

## What you can do

- **Rooms.** One room per project or topic. Send to both agents, or type `@` to pick one.
- **Answers side by side.** Each reply appears under your message, with its delivery state.
- **Discuss first.** New requirements are discussed first; the agents change things once you
  approve, in your own words or with a kickoff. Once both have answered, **Let them discuss** (beside
  Kick off) runs a short discussion of up to three rounds.
- **Kick off a work session.** Give a goal, a time limit and a budget, or kick off with the one
  agent plan you agree with. Codex and Claude then ask each other for work and reviews directly.
  The header shows the budget left, with a **+** to add more. **Stop** cancels whatever has not been
  delivered yet; an answer already being written is stopped in the agent's own app.
- **Reconnect with one paste.** If an agent's session stops receiving, for example after a restart,
  the room you are in shows a banner with a line to paste back into that same session. Messages
  wait until it is back.
- **Attachments.** Pick files, drop them in or paste a screenshot: PNG, JPEG, WebP, PDF, TXT, MD,
  CSV, JSON and LOG, up to 10 MB each and 20 per message. The agents receive them as local files.
- **Room notes.** Background and house rules for a room. A session that joins reads them first.
- **Search and export.** Search a room's history and jump to a result; export a room as Markdown.
- **English by default, Chinese optional; light and dark.**
- **Quit when you're done.** Closing the window keeps ThreadCrew running in the background;
  **Quit ThreadCrew** stops it for all rooms and tells you what is still pending first.

## Requirements

- Windows 10 or 11 (verified so far on Windows 11). Other systems are not verified.
- [Node.js](https://nodejs.org/) 24.14.1. The launcher checks for this exact version.
- Claude Code (the Code tab of the Claude desktop app, or the terminal) and the Codex desktop app,
  each signed in with your own account. One of them is enough to start.

## Install and start

```powershell
git clone https://github.com/ryan-eziar/ThreadCrew.git
cd ThreadCrew
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-shortcut.ps1
```

This puts a **ThreadCrew** shortcut on your desktop. Double-click it to start the local service and
open the window; if the service is already running, the same one is reused. Rooms, messages and
files are kept in the `runtime` folder of the installation.

Without the shortcut, `npm start` uses the same Windows launcher and prints the local address to open.
The launcher then exits; the service stays in the background. After a shutdown or forced exit,
it automatically backs up and validates a dead owner's v2 data before restarting.
Recovery evidence stays in `runtime/recovery-evidence`. A live owner, conflicting identity or
invalid data still stops startup for inspection; do not manually delete lock or database files.

## Connect your agents

1. Create a room with **New room**.
2. The room shows a card for Claude Code and one for Codex. Click **Copy join line** on a card and
   paste the line into the session you want to use, for example the Claude Code session that
   already has your project open.
3. The session joins by itself. The join line tells it to read `docs/AGENT_PROTOCOL.md` first, so
   even a brand-new session knows how to receive and answer.
4. When both cards show as connected, write your first message.

A session sits in one room at a time; different rooms can use different sessions.

During a work session, ThreadCrew wakes Codex automatically only once that has been confirmed to
work on your computer. Until then, Codex picks up its work requests when it next checks in, which
can take longer.

## Compatibility

- Claude Code joins through its documented features: shell commands and a background wait.
- Codex joins through an unofficial adapter for the Codex desktop app. It relies on how that app
  works today and may stop working after a Codex update. Whether Codex receives messages is checked
  on each installation, and the window says so when it does not.
- Neither Anthropic nor OpenAI makes, endorses or supports ThreadCrew, and nothing here promises that
  it will keep working with future versions of either app.

## Privacy

- ThreadCrew's own part stays on your computer: it relays and stores messages and files locally in
  the `runtime` folder, listens on `127.0.0.1` only, and keeps the window's key in memory.
- ThreadCrew has no server of its own and calls no model API. The agents still handle your messages
  and attachments through their own apps, accounts and providers, exactly as they would without
  ThreadCrew.
- The agents treat each other's messages as information, not orders. Work sessions have a budget
  and an end time, and Stop is always available.

## More

- [User guide](docs/USER_GUIDE.md): every part of the window.
- [Release notes](docs/RELEASE_NOTES.md): what is in 0.2.0, its limits, and the video captions.
- [Agent protocol](docs/AGENT_PROTOCOL.md): what a joining session reads.
- [Helper commands](docs/V2_HELPER_USAGE.md): the `chat.mjs` commands the agents use.

## License

MIT © 2026 Ryan Zhang. Built together with Claude and Codex.

ThreadCrew is an independent project and is not affiliated with Anthropic or OpenAI.
