import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Check, Trash } from "lucide-react";
import ExpandableDeleteButton from "./ExpandableDeleteButton";
import { TOKEN_KEY } from "../utils";
import Banner from "./Banner";

function SettingsPage() {
  const [token, setToken] = useState("");
  useEffect(() => { setToken(localStorage.getItem(TOKEN_KEY) || ""); }, []);
  const save = () => { localStorage.setItem(TOKEN_KEY, token); };

  return (
    <div className="page">
      <div className="page-head">
        <div className="title">Settings</div>
      </div>
      <div className="card form">
        <div className="form-row">
          <label>Management Token</label>
          <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="paste your token here" />
        </div>
        <div className="form-actions">
          <button className="btn primary" onClick={save}><Check /> <span>Save</span></button>
        </div>
      </div>
      {!token && (
        <Banner kind="warn">No token set. Go to Settings and paste your token to authorize requests.</Banner>
      )}
    </div>
  );
}

export default SettingsPage;