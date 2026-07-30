import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Clapperboard,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Play,
  RefreshCw,
  Square,
  Trash2,
  X,
} from 'lucide-react'
import {
  cancelMovieJob,
  deleteMovieJob,
  getMovieJob,
  listMovieJobs,
  pollMovieJob,
  resumeMovieJob,
  startMovieJob,
  stopMovieJob,
  type MovieJobView,
  type StartMovieJobRequest,
} from '../api/movie'
import { imageFileUrl, type UploadedImage } from '../api/images'
import { MovieForm } from '../components/movie/MovieForm'
import {
  MOVIE_NEW_PANEL,
  MovieHistorySidebar,
} from '../components/movie/MovieHistorySidebar'
import { MovieSceneList } from '../components/movie/MovieSceneList'
import { OutlineApprovalPanel } from '../components/movie/OutlineApprovalPanel'
import { Button } from '../components/ui/button'
import { JobErrorBanner } from '../components/JobErrorBanner'
import { ToolSidebar } from '../components/ToolSidebar'
import { VideoLightbox } from '../components/VideoLightbox'
import { useAuth } from '../contexts/AuthContext'
import { useIsMobile } from '../hooks/useIsMobile'
import { nextMovieReqId, useWsMovie } from '../hooks/useWsMovie'
import { parseVideoLength } from '../lib/imggen'
import { pickListedCapability } from '../lib/capability-picker'
import { firstSelectableModel } from '../lib/modelAvailability'

const TERMINAL = new Set(['completed', 'failed', 'canceled'])
const DEFAULT_DIRECTOR_SYSTEM = ''
const DEFAULT_SCENE_SYSTEM = ''

