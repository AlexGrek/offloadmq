import { useEffect, useRef, useState } from "react";

import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";

// ── Shell script extract / inject ────────────────────────────────────────────

function extractScript(yaml: string): string {
  const m = yaml.match(/^script:\s*\|[-+]?\s*\n((?:(?:[ \t]+[^\n]*)?\n)*)/m);
  if (!m) return "";
  const lines = m[1].split("\n");
  const indents = lines
    .filter((l) => l.trim().length > 0)
    .map((l) => (l.match(/^(\s*)/) ?? ["", ""])[1].length);
  const indent = indents.length ? Math.min(...indents) : 2;
  return lines
    .map((l) => (l.length >= indent ? l.slice(indent) : l))
    .join("\n")
    .replace(/\n+$/, "");
}

function injectScript(yaml: string, script: string): string {
  const indented = script
    .split("\n")
    .map((l) => "  " + l)
    .join("\n");
  const replacement = `script: |\n${indented}\n`;
  if (/^script:\s*\|/m.test(yaml)) {
    return yaml.replace(/^script:\s*\|[-+]?\s*\n((?:(?:[ \t]+[^\n]*)?\n)*)/m, replacement);
  }
  if (/^script:/m.test(yaml)) {
    return yaml.replace(/^script:.*$/m, replacement.trimEnd());
  }
  return yaml.trimEnd() + "\n" + replacement;
}

function isShellType(yaml: string): boolean {
  return /^type:\s*shell/m.test(yaml);
}

// ── Templates ─────────────────────────────────────────────────────────────────

const SHELL_TEMPLATE = `name: my-cap
type: shell
description: Shell script custom cap
script: |
  #!/bin/bash
  set -euo pipefail
  echo "Hello from \${CUSTOM_NAME}"
params:
  - name: name
    type: string
    default: World
timeout: 120
`;

const LLM_TEMPLATE = `name: my-llm-cap
type: llm
description: LLM prompt custom cap
model: mistral:7b
prompt: |
  Answer the following question in {{style}} style:
  {{question}}
system: You are a helpful assistant.
temperature: 0.7
max_tokens: 512
params:
  - name: question
    type: text
  - name: style
    type: string
    default: concise
`;

// ── Types ─────────────────────────────────────────────────────────────────────

type CustomCap = {
  name: string;
  capability: string;
  type: string;
  description: string;
  params: { name: string; type: string }[];
};

// ── Page ──────────────────────────────────────────────────────────────────────

