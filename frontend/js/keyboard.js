import { state, getActiveTab, getActivePane } from './state.js';
import { setSplitView } from './split-view.js';
import { createTab, closeTab, switchTab } from './tabs.js';
import { navigatePaneUp } from './navigation.js';
import { openQuickFind } from './quick-find.js';
import { 
    triggerClipboard, 
    triggerPaste, 
    triggerRename, 
    triggerDelete, 
    triggerOpen 
} from './context-menu.js';

// Keyboard Shortcuts Router
export function handleKeyboardShortcuts(e) {
    if (document.activeElement.tagName === 'INPUT') return;

    if (e.ctrlKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        openQuickFind();
    }
    else if (e.key === 'F3') {
        e.preventDefault();
        setSplitView(!state.isSplit);
    }
    else if (e.ctrlKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        const sidebar = document.querySelector('.sidebar');
        sidebar.classList.toggle('visible');
    }
    else if (e.ctrlKey && e.key.toLowerCase() === 't') {
        e.preventDefault();
        const tab = getActiveTab();
        const path = tab ? tab.currentPath : '/';
        createTab(state.activePane, path);
    }
    else if (e.ctrlKey && e.key.toLowerCase() === 'w') {
        e.preventDefault();
        const tab = getActiveTab();
        if (tab) {
            closeTab(state.activePane, tab.id);
        }
    }
    else if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        cycleTabs(e.shiftKey ? -1 : 1);
    }
    else if (e.ctrlKey && e.key.toLowerCase() === 'c') {
        triggerClipboard('copy');
    }
    else if (e.ctrlKey && e.key.toLowerCase() === 'x') {
        triggerClipboard('cut');
    }
    else if (e.ctrlKey && e.key.toLowerCase() === 'v') {
        triggerPaste();
    }
    else if (e.key === 'F2') {
        triggerRename();
    }
    else if (e.key === 'Delete') {
        triggerDelete();
    }
    else if (e.key === 'Backspace') {
        navigatePaneUp(state.activePane);
    }
    else if (e.key === 'Enter') {
        triggerOpen();
    }
}

export function cycleTabs(dir) {
    const pane = getActivePane();
    if (pane.tabs.length <= 1) return;
    const index = pane.tabs.findIndex(t => t.id === pane.activeTabId);
    const nextIndex = (index + dir + pane.tabs.length) % pane.tabs.length;
    switchTab(state.activePane, pane.tabs[nextIndex].id);
}
