import React, { useState } from "react";
import { AlertCircle, Check, Loader, Zap } from "lucide-react";
import { apiFetch } from "../utils";

function BackgroundJobTriggersPage() {
  const [storageLoading, setStorageLoading] = useState(false);
  const [storageResult, setStorageResult] = useState(null);
  const [storageError, setStorageError] = useState(null);

  const [heuristicsLoading, setHeuristicsLoading] = useState(false);
  const [heuristicsResult, setHeuristicsResult] = useState(null);
  const [heuristicsError, setHeuristicsError] = useState(null);

  const triggerStorage = async () => {
    setStorageLoading(true);
    setStorageError(null);
    setStorageResult(null);
    try {
      const result = await apiFetch("/management/storage/cleanup/trigger", {
        method: "POST",
      });
      setStorageResult(result);
    } catch (err) {
      setStorageError(err.message || "Failed to trigger storage cleanup");
    } finally {
      setStorageLoading(false);
    }
  };

  const triggerHeuristics = async () => {
    setHeuristicsLoading(true);
    setHeuristicsError(null);
    setHeuristicsResult(null);
    try {
      const result = await apiFetch("/management/heuristics/cleanup/trigger", {
        method: "POST",
      });
      setHeuristicsResult(result);
    } catch (err) {
      setHeuristicsError(err.message || "Failed to trigger heuristics cleanup");
    } finally {
      setHeuristicsLoading(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div className="title">Background Job Triggers</div>
      </div>

      {/* Storage Cleanup */}
      <div className="card">
        <div className="trigger-header">
          <div className="trigger-info">
            <h3>Storage Cleanup</h3>
            <p className="trigger-description">
              Immediately run the expired-bucket cleanup job. Deletes buckets
              past their TTL and removes their files from the storage backend.
            </p>
            <div className="trigger-details">
              <span>Runs automatically: every 3 hours</span>
            </div>
          </div>
          <button
            className="btn primary"
            onClick={triggerStorage}
            disabled={storageLoading}
          >
            {storageLoading ? (
              <>
                <Loader size={16} className="spin" />
                <span>Running...</span>
              </>
            ) : (
              <>
                <Zap size={16} />
                <span>Trigger Now</span>
              </>
            )}
          </button>
        </div>

        {storageError && (
          <div className="result error">
            <AlertCircle size={16} />
            <span>{storageError}</span>
          </div>
        )}

        {storageResult && (
          <div className="result success">
            <Check size={16} />
            <div className="result-content">
              <span className="result-title">Cleanup completed</span>
              <div className="result-details">
                <div className="detail-item">
                  <span className="detail-label">Buckets deleted:</span>
                  <span className="detail-value">{storageResult.deleted_count}</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Heuristics Cleanup */}
      <div className="card">
        <div className="trigger-header">
          <div className="trigger-info">
            <h3>Heuristics Cleanup</h3>
            <p className="trigger-description">
              Immediately run the heuristic record cleanup job. Deletes old
              records and enforces per-runner-capability limits.
            </p>
            <div className="trigger-details">
              <span>Runs automatically: every 16–22 hours</span>
            </div>
          </div>
          <button
            className="btn primary"
            onClick={triggerHeuristics}
            disabled={heuristicsLoading}
          >
            {heuristicsLoading ? (
              <>
                <Loader size={16} className="spin" />
                <span>Running...</span>
              </>
            ) : (
              <>
                <Zap size={16} />
                <span>Trigger Now</span>
              </>
            )}
          </button>
        </div>

        {heuristicsError && (
          <div className="result error">
            <AlertCircle size={16} />
            <span>{heuristicsError}</span>
          </div>
        )}

        {heuristicsResult && (
          <div className="result success">
            <Check size={16} />
            <div className="result-content">
              <span className="result-title">Cleanup completed</span>
              <div className="result-details">
                <div className="detail-item">
                  <span className="detail-label">Deleted by age:</span>
                  <span className="detail-value">{heuristicsResult.deleted_by_age}</span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Deleted by limit:</span>
                  <span className="detail-value">{heuristicsResult.deleted_by_limit}</span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">TTL (days):</span>
                  <span className="detail-value">{heuristicsResult.ttl_days}</span>
                </div>
                <div className="detail-item">
                  <span className="detail-label">Max records per runner/cap:</span>
                  <span className="detail-value">{heuristicsResult.max_records_per_runner_cap}</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default BackgroundJobTriggersPage;
