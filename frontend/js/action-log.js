/**
 * action-log.js — Action History Panel
 *
 * Fetches /api/log and renders a slide-in panel showing recent
 * file operations with per-record revert support.
 */

// ── State ─────────────────────────────────────────────────────────────────────

let panelVisible = false;
let currentFilter = '';       // absolute path filter, '' = global
let autoRefreshTimer = null;

// ── Icons & labels ────────────────────────────────────────────────────────────

const ACTION_META = {
  'copy':        { icon: '📋', label: 'Copied to clipboard',  cls: 'log-action-copy'  },
  'paste-copy':  { icon: '📄', label: 'Pasted (copy)',        cls: 'log-action-paste' },
  'paste-move':  { icon: '✂️',  label: 'Moved',               cls: 'log-action-move'  },
  'delete':      { icon: '🗑️', label: 'Deleted',              cls: 'log-action-delete'},
  'rename':      { icon: '✏️',  label: 'Renamed',             cls: 'log-action-rename'},
  'mkdir':       { icon: '📁', label: 'Folder created',       cls: 'log-action-mkdir' },
};

// ── DOM references (resolved lazily after panel is injected) ──────────────────

function getPanel()  { return document.getElementById('action-log-panel'); }
function getList()   { return document.getElementById('action-log-list');  }
function getStatus() { return document.getElementById('action-log-status');}

// ── Relative time ─────────────────────────────────────────────────────────────

function relativeTime(isoString) {
  const diff = Date.now() - new Date(isoString).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 5)  return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

async function fetchLog(pathFilter = '') {
  const params = new URLSearchParams({ limit: '100' });
  if (pathFilter) params.set('path', pathFilter);
  const res = await fetch(`/api/log?${params}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function revertRecord(id) {
  const res = await fetch('/api/log/revert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderRecords(records) {
  const list = getList();
  if (!list) return;

  if (!records.length) {
    list.innerHTML = `
      <div class="log-empty">
        <span class="log-empty-icon">📭</span>
        <p>No actions recorded yet.<br>Start managing files to see history here.</p>
      </div>`;
    return;
  }

  list.innerHTML = records.map(rec => {
    const meta   = ACTION_META[rec.action_str] || { icon: '❓', label: rec.action_str, cls: '' };
    const isPerm = rec.action_str === 'delete' || rec.action_str === 'copy';
    const isDone = rec.status === 0;
    const canRevert = rec.reversible && isDone;

    const primaryPath = rec.sources?.[0] ?? rec.dest ?? '—';
    const shortName   = primaryPath.split('/').pop() || primaryPath;

    let detail = '';
    if (rec.action_str === 'rename' && rec.name) {
      detail = `<span class="log-detail">→ <em>${escHtml(rec.name)}</em></span>`;
    } else if ((rec.action_str === 'paste-copy' || rec.action_str === 'paste-move') && rec.dest) {
      detail = `<span class="log-detail">→ <em>${escHtml(rec.dest)}</em></span>`;
    } else if (rec.action_str === 'mkdir' && rec.name) {
      detail = `<span class="log-detail"><em>${escHtml(rec.name)}</em> in ${escHtml(rec.dest)}</span>`;
    }

    const statusBadge = rec.status === 1
      ? `<span class="log-badge log-badge-reverted">reverted</span>`
      : '';

    const revertBtn = canRevert
      ? `<button class="log-revert-btn" data-id="${rec.id}" title="Revert this action">↩ Undo</button>`
      : isPerm && isDone
        ? `<span class="log-permanent" title="This action cannot be undone">permanent</span>`
        : '';

    return `
      <div class="log-record ${meta.cls}${rec.status === 1 ? ' log-record-reverted' : ''}" data-id="${rec.id}">
        <span class="log-icon">${meta.icon}</span>
        <div class="log-body">
          <div class="log-title">
            <span class="log-action-label">${meta.label}</span>
            ${statusBadge}
          </div>
          <div class="log-path" title="${escHtml(primaryPath)}">${escHtml(shortName)}</div>
          ${detail}
          <div class="log-time">${relativeTime(rec.timestamp)}</div>
        </div>
        <div class="log-actions">${revertBtn}</div>
      </div>`;
  }).join('');

  // Wire revert buttons
  list.querySelectorAll('.log-revert-btn').forEach(btn => {
    btn.addEventListener('click', () => handleRevert(Number(btn.dataset.id)));
  });
}

// ── Event handlers ────────────────────────────────────────────────────────────

async function handleRevert(id) {
  const btn = getList()?.querySelector(`.log-revert-btn[data-id="${id}"]`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳';
  }

  try {
    await revertRecord(id);
    showStatus('✅ Action reverted successfully', 'success');
    await refreshLog();

    // Notify the file list to refresh its current directory
    window.dispatchEvent(new CustomEvent('zen-action-reverted', { detail: { id } }));
  } catch (err) {
    showStatus(`❌ ${err.message}`, 'error');
    if (btn) {
      btn.disabled = false;
      btn.textContent = '↩ Undo';
    }
  }
}

async function refreshLog() {
  try {
    const data = await fetchLog(currentFilter);
    renderRecords(data.records ?? []);
  } catch (err) {
    showStatus(`Failed to load history: ${err.message}`, 'error');
  }
}

function showStatus(msg, type = '') {
  const el = getStatus();
  if (!el) return;
  el.textContent = msg;
  el.className = `action-log-status ${type ? `status-${type}` : ''}`;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => {
    el.textContent = '';
    el.className = 'action-log-status';
  }, 3500);
}

// ── Panel open / close ────────────────────────────────────────────────────────

export function openActionLog(pathFilter = '') {
  currentFilter = pathFilter;
  const panel    = getPanel();
  const backdrop = document.getElementById('action-log-backdrop');
  if (!panel) return;

  panelVisible = true;
  panel.classList.add('action-log-open');
  if (backdrop) backdrop.classList.add('active');

  // Update panel title to reflect filter
  const title = panel.querySelector('.action-log-title');
  if (title) {
    if (pathFilter) {
      const name = pathFilter.split('/').pop() || pathFilter;
      title.textContent = `History — ${name}`;
    } else {
      title.textContent = 'Action History';
    }
  }

  refreshLog();

  // Auto-refresh every 5 s while open
  clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(refreshLog, 5000);
}

export function closeActionLog() {
  panelVisible = false;
  const panel = getPanel();
  const backdrop = document.getElementById('action-log-backdrop');
  if (panel) panel.classList.remove('action-log-open');
  if (backdrop) backdrop.classList.remove('active');
  clearInterval(autoRefreshTimer);
}

export function toggleActionLog(pathFilter = '') {
  if (panelVisible && pathFilter === currentFilter) {
    closeActionLog();
  } else {
    openActionLog(pathFilter);
  }
}

// ── Initialise ────────────────────────────────────────────────────────────────

export function initActionLog() {
  // Close panel on Escape
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && panelVisible) closeActionLog();
  });

  // Close button
  const closeBtn = document.getElementById('action-log-close');
  if (closeBtn) closeBtn.addEventListener('click', closeActionLog);

  // Global toggle button in header
  const toggleBtn = document.getElementById('action-log-toggle');
  if (toggleBtn) toggleBtn.addEventListener('click', () => toggleActionLog());

  // Respond to file list refreshes triggerd by external reverts
  window.addEventListener('zen-action-reverted', () => {
    // File list modules listen for this to force re-fetch
  });
}

// ── Utility ───────────────────────────────────────────────────────────────────

function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
