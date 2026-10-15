// Teacher pages: clicking the invite link selects it for copying (was an inline onclick; CSP).
(function () {
  document.querySelectorAll('[data-select-on-click]').forEach(function (el) {
    el.addEventListener('click', function () { el.select(); });
  });
})();
