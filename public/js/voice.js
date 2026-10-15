/**
 * Voice input + read-aloud, shared by the goal box, the daily check-in and the mentor chat.
 *
 * Speech-to-text, in order of preference:
 *   1. MediaRecorder -> upload the clip to POST /api/voice/transcribe (Groq Whisper on the server).
 *      Max 60 s, low bitrate (mobile data), upload progress shown, retry keeps the same clip.
 *   2. The browser's own SpeechRecognition (Chrome/Edge/Safari) when recording isn't available.
 *   3. Typing. Mic blocked or unsupported always ends here, with a short explanation.
 * The clip is sent once and never stored; only the transcript comes back into the text box.
 *
 * Markup:
 *   <button type="button" data-voice-target="inputId" data-voice-status="statusId" data-csrf="…">
 *   (add data-voice-compact for icon-only buttons: the countdown then shows in the status line)
 *   <p id="statusId" class="voice-status" role="status" aria-live="polite"></p>
 *
 * Read-aloud (speechSynthesis): window.V2SVoice.addListenButton(container, getText) adds a
 * Listen/Stop toggle; window.V2SVoice.autoRead() is the remembered "read replies aloud" choice.
 */
(function () {
  var MAX_SECONDS = 60;
  var MIN_MS = 800;
  var MIME_CHOICES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'];
  var PREF_KEY = 'v2s.readAloud';

  function canRecord() {
    return !!(window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }
  function Recognition() { return window.SpeechRecognition || window.webkitSpeechRecognition; }

  function pickMime() {
    if (!window.MediaRecorder || typeof MediaRecorder.isTypeSupported !== 'function') return '';
    for (var i = 0; i < MIME_CHOICES.length; i++) if (MediaRecorder.isTypeSupported(MIME_CHOICES[i])) return MIME_CHOICES[i];
    return '';
  }
  function baseType(type, fallback) {
    var t = (type || '').split(';')[0].trim();
    return t || fallback;
  }
  function fmt(s) { return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }

  var MESSAGES = {
    blocked: 'Microphone is blocked. Allow it in your browser settings, or type instead.',
    nomic: 'No microphone found. Please type instead.',
    unsupported: 'Voice isn\'t supported in this browser. Please type instead.',
    short: 'That was too short. Hold the button a little longer and speak.',
    empty: 'We didn\'t catch any words. Try again a bit closer to the mic.',
    daily_limit: 'You\'ve used today\'s voice clips. Please type for now.',
    too_large: 'That clip was too long. Keep it under a minute.',
    unsupported_type: 'This browser recorded audio we can\'t read. Please type instead.',
    stt_unavailable: 'Couldn\'t turn that into text right now.',
    network: 'Upload failed. Check your connection.',
    login: 'Your session ended. Refresh the page and log in again.'
  };

  function attach(button) {
    var target = document.getElementById(button.getAttribute('data-voice-target'));
    var status = document.getElementById(button.getAttribute('data-voice-status'));
    var csrf = button.getAttribute('data-csrf');
    var compact = button.hasAttribute('data-voice-compact');
    if (!target) return;
    var idleHtml = button.innerHTML;
    var idleLabel = button.getAttribute('aria-label');
    var state = 'idle';
    var recorder = null, stream = null, chunks = [], timer = null, startedAt = 0, lastClip = null;
    var retryBtn = null;

    if (!canRecord() && !Recognition()) {
      button.disabled = true;
      button.title = MESSAGES.unsupported;
      return;
    }

    function say(text, withRetry) {
      if (status) status.textContent = text || '';
      if (retryBtn) { retryBtn.remove(); retryBtn = null; }
      if (withRetry && status && lastClip) {
        retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'voice-retry';
        retryBtn.textContent = 'Retry';
        retryBtn.addEventListener('click', function () { upload(lastClip); });
        status.appendChild(document.createTextNode(' '));
        status.appendChild(retryBtn);
      }
    }
    function setButton(label, busy) {
      if (compact && label !== null) {
        button.setAttribute('aria-label', label);
        if (status && state === 'recording') status.textContent = label.replace('Stop', 'Recording… tap the mic to stop');
      } else if (label === null) {
        button.innerHTML = idleHtml;
        if (idleLabel) button.setAttribute('aria-label', idleLabel);
      } else {
        button.textContent = label;
        button.setAttribute('aria-label', label);
      }
      button.classList.toggle('listening', state === 'recording');
      button.disabled = !!busy;
    }
    function insert(text) {
      var t = (text || '').trim();
      if (!t) { say(MESSAGES.empty); return; }
      target.value = target.value.trim() ? target.value.replace(/\s+$/, '') + ' ' + t : t;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.focus();
      say('Added what you said. Check it, then send.');
    }

    function upload(clip) {
      state = 'uploading';
      setButton('Uploading…', true);
      say('Uploading 0%');
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/voice/transcribe');
      xhr.setRequestHeader('Content-Type', clip.type);
      xhr.setRequestHeader('X-CSRF-Token', csrf);
      xhr.timeout = 90000;
      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable) say('Uploading ' + Math.round((e.loaded / e.total) * 100) + '%');
      };
      xhr.upload.onload = function () { say('Turning your voice into text…'); };
      xhr.onload = function () {
        state = 'idle';
        setButton(null, false);
        var body = {};
        try { body = JSON.parse(xhr.responseText); } catch (e) { /* rate limiter sends text */ }
        if (xhr.status === 200) { lastClip = null; insert(body.text); return; }
        var code = body.error;
        if (xhr.status === 429 && !code) { say('Too many voice clips in a row. Wait a minute.'); return; }
        var retryable = code === 'stt_unavailable' || xhr.status >= 500;
        say(MESSAGES[code] || 'Something went wrong with voice. Please try again or type.', retryable);
      };
      xhr.onerror = xhr.ontimeout = function () {
        state = 'idle';
        setButton(null, false);
        say(MESSAGES.network, true);
      };
      xhr.send(clip);
    }

    function stopTracks() {
      if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
    }

    function startRecording() {
      state = 'starting';
      setButton('Starting mic…', true);
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function (s) {
        stream = s;
        var mime = pickMime();
        try {
          recorder = mime ? new MediaRecorder(s, { mimeType: mime, audioBitsPerSecond: 32000 }) : new MediaRecorder(s);
        } catch (e) {
          recorder = new MediaRecorder(s);
        }
        chunks = [];
        recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
        recorder.onstop = function () {
          clearInterval(timer);
          stopTracks();
          var elapsed = Date.now() - startedAt;
          var type = baseType(recorder.mimeType || mime, /iPhone|iPad|Safari/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent) ? 'audio/mp4' : 'audio/webm');
          var clip = new Blob(chunks, { type: type });
          chunks = [];
          if (elapsed < MIN_MS || clip.size < 1000) {
            state = 'idle';
            setButton(null, false);
            say(MESSAGES.short);
            return;
          }
          lastClip = clip;
          upload(clip);
        };
        recorder.start(1000);
        startedAt = Date.now();
        state = 'recording';
        var left = MAX_SECONDS;
        setButton('Stop (' + fmt(left) + ')', false);
        say('Recording… tap Stop when you\'re done.');
        timer = setInterval(function () {
          left = MAX_SECONDS - Math.floor((Date.now() - startedAt) / 1000);
          if (left <= 0) { stopRecording(); return; }
          setButton('Stop (' + fmt(left) + ')', false);
        }, 250);
      }).catch(function (err) {
        state = 'idle';
        stopTracks();
        setButton(null, false);
        var name = err && err.name;
        if (name === 'NotAllowedError' || name === 'SecurityError') say(MESSAGES.blocked);
        else if (name === 'NotFoundError' || name === 'OverconstrainedError') say(MESSAGES.nomic);
        else if (Recognition()) { browserRecognition(); return; }
        else say(MESSAGES.unsupported);
        target.focus();
      });
    }

    function stopRecording() {
      if (state !== 'recording' || !recorder) return;
      state = 'stopping';
      setButton('Finishing…', true);
      clearInterval(timer);
      try { recorder.stop(); } catch (e) { stopTracks(); state = 'idle'; setButton(null, false); }
    }

    /** Fallback: the browser's own recognizer (audio handled by the browser vendor). */
    function browserRecognition() {
      var R = Recognition();
      if (!R) { say(MESSAGES.unsupported); return; }
      var rec = new R();
      rec.lang = document.documentElement.lang === 'en' ? 'en-NG' : (document.documentElement.lang || 'en-US');
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      state = 'recording';
      setButton('Listening…', true);
      say('Listening… speak now.');
      rec.onresult = function (e) { insert(e.results[0][0].transcript); };
      rec.onerror = function (e) {
        say(e.error === 'not-allowed' || e.error === 'service-not-allowed' ? MESSAGES.blocked : 'Couldn\'t hear that. Try again or type.');
      };
      rec.onend = function () { state = 'idle'; setButton(null, false); };
      try { rec.start(); } catch (e) { state = 'idle'; setButton(null, false); }
    }

    button.addEventListener('click', function () {
      if (state === 'recording') return stopRecording();
      if (state !== 'idle') return;
      if (canRecord()) startRecording();
      else browserRecognition();
    });
  }

  // ---- read aloud ----
  var speaking = null; // the Listen button currently playing

  function canSpeak() { return 'speechSynthesis' in window && typeof SpeechSynthesisUtterance === 'function'; }

  function stopSpeaking() {
    if (!canSpeak()) return;
    window.speechSynthesis.cancel();
    if (speaking) { speaking.textContent = 'Listen'; speaking.setAttribute('aria-pressed', 'false'); }
    speaking = null;
  }

  function speak(text, btn) {
    if (!canSpeak() || !text) return;
    stopSpeaking();
    var u = new SpeechSynthesisUtterance(text.slice(0, 4000));
    u.lang = 'en';
    u.rate = 1;
    u.onend = u.onerror = function () { if (speaking === btn) stopSpeaking(); };
    if (btn) { speaking = btn; btn.textContent = 'Stop'; btn.setAttribute('aria-pressed', 'true'); }
    window.speechSynthesis.speak(u);
  }

  function addListenButton(container, getText) {
    if (!canSpeak() || !container || container.querySelector('.tts-btn')) return null;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tts-btn';
    btn.textContent = 'Listen';
    btn.setAttribute('aria-pressed', 'false');
    btn.addEventListener('click', function () {
      if (speaking === btn) stopSpeaking(); else speak(getText(), btn);
    });
    container.appendChild(btn);
    return btn;
  }

  function autoRead() {
    try { return window.localStorage.getItem(PREF_KEY) === '1'; } catch (e) { return false; }
  }
  function setAutoRead(on) {
    try { window.localStorage.setItem(PREF_KEY, on ? '1' : '0'); } catch (e) { /* private mode */ }
    if (!on) stopSpeaking();
  }

  function init() {
    var buttons = document.querySelectorAll('[data-voice-target]');
    for (var i = 0; i < buttons.length; i++) attach(buttons[i]);
    // Static read-aloud targets: <div data-tts>…</div> gets a Listen button reading its text.
    var blocks = document.querySelectorAll('[data-tts]');
    for (var j = 0; j < blocks.length; j++) {
      (function (el) {
        addListenButton(el, function () {
          var clone = el.cloneNode(true);
          var b = clone.querySelector('.tts-btn'); if (b) b.remove();
          return clone.textContent.replace(/\s+/g, ' ').trim();
        });
      })(blocks[j]);
    }
    var toggle = document.getElementById('readAloud');
    if (toggle) {
      if (!canSpeak()) (toggle.closest('label') || toggle).hidden = true;
      toggle.checked = autoRead();
      toggle.addEventListener('change', function () { setAutoRead(toggle.checked); });
    }
  }

  window.V2SVoice = { addListenButton: addListenButton, speak: speak, stopSpeaking: stopSpeaking, autoRead: autoRead, canSpeak: canSpeak };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
