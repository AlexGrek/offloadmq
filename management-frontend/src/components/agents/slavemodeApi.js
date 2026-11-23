import { TOKEN_KEY } from "../../utils";

async function request(path, token, body) {
    const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-MGMT-API-KEY': token },
        body: JSON.stringify({ apiKey: 'mgmt', ...body }),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${res.status} ${res.statusText}${text ? ` – ${text}` : ''}`);
    }
    return res.json();
}

export async function runSlavemodeAndPoll(capability, agentUid, payload = {}, {
    timeoutSeconds = 60, onProgress,
} = {}) {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) throw new Error('No management token set.');
    if (!agentUid) throw new Error('No agent selected.');

    const submit = await request('/api/task/submit', token, {
        capability,
        payload: { ...payload, runner: agentUid },
        timeoutSecs: timeoutSeconds,
    });
    const { cap, id } = submit?.id ?? {};
    if (!cap || !id) throw new Error('Unexpected submit response');
    const path = `/api/task/poll/${encodeURIComponent(cap)}/${encodeURIComponent(id)}`;
    // Allow the server to report its own timeout before giving up locally.
    const deadline = Date.now() + (timeoutSeconds + 10) * 1000;
    onProgress?.('Waiting for agent…');

    do {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const { status, output, error, log, stage } = await request(path, token);
        if (status === 'completed') return output;
        if (status === 'failed' || status === 'canceled') {
            const reason = typeof output === 'string' ? output : output?.error;
            throw new Error(reason || error || (status === 'canceled' ? 'Task canceled' : 'Task failed'));
        }
        const lastLine = log?.trim().split('\n').pop();
        onProgress?.(lastLine || (stage ? `${stage}…` : null) || {
            assigned: 'Assigned to agent…',
            starting: 'Starting…',
            running: 'Running…',
            cancelRequested: 'Canceling…',
        }[status] || 'Waiting for agent…');
    } while (Date.now() < deadline);

    throw new Error(`Timed out waiting for agent (${timeoutSeconds}s)`);
}
