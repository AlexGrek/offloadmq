import React, { useEffect, useCallback, useState } from "react";
import { apiFetch } from "../utils";
import { RefreshCw } from "lucide-react";
import Banner from "./Banner";
import ExpandableDeleteButton from "./ExpandableDeleteButton";
import TaskDataRenderer from "./TaskDataRenderer";

function filterUnassigned(data) {
    if (!data) return data;
    const result = {};
    for (const [cat, val] of Object.entries(data)) {
        result[cat] = { assigned: [], unassigned: val?.unassigned || [] };
    }
    return result;
}

function taskCreatedMs(task) {
    const t = task?.createdAt;
    if (t == null) return 0;
    const ms = typeof t === "number" ? t : Date.parse(t);
    return Number.isFinite(ms) ? ms : 0;
}

function sortTasksRecentFirst(tasks) {
    if (!Array.isArray(tasks) || tasks.length <= 1) {
        return tasks ? [...tasks] : [];
    }
    return [...tasks].sort((a, b) => taskCreatedMs(b) - taskCreatedMs(a));
}

function sortTaskCategories(data) {
    if (!data) return data;
    const out = {};
    for (const [cat, val] of Object.entries(data)) {
        out[cat] = {
            assigned: sortTasksRecentFirst(val?.assigned || []),
            unassigned: sortTasksRecentFirst(val?.unassigned || []),
        };
    }
    return out;
}

function truncationNotice(meta) {
    if (!meta?.truncated) return "";
    const t = meta.totals || {};
    return `Showing the newest ${meta.limit} per list — server has ` +
        `${t.regular_assigned ?? "?"} assigned and ${t.regular_unassigned ?? "?"} queued regular tasks. ` +
        `Finished tasks are archived after 7 days.`;
}

function TasksPage() {
    const [response, setResponse] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [newOnly, setNewOnly] = useState(true);
    const [showFinished, setShowFinished] = useState(false);

    const load = useCallback(async () => {
        setLoading(true); setError("");
        try {
            // The server caps each list; ask only for unfinished tasks unless
            // the user wants history, so the page never pulls the whole archive.
            const status = showFinished ? "all" : "active";
            setResponse(await apiFetch(`/management/tasks/list?status=${status}`));
        } catch (e) {
            setError(e.message || String(e));
        } finally {
            setLoading(false);
        }
    }, [showFinished]);

    // `meta` sits next to the four task lists; keep it out of the category renderer.
    const { meta, ...data } = response || {};

    const handleReset = useCallback(async () => {
        const url = "/management/tasks/reset";
        try {
            await apiFetch(url, { method: "POST" });
            await load();
        } catch (e) {
            alert(`Failed to reset: ${e.message}`);
        }
    }, [load]);

    const handleCancel = useCallback(async (cap, taskId) => {
        const url = `/management/tasks/cancel/${encodeURIComponent(cap)}/${encodeURIComponent(taskId)}`;
        await apiFetch(url, { method: "POST" });
        await load();
    }, [load]);

    useEffect(() => { load(); }, [load]);

    return (
        <div className="page">
            <div className="page-head">
                <div className="title">Tasks</div>
                <div className="actions">
                    <ExpandableDeleteButton onDelete={handleReset} itemName="everything" customActionText="Reset" />
                    <label className="toggle">
                        <input type="checkbox" checked={newOnly} onChange={(e) => setNewOnly(e.target.checked)} />
                        <span>Unassigned only</span>
                    </label>
                    <label className="toggle">
                        <input type="checkbox" checked={showFinished} onChange={(e) => setShowFinished(e.target.checked)} />
                        <span>Show finished</span>
                    </label>
                    <button className="btn" onClick={load}><RefreshCw /> <span>Refresh</span></button>
                </div>
            </div>

            {error && <Banner kind="error">{error}</Banner>}
            {truncationNotice(meta) && <Banner kind="info">{truncationNotice(meta)}</Banner>}

            {loading ? (
                <div className="loader" aria-busy="true">Loading…</div>
            ) : (
                <TaskDataRenderer data={response ? sortTaskCategories(newOnly ? filterUnassigned(data) : data) : null} onCancel={handleCancel} />
            )}
        </div>
    );
}

export default TasksPage;