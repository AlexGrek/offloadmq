import { useCallback, useRef, useState } from "react";

import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SaveIndicator } from "@/components/SaveIndicator";
import { useDebouncedSave } from "@/hooks/useDebouncedSave";
import { usePoll } from "@/hooks/usePoll";

export function SlavemodePage() {
  const [all, setAll] = useState<string[]>([]);
  const [allowed, setAllowed] = useState<Set<string>>(new Set());
  // Set for the whole window from "user toggled a box" to "save actually
  // landed" so a 3s poll tick in between doesn't clobber the edit with the
  // stale pre-edit server state.
  const dirty = useRef(false);

  const { schedule, status, error } = useDebouncedSave<Set<string>>(async (next) => {
    try {
      // Fetch the other two policy tiers fresh right before saving instead of
      // trusting a cached snapshot from the last poll: /capabilities/policy
      // saves all three tiers atomically, so a stale regular/sensitive
      // snapshot here would silently clobber a concurrent edit made on the
      // Capabilities page (or another tab) in between polls.
      const current = await api.getCapabilitiesState();
      await api.saveCapabilityPolicy({
        regular_disabled: current.tierCaps.regularDisabled,
        sensitive_allowed: current.tierCaps.sensitiveAllowed,
        slavemode_allowed: [...next],
      });
    } finally {
      dirty.current = false;
    }
  }, 200);

  const load = useCallback(async () => {
    const s = await api.getCapabilitiesState();
    setAll(s.tierCaps.slavemodeAll);
    if (dirty.current) return;
    setAllowed(new Set(s.tierCaps.slavemodeAllowed));
  }, []);

  usePoll(load, 3000);

  const apply = (next: Set<string>) => {
    dirty.current = true;
    setAllowed(next);
    schedule(next);
  };

  const toggle = (cap: string) => {
    const next = new Set(allowed);
    if (next.has(cap)) next.delete(cap);
    else next.add(cap);
    apply(next);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Slavemode</h1>
        <div className="flex items-center gap-2">
          <SaveIndicator status={status} error={error} />
          <Button variant="outline" onClick={() => apply(new Set(all))}>
            Allow all
          </Button>
          <Button variant="outline" onClick={() => apply(new Set())}>
            Deny all
          </Button>
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