function jobTitle(idea: string, limit = 56): string {
  const trimmed = idea.trim()
  if (!trimmed) return 'Movie'
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit - 1).trimEnd()}…`
}

export default function MoviePage() {
  const { token } = useAuth()
  const isMobile = useIsMobile()
  const ws = useWsMovie(token)
  const watchReqRef = useRef<string | null>(null)

  const capabilities = ws.capabilities
  const capabilitiesStatus = ws.capabilitiesStatus
  const capabilitiesError = ws.capabilitiesError

  const [idea, setIdea] = useState('')
  const [width, setWidth] = useState(768)
  const [height, setHeight] = useState(512)
  const [sceneCount, setSceneCount] = useState(4)
  const [sceneLength, setSceneLength] = useState('25')
  const [directorModel, setDirectorModel] = useState('')
  const [sceneModel, setSceneModel] = useState('')
  const [videoCapability, setVideoCapability] = useState('')
  const [longShot, setLongShot] = useState(true)
  const [autoApprove, setAutoApprove] = useState(true)
  const [expandPrompt, setExpandPrompt] = useState(true)
  const [directorSystem, setDirectorSystem] = useState(DEFAULT_DIRECTOR_SYSTEM)
  const [sceneSystem, setSceneSystem] = useState(DEFAULT_SCENE_SYSTEM)
  const [initialImage, setInitialImage] = useState<UploadedImage | null>(null)

  const [jobs, setJobs] = useState<MovieJobView[]>([])
  const [jobsLoading, setJobsLoading] = useState(true)
  const [activePanel, setActivePanel] = useState<string>(MOVIE_NEW_PANEL)
  const [selectedJob, setSelectedJob] = useState<MovieJobView | null>(null)
  const [jobDetailLoading, setJobDetailLoading] = useState(false)

  const [submitting, setSubmitting] = useState(false)
  const [polling, setPolling] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [canceling, setCanceling] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [resuming, setResuming] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(() => !isMobile)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (isMobile) setSidebarOpen(false)
  }, [isMobile])

  const viewingJob = activePanel !== MOVIE_NEW_PANEL
  const viewedJobId = viewingJob ? activePanel : null

  useEffect(() => {
    if (ws.capabilitiesStatus !== 'ready') return
    const { llm, video } = capabilities
    if (llm.length > 0) {
      const firstLlm = firstSelectableModel(llm)
      setDirectorModel(prev => pickListedCapability(prev, llm) ?? firstLlm ?? '')
      setSceneModel(prev => {
        const picked = pickListedCapability(prev, llm)
        if (picked) return picked
        const visionOnline = llm.find(c => c.online && c.tags.includes('vision'))
        const visionAny = llm.find(c => c.tags.includes('vision'))
        return visionOnline?.base ?? visionAny?.base ?? firstLlm ?? ''
      })
    }
    if (video.length > 0) {
      const firstVideo = firstSelectableModel(video)
      setVideoCapability(prev => pickListedCapability(prev, video) ?? firstVideo ?? '')
    }
  }, [capabilities, ws.capabilitiesStatus])

  const loadJobs = useCallback(async () => {
    if (!token) return
    try {
      const list = await listMovieJobs(token)
      setJobs(list)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setJobsLoading(false)
    }
  }, [token])

  useEffect(() => {
    void loadJobs()
  }, [loadJobs])

  const applyJobUpdate = useCallback((job: MovieJobView, activeId?: string | null) => {
    if (activeId && job.job_id === activeId) {
      setSelectedJob(job)
    } else {
      setSelectedJob(prev => (prev?.job_id === job.job_id ? job : prev))
    }
    setJobs(prev => {
      const idx = prev.findIndex(j => j.job_id === job.job_id)
      if (idx >= 0) {
        const next = [...prev]
        next[idx] = job
        return next
      }
      return [job, ...prev]
    })
  }, [])

  useEffect(() => {
    return ws.subscribe(event => {
      if (event.type === 'movie:update') {
        if (event.req_id === watchReqRef.current) {
          setPolling(false)
        }
        if (viewedJobId && event.job.job_id === viewedJobId) {
          applyJobUpdate(event.job, viewedJobId)
        }
      } else if (
        event.type === 'error' &&
        event.req_id != null &&
        event.req_id === watchReqRef.current
      ) {
        setPolling(false)
        setError(event.message)
      }
    })
  }, [ws.subscribe, applyJobUpdate, viewedJobId])

  const viewedJobTerminal =
    selectedJob?.job_id === viewedJobId &&
    selectedJob.status != null &&
    TERMINAL.has(selectedJob.status)

  useEffect(() => {
    if (!viewedJobId || ws.status !== 'connected' || viewedJobTerminal) return
    const reqId = nextMovieReqId('watch')
    watchReqRef.current = reqId
    ws.send({ type: 'watch_job', req_id: reqId, job_id: viewedJobId })
  }, [viewedJobId, ws.status, viewedJobTerminal, ws.send])

  const refreshJob = useCallback(
    async (jobId: string) => {
      if (!token) return null
      const job = await getMovieJob(token, jobId)
      setSelectedJob(job)
      setJobs(prev => {
        const idx = prev.findIndex(j => j.job_id === job.job_id)
        if (idx >= 0) {
          const next = [...prev]
          next[idx] = job
          return next
        }
        return [job, ...prev]
      })
      return job
    },
    [token],
  )

  function selectNew() {
    setActivePanel(MOVIE_NEW_PANEL)
    setError(null)
  }

  async function selectJob(jobId: string) {
    if (!token) return
    setActivePanel(jobId)
    setError(null)
    setJobDetailLoading(true)
    try {
      await refreshJob(jobId)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setJobDetailLoading(false)
    }
  }

  function buildSubmitRequest(): StartMovieJobRequest {
    return {
      idea: idea.trim(),
      width,
      height,
      scene_count: sceneCount,
      scene_length: parseVideoLength(sceneLength),
      long_shot: longShot,
      auto_approve: autoApprove,
      expand_prompt: expandPrompt,
      director_model: directorModel,
      scene_model: sceneModel,
      video_capability: videoCapability,
      director_system: directorSystem.trim() || undefined,
      scene_system: sceneSystem.trim() || undefined,
      initial_image_id: initialImage?.image_id,
    }
  }

  async function onSubmit() {
    if (!token || submitting) return
    if (!idea.trim() || !directorModel || !sceneModel || !videoCapability) {
      setError('Fill in the idea and pick all three models.')
      return
    }
    setError(null)
    setSubmitting(true)
    setJobDetailLoading(true)
    try {
      const res = await startMovieJob(token, buildSubmitRequest())
      setActivePanel(res.job_id)
      await refreshJob(res.job_id)
      await loadJobs()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSubmitting(false)
      setJobDetailLoading(false)
    }
  }

  async function onPollNow(jobId: string) {
    setPolling(true)
    setError(null)
    if (ws.status === 'connected') {
      const reqId = nextMovieReqId('watch')
      watchReqRef.current = reqId
      if (ws.send({ type: 'watch_job', req_id: reqId, job_id: jobId })) {
        return
      }
    }
    if (!token) {
      setPolling(false)
      return
    }
    try {
      const job = await pollMovieJob(token, jobId)
      applyJobUpdate(job, viewedJobId)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPolling(false)
    }
  }

  async function onApproved(job: MovieJobView) {
    applyJobUpdate(job, viewedJobId)
  }

  async function onStop(jobId: string) {
    if (!token) return
    setStopping(true)
    setError(null)
    try {
      const job = await stopMovieJob(token, jobId)
      applyJobUpdate(job, viewedJobId)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setStopping(false)
    }
  }

  async function onResume(jobId: string) {
    if (!token) return
    setResuming(true)
    setError(null)
    try {
      const job = await resumeMovieJob(token, jobId)
      applyJobUpdate(job, viewedJobId)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setResuming(false)
    }
  }

  async function onCancel(jobId: string) {
    if (!token) return
    setCanceling(true)
    setError(null)
    try {
      await cancelMovieJob(token, jobId)
      await refreshJob(jobId)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setCanceling(false)
    }
  }

  async function onDelete(jobId: string) {
    if (!token) return
    setDeleting(true)
    setError(null)
    try {
      await deleteMovieJob(token, jobId)
      setJobs(prev => {
        const next = prev.filter(j => j.job_id !== jobId)
        if (next.length > 0) void selectJob(next[0].job_id)
        else {
          selectNew()
          setSelectedJob(null)
        }
        return next
      })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setDeleting(false)
    }
  }

  function editFromJob() {
    if (!selectedJob) return
    setIdea(selectedJob.idea)
    setWidth(selectedJob.width)
    setHeight(selectedJob.height)
    setSceneCount(selectedJob.scene_count)
    setSceneLength(String(selectedJob.scene_length))
    setDirectorModel(selectedJob.director_model)
    setSceneModel(selectedJob.scene_model)
    setVideoCapability(selectedJob.video_capability)
    setLongShot(selectedJob.long_shot)
    setAutoApprove(selectedJob.auto_approve)
    setExpandPrompt(selectedJob.expand_prompt)
    setDirectorSystem(selectedJob.director_system)
    setSceneSystem(selectedJob.scene_system)
    setInitialImage(null)
    setActivePanel(MOVIE_NEW_PANEL)
    setError(null)
  }

  const canSubmit = useMemo(
    () =>
      capabilitiesStatus === 'ready' &&
      Boolean(idea.trim() && directorModel && sceneModel && videoCapability) &&
      !submitting,
    [idea, directorModel, sceneModel, videoCapability, submitting, capabilitiesStatus],
  )

  const status = selectedJob?.status
  const isRunning = status === 'running'
  const isPaused = status === 'paused'
  const isNonTerminal = status != null && !TERMINAL.has(status)
  const isCompleted = status === 'completed'

  return (
    <div
      className="relative flex min-h-0 flex-1 overflow-hidden bg-background"
      data-testid="movie-page"
    >
      <ToolSidebar
        title="Movie Studio"
        open={sidebarOpen}
        isMobile={isMobile}
        onClose={() => setSidebarOpen(false)}
        testId="movie-sidebar"
      >
        <MovieHistorySidebar
          jobs={jobs}
          activePanel={activePanel}
          loading={jobsLoading}
          onSelectNew={() => {
            selectNew()
            if (isMobile) setSidebarOpen(false)
          }}
          onSelectJob={jobId => {
            void selectJob(jobId)
            if (isMobile) setSidebarOpen(false)
          }}
        />
      </ToolSidebar>

      <div className="flex min-h-0 min-w-0 flex-1 basis-0 flex-col overflow-hidden">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
          <Button variant="ghost" size="icon-sm" onClick={() => setSidebarOpen(v => !v)}>
            {sidebarOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
          </Button>
          <h1 className="min-w-0 flex-1 truncate font-display text-sm font-semibold">
            {viewingJob && selectedJob ? jobTitle(selectedJob.idea) : 'New movie'}
          </h1>
          {viewingJob && selectedJob && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => void onDelete(selectedJob.job_id)}
              disabled={deleting}
              data-testid="movie-delete-job"
              className="text-muted-foreground hover:text-destructive"
            >
              {deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            </Button>
          )}
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <AnimatePresence mode="wait">
            {activePanel === MOVIE_NEW_PANEL ? (
              <motion.div
                key="new"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
              >
                <MovieForm
                  token={token}
                  llmCapabilities={capabilities.llm}
                  videoCapabilities={capabilities.video}
                  capabilitiesStatus={capabilitiesStatus}
                  capabilitiesError={capabilitiesError}
                  onRefreshCapabilities={ws.refreshCapabilities}
                  idea={idea}
                  onIdeaChange={setIdea}
                  width={width}
                  onWidthChange={setWidth}
                  height={height}
                  onHeightChange={setHeight}
                  sceneCount={sceneCount}
                  onSceneCountChange={setSceneCount}
                  sceneLength={sceneLength}
                  onSceneLengthChange={setSceneLength}
                  directorModel={directorModel}
                  onDirectorModelChange={setDirectorModel}
                  sceneModel={sceneModel}
                  onSceneModelChange={setSceneModel}
                  videoCapability={videoCapability}
                  onVideoCapabilityChange={setVideoCapability}
                  longShot={longShot}
                  onLongShotChange={setLongShot}
                  autoApprove={autoApprove}
                  onAutoApproveChange={setAutoApprove}
                  expandPrompt={expandPrompt}
                  onExpandPromptChange={setExpandPrompt}
                  directorSystem={directorSystem}
                  onDirectorSystemChange={setDirectorSystem}
                  sceneSystem={sceneSystem}
                  onSceneSystemChange={setSceneSystem}
                  initialImage={initialImage}
                  onInitialImageChange={setInitialImage}
                  onSubmit={() => void onSubmit()}
                  submitting={submitting}
                  canSubmit={canSubmit}
                  error={error}
                />
              </motion.div>
            ) : (
              <motion.div
                key="detail"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="mx-auto max-w-3xl space-y-4 px-3 py-4 sm:px-6 sm:py-5"
                data-testid="movie-job-detail"
              >
                {error && <JobErrorBanner message={error} testId="movie-job-error" />}

                {jobDetailLoading && !selectedJob ? (
                  <div className="flex flex-1 items-center justify-center py-16">
                    <Loader2 className="size-6 animate-spin text-muted-foreground" />
                  </div>
                ) : selectedJob && selectedJob.job_id === viewedJobId ? (
                  <>
                    <div className="space-y-1">
                      <h2 className="font-display text-sm font-semibold leading-snug">
                        {jobTitle(selectedJob.idea, 120)}
                      </h2>
                      <p className="text-xs capitalize text-muted-foreground">
                        {selectedJob.status.replace(/_/g, ' ')} · {selectedJob.phase}
                        {isNonTerminal && ws.status === 'connected' ? ' · live' : ''}
                        {polling ? ' · syncing…' : ''}
                      </p>
                    </div>

                    <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                      <Button variant="outline" size="sm" className="min-h-10" onClick={editFromJob}>
                        <Pencil className="mr-1 size-3.5" />
                        Edit
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="min-h-10"
                        disabled={polling}
                        onClick={() => void onPollNow(selectedJob.job_id)}
                        data-testid="movie-poll-btn"
                      >
                        {polling ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : <RefreshCw className="mr-1 size-3.5" />}
                        Poll
                      </Button>
                      {isRunning && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="min-h-10"
                          disabled={stopping}
                          onClick={() => void onStop(selectedJob.job_id)}
                          data-testid="movie-stop-btn"
                        >
                          {stopping ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : <Square className="mr-1 size-3.5" />}
                          Stop
                        </Button>
                      )}
                      {isPaused && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="min-h-10"
                          disabled={resuming}
                          onClick={() => void onResume(selectedJob.job_id)}
                          data-testid="movie-resume-btn"
                        >
                          {resuming ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : <Play className="mr-1 size-3.5" />}
                          Resume
                        </Button>
                      )}
                      {isNonTerminal && (
                        <Button
                          variant="destructive"
                          size="sm"
                          className="min-h-10"
                          disabled={canceling}
                          onClick={() => void onCancel(selectedJob.job_id)}
                          data-testid="movie-cancel-btn"
                        >
                          {canceling ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : <X className="mr-1 size-3.5" />}
                          Cancel
                        </Button>
                      )}
                    </div>

                    {isCompleted && selectedJob.movie_file_id && (
                      <div className="space-y-1.5">
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          The movie
                        </p>
                        <VideoLightbox
                          src={imageFileUrl(selectedJob.movie_file_id, token)}
                          alt={jobTitle(selectedJob.idea, 80)}
                          triggerClassName="block w-full overflow-hidden rounded-2xl bg-muted/30"
                          testId="movie-final-video"
                          actions={
                            token
                              ? {
                                  fileId: selectedJob.movie_file_id,
                                  filename: `${jobTitle(selectedJob.idea, 40)}.mp4`,
                                  direction: 'output',
                                  token,
                                  onDeleted: () => void refreshJob(selectedJob.job_id),
                                }
                              : undefined
                          }
                        >
                          <video
                            src={imageFileUrl(selectedJob.movie_file_id, token)}
                            controls
                            loop
                            className="max-h-[60vh] w-full rounded-2xl object-contain"
                          />
                        </VideoLightbox>
                      </div>
                    )}

                    {selectedJob.status === 'awaitingApproval' && (
                      <OutlineApprovalPanel job={selectedJob} token={token} onApproved={job => void onApproved(job)} />
                    )}

                    {selectedJob.scenes.length > 0 && (
                      <div className="space-y-1.5">
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Scenes
                        </p>
                        <MovieSceneList
                          scenes={selectedJob.scenes}
                          token={token}
                          currentScene={selectedJob.current_scene}
                          activeLog={selectedJob.active_log}
                        />
                      </div>
                    )}

                    {selectedJob.status === 'failed' && selectedJob.error && (
                      <JobErrorBanner message={selectedJob.error} testId="movie-job-failed" />
                    )}
                  </>
                ) : (
                  <div className="flex items-center gap-2 py-16 text-sm text-muted-foreground">
                    <Clapperboard className="size-4" />
                    Select a movie from the sidebar.
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </main>
      </div>
    </div>
  )
}
