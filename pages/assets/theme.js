// Applies a saved light or dark choice before the page draws, so it doesn't flash. Loaded in the head, not deferred.
(function () {
  'use strict';
  try {
    const theme = localStorage.getItem('atlas-docs-theme');
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  } catch {
    // Storage can be off in private windows; the system setting applies.
  }
})();
