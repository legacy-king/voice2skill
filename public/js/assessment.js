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
