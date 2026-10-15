// App nav: add a background once the page scrolls (was inline; moved for the CSP).
(function () {
  var nav = document.getElementById('appnav');
  var onScroll = function () { nav.classList.toggle('scrolled', window.scrollY > 12); };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
})();
