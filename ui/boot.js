/* Picks the window for the broker that served this page: v2 (rooms) or v1 (single room).
 * The broker injects window.__AGENT_CHAT__ before any script runs. Scripts load in order.
 * A package without a window's files (the public one ships v2 only) shows a plain message
 * instead of an empty page. */
(function () {
  'use strict';
  const boot = window.__AGENT_CHAT__;
  const v2 = Boolean(boot && boot.apiVersion === 'agent-chat.window.v2');
  const files = v2 ? ['source-v2.js', 'app-v2.js'] : ['live-source.js', 'app.js'];
  if (v2) document.documentElement.classList.add('v2');
  let failed = false;
  const unavailable = () => {
    if (failed) return;
    failed = true;
    const box = document.createElement('p');
    box.style.cssText = 'max-width:560px;margin:20vh auto;padding:0 16px;font:15px/1.6 system-ui,sans-serif;text-align:center';
    box.textContent = 'This ThreadCrew window cannot load for this service. Start ThreadCrew from its shortcut and open the address it shows.';
    document.body.replaceChildren(box);
  };
  for (const file of files) {
    const s = document.createElement('script');
    s.src = file;
    s.async = false;
    s.onerror = unavailable;
    document.head.append(s);
  }
})();
