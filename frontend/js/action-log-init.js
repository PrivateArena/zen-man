/**
 * action-log-init.js — Bootstrap for the action history panel.
 * Loaded as a separate module script so it doesn't block app.js.
 */
import { initActionLog, toggleActionLog } from './action-log.js';

// Initialise toggle/close wiring after DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  initActionLog();

  // 'H' keyboard shortcut opens/closes the history panel globally
  document.addEventListener('keydown', e => {
    // Ignore when typing inside an input / textarea
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
    if (e.key === 'h' || e.key === 'H') {
      e.preventDefault();
      toggleActionLog();
    }
  });

  // Backdrop click closes the panel
  const backdrop = document.getElementById('action-log-backdrop');
  if (backdrop) {
    backdrop.addEventListener('click', () => {
      import('./action-log.js').then(m => m.closeActionLog());
    });
  }

  // When a revert fires, reload the current pane's file list
  window.addEventListener('zen-action-reverted', () => {
    // Trigger a re-fetch on every pane's active tab
    window.dispatchEvent(new CustomEvent('zen-refresh-filelist'));
  });
});
