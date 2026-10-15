// Landing page behaviour (was inline; moved for the CSP).
(function () {
  // Year
  document.getElementById('year').textContent = new Date().getFullYear();

  // Nav background on scroll
  var nav = document.getElementById('topnav');
  var onScroll = function () {
    nav.classList.toggle('scrolled', window.scrollY > 12);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // Reveal on scroll
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add('in-view');
        io.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
  document.querySelectorAll('.reveal').forEach(function (el) { io.observe(el); });

  // Decorative typed coach messages (mock card) — skipped for reduced-motion users
  var coach = document.getElementById('coach-type');
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduceMotion) {
    var lines = [
      'Nice work — 25 days in and you’re still showing up. 🎉',
      'auto-fill keeps empty tracks; auto-fit collapses them so items stretch.',
      'Next step: rebuild today’s gallery with auto-fit and resize the window.',
      'Your 12-day streak is your longest yet. Keep it alive!'
    ];
    var lineIdx = 0, charIdx = 0, deleting = false;
    var TYPE_MS = 26, PAUSE_MS = 2400;

    function tick() {
      var text = lines[lineIdx];
      if (!deleting) {
        charIdx++;
        coach.textContent = text.slice(0, charIdx);
        if (charIdx === text.length) {
          deleting = true;
          setTimeout(tick, PAUSE_MS);
          return;
        }
        setTimeout(tick, TYPE_MS + (text[charIdx - 1] === ' ' ? 60 : 0));
      } else {
        charIdx--;
        coach.textContent = text.slice(0, charIdx);
        if (charIdx === 0) {
          deleting = false;
          lineIdx = (lineIdx + 1) % lines.length;
          setTimeout(tick, 500);
          return;
        }
        setTimeout(tick, 12);
      }
    }
    setTimeout(tick, 900);
  }
})();
