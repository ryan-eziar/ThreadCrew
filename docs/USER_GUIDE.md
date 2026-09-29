# ThreadCrew user guide

[中文](USER_GUIDE.zh-CN.md)

## The window

- **Left: the sidebar.** Your rooms and **New room**. At the bottom: **Desktop notifications**,
  **Archived rooms**, **Settings and about**, **Quit ThreadCrew**, the light or dark theme, and the
  language (English by default; Chinese is optional).
- **Top: the room header.** Click the room name for the room panel (notes, export, rename,
  archive). While a work session runs, its chip and the budget left sit next to it. A
  **Needs your attention** chip appears when something waits for you. The magnifier searches the
  room, and the two member buttons show where Codex and Claude are.
- **Middle: the conversation.** Your messages on the right, the agents' replies on the left.
- **Bottom: the composer.** Who the message goes to, **Let them discuss**, **Kick off**,
  attachments, and Send. The line under it says whether the room is in *Discussion* or *Working*.

## Connecting sessions

Each room has one seat for Claude Code and one for Codex.

1. In a new room, click **Copy join line** on the agent's card. In an existing room, click the
   agent's name in the header and copy the join line there.
2. Paste the line into the native session you want to use. It joins by itself, after reading
   the agent protocol.
3. To move a seat to another session, use **Copy join line for a new session** in the same menu
   and paste it into the new session.

You can copy both join lines at once: one agent joining first doesn't spoil the other's line.
A session sits in one room at a time. If a session says the join line is outdated (`GATE_CHANGED` or
`JOIN_CHANGED`), the room or that seat changed in the meantime (the room was stopped or restored, or
the seat was taken or removed): copy the line again.

During a work session, Codex is woken automatically only once that has been confirmed to work on
your computer; until then it picks up work requests when it next checks in.

What the member buttons say:

| State | Meaning |
|---|---|
| Not joined | No session in this seat yet. Messages are kept and delivered once one joins. |
| Connected / Standing by | Ready. Claude "stands by" while it waits for messages. |
| Notified | A message is waiting for the agent to pick it up. |
| Working | It is answering. New messages queue behind. |
| Check needed | It is not certain whether the last message arrived; see the hint. |
| Offline | The session can't receive right now. Messages are kept; see *Reconnecting an agent*. |

### Reconnecting an agent

An agent's session can stop receiving, most often after its app or your computer restarts. When
that happens in the room you are in, a banner at the top says **Claude needs reconnecting** (or
Codex), and messages to it are kept until it is back.

