import CodeMirror from '@uiw/react-codemirror'
import { yaml } from '@codemirror/lang-yaml'
import { StreamLanguage } from '@codemirror/language'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { oneDark } from '@codemirror/theme-one-dark'

const SHELL_EXT = StreamLanguage.define(shell)

const SETUP = {
  lineNumbers: true,
  foldGutter: false,
  dropCursor: false,
  allowMultipleSelections: false,
  indentOnInput: true,
}

/**
 * language: 'yaml' | 'shell'
 */
export function CodeEditor({ value, onChange, language = 'yaml', height = '280px' }) {
  const extensions = language === 'yaml' ? [yaml()] : [SHELL_EXT]
  return (
    <CodeMirror
      value={value}
      height={height}
      theme={oneDark}
      extensions={extensions}
      onChange={onChange}
      basicSetup={SETUP}
      style={{ fontSize: '12px', borderRadius: '0.375rem', overflow: 'hidden' }}
    />
  )
}
