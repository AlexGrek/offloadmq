import type { ReactNode } from 'react'
import { Feather, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { PromptTextarea } from '@/components/PromptTextarea'
import { PromptActions } from './PromptActions'
import {
  IMGGEN_PROMPT_BUCKET,
  PROMPT_STUDIO_SYSTEM_BUCKET,
  PROMPT_STUDIO_TEMPLATE_BUCKET,
  TEMPLATE_TOKEN,
} from '@/lib/promptStudio'

/**
 * Prompt Studio empty-session panel: system prompt, optional example prompt (from the
 * txt2img library) and the message template that turns the example into the first
 * message. The rendered message is shown as a read-only preview; the message box at the
 * end of the form (the chat composer, rendered inline) adds optional text and images and
 * starts the session. System prompts and templates have their own prompt-library buckets.
 */
export function PromptStudioSetup({
  token,
  systemPrompt,
  onSystemPromptChange,
  defaultSystemPrompt,
  examplePrompt,
  onExamplePromptChange,
  template,
  onTemplateChange,
  defaultTemplate,
  onUsePrompt,
  composer,
}: {
  token: string
  systemPrompt: string
  onSystemPromptChange: (value: string) => void
  defaultSystemPrompt: string
  examplePrompt: string
  onExamplePromptChange: (value: string) => void
  template: string
  onTemplateChange: (value: string) => void
  defaultTemplate: string
  /** Opens Image Generation with a prompt (the example's "Use" action). */
  onUsePrompt: (prompt: string) => void
  /** The inline chat composer that sends the first message. */
  composer: ReactNode
}) {
  return (
    <section
      className="flex w-full max-w-2xl flex-col gap-5"
      data-testid="prompt-studio-setup"
    >
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-blue-500/15 text-blue-600 dark:bg-blue-500/20 dark:text-blue-400">
          <Feather className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-base font-semibold tracking-tight">Prompt Studio</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Brainstorm image prompts with an LLM. Start from an example prompt or write freely
            below — attach images for inspiration. Every reply can go straight to Image Generation.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="prompt-studio-system">System prompt</Label>
          <ResetButton
            disabled={systemPrompt.trim() === defaultSystemPrompt.trim()}
            onClick={() => onSystemPromptChange(defaultSystemPrompt)}
            testId="prompt-studio-system-reset"
          />
        </div>
        <PromptTextarea
          id="prompt-studio-system"
          token={token}
          value={systemPrompt}
          onChange={onSystemPromptChange}
          bucket={PROMPT_STUDIO_SYSTEM_BUCKET}
          placeholder={defaultSystemPrompt}
          rows={4}
          data-testid="prompt-studio-system"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="prompt-studio-example">
          Example prompt <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <PromptTextarea
          id="prompt-studio-example"
          token={token}
          value={examplePrompt}
          onChange={onExamplePromptChange}
          bucket={IMGGEN_PROMPT_BUCKET}
          previews
          placeholder="Paste a prompt, or open the list to pick one from your Image Generation prompts"
          rows={3}
          data-testid="prompt-studio-example"
        />
        <PromptActions
          token={token}
          prompt={examplePrompt}
          onUse={onUsePrompt}
          onApply={onExamplePromptChange}
          applyLabel="Use as example"
          testIdPrefix="prompt-studio-example"
          tone="muted"
          className="mt-0.5"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="prompt-studio-template">Message template</Label>
          <ResetButton
            disabled={template.trim() === defaultTemplate.trim()}
            onClick={() => onTemplateChange(defaultTemplate)}
            testId="prompt-studio-template-reset"
          />
        </div>
        <PromptTextarea
          id="prompt-studio-template"
          token={token}
          value={template}
          onChange={onTemplateChange}
          bucket={PROMPT_STUDIO_TEMPLATE_BUCKET}
          placeholder={defaultTemplate}
          rows={2}
          data-testid="prompt-studio-template"
        />
        <p className="text-xs text-muted-foreground">
          <code className="rounded bg-muted px-1 py-0.5">{TEMPLATE_TOKEN}</code> is replaced
          with the example prompt to build the first message.
        </p>
      </div>

      {composer}
    </section>
  )
}

function ResetButton({
  disabled,
  onClick,
  testId,
}: {
  disabled: boolean
  onClick: () => void
  testId: string
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 gap-1 text-xs"
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
    >
      <RotateCcw className="size-3" />
      Default
    </Button>
  )
}
