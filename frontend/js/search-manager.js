import { state, getActiveTab, getPaneDom } from './state.js';
import { formatSize, formatDate } from './utils.js';
import { openFile } from './api.js';
import { updateItemSelectionStyles, updateSelectionUI } from './file-list.js';

const ROW_HEIGHT = 32;
const PAGE_LIMIT = 200;

let navigateToCallback = null;
let statusPollInterval = null;
let activeSearchController = null;
let debounceTimeout = null;

// Search State
let searchResults = [];
let totalResultsCount = 0;
let currentPage = 1;
let selectedIndex = -1;
let currentConfig = {
    roots: [],
    excludes: [],
    worker_count: 2,
    follow_symlinks: false,
    auto_index: false
};

// Initializer
export function initSearchManager(navigateTo) {
    navigateToCallback = navigateTo;
}

export function toggleSearchManager() {
    const overlay = document.getElementById('search-manager-overlay');
    if (overlay && overlay.style.display === 'flex') {
        closeSearchManager();
    } else {
        openSearchManager();
    }
}

// Show/Hide Modal
export function openSearchManager() {
    const overlay = document.getElementById('search-manager-overlay');
    const input = document.getElementById('sm-input');
    
    // Clear previous search and load configuration
    input.value = '';
    searchResults = [];
    totalResultsCount = 0;
    currentPage = 1;
    selectedIndex = -1;
    
    updateFilterChips('');
    renderVirtualRows();
    updateStatusBar();
    
    overlay.style.display = 'flex';
    input.focus();
    
    // Setup listeners
    setupModalListeners();
    
    // Refresh indexer status and load settings config
    fetchIndexerStatus();
    startStatusPolling();
}

export function closeSearchManager() {
    const overlay = document.getElementById('search-manager-overlay');
    overlay.style.display = 'none';
    
    // Stop abort/debounce
    if (activeSearchController) {
        activeSearchController.abort();
        activeSearchController = null;
    }
    if (debounceTimeout) {
        clearTimeout(debounceTimeout);
        debounceTimeout = null;
    }
    
    stopStatusPolling();
    removeModalListeners();
    
    // Return focus to file list
    const activePaneId = state.activePane;
    const fileListEl = getPaneDom(activePaneId).querySelector('.file-list');
    if (fileListEl) fileListEl.focus();
}

// Global Hotkey registration
function setupGlobalShortcuts() {
    window.addEventListener('keydown', (e) => {
        // Ctrl+Shift+F triggers Search Manager
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
            e.preventDefault();
            const overlay = document.getElementById('search-manager-overlay');
            if (overlay.style.display === 'flex') {
                closeSearchManager();
            } else {
                openSearchManager();
            }
        }
    });
}

// Modal event listeners
function setupModalListeners() {
    const overlay = document.getElementById('search-manager-overlay');
    const input = document.getElementById('sm-input');
    const btnSettings = document.getElementById('sm-btn-settings');
    
    const viewport = document.getElementById('sm-results-viewport');
    
    const btnRebuild = document.getElementById('sm-btn-rebuild');
    const btnCancelRebuild = document.getElementById('sm-btn-cancel-rebuild');
    const chkAuto = document.getElementById('sm-chk-auto');
    const chkSymlinks = document.getElementById('sm-chk-symlinks');
    const btnAddRoot = document.getElementById('sm-add-root');
    const btnAddExclude = document.getElementById('sm-add-exclude');
    
    const btnPrev = document.getElementById('sm-page-prev');
    const btnNext = document.getElementById('sm-page-next');

    // Click backdrop to close
    overlay.addEventListener('click', onOverlayClick);
    
    // Search input
    input.addEventListener('input', onInputChanged);
    input.addEventListener('keydown', onInputKeyDown);
    
    // Scroll viewport
    viewport.addEventListener('scroll', onViewportScroll);
    viewport.addEventListener('keydown', onViewportKeyDown);
    
    // Settings panel
    btnSettings.addEventListener('click', toggleSettingsPanel);
    btnRebuild.addEventListener('click', triggerIndexRebuild);
    btnCancelRebuild.addEventListener('click', cancelIndexRebuild);
    
    chkAuto.addEventListener('change', saveConfigFromUI);
    chkSymlinks.addEventListener('change', saveConfigFromUI);
    btnAddRoot.addEventListener('click', addNewRootPrompt);
    btnAddExclude.addEventListener('click', addNewExcludePrompt);
    
    // Pagination
    btnPrev.addEventListener('click', prevPage);
    btnNext.addEventListener('click', nextPage);
}

