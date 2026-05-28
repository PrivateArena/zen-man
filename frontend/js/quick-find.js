import { state, getActiveTab, getPaneDom, getActivePane } from './state.js';
import { formatSize } from './utils.js';
import { openFile } from './api.js';
import { updateItemSelectionStyles, updateSelectionUI } from './file-list.js';

let navigateToCallback = null;
let activeAbortController = null;
let debounceTimeout = null;
let searchResults = [];
let selectedIndex = -1;

export function initQuickFind(navigateTo) {
    navigateToCallback = navigateTo;
}

export function openQuickFind() {
    const tab = getActiveTab();
    if (!tab) return;

    const overlay = document.getElementById('quick-find-overlay');
    const input = document.getElementById('quick-find-input');
    const pathLabel = document.getElementById('quick-find-path');
    const recursiveCheck = document.getElementById('quick-find-recursive');

    // Restore recursive toggle state from localStorage
    const savedRecursive = localStorage.getItem('quick-find-recursive') === 'true';
    recursiveCheck.checked = savedRecursive;

    // Reset state
    input.value = '';
    searchResults = [];
    selectedIndex = -1;
    pathLabel.textContent = `Finding in: ${tab.currentPath}`;
    
    // Clear previous results UI
    const resultsContainer = document.getElementById('quick-find-results');
    resultsContainer.innerHTML = '';
    document.getElementById('quick-find-count').textContent = '';

    // Show modal
    overlay.style.display = 'flex';
    input.focus();

    // Bind event listeners for this session
    setupModalListeners();
}

export function closeQuickFind() {
    const overlay = document.getElementById('quick-find-overlay');
    overlay.style.display = 'none';

    // Abort any active search immediately
    if (activeAbortController) {
        activeAbortController.abort();
        activeAbortController = null;
    }
    if (debounceTimeout) {
        clearTimeout(debounceTimeout);
        debounceTimeout = null;
    }

    // Return focus to active pane
    const activePaneId = state.activePane;
    const fileListEl = getPaneDom(activePaneId).querySelector('.file-list');
    if (fileListEl) fileListEl.focus();

    removeModalListeners();
}

function setupModalListeners() {
    const overlay = document.getElementById('quick-find-overlay');
    const input = document.getElementById('quick-find-input');
    const recursiveCheck = document.getElementById('quick-find-recursive');

    overlay.addEventListener('click', onOverlayClick);
    input.addEventListener('input', onInputChanged);
    input.addEventListener('keydown', onInputKeyDown);
    recursiveCheck.addEventListener('change', onRecursiveToggle);
}

function removeModalListeners() {
    const overlay = document.getElementById('quick-find-overlay');
    const input = document.getElementById('quick-find-input');
    const recursiveCheck = document.getElementById('quick-find-recursive');

    overlay.removeEventListener('click', onOverlayClick);
    input.removeEventListener('input', onInputChanged);
    input.removeEventListener('keydown', onInputKeyDown);
    recursiveCheck.removeEventListener('change', onRecursiveToggle);
}

function onOverlayClick(e) {
    if (e.target.id === 'quick-find-overlay') {
        closeQuickFind();
    }
}

function onRecursiveToggle() {
    const recursiveCheck = document.getElementById('quick-find-recursive');
    localStorage.setItem('quick-find-recursive', recursiveCheck.checked);
    // Refire search immediately if input has text
    triggerSearch();
}

function onInputChanged() {
    if (debounceTimeout) clearTimeout(debounceTimeout);
    debounceTimeout = setTimeout(() => {
        triggerSearch();
    }, 250); // 250ms debounce to prevent IO spam while typing
}

async function triggerSearch() {
    const input = document.getElementById('quick-find-input');
    const query = input.value.trim();
    const tab = getActiveTab();
    if (!tab) return;

    // Clear active controllers if any
    if (activeAbortController) {
        activeAbortController.abort();
    }

    const resultsContainer = document.getElementById('quick-find-results');
    const countLabel = document.getElementById('quick-find-count');

    if (query === '') {
        searchResults = [];
        selectedIndex = -1;
        resultsContainer.innerHTML = '';
        countLabel.textContent = '';
        return;
    }

    activeAbortController = new AbortController();
    const signal = activeAbortController.signal;

    const recursive = document.getElementById('quick-find-recursive').checked;
    countLabel.textContent = 'Searching...';

    try {
        const url = `/api/search?path=${encodeURIComponent(tab.currentPath)}&q=${encodeURIComponent(query)}&recursive=${recursive}`;
        const response = await fetch(url, { signal });
        
        if (!response.ok) {
            throw new Error(`Search failed: ${response.statusText}`);
        }

        const data = await response.json();
        
        searchResults = data.entries || [];
        selectedIndex = searchResults.length > 0 ? 0 : -1;
        renderSearchResults();

        const count = data.total_matched;
        if (data.capped) {
            countLabel.textContent = `${count}+ matches (capped)`;
        } else {
            countLabel.textContent = `${count} match${count === 1 ? '' : 'es'}`;
        }
    } catch (err) {
        if (err.name === 'AbortError') {
            // Silence aborted fetch requests
            return;
        }
        console.error(err);
        countLabel.textContent = 'Search failed';
        resultsContainer.innerHTML = `<div class="quick-find-empty">Error running search: ${err.message}</div>`;
    }
}

