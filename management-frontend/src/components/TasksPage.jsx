import React, { useEffect, useMemo, useCallback, useState } from "react";
import { motion, AnimatePresence } from 'framer-motion';
import { apiFetch } from "../utils";
import { RefreshCw } from "lucide-react";
import Banner from "./Banner";
import Chip from "./Chip";
import ExpandableDeleteButton from "./ExpandableDeleteButton";
import TaskDataRenderer from "./TaskDataRenderer";

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

    useEffect(() => { load(); }, [load]);

    return (
        <div className="page">
            <div className="page-head">
                <div className="title">Tasks</div>
                <div className="actions">
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
                <pre>{JSON.stringify(data, null, 4)}</pre>
            )}
        </div>
    );
}

export default TasksPage;