function removeModalListeners() {
    const overlay = document.getElementById('search-manager-overlay');
    const input = document.getElementById('sm-input');
    const btnSettings = document.getElementById('sm-btn-settings');
    const viewport = document.getElementById('sm-results-viewport');
    const btnRebuild = document.getElementById('sm-btn-rebuild');
    const btnCancelRebuild = document.getElementById('sm-btn-cancel-rebuild');
    const chkAuto = document.getElementById('sm-chk-auto');
    const chkSymlinks = document.getElementById('sm-chk-symlinks');
    const btnAddRoot = document.getElementById('sm-add-root');
    const btnAddExclude = document.getElementById('sm-add-exclude');
    const btnPrev = document.getElementById('sm-page-prev');
    const btnNext = document.getElementById('sm-page-next');

    overlay.removeEventListener('click', onOverlayClick);
    input.removeEventListener('input', onInputChanged);
    input.removeEventListener('keydown', onInputKeyDown);
    viewport.removeEventListener('scroll', onViewportScroll);
    viewport.removeEventListener('keydown', onViewportKeyDown);
    btnSettings.removeEventListener('click', toggleSettingsPanel);
    btnRebuild.removeEventListener('click', triggerIndexRebuild);
    btnCancelRebuild.removeEventListener('click', cancelIndexRebuild);
    chkAuto.removeEventListener('change', saveConfigFromUI);
    chkSymlinks.removeEventListener('change', saveConfigFromUI);
    btnAddRoot.removeEventListener('click', addNewRootPrompt);
    btnAddExclude.removeEventListener('click', addNewExcludePrompt);
    btnPrev.removeEventListener('click', prevPage);
    btnNext.removeEventListener('click', nextPage);
}

function onOverlayClick(e) {
    if (e.target.id === 'search-manager-overlay') {
        closeSearchManager();
    }
}

// Input and query parsing
function onInputChanged() {
    const val = document.getElementById('sm-input').value;
    updateFilterChips(val);
    
    if (debounceTimeout) clearTimeout(debounceTimeout);
    debounceTimeout = setTimeout(() => {
        currentPage = 1;
        triggerSearch();
    }, 300);
}

