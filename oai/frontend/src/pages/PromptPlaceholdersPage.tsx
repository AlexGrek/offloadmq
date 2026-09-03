import { Braces } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { PromptPlaceholdersPanel } from '@/components/promptPlaceholders/PromptPlaceholdersPanel'

export default function PromptPlaceholdersPage() {
  return (
    <main
      className="mx-auto min-h-0 w-full max-w-3xl flex-1 overflow-y-auto overscroll-contain p-6"
      data-testid="prompt-placeholders-page"
    >
      <div className="mb-5">
        <h1 className="font-display flex items-center gap-2 text-2xl font-bold">
          <Braces className="h-6 w-6 text-muted-foreground" />
          Prompt Placeholders
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Quick names for {'{?}'}, built-in categories, and your own custom, recursive placeholders.
        </p>
      </div>
      <Card>
        <CardContent className="p-4">
          <PromptPlaceholdersPanel />
        </CardContent>
      </Card>
    </main>
  )
}
