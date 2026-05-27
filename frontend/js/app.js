// Zen-Man Frontend Bootstrapper (ES Module Entrypoint)

import { state, getPaneDom } from './state.js';
import { initSplitView, setSplitView, setActivePane } from './split-view.js';
import { 
    initSidebar, 
    loadSidebarPlaces, 
    addCurrentToBookmarks 
} from './sidebar.js';
import { 
    initFileList, 
    renderFilesListVirtual, 
    updateSelectionUI 
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
    restoreDefaultWorkspace
} from './workspace.js';
import { handlePaneContextMenu } from './context-menu.js';
import { handleKeyboardShortcuts } from './keyboard.js';
import { initCustomActions } from './custom-actions.js';

// Initialize Module Callback Registrations to break circular dependencies
initSplitView(updateSelectionUI, createTab);
initSidebar(navigateTo);
initFileList(navigateTo);
initNavigation(renderTabs, scheduleAutoSave);
initTabs(scheduleAutoSave);

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    loadSidebarPlaces();
    loadWorkspaces();
    initCustomActions();
    
    // Restore previous default session (or create blank tab if none)
    restoreDefaultWorkspace();
});

function setupEventListeners() {
    setupPaneListeners('left');
    setupPaneListeners('right');

    // Global toggle split view
    document.getElementById('split-toggle-btn').addEventListener('click', () => {
        setSplitView(!state.isSplit);
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
    document.getElementById('pane-left').addEventListener('contextmenu', (e) => handlePaneContextMenu(e, 'left'));
    document.getElementById('pane-right').addEventListener('contextmenu', (e) => handlePaneContextMenu(e, 'right'));

    // Hide context menu on click anywhere — use capture so file-list's stopPropagation doesn't block it
    document.addEventListener('click', () => {
        document.getElementById('context-menu').style.display = 'none';
    }, { capture: true });

    // Global keyboard shortcuts
    document.addEventListener('keydown', handleKeyboardShortcuts);
}

function setupPaneListeners(paneId) {
    const paneEl = getPaneDom(paneId);
    
    // View Toggles
    paneEl.querySelector('.view-list').addEventListener('click', () => import('./navigation.js').then(m => m.setPaneViewMode(paneId, 'list')));
    paneEl.querySelector('.view-grid').addEventListener('click', () => import('./navigation.js').then(m => m.setPaneViewMode(paneId, 'grid')));
    
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
