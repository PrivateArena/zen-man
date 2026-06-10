// Zen-Man Frontend Bootstrapper (ES Module Entrypoint)

import { state, getPaneDom } from './state.js';
import { initSplitView, setSplitView, setQuadView, setActivePane } from './split-view.js';
import { 
    initSidebar, 
    loadSidebarPlaces, 
    addCurrentToBookmarks 
} from './sidebar.js';
import { 
    initFileList, 
    renderFilesListVirtual, 
    updateSelectionUI,
    renderFiles
} from './file-list.js';
import { 
    initNavigation, 
    navigateTo, 
    navigatePaneHistory, 
    navigatePaneUp, 
    enablePaneAddressBarEdit, 
    disablePaneAddressBarEdit 
} from './navigation.js';
import { 
    createTab, 
    renderTabs,
    initTabs
} from './tabs.js';
import { 
    loadWorkspaces, 
    showWorkspaceCreatePanel, 
    hideWorkspaceCreatePanel, 
    triggerSaveWorkspace, 
    triggerDeleteWorkspace, 
    handleWorkspaceChange,
    scheduleAutoSave,
    restoreLastWorkspace
} from './workspace.js';
import { handlePaneContextMenu } from './context-menu.js';
import { handleKeyboardShortcuts } from './keyboard.js';
import { initCustomActions } from './custom-actions.js';
import { initQuickFind } from './quick-find.js';

// Initialize Module Callback Registrations to break circular dependencies
initSplitView(updateSelectionUI, createTab);
initSidebar(navigateTo);
initFileList(navigateTo);
initNavigation(renderTabs, scheduleAutoSave);
initTabs(scheduleAutoSave);
initQuickFind(navigateTo);

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    loadSidebarPlaces();
    initCustomActions();
    
    // Restore previous active session (or create blank tab if none)
    restoreLastWorkspace();
});

function setupEventListeners() {
    setupPaneListeners('left');
    setupPaneListeners('right');
    setupPaneListeners('left-bottom');
    setupPaneListeners('right-bottom');

    // Global toggle split view
    document.getElementById('split-2-btn').addEventListener('click', () => {
        setSplitView(!state.isSplit);
    });
    document.getElementById('split-4-btn').addEventListener('click', () => {
        setQuadView(!state.isQuad);
    });

    // Bookmark actions
    document.getElementById('btn-add-bookmark').addEventListener('click', addCurrentToBookmarks);

    // Workspace actions
    document.getElementById('workspace-new-btn').addEventListener('click', showWorkspaceCreatePanel);
    document.getElementById('workspace-confirm-save').addEventListener('click', triggerSaveWorkspace);
    document.getElementById('workspace-cancel-save').addEventListener('click', hideWorkspaceCreatePanel);
    document.getElementById('workspace-delete').addEventListener('click', triggerDeleteWorkspace);
    document.getElementById('workspace-select').addEventListener('change', handleWorkspaceChange);

    // Right click context menu routing
    Object.keys(state.panes).forEach(paneId => {
        document.getElementById(`pane-${paneId}`).addEventListener('contextmenu', (e) => handlePaneContextMenu(e, paneId));
    });

    // Right-click hold for calculating directory size
    const indicator = new ProgressIndicator();
    let holdTimer = null;
    let isHoldTriggered = false;
    const HOLD_DURATION = 1500; // 1.5 seconds

    document.addEventListener('mousedown', (e) => {
        if (e.button !== 2) return;
        const item = e.target.closest('.file-item');
        if (item && item.getAttribute('data-dir') === 'true') {
            const path = item.getAttribute('data-path');
            isHoldTriggered = false;
            indicator.show(e.clientX, e.clientY, HOLD_DURATION);
            holdTimer = setTimeout(() => {
                isHoldTriggered = true;
                indicator.hide();
                
                const sizeEl = item.querySelector('.file-size');
                if (sizeEl) {
                    sizeEl.innerHTML = '<span class="folder-size-loading"></span>';
                }
                
                fetch(`/api/dir/size?path=${encodeURIComponent(path)}`)
                    .then(r => r.json())
                    .then(data => {
                        if (data.status === 'success') {
                            Object.keys(state.panes).forEach(paneId => {
                                const pane = state.panes[paneId];
                                pane.tabs.forEach(t => {
                                    t.loadedEntries.forEach(entry => {
                                        const fullPath = t.currentPath + (t.currentPath.endsWith('/') ? '' : '/') + entry.name;
                                        if (fullPath === path) {
                                            entry.size = data.size;
                                            entry.files_count = data.files_count;
                                        }
                                    });
                                });
                            });
                            renderFiles(state.activePane);
                        }
                    })
                    .catch(err => {
                        console.error(err);
                        if (sizeEl) sizeEl.textContent = 'Error';
                    });
            }, HOLD_DURATION);
        }
    }, true);

    document.addEventListener('mousemove', (e) => {
        if (holdTimer) {
            indicator.updatePosition(e.clientX, e.clientY);
        }
    }, true);

    document.addEventListener('mouseup', (e) => {
        if (e.button === 2) {
            clearTimeout(holdTimer);
            holdTimer = null;
            if (!isHoldTriggered) {
                indicator.hide();
            }
        }
    }, true);

    document.addEventListener('contextmenu', (e) => {
        if (isHoldTriggered) {
            e.preventDefault();
            e.stopPropagation();
            isHoldTriggered = false;
        }
    }, true);

    // Hide context menu on click anywhere — use capture so file-list's stopPropagation doesn't block it
    document.addEventListener('click', () => {
        document.getElementById('context-menu').style.display = 'none';
    }, { capture: true });

    // Close views dropdowns on click outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.views-dropdown')) {
            document.querySelectorAll('.views-dropdown').forEach(d => d.classList.remove('open'));
        }
    });

    // Global keyboard shortcuts
    document.addEventListener('keydown', handleKeyboardShortcuts);
}

