// Forms marked data-once send once: a second tap on a slow phone would post them again (the server
// copes, but a roadmap built by AI would be paid for twice).
document.addEventListener('submit', function (e) {
  var form = e.target;
  if (!form.hasAttribute('data-once')) return;
  if (form.dataset.sent) { e.preventDefault(); return; }
  form.dataset.sent = '1';
  var btn = form.querySelector('button[type="submit"]');
  if (btn) btn.disabled = true;
});
// Back button: the browser may restore the page as it was left, so make the forms usable again.
window.addEventListener('pageshow', function () {
  document.querySelectorAll('form[data-once]').forEach(function (form) {
    delete form.dataset.sent;
    var btn = form.querySelector('button[type="submit"]');
    if (btn) btn.disabled = false;
  });
});
