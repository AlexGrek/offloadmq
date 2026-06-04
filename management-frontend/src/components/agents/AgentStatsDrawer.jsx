import React, { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, BarChart2, RefreshCw } from "lucide-react";
import {
    BarChart,
    Bar,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    Legend,
    ResponsiveContainer,
} from "recharts";
import { apiFetch } from "../../utils";

const HOURS_TO_SHOW = 24;

function bucketByHour(records) {
    if (!records || records.length === 0) return [];

    const now = new Date();
    const buckets = {};

    // Pre-fill the last N hours so gaps show as zero
    for (let i = HOURS_TO_SHOW - 1; i >= 0; i--) {
        const d = new Date(now);
        d.setHours(d.getHours() - i, 0, 0, 0);
        const key = d.toISOString().slice(0, 13); // "2026-06-04T14"
        buckets[key] = { hour: formatHourLabel(d), success: 0, failure: 0 };
    }

    for (const r of records) {
        const key = new Date(r.completedAt).toISOString().slice(0, 13);
        if (buckets[key]) {
            if (r.success) buckets[key].success++;
            else buckets[key].failure++;
        }
    }

    return Object.values(buckets);
}

function formatHourLabel(date) {
    return new Intl.DateTimeFormat(undefined, { hour: "2-digit", hour12: false }).format(date) + "h";
}

