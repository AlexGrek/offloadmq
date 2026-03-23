import React, { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Check, Settings2 } from "lucide-react";
import { TOKEN_KEY } from "../utils";

function TokenSettings() {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [saved, setSaved] = useState(false);
  const popoverRef = useRef(null);

  useEffect(() => {
    setToken(localStorage.getItem(TOKEN_KEY) || "");
  }, []);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [open]);

  const save = () => {
    localStorage.setItem(TOKEN_KEY, token);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="token-settings" ref={popoverRef}>
      <button
        className="icon"
        onClick={() => setOpen(!open)}
        aria-label="Settings"
      >
        <Settings2 size={18} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            className="settings-popover"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.15 }}
          >
            <div className="form">
              <div className="form-row">
                <label>Management Token</label>
                <input
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="paste your token here"
                />
              </div>
              <div className="form-actions">
                <button className="btn primary" onClick={save}>
                  <Check size={16} />
                  <span>{saved ? "Saved" : "Save"}</span>
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default TokenSettings;