export function CustomCapsPage() {
  const [caps, setCaps] = useState<CustomCap[]>([]);
  const [yaml, setYaml] = useState("");
  const [scriptContent, setScriptContent] = useState("");
  const [editorTab, setEditorTab] = useState<"yaml" | "script">("yaml");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const editorRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => api.listCustomCaps().then((r) => setCaps(r.caps));

  useEffect(() => { load(); }, []);

  function switchTab(tab: "yaml" | "script") {
    if (tab === "script" && editorTab === "yaml") {
      setScriptContent(extractScript(yaml));
    } else if (tab === "yaml" && editorTab === "script") {
      setYaml((prev) => injectScript(prev, scriptContent));
    }
    setEditorTab(tab);
  }

  function handleScriptChange(val: string) {
    setScriptContent(val);
    setYaml((prev) => injectScript(prev, val));
  }

  const edit = async (name: string) => {
    const { yaml: text } = await api.getCustomCap(name);
    setYaml(text);
    setScriptContent("");
    setEditorTab("yaml");
    setError("");
    setTimeout(() => editorRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
  };

  const save = async () => {
    setError("");
    if (!yaml.trim()) { setError("YAML is empty"); return; }
    setSaving(true);
    try {
      // Extract name from YAML
      const nameMatch = yaml.match(/^name:\s*(\S+)/m);
      const name = nameMatch?.[1] ?? "";
      if (!name) { setError("YAML must contain a `name:` field"); return; }
      await api.saveCustomCap(name, yaml);
      setYaml("");
      setScriptContent("");
      setEditorTab("yaml");
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (name: string) => {
    if (!window.confirm(`Delete custom cap "${name}"?`)) return;
    try {
      await api.deleteCustomCap(name);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const upload = async (file: File) => {
    setError("");
    setSaving(true);
    try {
      await api.uploadCustomCap(file);
      if (fileRef.current) fileRef.current.value = "";
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Custom capabilities</h1>

      {/* Installed list */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Installed</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {caps.length === 0 && (
            <p className="text-sm text-muted-foreground italic">No custom caps installed</p>
          )}
          {caps.map((c) => (
            <div key={c.name} className="rounded-md border p-3 text-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="font-semibold">
                    {c.name}
                    <span className="ml-2 text-xs font-normal text-muted-foreground lowercase">
                      {c.type}
                    </span>
                  </p>
                  {c.description && (
                    <p className="text-xs text-muted-foreground mt-0.5">{c.description}</p>
                  )}
                  <p className="font-mono text-xs text-muted-foreground mt-1">{c.capability}</p>
                  {c.params.length > 0 && (
                    <p className="text-xs text-muted-foreground mt-1">
                      Params: {c.params.map((p) => p.name).join(", ")}
                    </p>
                  )}
                </div>
                <div className="flex gap-1 shrink-0">
                  <Button size="sm" variant="outline" onClick={() => edit(c.name)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => remove(c.name)}>
                    Delete
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Editor */}
      <Card ref={editorRef}>
        <CardHeader>
          <CardTitle className="text-base">Editor</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Tab bar */}
          <div className="flex gap-1 border-b">
            <button
              type="button"
              onClick={() => switchTab("yaml")}
              className={`px-3 py-1.5 text-xs font-medium transition-colors -mb-px ${
                editorTab === "yaml"
                  ? "border-b-2 border-primary text-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              YAML
            </button>
            {isShellType(yaml) && (
              <button
                type="button"
                onClick={() => switchTab("script")}
                className={`px-3 py-1.5 text-xs font-medium transition-colors -mb-px ${
                  editorTab === "script"
                    ? "border-b-2 border-primary text-primary"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Script
              </button>
            )}
          </div>

          {editorTab === "yaml" ? (
            <textarea
              className="min-h-72 w-full rounded-md border bg-background p-3 font-mono text-xs resize-y"
              placeholder={"name: my-cap\ntype: shell\ndescription: ..."}
              value={yaml}
              onChange={(e) => setYaml(e.target.value)}
            />
          ) : (
            <div>
              <p className="text-xs text-muted-foreground mb-1">
                Bash script — changes sync back to YAML automatically
              </p>
              <textarea
                className="min-h-72 w-full rounded-md border bg-background p-3 font-mono text-xs resize-y"
                value={scriptContent}
                onChange={(e) => handleScriptChange(e.target.value)}
              />
            </div>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}

          <div className="flex flex-wrap gap-2">
            <Button disabled={!yaml.trim() || saving} onClick={save}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => { setYaml(SHELL_TEMPLATE); setScriptContent(""); setEditorTab("yaml"); }}
            >
              Shell template
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => { setYaml(LLM_TEMPLATE); setScriptContent(""); setEditorTab("yaml"); }}
            >
              LLM template
            </Button>
            {yaml.trim() && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => { setYaml(""); setScriptContent(""); setEditorTab("yaml"); setError(""); }}
              >
                Clear
              </Button>
            )}
          </div>

          {/* File upload */}
          <div className="border-t pt-4 mt-2">
            <Label className="text-xs text-muted-foreground mb-2 block">
              Or upload a .yaml / .yml file
            </Label>
            <div className="flex gap-2">
              <input
                type="file"
                ref={fileRef}
                accept=".yaml,.yml"
                disabled={saving}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) upload(f);
                }}
                className="flex-1 text-xs file:rounded file:border-0 file:bg-primary file:text-primary-foreground file:text-xs file:font-medium file:px-2 file:py-1 file:mr-2 file:cursor-pointer cursor-pointer"
              />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
