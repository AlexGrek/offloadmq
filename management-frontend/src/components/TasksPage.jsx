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

function TasksPage() {
    const [data, setData] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [newOnly, setNewOnly] = useState(true);

    const load = useCallback(async () => {
        setLoading(true); setError("");
        try {
            const url = "/management/tasks/list";
            const data = await apiFetch(url);
            setData(data);
        } catch (e) {
            setError(e.message || String(e));
        } finally {
            setLoading(false);
        }
    }, []);

    const handleReset = useCallback(async () => {
        const url = "/management/tasks/reset";
        try {
            await apiFetch(url, { method: "POST" });
            await load();
        } catch (e) {
            alert(`Failed to reset: ${e.message}`);
        }
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
                    <button className="btn" onClick={load}><RefreshCw /> <span>Refresh</span></button>
                </div>
            </div>

            {error && <Banner kind="error">{error}</Banner>}

            {loading ? (
                <div className="loader" aria-busy="true">Loading…</div>
            ) : (
                <TaskDataRenderer data={newOnly ? filterUnassigned(data) : data} />
            )}
        </div>
    );
}

export default TasksPage;