function renderSearchResults() {
    const resultsContainer = document.getElementById('quick-find-results');
    if (searchResults.length === 0) {
        resultsContainer.innerHTML = `<div class="quick-find-empty">No matching files or folders found</div>`;
        return;
    }

    let html = '';
    searchResults.forEach((item, index) => {
        const icon = item.is_dir ? '📁' : '📄';
        const sizeStr = item.is_dir ? '' : formatSize(item.size);
        const isSelected = index === selectedIndex ? 'selected' : '';
        
        html += `
            <div class="quick-find-item ${isSelected}" data-index="${index}">
                <span class="quick-find-item-icon">${icon}</span>
                <div class="quick-find-item-details">
                    <span class="quick-find-item-name">${item.name}</span>
                    <span class="quick-find-item-relpath">${item.rel_path}</span>
                </div>
                ${sizeStr ? `<span class="quick-find-item-size">${sizeStr}</span>` : ''}
            </div>
        `;
    });

    resultsContainer.innerHTML = html;

    // Attach click event handlers
    resultsContainer.querySelectorAll('.quick-find-item').forEach(el => {
        const index = parseInt(el.getAttribute('data-index'), 10);
        
        // Double left-click to open/navigate (User Option C)
        el.addEventListener('dblclick', (e) => {
            e.preventDefault();
            executeItemAction(index, 'open');
        });

        // Click to select
        el.addEventListener('click', () => {
            selectedIndex = index;
            highlightSelectedRow();
        });

        // Right click to reveal in directory (User Option C)
        el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            executeItemAction(index, 'reveal');
        });
    });

    // Auto-scroll selected row into view
    scrollToSelected();
}

function highlightSelectedRow() {
    const resultsContainer = document.getElementById('quick-find-results');
    resultsContainer.querySelectorAll('.quick-find-item').forEach((el, index) => {
        if (index === selectedIndex) {
            el.classList.add('selected');
        } else {
            el.classList.remove('selected');
        }
    });
    scrollToSelected();
}

function scrollToSelected() {
    const resultsContainer = document.getElementById('quick-find-results');
    const selectedRow = resultsContainer.querySelector('.quick-find-item.selected');
    if (selectedRow) {
        selectedRow.scrollIntoView({ block: 'nearest' });
    }
}

function onInputKeyDown(e) {
    if (e.key === 'Escape') {
        e.preventDefault();
        closeQuickFind();
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

async function executeItemAction(index, mode) {
    const item = searchResults[index];
    if (!item) return;

    const tab = getActiveTab();
    if (!tab) return;

    // Resolve full absolute path of matched item
    const rootPath = tab.currentPath.endsWith('/') ? tab.currentPath : (tab.currentPath + '/');
    const itemPath = tab.currentPath + (tab.currentPath.endsWith('/') ? '' : '/') + item.rel_path;

    closeQuickFind();

    if (mode === 'open') {
        if (item.is_dir) {
            // Navigate to folder
            if (navigateToCallback) {
                navigateToCallback(itemPath, true, state.activePane);
            }
        } else {
            // Open file using default action helper
            openFile(itemPath);
        }
    } 
    else if (mode === 'reveal') {
        // Find parent directory of file/folder
        let parentDir;
        if (item.is_dir) {
            // Reveal a folder inside its parent
            parentDir = itemPath.substring(0, itemPath.lastIndexOf('/')) || '/';
        } else {
            // Reveal a file inside its parent
            parentDir = itemPath.substring(0, itemPath.lastIndexOf('/')) || '/';
        }

        if (navigateToCallback) {
            // Navigate to parent directory
            await navigateToCallback(parentDir, true, state.activePane);

            // Once navigated, highlight/select the item
            const activeTab = getActiveTab();
            if (activeTab) {
                activeTab.selectedPaths.clear();
                activeTab.selectedPaths.add(itemPath);
                updateItemSelectionStyles(state.activePane);
                updateSelectionUI();

                // Scroll the selected item into view
                setTimeout(() => {
                    const fileListEl = getPaneDom(state.activePane).querySelector('.file-list');
                    const fileItem = fileListEl.querySelector(`[data-path="${CSS.escape(itemPath)}"]`);
                    if (fileItem) {
                        fileItem.scrollIntoView({ block: 'nearest' });
                    }
                }, 150);
            }
        }
    }
}
