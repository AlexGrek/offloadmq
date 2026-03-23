import React, { useEffect, useState } from "react";
import { Check, Copy, Key } from "lucide-react";
import { TOKEN_KEY } from "../utils";
import Banner from "./Banner";

function TokenSettingsPage() {
  const [token, setToken] = useState("");
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setToken(localStorage.getItem(TOKEN_KEY) || "");
  }, []);

  const save = () => {
    localStorage.setItem(TOKEN_KEY, token);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const onCopy = () => {
    navigator.clipboard.writeText(token);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="page">
      <div className="page-head">
        <div className="title">Management Token</div>
      </div>

      <div className="card pad">
        <div style={{ marginBottom: "1.5rem" }}>
          <p style={{ color: "var(--muted)", marginBottom: "1rem" }}>
            Your management token is used to authenticate requests to the management API.
            Keep this token secure and do not share it publicly.
          </p>
        </div>

        <form className="form" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <div className="form-row">
            <label>Token</label>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <input
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="paste your token here"
                style={{ flex: 1, fontFamily: 'monospace' }}
              />
              <button
                type="button"
                className="btn icon"
                onClick={onCopy}
                title="Copy token"
                style={{ flexShrink: 0 }}
              >
                {copied ? <Check size={16} color="#22c55e" /> : <Copy size={16} />}
              </button>
            </div>
          </div>

          <div className="form-actions">
            <button type="submit" className="btn primary">
              <Check size={16} />
              <span>{saved ? "Saved" : "Save Token"}</span>
            </button>
          </div>
        </form>

        {saved && (
          <Banner kind="success" style={{ marginTop: "1rem" }}>
            Token saved successfully
          </Banner>
        )}
      </div>
    </div>
  );
}

export default TokenSettingsPage;
