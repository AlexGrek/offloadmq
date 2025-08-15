import React, { useEffect, useMemo, useCallback, useState } from "react";
import { motion, AnimatePresence } from 'framer-motion';
import { apiFetch, fmtDate } from "../utils";
import { RefreshCw } from "lucide-react";
import Banner from "./Banner";
import Chip from "./Chip";

function AgentsPage() {
    const [agents, setAgents] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [onlineOnly, setOnlineOnly] = useState(true);
    const [expanded, setExpanded] = useState({}); // uid -> bool

    const load = useCallback(async () => {
        setLoading(true); setError("");
        try {
            const url = onlineOnly ? "/management/agents/list/online" : "/management/agents/list";
            const data = await apiFetch(url);
            setAgents(Array.isArray(data) ? data : []);
        } catch (e) {
            setError(e.message || String(e));
        } finally {
            setLoading(false);
        }
    }, [onlineOnly]);

    useEffect(() => { load(); }, [load, onlineOnly]);

    const toggle = (uid) => setExpanded((s) => ({ ...s, [uid]: !s[uid] }));

    const onDelete = async (uid) => {
        try {
            await apiFetch(`/management/agents/delete/${encodeURIComponent(uid)}`, { method: "POST" });
            await load();
        } catch (e) {
            alert(`Failed to delete: ${e.message}`);
        }
    };

    return (
        <div className="page">
            <div className="page-head">
                <div className="title">Agents</div>
                <div className="actions">
                    <label className="toggle">
                        <input type="checkbox" checked={onlineOnly} onChange={(e) => setOnlineOnly(e.target.checked)} />
                        <span>Online only</span>
                    </label>
                    <button className="btn" onClick={load}><RefreshCw /> <span>Refresh</span></button>
                </div>
            </div>

            {error && <Banner kind="error">{error}</Banner>}

            {loading ? (
                <div className="loader" aria-busy="true">Loading…</div>
            ) : (
                <ul className="list">
                    {agents.map((a) => {
                        const isOpen = !!expanded[a.uid];
                        return (
                            <li key={a.uid} className="card">
                                <div className="row" onClick={() => toggle(a.uid)} aria-expanded={isOpen}>
                                    <div className="row-main">
                                        <div className="row-title">{a.uidShort || a.uid}</div>
                                        <div className="row-sub">
                                            <Chip>Tier {a.tier}</Chip>
                                            <Chip>Capacity {a.capacity}</Chip>
                                            <Chip>{(a.capabilities || []).length} caps</Chip>
                                            <Chip>{a.lastContact ? "Seen " + new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(Math.round((new Date(a.lastContact) - Date.now()) / 60000), "minute") : "Never"}</Chip>
                                        </div>
                                    </div>
                                    <div className="row-actions">
                                        <ExpandableDeleteButton onDelete={() => { onDelete(a.uid); }} itemName={a.uid} />
                                        {/* <button className="btn danger" onClick={(e)=>{e.stopPropagation(); onDelete(a.uid);}} title="Delete"><Trash/></button> */}
                                    </div>
                                </div>

                                <AnimatePresence initial={false}>
                                    {isOpen && (
                                        <motion.div className="expand" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ type: "spring", stiffness: 120, damping: 18 }}>
                                            <div className="grid">
                                                <div>
                                                    <div className="kv"><span>UID:</span><code>{a.uid}</code></div>
                                                    <div className="kv"><span>Registered:</span><b>{fmtDate(a.registeredAt)}</b></div>
                                                    <div className="kv"><span>Last contact:</span><b>{fmtDate(a.lastContact)}</b></div>
                                                    <div className="kv"><span>Personal token:</span><code>{a.personalLoginToken}</code></div>
                                                </div>
                                                <div>
                                                    <div className="section-title">System</div>
                                                    <div className="kv"><span>OS:</span><b>{a.systemInfo?.os}</b></div>
                                                    <div className="kv"><span>Client:</span><b>{a.systemInfo?.client}</b></div>
                                                    <div className="kv"><span>Runtime:</span><b>{a.systemInfo?.runtime}</b></div>
                                                    <div className="kv"><span>CPU Arch:</span><b>{a.systemInfo?.cpuArch}</b></div>
                                                    <div className="kv"><span>Total RAM:</span><b>{a.systemInfo?.totalMemoryMb} MB</b></div>
                                                </div>
                                                <div>
                                                    <div className="section-title">GPU</div>
                                                    {a.systemInfo?.gpu ? (
                                                        <>
                                                            <div className="kv"><span>Vendor:</span><b>{a.systemInfo.gpu.vendor}</b></div>
                                                            <div className="kv"><span>Model:</span><b>{a.systemInfo.gpu.model}</b></div>
                                                            <div className="kv"><span>VRAM:</span><b>{a.systemInfo.gpu.vramMb} MB</b></div>
                                                        </>
                                                    ) : (
                                                        <div className="muted">No GPU</div>
                                                    )}
                                                </div>
                                                <div>
                                                    <div className="section-title">Capabilities</div>
                                                    <div className="chips-wrap">{(a.capabilities || []).map((c, i) => (<Chip key={i}>{c}</Chip>))}</div>
                                                </div>
                                            </div>
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}

export default AgentsPage;