import { useMemo, useState } from 'react'
import { CapabilityModelPicker, type PickerCapability } from '../CapabilityModelPicker'
import type { ModelOption } from '../../api/personas'

type Props = {
  /** `null` while the options are loading. */
  options: ModelOption[] | null
  /** `null` = automatic. */
  value: string | null
  onChange: (capability: string | null) => void
  /** Label of the automatic entry, e.g. "Auto — llm.x (most used)". */
  autoLabel: string
  onRefresh?: () => void
  testIdPrefix: string
}

/**
 * The shared {@link CapabilityModelPicker} fed from the persona model options
 * (`GET /api/personas/options`), plus an "Auto" entry. A saved preference that is no
 * longer listed stays selectable as an offline model.
 */
export function PersonaModelPicker({ options, value, onChange, autoLabel, onRefresh, testIdPrefix }: Props) {
  // The options carry no last-seen time; offline ones show a fresh amber dot.
  const [seenAt] = useState(() => new Date().toISOString())

  const capabilities = useMemo<PickerCapability[]>(() => {
    const byBase = new Map<string, PickerCapability>()
    const add = (base: string, online: boolean, workflow?: string) => {
      const known = byBase.get(base)
      if (known) {
        if (workflow && !known.tags.includes(workflow)) known.tags.push(workflow)
        known.online ||= online
        return
      }
      byBase.set(base, {
        base,
        raw: base,
        tags: workflow ? [workflow] : [],
        online,
        last_available_at: seenAt,
        usage_count: 0,
      })
    }
    for (const o of options ?? []) add(o.capability, o.online, o.workflow)
    if (options && value && !byBase.has(value)) add(value, false)
    return [...byBase.values()]
  }, [options, value, seenAt])

  return (
    <CapabilityModelPicker
      capabilities={capabilities}
      selected={value ?? ''}
      onSelect={base => onChange(base || null)}
      onRefresh={onRefresh ?? (() => {})}
      capabilitiesStatus={options ? 'ready' : 'loading'}
      capabilitiesError={null}
      autoLabel={autoLabel}
      testIdPrefix={testIdPrefix}
    />
  )
}