function CustomTooltip({ active, payload, label }) {
    if (!active || !payload?.length) return null;
    return (
        <div style={{
            background: "var(--glass)",
            border: "1px solid var(--border)",
            borderRadius: "8px",
            padding: "8px 12px",
            fontSize: "12px",
        }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{label}</div>
            {payload.map(p => (
                <div key={p.name} style={{ color: p.fill }}>
                    {p.name}: <b>{p.value}</b>
                </div>
            ))}
        </div>
    );
}

export default function AgentStatsDrawer({ agent, onClose }) {
    const [records, setRecords] = useState(null);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(false);

    const load = React.useCallback(async () => {
        if (!agent) return;
        setLoading(true);
        setError(null);
        try {
            const data = await apiFetch(
                `/management/heuristics/records?runner_id=${encodeURIComponent(agent.uid)}&limit=2000`
            );
            setRecords(Array.isArray(data) ? data : (data?.records ?? []));
        } catch (e) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    }, [agent]);

    useEffect(() => {
        load();
    }, [load]);

    const chartData = records ? bucketByHour(records) : [];
    const totalSuccess = records ? records.filter(r => r.success).length : 0;
    const totalFail = records ? records.filter(r => !r.success).length : 0;

    return (
        <AnimatePresence>
            {agent && (
                <>
                    {/* Backdrop */}
                    <motion.div
                        key="backdrop"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={onClose}
                        style={{
                            position: "fixed", inset: 0,
                            background: "rgba(0,0,0,0.45)",
                            zIndex: 900,
                        }}
                    />

                    {/* Drawer */}
                    <motion.div
                        key="drawer"
                        initial={{ x: "100%" }}
                        animate={{ x: 0 }}
                        exit={{ x: "100%" }}
                        transition={{ type: "spring", stiffness: 320, damping: 32 }}
                        style={{
                            position: "fixed", top: 0, right: 0, bottom: 0,
                            width: "min(580px, 100vw)",
                            background: "var(--bg)",
                            borderLeft: "1px solid var(--border)",
                            zIndex: 901,
                            display: "flex",
                            flexDirection: "column",
                            overflow: "hidden",
                        }}
                    >
                        {/* Header */}
                        <div style={{
                            display: "flex", alignItems: "center", gap: "10px",
                            padding: "14px 18px",
                            borderBottom: "1px solid var(--border)",
                            flexShrink: 0,
                        }}>
                            <BarChart2 size={18} style={{ color: "var(--primary)" }} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontWeight: 700, fontSize: "15px" }}>Runner Stats</div>
                                <div style={{ fontSize: "11px", color: "var(--muted)", fontFamily: "monospace" }}>
                                    {agent.displayName || agent.uidShort || agent.uid}
                                </div>
                            </div>
                            <button
                                onClick={load}
                                disabled={loading}
                                title="Refresh"
                                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", padding: "4px" }}
                            >
                                <RefreshCw size={15} style={{ animation: loading ? "spin 1s linear infinite" : "none" }} />
                            </button>
                            <button
                                onClick={onClose}
                                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", padding: "4px" }}
                            >
                                <X size={18} />
                            </button>
                        </div>

                        {/* Body */}
                        <div style={{ flex: 1, overflow: "auto", padding: "18px" }}>
                            {error && (
                                <div style={{
                                    padding: "10px 14px", borderRadius: "8px",
                                    background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)",
                                    color: "#ef4444", fontSize: "13px", marginBottom: "16px",
                                }}>
                                    {error}
                                </div>
                            )}

                            {/* Summary chips */}
                            {records && (
                                <div style={{ display: "flex", gap: "10px", marginBottom: "20px", flexWrap: "wrap" }}>
                                    <Stat label="Total runs" value={records.length} />
                                    <Stat label="Successes" value={totalSuccess} color="#22c55e" />
                                    <Stat label="Failures" value={totalFail} color="#ef4444" />
                                    {records.length > 0 && (
                                        <Stat
                                            label="Success rate"
                                            value={`${((totalSuccess / records.length) * 100).toFixed(1)}%`}
                                            color={totalSuccess / records.length >= 0.8 ? "#22c55e" : "#f59e0b"}
                                        />
                                    )}
                                </div>
                            )}

                            {/* Chart */}
                            <div style={{ marginBottom: "8px" }}>
                                <div style={{
                                    fontSize: "11px", fontWeight: 600, textTransform: "uppercase",
                                    letterSpacing: "0.06em", color: "var(--muted)", marginBottom: "12px",
                                }}>
                                    Runs per hour — last {HOURS_TO_SHOW}h
                                </div>
                                {loading && !records ? (
                                    <div style={{ textAlign: "center", color: "var(--muted)", padding: "40px 0", fontSize: "13px" }}>
                                        Loading…
                                    </div>
                                ) : chartData.length === 0 ? (
                                    <div style={{ textAlign: "center", color: "var(--muted)", padding: "40px 0", fontSize: "13px" }}>
                                        No records found for this runner.
                                    </div>
                                ) : (
                                    <ResponsiveContainer width="100%" height={260}>
                                        <BarChart data={chartData} margin={{ top: 4, right: 10, left: -20, bottom: 0 }}>
                                            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                                            <XAxis
                                                dataKey="hour"
                                                tick={{ fontSize: 11, fill: "var(--muted)" }}
                                                interval="preserveStartEnd"
                                            />
                                            <YAxis
                                                allowDecimals={false}
                                                tick={{ fontSize: 11, fill: "var(--muted)" }}
                                            />
                                            <Tooltip content={<CustomTooltip />} />
                                            <Legend
                                                wrapperStyle={{ fontSize: 12 }}
                                                formatter={(value) => (
                                                    <span style={{ color: "var(--text)" }}>{value}</span>
                                                )}
                                            />
                                            <Bar dataKey="success" name="Success" fill="#22c55e" radius={[3, 3, 0, 0]} maxBarSize={32} />
                                            <Bar dataKey="failure" name="Failure" fill="#ef4444" radius={[3, 3, 0, 0]} maxBarSize={32} />
                                        </BarChart>
                                    </ResponsiveContainer>
                                )}
                            </div>

                            {/* Per-capability breakdown */}
                            {records && records.length > 0 && (
                                <CapabilityBreakdown records={records} />
                            )}
                        </div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
}

function Stat({ label, value, color }) {
    return (
        <div style={{
            padding: "8px 14px",
            borderRadius: "8px",
            border: "1px solid var(--border)",
            background: "var(--glass)",
        }}>
            <div style={{ fontSize: "11px", color: "var(--muted)" }}>{label}</div>
            <div style={{ fontWeight: 700, fontSize: "18px", color: color || "var(--text)" }}>{value}</div>
        </div>
    );
}

function CapabilityBreakdown({ records }) {
    const byCapability = {};
    for (const r of records) {
        const cap = r.capability || "unknown";
        if (!byCapability[cap]) byCapability[cap] = { success: 0, failure: 0 };
        if (r.success) byCapability[cap].success++;
        else byCapability[cap].failure++;
    }

    const rows = Object.entries(byCapability).sort((a, b) => {
        const ta = a[1].success + a[1].failure;
        const tb = b[1].success + b[1].failure;
        return tb - ta;
    });

    if (rows.length === 0) return null;

    return (
        <div style={{ marginTop: "24px" }}>
            <div style={{
                fontSize: "11px", fontWeight: 600, textTransform: "uppercase",
                letterSpacing: "0.06em", color: "var(--muted)", marginBottom: "10px",
            }}>
                By capability
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                {rows.map(([cap, counts]) => {
                    const total = counts.success + counts.failure;
                    const pct = total > 0 ? (counts.success / total) * 100 : 0;
                    return (
                        <div key={cap} style={{
                            padding: "8px 12px",
                            borderRadius: "7px",
                            border: "1px solid var(--border)",
                            background: "var(--glass)",
                        }}>
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "5px" }}>
                                <code style={{ fontSize: "11px" }}>{cap}</code>
                                <span style={{ fontSize: "11px", color: "var(--muted)" }}>{total} runs</span>
                            </div>
                            {/* Mini stacked bar */}
                            <div style={{ height: 6, borderRadius: 3, overflow: "hidden", background: "#ef444433", display: "flex" }}>
                                <div style={{ width: `${pct}%`, background: "#22c55e", transition: "width 0.4s" }} />
                            </div>
                            <div style={{ display: "flex", gap: "12px", marginTop: "4px", fontSize: "11px" }}>
                                <span style={{ color: "#22c55e" }}>{counts.success} ok</span>
                                <span style={{ color: "#ef4444" }}>{counts.failure} fail</span>
                                <span style={{ color: "var(--muted)", marginLeft: "auto" }}>{pct.toFixed(1)}%</span>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
