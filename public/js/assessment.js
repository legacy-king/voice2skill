// Assessment: copy the visible goal box into the hidden form field (was inline; moved for the CSP).
(function () {
  // Sync goal input to hidden field
  var goalInput = document.getElementById('goal-input');
  var goalVisible = document.getElementById('goal-input-visible');
  if (goalInput && goalVisible) {
    goalVisible.addEventListener('input', function() {
      goalInput.value = goalVisible.value;
    });
  }
})();

// Assessment result: building a roadmap can take a while, so stop double-submits and say so.
(function () {
  var form = document.querySelector('form[action$="/select"]');
  if (!form) return;
  form.addEventListener('submit', function () {
    var btn = form.querySelector('button[type="submit"]');
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = 'Building your roadmap… this can take up to a minute';
  });
})();
