/**
 * Mentor chat client. Streams replies from POST /mentor/message/stream (server-sent events over
 * fetch) and falls back to the plain JSON endpoint when the browser can't read a stream.
 * Model and user text is only ever set with textContent, never parsed as HTML.
 * Read-aloud (public/js/voice.js): every mentor reply gets a Listen button, and new replies are
 * spoken automatically when "Read replies aloud" is on (remembered per browser).
 */
(function () {
  var root = document.getElementById('mentor-app');
  if (!root) return;
  var csrf = root.getAttribute('data-csrf');
  var dailyLimit = Number(root.getAttribute('data-daily-limit'));
  var chat = document.getElementById('chat');
  var form = document.getElementById('composer');
  var box = document.getElementById('msg');
  var send = document.getElementById('send');
  var remaining = document.getElementById('remaining');
  var pendingText = null, pendingId = null; // keep the same id when retrying a failed send
  var canStream = !!(window.ReadableStream && window.TextDecoder && window.fetch);

  function newId() {
    var a = new Uint8Array(16); crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  function bubble(text, cls) {
    var d = document.createElement('div');
    d.className = 'co-msg ' + cls;
    d.textContent = text;
    chat.appendChild(d);
    chat.scrollTop = chat.scrollHeight;
    return d;
  }
  var ERR = {
    no_access: 'Your mentor access has ended. Renew it on the Join page.',
    daily_limit: 'You\'ve used today\'s messages. Come back tomorrow — consistency beats cramming.',
    monthly_limit: 'You\'ve reached this month\'s message limit. Ask your tutor if you need more.',
    ai_unavailable: 'The mentor is unavailable right now. Your message was not counted — press Send to retry.',
    in_progress: 'Still working on your last message…'
  };
  /** Listen button on a finished reply; speak it now if the reader turned read-aloud on. */
  function voiceUp(el, text, fresh) {
    var V = window.V2SVoice;
    if (!V || !el || !text) return;
    V.addListenButton(el, function () { return text; });
    if (fresh && V.autoRead()) V.speak(text, el.querySelector('.tts-btn'));
  }
  function setRemaining(n) {
    if (typeof n === 'number') remaining.textContent = n + ' of ' + dailyLimit + ' messages left today';
  }
  chat.scrollTop = chat.scrollHeight;
  // Replies already on the page (history) get Listen buttons once voice.js has loaded.
  Array.prototype.forEach.call(chat.querySelectorAll('.co-msg-bot:not(#welcome)'), function (el) { voiceUp(el, el.textContent.trim(), false); });

  function post(url, text) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ message: text, clientMsgId: pendingId })
    });
  }

  /** JSON answers: errors decided up front, replays, and the non-streaming endpoint. */
  function handleJson(r, ui) {
    return r.json().catch(function () { return { error: 'ai_unavailable' }; }).then(function (body) {
      ui.wait.remove();
      if (r.ok && body.reply) {
        voiceUp(bubble(body.reply, 'co-msg-bot'), body.reply, true);
        pendingText = pendingId = null;
        setRemaining(body.remainingToday);
      } else {
        fail(ui, body.error);
      }
    });
  }

  function fail(ui, code) {
    ui.mine.remove(); box.value = ui.text; // let them retry the same text (same id => never double-billed)
    bubble(ERR[code] || 'Something went wrong. Please try again.', 'co-msg-bot co-msg-err');
    if (code === 'daily_limit' || code === 'monthly_limit' || code === 'no_access') pendingText = pendingId = null;
  }

  /** Reads "event:/data:" blocks from the response body as they arrive. */
  function readStream(r, ui) {
    var reader = r.body.getReader();
    var decoder = new TextDecoder();
    var buf = '';
    var out = null;
    var finished = false;
    function handle(block) {
      var event = 'message', data = '';
      block.split('\n').forEach(function (line) {
        if (line.indexOf('event:') === 0) event = line.slice(6).trim();
        else if (line.indexOf('data:') === 0) data += line.slice(5).trim();
      });
      if (!data) return;
      var msg; try { msg = JSON.parse(data); } catch (e) { return; }
      if (event === 'message' && typeof msg.delta === 'string') {
        if (!out) { ui.wait.remove(); out = ui.out = bubble('', 'co-msg-bot'); }
        out.textContent += msg.delta;
        chat.scrollTop = chat.scrollHeight;
      } else if (event === 'done') {
        finished = true;
        if (out) voiceUp(out, out.textContent, true);
        pendingText = pendingId = null;
        setRemaining(msg.remainingToday);
      } else if (event === 'error') {
        finished = true;
        if (out) out.remove(); else ui.wait.remove();
        fail(ui, msg.error);
      }
    }
    function pump() {
      return reader.read().then(function (chunk) {
        if (chunk.done) {
          if (!finished) { if (out) out.remove(); else ui.wait.remove(); fail(ui, 'ai_unavailable'); }
          return;
        }
        buf += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n');
        var i;
        while ((i = buf.indexOf('\n\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 2); }
        return pump();
      });
    }
    return pump();
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = box.value.trim();
    if (!text) return;
    if (text !== pendingText) { pendingText = text; pendingId = newId(); }
    send.disabled = true;
    var welcome = document.getElementById('welcome'); if (welcome) welcome.remove();
    var ui = { text: text, mine: bubble(text, 'co-msg-me'), wait: bubble('Thinking…', 'co-msg-bot co-msg-wait') };
    box.value = '';

    var request = canStream
      ? post('/mentor/message/stream', text).then(function (r) {
        var type = r.headers.get('content-type') || '';
        return type.indexOf('text/event-stream') === 0 && r.body ? readStream(r, ui) : handleJson(r, ui);
      })
      : post('/mentor/message', text).then(function (r) { return handleJson(r, ui); });

    request.catch(function () {
      ui.wait.remove(); ui.mine.remove(); if (ui.out) ui.out.remove(); box.value = text;
      bubble('Network problem. Check your connection and press Send to retry.', 'co-msg-bot co-msg-err');
    }).then(function () { send.disabled = false; box.focus(); });
  });
  box.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });
})();