function updateFilterChips(queryText) {
    const pillsContainer = document.getElementById('sm-filter-pills');
    pillsContainer.innerHTML = '<span class="sm-pill-label">Filters:</span>';
    
    const extRegex = /\bext:([^\s"]+|"[^"]+")/g;
    const inRegex = /\bin:([^\s"]+|"[^"]+")/g;
    const typeRegex = /\btype:(file|dir|any)\b/g;
    
    let match;
    let found = false;
    
    while ((match = extRegex.exec(queryText)) !== null) {
        const val = match[1].replace(/"/g, '');
        createPill(pillsContainer, `ext: ${val}`, match[0]);
        found = true;
    }
    while ((match = inRegex.exec(queryText)) !== null) {
        const val = match[1].replace(/"/g, '');
        createPill(pillsContainer, `in: ${val}`, match[0]);
        found = true;
    }
    while ((match = typeRegex.exec(queryText)) !== null) {
        createPill(pillsContainer, `type: ${match[1]}`, match[0]);
        found = true;
    }
    
    pillsContainer.style.display = found ? 'flex' : 'none';
}

function createPill(container, text, rawText) {
    const pill = document.createElement('span');
    pill.className = 'sm-pill';
    pill.textContent = text;
    
    const removeBtn = document.createElement('span');
    removeBtn.className = 'remove-pill';
    removeBtn.textContent = ' ✕';
    removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const input = document.getElementById('sm-input');
        input.value = input.value.replace(rawText, '').replace(/\s+/g, ' ').trim();
        input.focus();
        onInputChanged();
    });
    
    pill.appendChild(removeBtn);
    container.appendChild(pill);
}

// API Searches
async function triggerSearch() {
    const input = document.getElementById('sm-input');
    const query = input.value.trim();
    
    if (activeSearchController) {
        activeSearchController.abort();
    }
    
    if (query === '') {
        searchResults = [];
        totalResultsCount = 0;
        selectedIndex = -1;
        renderVirtualRows();
        updateStatusBar();
        return;
    }
    
    activeSearchController = new AbortController();
    const offset = (currentPage - 1) * PAGE_LIMIT;
    
    try {
        const url = `/api/index/search?q=${encodeURIComponent(query)}&limit=${PAGE_LIMIT}&offset=${offset}`;
        const response = await fetch(url, { signal: activeSearchController.signal });
        
        if (!response.ok) {
            throw new Error(`Search failed: ${response.statusText}`);
        }
        
        const data = await response.json();
        searchResults = (data.entries || []).map(entry => {
            entry.path = entry.rel_path;
            return entry;
        });
        totalResultsCount = data.total_matched || 0;
        
        if (searchResults.length > 0 && selectedIndex === -1) {
            selectedIndex = 0;
        } else if (searchResults.length === 0) {
            selectedIndex = -1;
        }
        
        renderVirtualRows();
        updateStatusBar();
    } catch (err) {
        if (err.name !== 'AbortError') {
            console.error('Search error:', err);
            searchResults = [];
            totalResultsCount = 0;
            selectedIndex = -1;
            renderVirtualRows();
            updateStatusBar();
        }
    }
}

// Virtual Scroller
function renderVirtualRows() {
    const viewport = document.getElementById('sm-results-viewport');
    const inner = document.getElementById('sm-results-inner');
    
    const count = searchResults.length;
    const totalHeight = count * ROW_HEIGHT;
    inner.style.height = `${totalHeight}px`;
    
    if (count === 0) {
        inner.innerHTML = '<div style="padding:20px; text-align:center; color:var(--text-muted);">No items matched your query</div>';
        return;
    }
    
    const scrollTop = viewport.scrollTop;
    const viewportHeight = viewport.clientHeight || 450;
    
    let startIndex = Math.floor(scrollTop / ROW_HEIGHT);
    let endIndex = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT);
    
    // Add buffers
    startIndex = Math.max(0, startIndex - 5);
    endIndex = Math.min(count - 1, endIndex + 5);
    
    let html = '';
    for (let i = startIndex; i <= endIndex; i++) {
        const item = searchResults[i];
        if (!item) continue;
        
        const isSelected = i === selectedIndex ? 'selected' : '';
        const icon = item.is_dir ? '📁' : '📄';
        const sizeStr = item.is_dir ? '' : formatSize(item.size);
        const dateStr = formatDate(item.mtime);
        
        html += `
            <div class="sm-row ${isSelected}" style="position:absolute; top:${i * ROW_HEIGHT}px; left:0; right:0; height:${ROW_HEIGHT}px;" data-index="${i}">
                <div class="sm-col-name"><span class="sm-icon">${icon}</span><span>${item.name}</span></div>
                <div class="sm-col-path" title="${item.path}">${item.path}</div>
                <div class="sm-col-size">${sizeStr}</div>
                <div class="sm-col-date">${dateStr}</div>
            </div>
        `;
    }
    
    inner.innerHTML = html;
    
    // Bind click & double click events
    inner.querySelectorAll('.sm-row').forEach(row => {
        const idx = parseInt(row.getAttribute('data-index'), 10);
        
        row.addEventListener('click', () => {
            selectedIndex = idx;
            highlightSelectedRow();
        });
        
        row.addEventListener('dblclick', (e) => {
            e.preventDefault();
            executeItemAction(idx, 'open');
        });
        
        row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            selectedIndex = idx;
            highlightSelectedRow();
            const item = searchResults[idx];
            if (item) {
                import('./context-menu.js').then(m => {
                    m.showSearchResultContextMenu(e, item.path, item.is_dir);
                });
            }
        });
    });
}

function highlightSelectedRow() {
    const inner = document.getElementById('sm-results-inner');
    inner.querySelectorAll('.sm-row').forEach(row => {
        const idx = parseInt(row.getAttribute('data-index'), 10);
        if (idx === selectedIndex) {
            row.classList.add('selected');
        } else {
            row.classList.remove('selected');
        }
    });
    scrollToSelected();
}

function scrollToSelected() {
    const viewport = document.getElementById('sm-results-viewport');
    if (selectedIndex === -1) return;
    
    const itemTop = selectedIndex * ROW_HEIGHT;
    const itemBottom = itemTop + ROW_HEIGHT;
    const viewTop = viewport.scrollTop;
    const viewBottom = viewTop + viewport.clientHeight;
    
    if (itemTop < viewTop) {
        viewport.scrollTop = itemTop;
    } else if (itemBottom > viewBottom) {
        viewport.scrollTop = itemBottom - viewport.clientHeight;
    }
}

function onViewportScroll() {
    renderVirtualRows();
}

// Actions execution
async function executeItemAction(index, mode) {
    const item = searchResults[index];
    if (!item) return;
    
    closeSearchManager();
    
    if (mode === 'open') {
        if (item.is_dir) {
            if (navigateToCallback) {
                navigateToCallback(item.path, true, state.activePane);
            }
        } else {
            openFile(item.path);
        }
    } 
    else if (mode === 'reveal') {
        const parentDir = item.path.substring(0, item.path.lastIndexOf('/')) || '/';
        if (navigateToCallback) {
            await navigateToCallback(parentDir, true, state.activePane);
            
            // Highlight item
            const activeTab = getActiveTab();
            if (activeTab) {
                activeTab.selectedPaths.clear();
                activeTab.selectedPaths.add(item.path);
                updateItemSelectionStyles(state.activePane);
                updateSelectionUI();
                
                // Scroll into view
                setTimeout(() => {
                    const paneDom = getPaneDom(state.activePane);
                    const fileItem = paneDom.querySelector(`[data-path="${CSS.escape(item.path)}"]`);
                    if (fileItem) {
                        fileItem.scrollIntoView({ block: 'nearest' });
                    }
                }, 150);
            }
        }
    }
}

// Input keyboard controls
function onInputKeyDown(e) {
    if (e.key === 'Escape') {
        e.preventDefault();
        closeSearchManager();
    }
    else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (searchResults.length === 0) return;
        selectedIndex = (selectedIndex + 1) % searchResults.length;
        highlightSelectedRow();
    }
    else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (searchResults.length === 0) return;
        selectedIndex = (selectedIndex - 1 + searchResults.length) % searchResults.length;
        highlightSelectedRow();
    }
    else if (e.key === 'Enter') {
        e.preventDefault();
        if (selectedIndex !== -1 && searchResults[selectedIndex]) {
            executeItemAction(selectedIndex, 'open');
        }
    }
}

