import { json, jsonParseLinter } from "@codemirror/lang-json";
import { linter, lintGutter } from "@codemirror/lint";
import CodeMirror from "@uiw/react-codemirror";

import { cn } from "@/lib/utils";

const extensions = [json(), linter(jsonParseLinter()), lintGutter()];

/** Code-highlighted JSON editor (CodeMirror) with live syntax-error linting. */
export function JsonCodeEditor({
  value,
  onChange,
  minHeight = "240px",
  maxHeight = "480px",
  readOnly = false,
  placeholder,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  minHeight?: string;
  maxHeight?: string;
  readOnly?: boolean;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border border-input text-xs [&_.cm-editor]:bg-background",
        className,
      )}
    >
      <CodeMirror
        value={value}
        onChange={onChange}
        extensions={extensions}
        basicSetup={{
          lineNumbers: true,
          foldGutter: true,
          highlightActiveLine: !readOnly,
          highlightActiveLineGutter: !readOnly,
        }}
        height="auto"
        minHeight={minHeight}
        maxHeight={maxHeight}
        readOnly={readOnly}
        placeholder={placeholder}
        theme="dark"
      />
    </div>
  );
}
