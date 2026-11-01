# Hallucinate

`/app/hallucinate` is a frontend-driven live wallpaper. Choose an online txt2img
model, a prompt template, and a canvas preset. Start opens a window-filling image
surface with a six-second fade between images. Display controls pause/resume,
return to settings, and toggle browser fullscreen. Reduced-motion preferences
disable the fade. Images always keep their proportions and fit completely within
the screen, with black bars when the screen and image aspect ratios differ. Display controls fade
away after four seconds of inactivity and return on pointer or keyboard activity.
The runtime status stays visible: current generation/upscale step, job ID, status,
queue time, execution time, and total elapsed time. Its progress bar uses the
backend's typical-runtime estimate once execution starts; queued jobs and jobs
without estimates use an indeterminate bar. Timings update between polls and
stop when the job finishes or monitoring stops. Each new job resets the readout.

Each iteration expands built-in and custom prompt placeholders again, chooses a
new random seed, and submits one txt2img task through the existing Image Generation
API. `{?}` uses the generator's existing server-side substitution. There is no
negative-prompt control. An explicit empty override clears the workflow negative
prompt. Custom substitution pools are fetched once at start; restart after editing placeholder definitions.

Optional upscale discovers Image Tools operations advertising `upscale*`; the
first available tool is selected by default, with a default multiplier of ×2.
After generation completes, an Image Tools job processes its output. Only the
upscaled result is displayed. ComfyUI upscale outputs retain their full resolution;
the Basic resize size cap does not apply to these tools.

There is no wallpaper job history or server-side recurring session. The frontend
owns the loop and starts the next iteration after the preceding result is loaded.
Rendering overlaps the fade; a fast result waits for the preceding fade to finish
before replacing the visible frame. Hidden tabs finish the current iteration but
pause new submissions. Pause, navigating away, or page teardown aborts the loop and attempts
to cancel in-flight work. Errors stop the loop visibly; resume retries explicitly.
A browser or machine crash can leave the last submitted job to finish normally,
but cannot start another. Existing backend workers reconcile individual tasks.

Completed images are fetched into browser object URLs before temporary generation
and upscale jobs/files are deleted. At most two frames are retained, with older
URLs revoked on replacement or unmount. Temporary jobs may briefly appear in the
shared generation/task views while running. Requests have a 15-second deadline;
polling also aborts immediately on Pause.
Submissions retain their bounded response wait so a returned job ID can be
canceled even when Pause races the submission. If a submission times out after
the server has accepted it, its unknown job ID cannot be cleaned by this page.
Cancellation cleanup waits up to 30 seconds per job for a terminal status;
if an agent remains unresponsive, its record stays
available to the existing backend reconciler rather than deleting an active job.
Network failure or abrupt tab shutdown can also leave the final temporary record
for normal file/history cleanup. Cleanup failure stops further generation to
avoid unlimited storage growth.

Prompt favorites and recent templates use the separate `hallucinate-prompt`
bucket in the shared Prompt API. The textarea's saved-prompts picker manages that
library. **Import from txt2img** opens the `imggen-prompt` library and copies the
selected text to Hallucinate's prompt and recents; it does not move or change the
original entry. Starting records the original template once, rather than flooding
recents with each expanded variation.

Implementation: `frontend/src/pages/HallucinatePage.tsx`,
`frontend/src/lib/hallucinate.ts`. No new endpoints, database tables, workers, or
deployment settings. Regression coverage: `e2e/tests/hallucinate.spec.ts`.
