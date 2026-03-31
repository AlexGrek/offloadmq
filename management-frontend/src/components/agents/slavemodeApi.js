import { TOKEN_KEY } from "../../utils";

export function getMgmtToken() {
    return localStorage.getItem(TOKEN_KEY) || '';
}

export async function submitSlavemodeTask(capability, payload, mgmtToken) {
    const res = await fetch('/api/task/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-MGMT-API-KEY': mgmtToken },
        body: JSON.stringify({ capability, payload, apiKey: 'mgmt' }),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${res.status} ${res.statusText}${text ? ` – ${text}` : ''}`);
    }
    return res.json();
}

export async function pollTask(cap, id, mgmtToken) {
    const res = await fetch(`/api/task/poll/${cap}/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-MGMT-API-KEY': mgmtToken },
        body: JSON.stringify({ apiKey: 'mgmt' }),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${res.status} ${res.statusText}${text ? ` – ${text}` : ''}`);
    }
    return res.json();
}

export async function runSlavemodeAndPoll(capability, payload, mgmtToken) {
    const submitData = await submitSlavemodeTask(capability, payload, mgmtToken);
    const taskId = submitData?.id?.id;
    const taskCap = submitData?.id?.cap;
    if (!taskId || !taskCap) throw new Error('Unexpected submit response');

    const MAX_ATTEMPTS = 30;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const poll = await pollTask(taskCap, taskId, mgmtToken);
        const status = poll?.status || '';
        if (poll?.output != null || status === 'completed' || status === 'failed') {
            if (status === 'failed' || poll?.error) {
                const raw = poll?.output;
                const msg = typeof raw === 'string' ? raw : raw?.error ?? (raw != null ? JSON.stringify(raw) : null);
                throw new Error(msg || poll?.error || 'Task failed');
            }
            return poll?.output;
        }
    }
    throw new Error('Timed out waiting for agent');
}
