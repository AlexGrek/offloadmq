type JobErrorBannerProps = {
  message: string
  testId?: string
}

/** Visible alert for submit/poll/API failures on offload job tool pages. */
export function JobErrorBanner({ message, testId }: JobErrorBannerProps) {
  return (
    <p
      role="alert"
      className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
      data-testid={testId}
    >
      {message}
    </p>
  )
}