// Viewport keyboard controls when focused
function onViewportKeyDown(e) {
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (searchResults.length === 0) return;
        selectedIndex = Math.min(searchResults.length - 1, selectedIndex + 1);
        highlightSelectedRow();
    }
    else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (searchResults.length === 0) return;
        selectedIndex = Math.max(0, selectedIndex - 1);
        highlightSelectedRow();
    }
    else if (e.key === 'Enter') {
        e.preventDefault();
        if (selectedIndex !== -1 && searchResults[selectedIndex]) {
            executeItemAction(selectedIndex, 'open');
        }
    }
}

// Pagination logic
function updateStatusBar() {
    const totalPages = Math.max(1, Math.ceil(totalResultsCount / PAGE_LIMIT));
    document.getElementById('sm-stats-left').textContent = `${totalResultsCount.toLocaleString()} result${totalResultsCount === 1 ? '' : 's'} matched`;
    document.getElementById('sm-page-info').textContent = `Page ${currentPage} of ${totalPages}`;
    
    document.getElementById('sm-page-prev').disabled = currentPage <= 1;
    document.getElementById('sm-page-next').disabled = currentPage >= totalPages;
}

function prevPage() {
    if (currentPage > 1) {
        currentPage--;
        selectedIndex = 0;
        triggerSearch();
        document.getElementById('sm-results-viewport').scrollTop = 0;
    }
}

function nextPage() {
    const totalPages = Math.ceil(totalResultsCount / PAGE_LIMIT);
    if (currentPage < totalPages) {
        currentPage++;
        selectedIndex = 0;
        triggerSearch();
        document.getElementById('sm-results-viewport').scrollTop = 0;
    }
}

// Settings Panel Collapse/Expand
function toggleSettingsPanel() {
    const panel = document.getElementById('sm-settings-panel');
    const isHidden = panel.style.display === 'none';
    panel.style.display = isHidden ? 'grid' : 'none';
}

// Fetch Index Status & Configuration
async function fetchIndexerStatus() {
    try {
        const response = await fetch('/api/index/status');
        if (!response.ok) throw new Error('Failed status load');
        
        const data = await response.json();
        
        // Update Indicator Dots
        const ind = document.getElementById('sm-status-indicator');
        const txt = document.getElementById('sm-status-text');
        
        ind.className = 'sm-status-indicator';
        
        const btnRebuild = document.getElementById('sm-btn-rebuild');
        const btnCancel = document.getElementById('sm-btn-cancel-rebuild');
        
        if (data.is_indexing) {
            ind.classList.add('indexing');
            const indexedCount = (data.progress && data.progress.indexed) ? data.progress.indexed : 0;
            txt.textContent = `Indexing... (${indexedCount.toLocaleString()} files)`;
            btnRebuild.disabled = true;
            btnCancel.style.display = 'inline-block';
        } else {
            ind.classList.add('ready');
            txt.textContent = 'Ready';
            btnRebuild.disabled = false;
            btnCancel.style.display = 'none';
        }
        
        // Update Settings forms once
        const cfg = data.config || {};
        currentConfig.roots = cfg.roots || [];
        currentConfig.excludes = cfg.excludes || [];
        currentConfig.worker_count = cfg.worker_count || 2;
        currentConfig.follow_symlinks = !!cfg.follow_symlinks;
        currentConfig.auto_index = !!cfg.auto_index;
        
        renderSettingsLists();
    } catch (err) {
        console.error('Failed fetching status:', err);
    }
}

