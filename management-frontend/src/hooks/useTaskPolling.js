import { useEffect, useRef } from 'react';

/**
 * Hook for interval-based task polling.
 * Sets up a polling interval when `currentTask` is non-null and cleans up on unmount.
 *
 * @param {object} options
 * @param {object|null} options.currentTask - { id, capability } or null to stop polling
 * @param {string} options.apiKey - Client API key for poll requests
 * @param {function} options.addDevEntry - DevPanel logger
 * @param {function} options.onResult - Called with the poll data when output is received
 * @param {function} options.onError - Called with error message string
 * @param {function} [options.onLog] - Called with log text when available
 * @param {function} [options.onStatus] - Called with status text on each poll
 * @param {number} [options.interval=2000] - Polling interval in ms
 */
export function useTaskPolling({ currentTask, apiKey, addDevEntry, onResult, onError, onLog, onStatus, interval = 2000 }) {
  const pollIntervalRef = useRef(null);

  useEffect(() => {
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    if (!currentTask) return;

    const poll = async () => {
      const pollUrl = `/api/task/poll/${encodeURIComponent(currentTask.capability)}/${currentTask.id}`;
      const pollPayload = { apiKey };
      try {
        const res = await fetch(pollUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(pollPayload),
        });
        const data = await res.json();
        addDevEntry?.({ key: `poll-${currentTask.id}`, label: 'Poll task', method: 'POST', url: pollUrl, request: pollPayload, response: data });

        if (data.log) onLog?.(data.log);

        if (data.output) {
          onResult(data);
        } else if (data.error) {
          onError(data.error.message || String(data.error));
        } else {
          onStatus?.(data.status);
        }
      } catch (err) {
        addDevEntry?.({ key: `poll-${currentTask.id}`, label: 'Poll task', method: 'POST', url: pollUrl, request: pollPayload, response: { error: err.message } });
        onError(`Polling failed: ${err.message}`);
      }
    };

    poll();
    pollIntervalRef.current = setInterval(poll, interval);
    return () => { if (pollIntervalRef.current) clearInterval(pollIntervalRef.current); };
  }, [currentTask, apiKey, addDevEntry]); // eslint-disable-line react-hooks/exhaustive-deps
}
