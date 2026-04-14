import React, { useState } from "react";
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronUp, Layers, Gauge, Cpu, Clock, Fingerprint, SquareArrowRight } from "lucide-react";
import { fmtDate, stripCapabilityAttrs, parseCapabilityAttrs } from "../../utils";
import Chip from "../Chip";
import AttributeTag from "../AttributeTag";
import ColorDot from "../ColorDot";
import ExpandableDeleteButton from "../ExpandableDeleteButton";
import ForceRescanButton from "./ForceRescanButton";
import OllamaManagerModal from "./OllamaManagerModal";
import OnnxManagerModal from "./OnnxManagerModal";
import SpecialCapsModal from "./SpecialCapsModal";

function relativeTime(iso) {
    if (!iso) return 'Never';
    const diff = Math.round((new Date(iso) - Date.now()) / 60000);
    return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(diff, 'minute');
}

function KV({ label, value, mono }) {
    if (value == null || value === '') return null;
    return (
        <div style={{ display: 'flex', gap: '6px', fontSize: '12px', marginBottom: '3px', flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--muted)', flexShrink: 0 }}>{label}:</span>
            {mono
                ? <code style={{ fontSize: '11px', wordBreak: 'break-all' }}>{value}</code>
                : <b style={{ wordBreak: 'break-word' }}>{value}</b>}
        </div>
    );
}

export default function AgentCard({ a, onDelete, onRescanDone }) {
    const [isOpen, setIsOpen] = useState(false);
    const [capsExpanded, setCapsExpanded] = useState(false);

    const slavemodeCapabilities = (a.capabilities || []).filter(c => stripCapabilityAttrs(c).startsWith('slavemode.'));
    const hasForceRescan = slavemodeCapabilities.some(c => stripCapabilityAttrs(c) === 'slavemode.force-rescan');
    const hasSpecialCapsCtrl = slavemodeCapabilities.some(c => stripCapabilityAttrs(c) === 'slavemode.special-caps-ctrl');
    const hasOllamaList = slavemodeCapabilities.some(c => stripCapabilityAttrs(c) === 'slavemode.ollama-list');
    const hasOllamaDelete = slavemodeCapabilities.some(c => stripCapabilityAttrs(c) === 'slavemode.ollama-delete');
    const hasOllamaPull = slavemodeCapabilities.some(c => stripCapabilityAttrs(c) === 'slavemode.ollama-pull');
    const hasOnnxList = slavemodeCapabilities.some(c => stripCapabilityAttrs(c) === 'slavemode.onnx-models-list');
    const hasOnnxDelete = slavemodeCapabilities.some(c => stripCapabilityAttrs(c) === 'slavemode.onnx-models-delete');
    const hasOnnxPrepare = slavemodeCapabilities.some(c => stripCapabilityAttrs(c) === 'slavemode.onnx-models-prepare');
    const regularCaps = (a.capabilities || []).filter(c => !stripCapabilityAttrs(c).startsWith('slavemode.'));
    const visibleCaps = capsExpanded ? regularCaps : regularCaps.slice(0, 4);

    return (
        <li style={{ borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--glass)', overflow: 'hidden', transition: 'box-shadow 0.15s' }}>
            {/* Header row */}
            <div
                onClick={() => setIsOpen(v => !v)}
                style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 14px', cursor: 'pointer', userSelect: 'none', flexWrap: 'wrap' }}
            >
                <ColorDot seed={a.systemInfo?.machineId || ''} />

                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 600, fontSize: '14px', fontFamily: 'monospace' }}>{a.uidShort || a.uid}</span>
                        {a.displayName && <span style={{ fontSize: '13px', color: 'var(--text)' }}>— {a.displayName}</span>}
                    </div>
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '4px' }}>
                        <Chip><Layers size={10} style={{ marginRight: 3 }} />{a.tier}</Chip>
                        <Chip><Gauge size={10} style={{ marginRight: 3 }} />{a.capacity}</Chip>
                        <Chip><Cpu size={10} style={{ marginRight: 3 }} />{(a.capabilities || []).length}</Chip>
                        {a.appVersion && <Chip>{a.appVersion}</Chip>}
                        {a.systemInfo?.machineId && <Chip><Fingerprint size={10} style={{ marginRight: 3 }} />{a.systemInfo.machineId}</Chip>}
                        {a.lastCommMethod === 'WebSocket' && <Chip variant="websocket">WebSocket</Chip>}
                        <Chip><Clock size={10} style={{ marginRight: 3 }} />{relativeTime(a.lastContact)}</Chip>
                        {hasForceRescan && (
                            <span style={{ display: 'inline-flex', alignItems: 'center', padding: '1px 5px', borderRadius: '4px', background: 'rgba(217,119,6,0.15)', border: '1px solid rgba(217,119,6,0.3)', color: '#f59e0b' }}>
                                <SquareArrowRight size={12} />
                            </span>
                        )}
                    </div>
                </div>

                <div style={{ color: 'var(--muted)', flexShrink: 0 }}>
                    {isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </div>
            </div>

            {/* Expanded details */}
            <AnimatePresence initial={false}>
                {isOpen && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ type: 'spring', stiffness: 120, damping: 18 }}
                        style={{ overflow: 'hidden' }}
                    >
                        <div style={{ borderTop: '1px solid var(--border)', padding: '12px 14px' }}>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px' }}>
                                {/* Identity */}
                                <div>
                                    <div style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)', marginBottom: '6px' }}>Identity</div>
                                    {a.displayName && <KV label="Name" value={a.displayName} />}
                                    <KV label="UID" value={a.uid} mono />
                                    <KV label="Registered" value={fmtDate(a.registeredAt)} />
                                    <KV label="Last contact" value={fmtDate(a.lastContact)} />
                                    {a.appVersion && <KV label="Version" value={a.appVersion} />}
                                    <KV label="Token" value={a.personalLoginToken} mono />
                                </div>

                                {/* System */}
                                <div>
                                    <div style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)', marginBottom: '6px' }}>System</div>
                                    <KV label="OS" value={a.systemInfo?.os} />
                                    <KV label="Client" value={a.systemInfo?.client} />
                                    <KV label="Runtime" value={a.systemInfo?.runtime} />
                                    <KV label="CPU Arch" value={a.systemInfo?.cpuArch} />
                                    {a.systemInfo?.cpuModel && <KV label="CPU" value={a.systemInfo.cpuModel} />}
                                    <KV label="RAM" value={a.systemInfo?.totalMemoryGb != null ? `${a.systemInfo.totalMemoryGb} GB` : null} />
                                    {a.systemInfo?.machineId && <KV label="Machine ID" value={a.systemInfo.machineId} mono />}
                                </div>

                                {/* GPU */}
                                <div>
                                    <div style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)', marginBottom: '6px' }}>GPU</div>
                                    {a.systemInfo?.gpu ? (
                                        <>
                                            <KV label="Vendor" value={a.systemInfo.gpu.vendor} />
                                            <KV label="Model" value={a.systemInfo.gpu.model} />
                                            {!!a.systemInfo.gpu.vramGb && <KV label="VRAM" value={`${a.systemInfo.gpu.vramGb} GB`} />}
                                        </>
                                    ) : (
                                        <span style={{ fontSize: '12px', color: 'var(--muted)' }}>No GPU</span>
                                    )}
                                </div>

                                {/* Capabilities */}
                                <div>
                                    <div style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)', marginBottom: '6px' }}>
                                        Capabilities ({regularCaps.length})
                                    </div>
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                                        {visibleCaps.map((c, i) => {
                                            const base = stripCapabilityAttrs(c);
                                            const attrs = parseCapabilityAttrs(c);
                                            return (
                                                <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                                                    <Chip>{base}</Chip>
                                                    {attrs.length > 0 && (
                                                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px' }}>
                                                            {attrs.map((attr, j) => <AttributeTag key={j} attr={attr} />)}
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                        {regularCaps.length > 4 && (
                                            <button
                                                onClick={e => { e.stopPropagation(); setCapsExpanded(v => !v); }}
                                                style={{ fontSize: '11px', padding: '2px 7px', borderRadius: '4px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--muted)', cursor: 'pointer' }}
                                            >
                                                {capsExpanded ? 'Show less' : `+${regularCaps.length - 4} more`}
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </div>

                            {/* Slavemode section */}
                            {slavemodeCapabilities.length > 0 && (
                                <div style={{ marginTop: '12px', padding: '10px 12px', borderRadius: '7px', background: 'rgba(217,119,6,0.08)', border: '1px solid rgba(217,119,6,0.25)' }}>
                                    <div style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#f59e0b', marginBottom: '8px' }}>
                                        <SquareArrowRight />
                                    </div>
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
                                        {hasForceRescan && <ForceRescanButton onDone={onRescanDone} />}
                                        {hasSpecialCapsCtrl && <SpecialCapsModal agentUid={a.uid} />}
                                        {(hasOllamaList || hasOllamaDelete || hasOllamaPull) && (
                                            <OllamaManagerModal
                                                agentUid={a.uid}
                                                hasList={hasOllamaList}
                                                hasDelete={hasOllamaDelete}
                                                hasPull={hasOllamaPull}
                                            />
                                        )}
                                        {(hasOnnxList || hasOnnxDelete || hasOnnxPrepare) && (
                                            <OnnxManagerModal
                                                agentUid={a.uid}
                                                hasList={hasOnnxList}
                                                hasDelete={hasOnnxDelete}
                                                hasPrepare={hasOnnxPrepare}
                                            />
                                        )}
                                        {slavemodeCapabilities
                                            .filter(c => !['slavemode.force-rescan', 'slavemode.special-caps-ctrl', 'slavemode.ollama-list', 'slavemode.ollama-delete', 'slavemode.ollama-pull', 'slavemode.onnx-models-list', 'slavemode.onnx-models-delete', 'slavemode.onnx-models-prepare'].includes(stripCapabilityAttrs(c)))
                                            .map((c, i) => (
                                                <span key={i} style={{ fontSize: '12px', padding: '2px 8px', borderRadius: '4px', background: 'rgba(217,119,6,0.12)', border: '1px solid rgba(217,119,6,0.3)', color: '#fbbf24', fontFamily: 'monospace' }}>
                                                    {stripCapabilityAttrs(c)}
                                                </span>
                                            ))
                                        }
                                    </div>
                                </div>
                            )}

                            <div style={{ marginTop: '12px', display: 'flex', justifyContent: 'flex-end' }} onClick={e => e.stopPropagation()}>
                                <ExpandableDeleteButton onDelete={() => onDelete(a.uid)} itemName={a.uid} />
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </li>
    );
}
