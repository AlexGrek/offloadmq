import React, { useEffect, useCallback, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { apiFetch, fmtDate } from "../utils";
import { RefreshCw, ChevronDown, ChevronRight, HardDrive, Trash2 } from "lucide-react";
import Banner from "./Banner";
import Chip from "./Chip";
import ExpandableDeleteButton from "./ExpandableDeleteButton";

function fmtBytes(n) {
    if (n == null) return "—";
    if (n === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.min(Math.floor(Math.log2(n) / 10), units.length - 1);
    const val = n / Math.pow(1024, i);
    return `${val % 1 === 0 ? val : val.toFixed(1)} ${units[i]}`;
}

function UsageBar({ used, max, label }) {
    const pct = max > 0 ? Math.min(100, (used / max) * 100) : 0;
    const color = pct > 90 ? "#ef4444" : pct > 70 ? "#f59e0b" : "#22c55e";
    return (
        <div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", marginBottom: "4px", color: "var(--muted)" }}>
                <span>{label}</span>
                <span style={{ fontWeight: 600 }}>{fmtBytes(used)} / {fmtBytes(max)}</span>
            </div>
            <div style={{ height: "6px", borderRadius: "999px", background: "var(--border)", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: "999px", transition: "width .4s ease" }} />
            </div>
        </div>
    );
}

function QuotasPanel({ quotas }) {
    if (!quotas) return null;
    const { limits, usage } = quotas;
    const keys = Object.keys(usage || {});

    return (
        <div className="card" style={{ padding: "14px 18px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "14px" }}>
                <HardDrive size={16} style={{ color: "var(--primary)" }} />
                <span style={{ fontWeight: 700, fontSize: "0.95rem" }}>Quotas & Usage</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "8px", marginBottom: keys.length ? "16px" : 0 }}>
                {[
                    { label: "Max buckets / key", value: limits?.max_buckets_per_key ?? "—" },
                    { label: "Max bucket size",   value: fmtBytes(limits?.bucket_size_bytes) },
                    { label: "Bucket TTL",         value: limits?.bucket_ttl_minutes != null ? `${limits.bucket_ttl_minutes} min` : "—" },
                ].map(({ label, value }) => (
                    <div key={label} style={{ background: "var(--code-bg)", borderRadius: "10px", padding: "10px 12px" }}>
                        <div style={{ fontSize: "0.70rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: ".4px", color: "var(--muted)", marginBottom: "4px" }}>{label}</div>
                        <div style={{ fontWeight: 700, fontSize: "1rem" }}>{value}</div>
                    </div>
                ))}
            </div>
            {keys.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                    <div style={{ fontSize: "0.75rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: ".4px", color: "var(--muted)" }}>Per-key usage</div>
                    {keys.map(key => {
                        const u = usage[key];
                        return (
                            <div key={key} style={{ background: "var(--code-bg)", borderRadius: "10px", padding: "10px 12px", display: "flex", flexDirection: "column", gap: "8px" }}>
                                <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                    <code style={{ fontSize: "0.78rem", wordBreak: "break-all" }}>{key.slice(0, 16)}…</code>
                                    <Chip>{u.bucket_count} bucket{u.bucket_count !== 1 ? "s" : ""}</Chip>
                                    <Chip>{u.total_files} file{u.total_files !== 1 ? "s" : ""}</Chip>
                                </div>
                                <UsageBar
                                    used={u.total_bytes}
                                    max={(limits?.bucket_size_bytes || 1) * (limits?.max_buckets_per_key || 1)}
                                    label="Storage"
                                />
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

function BucketCard({ bucket, onDeleted }) {
    const { bucket_uid, created_at, file_count, used_bytes, tasks } = bucket;
    const shortUid = bucket_uid.length > 18 ? bucket_uid.slice(0, 8) + "…" + bucket_uid.slice(-6) : bucket_uid;
    const [showTasks, setShowTasks] = useState(false);

    const handleDelete = async () => {
        await apiFetch(`/management/storage/bucket/${encodeURIComponent(bucket_uid)}`, { method: "DELETE" });
        onDeleted();
    };

    return (
        <div className="card" style={{ padding: "10px 14px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                        <code style={{ fontSize: "0.82rem" }}>{shortUid}</code>
                        <Chip>{file_count} file{file_count !== 1 ? "s" : ""}</Chip>
                        <Chip>{fmtBytes(used_bytes)}</Chip>
                        {tasks?.length > 0 && (
                            <button
                                onClick={() => setShowTasks(s => !s)}
                                style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}
                            >
                                <Chip style={{ background: "color-mix(in srgb, var(--primary) 15%, transparent)", color: "var(--primary)", cursor: "pointer" }}>
                                    {tasks.length} task{tasks.length !== 1 ? "s" : ""} {showTasks ? "▲" : "▼"}
                                </Chip>
                            </button>
                        )}
                    </div>
                    <div style={{ fontSize: "0.75rem", color: "var(--muted)", marginTop: "3px" }}>
                        Created {fmtDate(created_at)}
                    </div>
                </div>
                <ExpandableDeleteButton onDelete={handleDelete} itemName={shortUid} />
            </div>
            {showTasks && tasks?.length > 0 && (
                <div style={{ marginTop: "8px", display: "flex", flexDirection: "column", gap: "3px" }}>
                    <div style={{ fontSize: "0.70rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: ".4px", color: "var(--muted)", marginBottom: "2px" }}>Tasks</div>
                    {tasks.map(taskId => (
                        <code key={taskId} style={{ fontSize: "0.75rem", background: "var(--code-bg)", padding: "3px 8px", borderRadius: "6px", wordBreak: "break-all" }}>{taskId}</code>
                    ))}
                </div>
            )}
        </div>
    );
}

function KeySection({ apiKey, group, onReload }) {
    const [expanded, setExpanded] = useState(false);
    const shortKey = apiKey.length > 20 ? apiKey.slice(0, 12) + "…" + apiKey.slice(-6) : apiKey;

    const handleDeleteAll = async () => {
        await apiFetch(`/management/storage/key/${encodeURIComponent(apiKey)}/buckets`, { method: "DELETE" });
        onReload();
    };

    return (
        <li className="card">
            <button className="row" onClick={() => setExpanded(s => !s)}>
                <span style={{ color: "var(--muted)", flexShrink: 0 }}>
                    {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                </span>
                <span className="row-main">
                    <span className="row-title mono" style={{ fontSize: "0.88rem" }}>{shortKey}</span>
                    <span className="row-sub">
                        <Chip>{group.bucket_count} bucket{group.bucket_count !== 1 ? "s" : ""}</Chip>
                        <Chip>{group.total_files} file{group.total_files !== 1 ? "s" : ""}</Chip>
                        <Chip>{fmtBytes(group.total_bytes)}</Chip>
                    </span>
                </span>
                <span className="row-actions" onClick={e => e.stopPropagation()}>
                    <ExpandableDeleteButton onDelete={handleDeleteAll} itemName={`all buckets for ${shortKey}`} />
                </span>
            </button>

            <AnimatePresence initial={false}>
                {expanded && (
                    <motion.div
                        className="expand"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ type: "spring", stiffness: 120, damping: 18 }}
                    >
                        <div style={{ padding: "8px 14px 14px", display: "flex", flexDirection: "column", gap: "8px", borderTop: "1px solid var(--border)" }}>
                            <div style={{ fontSize: "0.70rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: ".4px", color: "var(--muted)", marginBottom: "2px" }}>
                                Full key
                            </div>
                            <code style={{ fontSize: "0.78rem", wordBreak: "break-all", background: "var(--code-bg)", padding: "6px 10px", borderRadius: "8px" }}>{apiKey}</code>
                            <div style={{ fontSize: "0.70rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: ".4px", color: "var(--muted)", marginTop: "4px" }}>
                                Buckets
                            </div>
                            {(group.buckets || []).map(b => (
                                <BucketCard key={b.bucket_uid} bucket={b} apiKey={apiKey} onDeleted={onReload} />
                            ))}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </li>
    );
}

function StoragePage() {
    const [buckets, setBuckets] = useState(null);
    const [quotas, setQuotas] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    const load = useCallback(async () => {
        setLoading(true); setError("");
        try {
            const [b, q] = await Promise.all([
                apiFetch("/management/storage/buckets"),
                apiFetch("/management/storage/quotas"),
            ]);
            setBuckets(b);
            setQuotas(q);
        } catch (e) {
            setError(e.message || String(e));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    const handlePurgeAll = useCallback(async () => {
        await apiFetch("/management/storage/buckets", { method: "DELETE" });
        await load();
    }, [load]);

    const keyEntries = Object.entries(buckets?.buckets_by_key || {});

    return (
        <div className="page">
            <div className="page-head">
                <div className="title">Storage</div>
                <div className="actions">
                    <ExpandableDeleteButton onDelete={handlePurgeAll} itemName="all buckets" customActionText="Purge all" />
                    <button className="btn" onClick={load}><RefreshCw /><span>Refresh</span></button>
                </div>
            </div>

            {error && <Banner kind="error">{error}</Banner>}

            {loading ? (
                <div className="loader" aria-busy="true">Loading…</div>
            ) : (
                <>
                    <QuotasPanel quotas={quotas} />

                    {keyEntries.length === 0 ? (
                        <div style={{ color: "var(--muted)", fontStyle: "italic", padding: "8px 0" }}>No buckets found.</div>
                    ) : (
                        <ul className="list">
                            {keyEntries.map(([key, group]) => (
                                <KeySection key={key} apiKey={key} group={group} onReload={load} />
                            ))}
                        </ul>
                    )}
                </>
            )}
        </div>
    );
}

export default StoragePage;
