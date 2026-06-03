// Low-level HTTP payload post executor
export async function executeFileOp(op, sources = [], dest = null, name = null, merge = false) {
    const response = await fetch('/api/op', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op, sources, dest, name, merge })
    });
    if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || response.statusText);
    }
    return response.json();
}

export async function openFile(path) {
    try {
        await executeFileOp('open', [path]);
    } catch (err) {
        alert(`Error opening file: ${err.message}`);
    }
}