1. Click **Copy reconnect line** in the banner (it is also in the agent's menu).
2. Open that agent's original session, the same conversation that was in the room, and paste
   the line.
3. The session checks that it is the same one, reconnects its seat and starts receiving again.
   The banner goes away only once the room sees it receiving.

The banner appears only in the room you open. If an agent drops while you are in the room, the
banner waits 45 seconds first, so the short pauses between an agent's replies never set it off.
The line is refused in any other session. To move a seat to another session, use **Copy join line
for a new session** instead.

### Resuming unanswered messages

An agent can lose track of a reply it still owes, for example after its app compacts a long
conversation. Once a reply has been awaited for five minutes, the message offers **Copy resume line**
next to **Stop waiting**; the agent's menu has it too.

1. Click **Copy resume line**.
2. Paste it into that agent's original session, the same conversation that is in the room.
3. The session checks that it is the same one, then lists exactly the messages it still has to
   answer, and answers them.

Nothing is sent or answered on the agent's behalf, and the line is refused in any other session.

## Sending

- By default a message goes to both agents. Click a name under the text to leave it out, or type
  `@` to send to one.
- **Enter** sends, **Shift+Enter** adds a line. Messages may use Markdown.
- While something is queued or running and the box is empty, Send turns into **Stop**. Stop cancels
  what has not been delivered yet. An answer that is already being written has to be stopped in
  the agent's own app.

## Replies and discussions

Each message shows a delivery state per agent: queued, delivered, picked up, answered.

New requirements are discussed first: the agents answer with their views and don't start changing
things. They make changes once you approve, in your own words, or when a change continues work you
already approved. **Kick off** (below) starts a bounded work session for the two to work on together.
*Working* on its own approves nothing else: during a work session a new message is discussed first
and doesn't widen the work unless you say so.

**Let them discuss** sits in the composer, next to **Kick off**. It is about your latest message:
once both agents have answered it, click the button, choose 1 to 3 rounds and **Start discussion**.
Each sees the other's answer and replies. It ends when the rounds run out, or when both say in the
same round that they have nothing to add. The button then offers **Discuss again**.

When a discussion can't start yet, the button stays in its place, greyed, and its popover says why
(for example, one answer is still missing, or an agent can't receive). While a discussion runs, the
button shows the round; its popover offers **Stop**, which stops the whole room, so it asks first.

**Starting work when both agree.** If your message already says to go ahead once they agree (for
example "discuss it, then start"), both agents confirm the same plan when they are done, and the room
starts a work session by itself, with the standard budget and time limit. The room shows that it
started, on the strength of which message, and with which plan; **Stop** works as usual. Only your
own messages count, and if only one agent confirms, nothing starts. **Kick off** works as before.

## Work sessions

Turn on **Kick off** before sending when the two should work together and make changes. Set:

- **the goal**, one line (by default the first line of the message);
- **the budget**: small, standard or large, a number of requests and wake-ups;
- **how long it may run**: 2, 4 or 10 hours.

Both agents must be in the room, and a room runs one work session at a time. During the session
they send each other requests (for work or a review) and answers, and report progress.

**Kick off with this plan.** When a discussion has produced a plan you agree with, point at that
agent reply and choose **Kick off with this plan**. Its full text (not a preview) goes into the
composer with Kick off turned on, and the goal is taken from its first line. Check both, then press
**Kick off**; nothing is sent before that. It uses the one reply you chose: picking another reply
replaces it, and a draft you had is only replaced after you confirm. A reply longer than a message
may be (32,000 characters) can't be used this way.

- A **request** is one agent asking the other for something.
- A **wake-up** is one turn of an agent's session to handle a request or an answer. A request
  and its answer usually take two, so the presets give twice as many wake-ups as requests.
- The header shows what is left of each. The **+** next to a number adds more. When one runs out,
  the session pauses until you add more.
- **Stop** cancels what has not been delivered yet; answers already being written are stopped in
  the agents' own apps. Afterwards the work panel offers **Release work session** to free the room.

## Attachments

Click the paper clip, drop files on the conversation or paste a screenshot. Supported: PNG, JPEG,
WebP, PDF, TXT, MD, CSV, JSON and LOG, up to 10 MB each and 20 per message.

Each file uploads at once and shows above the text. Sending waits until every file is uploaded;
a file that failed must be retried or removed first, so a message never goes out without a file
you added. The agents receive the files as local copies they can open with their own tools. In the
conversation, images show as thumbnails that open larger, and other files download with a click.

Whether an agent can read what is in a PDF or an image depends on that agent's own tools. ThreadCrew
delivers the file; it does not install readers or renderers for the agents. For example, Claude
Code renders PDF pages with Poppler (`pdftoppm`); without Poppler an agent may still read a PDF's
text but not see its layout. In our tests on Windows 11 both agents read the text of a PDF;
rendering PDF pages, and PDFs with complex layouts, were not verified.

## Room notes

Open the room panel and choose **Write notes**. Notes are plain text, up to 8000 characters: what
the project is, the conventions, what to watch out for. A session that joins reads the current
notes first, and messages carry them as background. Notes are background, not a new task.

## Search, export and moving around

- **Search** (the magnifier) matches the words as typed, in any case, newest first. Click a result
  to jump there.
- **Export as Markdown** (room panel) saves the room with speakers, times, full text and the
  notes. Its headings and labels follow the window's language; what was written stays as written.
  Attachments are listed by name and size; the files themselves are not included.
- On a long conversation, the faint marks on the left edge are your messages: point at one for a
  preview, click to jump. **Outline** lists them all. The round buttons jump to the start or back
  to the latest.

## Archived rooms

Archive a room from its panel when it is finished. **Archived rooms** in the sidebar switches the
list to the archive, with a filter by name. An archived room can be read and restored, but not
used for new messages.

## Settings and about

**Settings and about** holds your display name: the room and its exports show you by it, and
empty means "You". It also shows the version and the license, and **Copy diagnostics** copies a
short technical summary for bug reports. It contains the product and Node versions, the platform
and the checks, and no credentials, paths or conversation IDs.

## Updates

**Settings and about → Updates** shows the version you have, the latest release and when ThreadCrew
last checked.

- **Check for updates automatically** (on by default) asks GitHub when ThreadCrew starts and every
  six hours. It only looks up version numbers. **Check now** asks at once.
- When a release is out, a line at the top of the window says so. **Later** hides it for that version.
- **Update to v…** asks first. An update waits until no messages or work are pending: if some are,
  the dialog lists the busy rooms and what is left in each. It also warns about unsent text or files
  in this window, which a restart loses.
- After you confirm, the window shows the steps: download, verify, stop, install, restart. ThreadCrew
  then opens a new window by itself (the address may change), and the old one can be closed. If no
  new window opens, open ThreadCrew from its shortcut.
- If the new version doesn't start, ThreadCrew goes back to the previous version and says so. An
  update that fails before ThreadCrew stops leaves it running as it was.
- A ZIP install or a clean Git clone on `main` updates this way. A clone with local changes, local
  commits or another branch is not touched: update it with Git yourself.

## Quitting ThreadCrew

Closing the window keeps ThreadCrew running in the background. The agents keep receiving only while
their own sessions stay open and connected; closing an agent's app is not covered by this. To stop
ThreadCrew, use **Quit ThreadCrew** in the sidebar (or in **Settings and about**).

Quitting stops every room, not only the open one. The confirmation says what is still pending
(messages not yet delivered, answers being written, work sessions running) and warns about text or
files in this window that you haven't sent. **Cancel** changes nothing.

After you confirm, the window shows **Quitting ThreadCrew…** until ThreadCrew answers:

- **ThreadCrew has stopped.** You can close the window. Saved messages and work records are kept;
  start ThreadCrew from its shortcut to use it again. Queued messages wait until then, a work
  session carries on only while its grant is valid (its time limit keeps running), and anything
  not known to have arrived is not resent by itself.
- **ThreadCrew didn't stop cleanly.** It may still be running. Open it again from its shortcut; the
  launcher checks it and recovers safely. Don't delete its runtime data.
- **Stop not confirmed.** The connection closed before ThreadCrew answered, so it isn't known
  whether it stopped. Open it again from its shortcut; the launcher checks whether it is running.

Other open ThreadCrew windows show the same result. The agents' own sessions are not closed.

## When something looks wrong

- **The window says the key expired.** The service restarted: reload the page.
- **An agent stays Offline or Disconnected after a restart.** Open that room and use **Copy reconnect
  line** in its banner (or the agent's menu), then paste it into that agent's same original session.
  Use **Copy join line for a new session** only when you mean to give the seat to another session.
- **A delivery is marked Check needed.** Look in the agent's own app before resending, because it
  may already have the message.
- **An agent seems to have forgotten a message.** After five minutes the message offers **Copy
  resume line**: paste it into that agent's same session (see *Resuming unanswered messages*).
- **An update didn't finish.** The window says why. ThreadCrew stays on, or goes back to, the
  previous version, with your rooms and records intact.
