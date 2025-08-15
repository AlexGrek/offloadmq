// ----- API Keys Page -----

import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { KeySquare, RefreshCw, Trash } from "lucide-react";
import ExpandableDeleteButton from "./ExpandableDeleteButton";
import { apiFetch, fmtDate } from "../utils";
import Banner from "./Banner";
import Chip from "./Chip";

function ApiKeysPage() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [keyVal, setKeyVal] = useState("");
  const [caps, setCaps] = useState("");

  const load = async () => {
    setLoading(true); setError("");
    try {
      const data = await apiFetch("/management/client_api_keys/list");
      setItems(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const onCreate = async (e) => {
    e.preventDefault();
    const capabilities = caps.split(",").map(s => s.trim()).filter(Boolean);
    try {
      await apiFetch("/management/client_api_keys/update", {
        method: "POST",
        body: JSON.stringify({ key: keyVal, capabilities })
      });
      setKeyVal(""); setCaps("");
      await load();
    } catch (e) { alert(`Failed to create: ${e.message}`); }
  };

  const onRevoke = async (key) => {
    try {
      await apiFetch(`/management/client_api_keys/revoke/${encodeURIComponent(key)}`, { method: "POST" });
      await load();
    } catch (e) { alert(`Failed to revoke: ${e.message}`); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div className="title">API Keys</div>
        <div className="actions"><button className="btn" onClick={load}><RefreshCw /> <span>Refresh</span></button></div>
      </div>

      <form className="card form" onSubmit={onCreate}>
        <div className="form-row">
          <label>Key</label>
          <input value={keyVal} onChange={(e) => setKeyVal(e.target.value)} placeholder="my-app-key-123" required />
        </div>
        <div className="form-row">
          <label>Capabilities</label>
          <input value={caps} onChange={(e) => setCaps(e.target.value)} placeholder="capA, capB, capC" />
        </div>
        <div className="form-actions"><button className="btn primary" type="submit"><KeySquare /> <span>Create / Update</span></button></div>
      </form>

      {error && <Banner kind="error">{error}</Banner>}

      {loading ? (
        <div className="loader" aria-busy="true">Loading…</div>
      ) : (
        <ul className="list">
          {items.map((it) => (
            <li key={it.key} className="card">
              <div className="row">
                <div className="row-main">
                  <div className="row-title mono" title={it.key}>{it.key}</div>
                  <div className="row-sub">
                    <Chip>{it.isPredefined ? "predefined" : "custom"}</Chip>
                    <Chip>{it.isRevoked ? "revoked" : "active"}</Chip>
                    <Chip>created {fmtDate(it.created)}</Chip>
                  </div>
                </div>
                <div className="row-actions">
                  <ExpandableDeleteButton onDelete={() => onRevoke(it.key)} disabled={it.isRevoked} customActionText="Revoke" itemName={it.key} />
                </div>
              </div>
              {(it.capabilities || []).length > 0 && (
                <div className="pad">
                  <div className="section-title">Capabilities</div>
                  <div className="chips-wrap">{it.capabilities.map((c, i) => (<Chip key={i}>{c}</Chip>))}</div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default ApiKeysPage;