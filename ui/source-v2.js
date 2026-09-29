/* Agent Chat window: network layer for BROKER_WINDOW_CONTRACT_V2 (rooms, pages, deltas).
 * The human token stays in memory: never in the URL, storage or logs. Streams are fetch-based SSE
 * with Authorization. Reconnect policy and cursors live in the app; this file only moves bytes.
 * Nothing here calls a model. */
(function () {
  'use strict';

  const API_VERSION = 'agent-chat.window.v2';

  // The file name in a Content-Disposition header: the UTF-8 form (filename*) first.
  function dispositionName(header) {
    if (!header) return null;
    const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
    if (star) { try { return decodeURIComponent(star[1].trim()); } catch (err) { /* fall through */ } }
    const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
    return plain ? plain[1].trim() : null;
  }

  function create(boot) {
    const base = `${boot.baseUrl}/api/v2`;
    const auth = { Authorization: `Bearer ${boot.humanToken}` };

    async function request(method, path, body) {
      let res;
      try {
        res = await fetch(base + path, {
          method,
          cache: 'no-store',
          headers: body === undefined ? auth : { ...auth, 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (err) {
        return { ok: false, status: 0, error: { code: 'NETWORK', outcome: method === 'GET' ? 'rejected' : 'unknown' } };
      }
      let json;
      try { json = await res.json(); } catch (err) {
        return { ok: false, status: res.status, error: { code: 'NETWORK', outcome: method === 'GET' ? 'rejected' : 'unknown' } };
      }
      // A write answered by an unexpected version may still have been committed: treat it as unknown.
      if (json.apiVersion !== API_VERSION) return { ok: false, status: res.status, error: { code: 'VERSION_MISMATCH', outcome: method === 'GET' ? 'rejected' : 'unknown' } };
      return { ...json, status: res.status };
    }

    // One SSE stream. handlers: onOpen(), onEvent(name, data), onEnd(reason: 'auth'|'error'|'ended').
    function stream(path, handlers) {
      const ac = new AbortController();
      let closed = false;
      (async () => {
        let res;
        try {
          res = await fetch(base + path, { headers: auth, cache: 'no-store', signal: ac.signal });
        } catch (err) {
          if (!closed) handlers.onEnd('error');
          return;
        }
        if (res.status === 401 || res.status === 403) { if (!closed) handlers.onEnd('auth'); return; }
        if (!res.ok || !res.body) { if (!closed) handlers.onEnd('error'); return; }
        if (handlers.onOpen) handlers.onOpen();
        try {
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done || closed) break;
            buffer += value.replace(/\r\n/g, '\n');
            let cut;
            while ((cut = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, cut);
              buffer = buffer.slice(cut + 2);
              let event = 'message';
              const data = [];
              for (const line of frame.split('\n')) {
                if (line.startsWith('event:')) event = line.slice(6).trim();
                else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
              }
              if (!data.length) continue; // comments and keepalives
              let parsed;
              try { parsed = JSON.parse(data.join('\n')); } catch (err) { continue; }
              if (!closed) handlers.onEvent(event, parsed);
            }
          }
          if (!closed) handlers.onEnd('ended');
        } catch (err) {
          if (!closed) handlers.onEnd('error');
        }
      })();
      return { close() { closed = true; ac.abort(); } };
    }

    // A file (attachment bytes, the Markdown export) with the same Authorization header; the caller
    // makes an object URL from the blob. Credentials never go into a URL.
    async function download(path) {
      let res;
      try { res = await fetch(base + path, { headers: auth, cache: 'no-store' }); } catch (err) {
        return { ok: false, status: 0, error: { code: 'NETWORK' } };
      }
      if (!res.ok) {
        let code = res.status === 404 ? 'NOT_FOUND' : 'NETWORK';
        try { const j = await res.json(); if (j && j.error && j.error.code) code = j.error.code; } catch (err) { /* not JSON */ }
        return { ok: false, status: res.status, error: { code } };
      }
      let blob;
      try { blob = await res.blob(); } catch (err) { return { ok: false, status: res.status, error: { code: 'NETWORK' } }; }
      return { ok: true, blob, filename: dispositionName(res.headers.get('Content-Disposition')) };
    }

    const q = (params) => {
      const parts = Object.entries(params).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
      return parts.length ? `?${parts.join('&')}` : '';
    };
    const room = (id) => `/rooms/${encodeURIComponent(id)}`;

    return {
      get: (path) => request('GET', path),
      post: (path, body) => request('POST', path, body),
      rooms: (lifecycle, cursor) => request('GET', `/rooms${q({ lifecycle, limit: 50, cursor })}`),
      view: (roomId) => request('GET', `${room(roomId)}/view?limit=100`),
      timeline: (roomId, params) => request('GET', `${room(roomId)}/timeline${q({ limit: 100, ...params })}`),
      attention: (roomId, cursor) => request('GET', `${room(roomId)}/attention${q({ limit: 20, cursor })}`),
      attachmentText: (roomId, id, cursor) => request('GET', `${room(roomId)}/attachments/${encodeURIComponent(id)}/text${q({ cursor })}`),
      settings: () => request('GET', '/settings'),
      diagnostics: () => request('GET', '/diagnostics'),
      notes: (roomId) => request('GET', `${room(roomId)}/notes`),
      search: (roomId, text, cursor) => request('GET', `${room(roomId)}/search${q({ q: text, limit: 20, cursor })}`),
      download: (path) => download(path),
      attachmentDownloadPath: (roomId, id) => `${room(roomId)}/attachments/${encodeURIComponent(id)}/download`,
      exportPath: (roomId, lang) => `${room(roomId)}/export${q({ lang })}`,
      shutdownPreview: () => request('GET', '/admin/shutdown-preview'),
      shutdown: (body) => request('POST', '/admin/shutdown', body),
      shutdownStatus: (instanceId, shutdownId) => request('GET', `/admin/shutdown-status${q({ expectedInstanceId: instanceId, shutdownId })}`),
      operation: (id) => request('GET', `/operations/${encodeURIComponent(id)}`),
      catalogStream: (after, handlers) => stream(`/events${q({ after })}`, handlers),
      roomStream: (roomId, after, handlers) => stream(`${room(roomId)}/events${q({ after })}`, handlers),
      roomPath: room,
    };
  }

  window.AgentChatSourceV2 = { create, dispositionName };
})();
