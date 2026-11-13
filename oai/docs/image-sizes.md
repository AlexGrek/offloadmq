# Shared image sizes

All OAI output-size and exact-resize controls use `ImageSizePicker` and the
`IMAGE_SIZE_PRESETS` catalog in `frontend/src/lib/imageSizes.ts`. The presets are
compact chips in one wrapping line (no category headings, square → portrait →
landscape). Orientation is only a faint tint — square green, portrait blue,
landscape orange — also exposed as `data-orientation` and the chip tooltip; the
pressed chip gets a stronger tint, a border and bold text, so selection does not
depend on color alone.
Width and Height fields accept manual overrides; the swap button exchanges them.

Deliberate preset selections, swaps, and valid custom dimensions save one
`oai_image_size` localStorage entry as `[width, height]`. Other apps and newly
opened generation dialogs restore that shared preference. Invalid or unavailable
storage falls back to the app's default. Opening a form does not overwrite the
preference. Each app still enforces its supported bounds; incompatible remembered
sizes fall back locally without replacing the saved value.

Video generation (Txt2Video / Img2Video on `/app/images`) has its own size: it
uses `VIDEO_SIZE_PRESETS` (mostly sides under 1024 px: 512², 640², 768², 1024²,
plus portrait and landscape variants such as 480×832, 720×1280, 832×480, 1280×720)
and remembers deliberate choices under a separate `oai_video_size` entry, so an
image size never leaks into video and vice versa. The default is
`DEFAULT_VIDEO_SIZE` = 768×768 whenever no valid video size is remembered, and
the default length is `DEFAULT_VIDEO_LENGTH` = 45 frames (`lib/imggen.ts`).
`ImageSizePicker` takes `presets` and `storageKey` props for this.

Image-to-image keeps its original-resolution and aspect-ratio controls. Manual
edits respect Keep proportions and remember the resulting pair. Choosing a fixed
preset turns Keep proportions off. Original resolution locks the picker until
turned off. Loading an input or historical job preserves that image/job's own
sizes rather than replacing them with a browser preference.

Image Tools retains percentage sizing, fit modes and resampling controls. Its
pixel-size picker shares the same catalog; presets exceeding its supported edge
limit are visible but disabled. Rescale's max-pixel/megapixel limits remain separate
from its exact-size picker.

Browser regressions: `e2e/tests/image-sizes.spec.ts`, plus the existing app suites.
