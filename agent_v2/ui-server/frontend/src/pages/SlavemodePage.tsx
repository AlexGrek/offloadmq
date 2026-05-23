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
  const other = useRef<{ regular: string[]; sensitive: string[] }>({
    regular: [],
    sensitive: [],
  });

  const { schedule, status } = useDebouncedSave<Set<string>>(
    (next) =>
      api.saveCapabilityPolicy({
        regular_disabled: other.current.regular,
        sensitive_allowed: other.current.sensitive,
        slavemode_allowed: [...next],
      }),
    200
  );

  const load = useCallback(async () => {
    const s = await api.getCapabilitiesState();
    setAll(s.tierCaps.slavemodeAll);
    setAllowed(new Set(s.tierCaps.slavemodeAllowed));
    other.current = {
      regular: s.tierCaps.regularDisabled,
      sensitive: s.tierCaps.sensitiveAllowed,
    };
  }, []);

  usePoll(load, 3000);

  const apply = (next: Set<string>) => {
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
          <SaveIndicator status={status} />
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