function setupPaneListeners(paneId) {
    const paneEl = getPaneDom(paneId);
    
    // Views Dropdown Toggle
    const dropdown = paneEl.querySelector('.views-dropdown');
    const dropdownBtn = paneEl.querySelector('.views-dropdown-btn');
    if (dropdown && dropdownBtn) {
        dropdownBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            // Close other open dropdowns
            document.querySelectorAll('.views-dropdown').forEach(d => {
                if (d !== dropdown) d.classList.remove('open');
            });
            dropdown.classList.toggle('open');
        });
    }

    // Flat View Radio Options
    const flatRadios = paneEl.querySelectorAll(`input[name="flat-view-${paneId}"]`);
    flatRadios.forEach(radio => {
        radio.addEventListener('change', () => {
            const pane = state.panes[paneId];
            const tab = pane.tabs.find(t => t.id === pane.activeTabId);
            if (tab) {
                const mode = radio.value === 'none' ? null : radio.value;
                tab.flatViewMode = mode;
                if (!tab.collapsedFileGroups) {
                    tab.collapsedFileGroups = new Set();
                } else {
                    tab.collapsedFileGroups.clear();
                }

                // If Flat View is enabled, disable Grid View (as it only works with Normal View)
                const gridChk = paneEl.querySelector('.chk-grid-view');
                const nestedGridWrapper = paneEl.querySelector('.nested-grid-view');
                if (mode) {
                    tab.viewMode = 'list';
                    if (gridChk) {
                        gridChk.checked = false;
                        gridChk.disabled = true;
                    }
                    if (nestedGridWrapper) {
                        nestedGridWrapper.classList.add('disabled');
                    }
                } else {
                    if (gridChk) {
                        gridChk.disabled = false;
                        gridChk.checked = tab.viewMode === 'grid';
                    }
                    if (nestedGridWrapper) {
                        nestedGridWrapper.classList.remove('disabled');
                    }
                }

                import('./navigation.js').then(m => m.navigateTo(tab.currentPath, false, paneId));
            }
            if (dropdown) dropdown.classList.remove('open');
        });
    });

    // Grid View Toggle (Checkbox)
    const gridChk = paneEl.querySelector('.chk-grid-view');
    if (gridChk) {
        gridChk.addEventListener('change', () => {
            const pane = state.panes[paneId];
            const tab = pane.tabs.find(t => t.id === pane.activeTabId);
            if (tab) {
                const nextMode = gridChk.checked ? 'grid' : 'list';
                import('./navigation.js').then(m => m.setPaneViewMode(paneId, nextMode));
            }
        });
    }
    
    // Navigation Buttons
    paneEl.querySelector('.nav-back').addEventListener('click', () => navigatePaneHistory(paneId, -1));
    paneEl.querySelector('.nav-forward').addEventListener('click', () => navigatePaneHistory(paneId, 1));
    paneEl.querySelector('.nav-up').addEventListener('click', () => navigatePaneUp(paneId));
    
    // Breadcrumbs address bar toggle
    const breadcrumbContainer = paneEl.querySelector('.breadcrumb-container');
    const addressBar = paneEl.querySelector('.address-bar');
    const breadcrumbs = paneEl.querySelector('.breadcrumbs');
    
    breadcrumbContainer.addEventListener('click', (e) => {
        if (e.target === breadcrumbContainer || e.target === breadcrumbs) {
            enablePaneAddressBarEdit(paneId);
        }
    });
    
    addressBar.addEventListener('blur', () => disablePaneAddressBarEdit(paneId));
    addressBar.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            navigateTo(addressBar.value, true, paneId);
            addressBar.blur();
        } else if (e.key === 'Escape') {
            addressBar.blur();
        }
    });

    // New Tab button
    paneEl.querySelector('.btn-new-tab').addEventListener('click', () => {
        const tab = state.panes[paneId].tabs.find(t => t.id === state.panes[paneId].activeTabId);
        const path = tab ? tab.currentPath : '/';
        createTab(paneId, path);
    });

    // Switch pane focus on click or focus in
    paneEl.addEventListener('click', () => {
        if (state.activePane !== paneId) {
            setActivePane(paneId);
        }
    });

    paneEl.addEventListener('focusin', () => {
        if (state.activePane !== paneId) {
            setActivePane(paneId);
        }
    });

    // Scroll listener for virtual list
    const fileListEl = paneEl.querySelector('.file-list');
    fileListEl.addEventListener('scroll', () => {
        const tab = state.panes[paneId].tabs.find(t => t.id === state.panes[paneId].activeTabId);
        if (tab && tab.viewMode === 'list') {
            renderFilesListVirtual(paneId);
        }
    });

    // Window resize recalculations
    window.addEventListener('resize', () => {
        const activeTab = state.panes[paneId].tabs.find(t => t.id === state.panes[paneId].activeTabId);
        if (activeTab && activeTab.viewMode === 'list') {
            renderFilesListVirtual(paneId);
        }
    });
}

