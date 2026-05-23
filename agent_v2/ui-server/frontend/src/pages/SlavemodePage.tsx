import { useCallback, useState } from "react";

import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { usePoll } from "@/hooks/usePoll";

export function SlavemodePage() {
  const [all, setAll] = useState<string[]>([]);
  const [allowed, setAllowed] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    const s = await api.getCapabilitiesState();
    setAll(s.tierCaps.slavemodeAll);
    setAllowed(new Set(s.tierCaps.slavemodeAllowed));
  }, []);

  usePoll(load, 3000);

  const toggle = (cap: string) => {
    setAllowed((prev) => {
      const next = new Set(prev);
      if (next.has(cap)) next.delete(cap);
      else next.add(cap);
      return next;
    });
  };

  const save = async () => {
    const s = await api.getCapabilitiesState();
    await api.saveCapabilityPolicy({
      regular_disabled: s.tierCaps.regularDisabled,
      sensitive_allowed: s.tierCaps.sensitiveAllowed,
      slavemode_allowed: [...allowed],
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Slavemode</h1>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setAllowed(new Set(all))}>
            Allow all
          </Button>
          <Button variant="outline" onClick={() => setAllowed(new Set())}>
            Deny all
          </Button>
          <Button onClick={save}>Save</Button>
        </div>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Control capabilities (opt-in)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {all.map((cap) => (
            <label key={cap} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={allowed.has(cap)}
                onChange={() => toggle(cap)}
              />
              <span className="font-mono text-xs">{cap}</span>
            </label>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
