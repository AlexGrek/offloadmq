import { useCallback, useMemo } from 'react'
import { Activity, Loader2, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useAuth } from '../contexts/AuthContext'
import { useProgress } from '../contexts/ProgressContext'
import { useWorkload } from '../contexts/WorkloadContext'
import { cancelOffloadTask } from '../api/tasks'
import { cancelImageJob } from '../api/images'
import type { RunningJobItem } from '../api/progress'
import type { ChatTaskRecord } from '../contexts/WorkloadContext'
import {
  ProgressPanel,
  chatProgressRows,
  imageProgressRows,
} from './ProgressPanel'

export function GlobalProgressDrawer() {
  const {
    drawerOpen,
    setDrawerOpen,
    runningImageJobs: imageJobs,
    runningImageJobsLoading: loadingImages,
    refreshRunningImageJobs: refreshImages,
  } = useProgress()
  const { token } = useAuth()
  const { runningChatTasks, finishChatTask } = useWorkload()

  const handleCancelChat = useCallback(
    async (task: ChatTaskRecord) => {
      if (!token || !task.cap || !task.id) return
      try {
        await cancelOffloadTask(token, task.cap, task.id)
        finishChatTask(task.reqId, 'canceled', true)
      } catch (e) {
        console.error('cancel chat task', e)
      }
    },
    [token, finishChatTask],
  )

  const handleCancelImage = useCallback(
    async (job: RunningJobItem) => {
      if (!token) return
      try {
        await cancelImageJob(token, job.job_id)
        await refreshImages()
      } catch (e) {
        console.error('cancel image job', e)
      }
    },
    [token, refreshImages],
  )

  const chatRows = useMemo(
    () => chatProgressRows(runningChatTasks, handleCancelChat),
    [runningChatTasks, handleCancelChat],
  )
  const imageRows = useMemo(
    () => imageProgressRows(imageJobs, null, handleCancelImage),
    [imageJobs, handleCancelImage],
  )
  const totalRunning = chatRows.length + imageRows.length

  return (
    <>
      {drawerOpen && (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-black/20 md:hidden"
          aria-label="Close progress panel"
          onClick={() => setDrawerOpen(false)}
        />
      )}
      <aside
        className={cn(
          'fixed top-14 right-0 z-50 flex h-[calc(100dvh-3.5rem)] w-full max-w-md flex-col border-l border-border bg-background shadow-xl transition-transform duration-200',
          drawerOpen ? 'translate-x-0' : 'translate-x-full',
        )}
        data-testid="progress-drawer"
        aria-hidden={!drawerOpen}
      >
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
          <Activity className="size-4 text-violet-600 dark:text-violet-400" />
          <span className="text-sm font-semibold">Progress</span>
          {totalRunning > 0 && (
            <span className="rounded-full bg-violet-500/15 px-2 py-0.5 text-[10px] font-medium text-violet-700 dark:text-violet-300">
              {totalRunning} running
            </span>
          )}
          <span className="flex-1" />
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void refreshImages()}
            disabled={loadingImages}
            title="Refresh image jobs"
            data-testid="progress-refresh"
          >
            {loadingImages ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close progress panel"
            data-testid="progress-close"
          >
            <X className="size-4" />
          </Button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          <ProgressPanel
            title="Chat"
            emptyMessage="No chat tasks running."
            rows={chatRows}
          />
          <ProgressPanel
            title="Image generation"
            loading={loadingImages && imageRows.length === 0}
            emptyMessage="No image jobs in progress."
            rows={imageRows}
          />
        </div>
      </aside>
    </>
  )
}