class ProgressIndicator {
    constructor(size = 40, strokeWidth = 4) {
        this.size = size; this.center = size / 2;
        this.radius = (size / 2) - strokeWidth;
        this.circumference = 2 * Math.PI * this.radius;
        this.el = document.createElement('div');
        this.el.className = 'hold-progress-indicator';
        this.el.style.cssText = `position:fixed; pointer-events:none; z-index:100000; display:none; opacity:0; transition: opacity 0.1s;`;
        this.el.innerHTML = `
            <svg width="${size}" height="${size}">
                <circle cx="${this.center}" cy="${this.center}" r="${this.radius}"
                        stroke="#ffcc00" stroke-width="${strokeWidth}" fill="transparent"
                        stroke-dasharray="${this.circumference}" stroke-dashoffset="${this.circumference}"
                        stroke-linecap="round" transform="rotate(-90 ${this.center} ${this.center})"/>
            </svg>`;
        (document.body || document.documentElement).appendChild(this.el);
        this.circle = this.el.querySelector('circle');
    }
    show(x, y, duration) {
        this.updatePosition(x, y); this.el.style.display = 'block'; this.el.style.opacity = '1';
        this.circle.style.transition = 'none'; this.circle.style.strokeDashoffset = this.circumference;
        this.circle.style.stroke = "#ffcc00"; this.circle.getBoundingClientRect();
        this.circle.style.transition = `stroke-dashoffset ${duration}ms linear, stroke ${duration}ms linear`;
        this.circle.style.strokeDashoffset = '0'; this.circle.style.stroke = "#30fb3d";
    }
    hide() {
        this.el.style.opacity = '0';
        setTimeout(() => { if (this.el.style.opacity === '0') this.el.style.display = 'none'; }, 100);
    }
    updatePosition(x, y) { this.el.style.left = `${x - this.center}px`; this.el.style.top = `${y - this.center}px`; }
}
