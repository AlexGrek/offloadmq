import { useState, useEffect } from 'react';
import { fetchOnlineCapabilities, stripCapabilityAttrs } from '../utils';

/**
 * Hook to fetch online capabilities filtered by a prefix (e.g. "llm.", "shell", "imggen.").
 * Optionally auto-selects the first capability as the model (stripping the prefix).
 *
 * @param {string} prefix - Capability prefix to filter by (e.g. "llm.", "shell", "imggen.")
 * @param {object} [options]
 * @param {function} [options.setModel] - Setter to auto-select the first model (prefix stripped)
 * @param {function} [options.setError] - Setter to report fetch errors
 * @returns {[Array, Function]} - [capabilities, setCapabilities]
 */
export function useCapabilities(prefix, { setModel, setError } = {}) {
  const [capabilities, setCapabilities] = useState([]);

  useEffect(() => {
    const load = async () => {
      try {
        const data = await fetchOnlineCapabilities();
        if (Array.isArray(data)) {
          const filtered = data.filter((cap) => {
            try {
              return typeof cap === 'string' && stripCapabilityAttrs(cap).startsWith(prefix);
            } catch {
              return false;
            }
          });
          setCapabilities(filtered);
          if (filtered.length > 0 && setModel) {
            setModel(prev => prev || stripCapabilityAttrs(filtered[0]).replace(new RegExp(`^${prefix.replace(/\./g, '\\.')}`), ''));
          }
        }
      } catch (err) {
        setError?.(`Failed to fetch capabilities: ${err.message}`);
      }
    };
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return [capabilities, setCapabilities];
}
