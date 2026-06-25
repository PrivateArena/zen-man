/**
 * Central Keyboard Shortcuts Registry
 * Defines all standard application shortcuts as pure strings.
 */
export const SHORTCUTS = {
    'open': 'Enter',
    'cut': 'Ctrl+X',
    'copy': 'Ctrl+C',
    'copy-path': 'Alt+Shift+C',
    'copy-name': 'Ctrl+Alt+C',
    'open-in-new-tab': 'Alt+T',
    'cut-inside': 'Alt+X',
    'copy-inside': 'Alt+C',
    'paste-inside': 'Alt+V',
    'rename': 'F2',
    'delete': 'Del',
    'paste': 'Ctrl+V',
    'create-folder': 'Ctrl+Shift+N',
    
    // Non-context-menu global shortcuts
    'search-manager': 'Ctrl+Shift+F',
    'quick-find': 'Ctrl+F',
    'split-view': 'F3',
    'quad-view': 'F4',
    'toggle-sidebar': 'Ctrl+B',
    'new-tab': 'Ctrl+T',
    'close-tab': 'Ctrl+W',
    'navigate-up': 'Backspace',
    'select-all': 'Ctrl+A'
};

/**
 * Parses a shortcut string (e.g. 'Ctrl+Shift+N') into modifiers and key.
 */
export function parseShortcut(shortcutStr) {
    const parts = shortcutStr.split('+');
    const keyPart = parts[parts.length - 1];
    
    const ctrlKey = parts.includes('Ctrl');
    const altKey = parts.includes('Alt');
    const shiftKey = parts.includes('Shift');
    
    // Normalize key mapping for matching
    let key = keyPart;
    let aliasKeys = [];
    if (key.toLowerCase() === 'del') {
        key = 'Delete';
        aliasKeys = ['Del'];
    }
    
    return {
        key,
        aliasKeys,
        ctrlKey,
        altKey,
        shiftKey
    };
}

/**
 * Matches a KeyboardEvent against a shortcut string definition.
 */
export function matchesShortcut(e, shortcutStr) {
    if (!shortcutStr) return false;
    
    const parsed = parseShortcut(shortcutStr);
    
    if (e.ctrlKey !== parsed.ctrlKey) return false;
    if (e.altKey !== parsed.altKey) return false;
    if (e.shiftKey !== parsed.shiftKey) return false;
    
    const keyLower = parsed.key.toLowerCase();
    const eventKeyLower = e.key.toLowerCase();
    
    if (keyLower === eventKeyLower) return true;
    
    if (parsed.aliasKeys.some(k => k.toLowerCase() === eventKeyLower)) return true;
    
    return false;
}

/**
 * Retrieves the display text for a given action.
 */
export function getShortcutDisplay(action) {
    return SHORTCUTS[action] || '';
}
