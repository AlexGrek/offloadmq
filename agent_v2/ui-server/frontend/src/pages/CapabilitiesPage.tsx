import { useCallback, useState } from "react";

import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { usePoll } from "@/hooks/usePoll";
import type { CapabilitiesState } from "@/types";

function CapList({
  title,
  caps,
  selected,
  onToggle,
  mode,
}: {
  title: string;
  caps: string[];
  selected: Set<string>;
  onToggle: (cap: string) => void;
  mode: "opt-out" | "opt-in";
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 max-h-64 overflow-y-auto">
        {caps.length === 0 && (
          <p className="text-sm text-muted-foreground">None detected</p>
        )}
        {caps.map((cap) => {
          const checked =
            mode === "opt-out" ? !selected.has(cap) : selected.has(cap);
          return (
            <label key={cap} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={checked}
                onChange={() => onToggle(cap)}
              />
              <span className="font-mono text-xs">{cap}</span>
            </label>
          );
        })}
      </CardContent>
    </Card>
  );
}

export function CapabilitiesPage() {
  const [state, setState] = useState<CapabilitiesState | null>(null);
  const [regularDisabled, setRegularDisabled] = useState<Set<string>>(new Set());
  const [sensitiveAllowed, setSensitiveAllowed] = useState<Set<string>>(
    new Set()
  );

  const load = useCallback(async () => {
    const s = await api.getCapabilitiesState();
    setState(s);
    setRegularDisabled(new Set(s.tierCaps.regularDisabled));
    setSensitiveAllowed(new Set(s.tierCaps.sensitiveAllowed));
  }, []);

  usePoll(load, 3000);

  const save = async () => {
    await api.saveCapabilityPolicy({
      regular_disabled: [...regularDisabled],
      sensitive_allowed: [...sensitiveAllowed],
      slavemode_allowed: state?.tierCaps.slavemodeAllowed ?? [],
    });
    await load();
  };

  const rescan = async (restart: boolean) => {
    await api.rescanCapabilities(restart);
    await load();
  };

  if (!state) return <p className="text-muted-foreground">Loading…</p>;

  const toggleRegular = (cap: string) => {
    setRegularDisabled((prev) => {
      const next = new Set(prev);
      if (next.has(cap)) next.delete(cap);
      else next.add(cap);
      return next;
    });
  };

  const toggleSensitive = (cap: string) => {
    setSensitiveAllowed((prev) => {
      const next = new Set(prev);
      if (next.has(cap)) next.delete(cap);
      else next.add(cap);
      return next;
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Capabilities</h1>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => rescan(false)}>
            Rescan
          </Button>
          <Button variant="outline" onClick={() => rescan(true)}>
            Rescan + restart
          </Button>
          <Button onClick={save}>Save policy</Button>
        </div>
      </div>
      {state.scanning && (
        <p className="text-sm text-muted-foreground">Scanning…</p>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        <CapList
          title="Regular (opt-out)"
          caps={state.tierCaps.regular}
          selected={regularDisabled}
          onToggle={toggleRegular}
          mode="opt-out"
        />
        <CapList
          title="Sensitive (opt-in)"
          caps={state.tierCaps.sensitive}
          selected={sensitiveAllowed}
          onToggle={toggleSensitive}
          mode="opt-in"
        />
      </div>
    </div>
  );
}
