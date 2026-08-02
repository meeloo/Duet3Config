// Entry point.

import './panels/index.js';
import './ui/topbar.js';
import './ui/messagebox.js';
import './ui/layout.js';

import { actions, connect, controllerUrl, driverId, loadSetting, machine } from './core/store.js';
import { initTheme } from './core/theme.js';

// Before first paint, so there is no flash of the wrong theme.
initTheme();

const root = document.getElementById('app');
if (!root) throw new Error('#app not found');

root.innerHTML = `
  <cnc-topbar></cnc-topbar>
  <cnc-dashboard></cnc-dashboard>
  <cnc-messagebox></cnc-messagebox>
`;

// Reconnect on load if enabled. Served from the controller itself, this makes
// the page usable with no interaction at all.
if (loadSetting('autoConnect', true)) {
  void connect(controllerUrl.peek(), driverId.peek()).catch(() => {
    // Already surfaced in the top bar.
  });
}

// Global E-stop: Escape twice within 500 ms. Deliberately not a single press —
// Escape also dismisses dialogs, and an accidental halt mid-cut is its own kind
// of damage.
let lastEscape = 0;
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const now = performance.now();
  if (now - lastEscape < 500) {
    lastEscape = 0;
    void actions.estop();
  } else {
    lastEscape = now;
  }
});

// Warn before navigating away mid-job.
window.addEventListener('beforeunload', (e) => {
  const status = machine.peek().status;
  if (status === 'running' || status === 'tool-change' || status === 'paused') {
    e.preventDefault();
    e.returnValue = '';
  }
});
