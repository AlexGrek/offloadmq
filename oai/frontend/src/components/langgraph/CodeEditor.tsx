import { useEffect, useRef } from 'react'
import { EditorView, basicSetup } from 'codemirror'
import { EditorState } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import { python } from '@codemirror/lang-python'
import { json } from '@codemirror/lang-json'
import { StreamLanguage } from '@codemirror/language'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { useTheme } from '@/contexts/ThemeContext'

export function CodeEditor({ value, onChange, language, label, readOnly = false }: {
  value: string; onChange?: (value: string) => void
  language: 'python' | 'toml' | 'json'; label: string; readOnly?: boolean
}) {
  const parent = useRef<HTMLDivElement>(null)
  const editor = useRef<EditorView | null>(null)
  const callback = useRef(onChange)
  const initial = useRef(value)
  const { theme } = useTheme()
  useEffect(() => { callback.current = onChange }, [onChange])
  useEffect(() => {
    if (!parent.current) return
    const view = new EditorView({
      parent: parent.current, doc: initial.current,
      extensions: [
        basicSetup, keymap.of([indentWithTab]),
        language === 'python' ? python() : language === 'json' ? json() : StreamLanguage.define(toml),
        EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly),
        EditorView.contentAttributes.of({ 'aria-label': label, 'data-testid': 'langgraph-code-input' }),
        EditorView.theme({
          '&': { backgroundColor: 'var(--background)', color: 'var(--foreground)', height: '100%' },
          '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, monospace', fontSize: '13px' },
          '.cm-content': { minHeight: '340px' },
          '.cm-gutters': { backgroundColor: 'var(--muted)', color: 'var(--muted-foreground)', border: 'none' },
          '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--muted) 35%, transparent)' },
          '&.cm-focused': { outline: '2px solid var(--ring)' },
        }, { dark: theme === 'dark' }),
        EditorView.updateListener.of(update => {
          if (update.docChanged) callback.current?.(update.state.doc.toString())
        }),
      ],
    })
    editor.current = view
    return () => { initial.current = view.state.doc.toString(); view.destroy(); editor.current = null }
  }, [language, readOnly, theme, label])
  useEffect(() => {
    const view = editor.current
    if (view && view.state.doc.toString() !== value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
    }
  }, [value])
  return <div ref={parent} className="h-[360px] min-w-0 overflow-hidden rounded-md border border-input sm:h-[460px]" data-testid="langgraph-code-editor" />
}