function renderSettingsLists() {
    // Checkboxes
    document.getElementById('sm-chk-auto').checked = currentConfig.auto_index;
    document.getElementById('sm-chk-symlinks').checked = currentConfig.follow_symlinks;
    
    // Roots
    const rootsContainer = document.getElementById('sm-roots-list');
    rootsContainer.innerHTML = currentConfig.roots.map((r, i) => `
        <div class="sm-list-item">
            <span title="${r}">${r}</span>
            <button class="btn-remove-item" data-type="root" data-index="${i}">✕</button>
        </div>
    `).join('') || '<div style="color:var(--text-muted); font-size:0.8rem; text-align:center; padding:10px;">No index roots defined</div>';
    
    // Excludes
    const excludesContainer = document.getElementById('sm-excludes-list');
    excludesContainer.innerHTML = currentConfig.excludes.map((e, i) => `
        <div class="sm-list-item">
            <span title="${e}">${e}</span>
            <button class="btn-remove-item" data-type="exclude" data-index="${i}">✕</button>
        </div>
    `).join('') || '<div style="color:var(--text-muted); font-size:0.8rem; text-align:center; padding:10px;">No exclusions defined</div>';

    // Bind remove buttons
    const panel = document.getElementById('sm-settings-panel');
    const removeBtns = panel.querySelectorAll('.btn-remove-item[data-index]');
    removeBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            const type = e.target.getAttribute('data-type');
            const idx = parseInt(e.target.getAttribute('data-index'), 10);
            removeConfigItem(type, idx);
        });
    });
}

// Configuration mutations
async function saveConfigFromUI() {
    currentConfig.auto_index = document.getElementById('sm-chk-auto').checked;
    currentConfig.follow_symlinks = document.getElementById('sm-chk-symlinks').checked;
    
    await uploadConfig();
}

async function uploadConfig() {
    try {
        const response = await fetch('/api/index/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(currentConfig)
        });
        if (!response.ok) throw new Error('Config save failed');
        
        // Refresh UI
        fetchIndexerStatus();
    } catch (err) {
        alert(`Failed to save configuration: ${err.message}`);
    }
}

function removeConfigItem(type, idx) {
    if (type === 'root') {
        currentConfig.roots.splice(idx, 1);
    } else {
        currentConfig.excludes.splice(idx, 1);
    }
    uploadConfig();
}

function addNewRootPrompt() {
    const root = prompt("Enter directory path to index:");
    if (root && root.trim() !== '') {
        currentConfig.roots.push(root.trim());
        uploadConfig();
    }
}

function addNewExcludePrompt() {
    const exclude = prompt("Enter glob pattern to exclude (e.g. **/node_modules, *.tmp):");
    if (exclude && exclude.trim() !== '') {
        currentConfig.excludes.push(exclude.trim());
        uploadConfig();
    }
}

// Triggering / Cancelling rebuild tasks
async function triggerIndexRebuild() {
    try {
        const response = await fetch('/api/index/rebuild', { method: 'POST' });
        if (!response.ok) throw new Error(response.statusText);
        
        fetchIndexerStatus();
    } catch (err) {
        alert(`Failed to trigger index rebuild: ${err.message}`);
    }
}

async function cancelIndexRebuild() {
    try {
        const response = await fetch('/api/index/cancel', { method: 'POST' });
        if (!response.ok) throw new Error(response.statusText);
        
        fetchIndexerStatus();
    } catch (err) {
        alert(`Failed to cancel index rebuild: ${err.message}`);
    }
}

// Poller loop for status
function startStatusPolling() {
    if (statusPollInterval) clearInterval(statusPollInterval);
    statusPollInterval = setInterval(() => {
        fetchIndexerStatus();
    }, 1000);
}

function stopStatusPolling() {
    if (statusPollInterval) {
        clearInterval(statusPollInterval);
        statusPollInterval = null;
    }
}
