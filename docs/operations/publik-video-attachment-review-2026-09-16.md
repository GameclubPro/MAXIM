# Publik Video Attachment Review, 2026-09-16

## Report And Evidence

The reported workflow is choosing a 36 MB MP4 through the video button in Publik,
using MAX Desktop 26.31.0 on Windows 11 Pro. The file does not appear and the user
reports no visible error. Text-only posts work and the user has administrator rights.

Verified in the repository:

- `PublicationsPage.handlePublicationVideoFile` rejected files above 24,000,000 bytes
  before reading the file or calling the API. A 36 MB MP4 necessarily exceeds this
  limit, regardless of whether the reported size is decimal MB or binary MiB.
- The catch branch only emitted a toast. `ToastProvider` removes it after 3,200 ms;
  the editor had no persistent record of why the attachment was rejected.
- The contract caps inline video at 32,000,000 base64 characters. The API separately
  caps decoded video at 24,000,000 bytes. This is an ingestion limit of Publik,
  not a claim about MAX's native attachment limit.
- For a generic `application/octet-stream` MIME, the client accepted MKV but rejected
  MP4, MOV, and WebM. Empty MIME already supported all four extensions. The report
  does not establish which MIME the user's Windows picker supplied.
- Empty files were not explicitly rejected by the publication handler. Shared blob
  reading already has bounded timeouts and a FileReader fallback.

The file-size rejection occurs before network upload and access checks. Administrator
permissions therefore cannot remove this rejection. No evidence establishes a
Windows-specific picker defect or a toast stacking defect. The original user's file
and native MAX Desktop session were not available for reproduction.

## Initial Remediation

1. Extract publication video preparation into a focused, testable helper. Derive its
   byte limit from the existing base64 contract instead of duplicating the number.
2. Reject oversized, empty, unsupported, and incomplete reads with concise errors.
   Reject oversized files before allocating base64 or reading their contents.
3. Infer a supported extension for missing or generic MIME only. Reject explicit
   incompatible MIME and extensions outside the allowlist; server byte validation
   remains unchanged.
4. Keep selection errors beside the attachment toolbar, with an error indicator and
   accessible association to the input. Include the size limit in the button tooltip
   and accessible description. A new successful selection clears the error; editing
   text or cancelling the file picker does not.
5. Preserve the previous video and post text on failed replacement. Reset the file
   input after processing so selecting the same file again works.
6. Validate the mini app. The initial error-feedback fix was committed separately;
   the subsequent request to increase capacity expanded the final release scope.

## Direct Upload, 100 MB

The follow-up request asks for larger videos without filling the VPS. New selection
therefore uses direct browser-to-MAX multipart upload, capped at 100,000,000 bytes.
The 24 MB inline compatibility path is unchanged; raising its limit would increase
JSON/base64 buffers and database storage without solving the disk concern.

1. The authenticated Publisher API accepts only file metadata and an idempotent
   request ID. Admission is limited to three starts/user/minute, 30 starts/minute
   globally, and a bounded pending queue.
2. The `publisher-video-upload` worker runs only in `api-publisher` and uses the
   existing per-bot MAX request machinery to obtain a video upload session. Only
   its signed upload URL is returned to the owner; the bot credential and media
   token are never returned to the mini app.
3. The browser sends the original Blob directly to MAX. There is no base64 conversion,
   API binary body, Redis binary payload, database bytea, or VPS temporary video file.
   The UI shows progress and supports cancellation while preserving existing content.
4. Completion is checked against MAX by the Publisher worker, not trusted from a
   client-supplied token. Only after MAX exposes a playable video does the worker save
   a small `PublicationAsset` record with `bytes: null` and an internal exact-bot marker.
5. The owned asset can be attached to its first draft, saved, scheduled, duplicated,
   and reused. Public content cannot forge the internal marker. Dispatch resolves it
   only for the original Publisher bot and sends the MAX token without reuploading.
6. Upload sessions expire after one hour. Completed/failed job history is limited
   by both age and count. Abandoned uploads do not leave video files on the VPS;
   completed unattached assets contain metadata only. Existing draft removal also
   removes its unreferenced metadata assets.

The 100 MB selected-file limit is checked in the client and in session metadata;
MAX owns the binary upload and its server-side size validation. No claim is made
that metadata constrains an adversarial client's direct upload at MAX's endpoint.
The original report's missing/generic MIME case is normalized in both the metadata
and multipart part without reading the whole file into JavaScript memory.

## Verification

```bash
npm run check:miniapp
npm run build:miniapp:production
node apps/miniapp/test/publication-video-picker.browser.mjs
npm test --workspace @maxim/api -- publisher-video-upload publication-content.service.spec admin-managed-broadcast-runtime-publication-media.spec
```

The browser regression uses local preview transport and blocks external requests.
It checks 36 MB direct upload, rejection above 100 MB, persistence beyond the old toast
lifetime, text edits, picker cancellation, upload cancellation/failure, same-file retry,
generic-MIME selection, empty files, preservation of the old attachment, accessible
errors, and visible error bounds. MAX binary responses are mocked in this regression.
Desktop light/dark, iPhone, Android dark, and narrow iPhone SE are covered. Screenshots
are generated in a temporary directory, outside the repository. Successful small-file
selection uses synthetic bytes and does not assert MAX upload or playback support.
Unit tests cover the exact 100 MB boundary, one byte over, metadata-only API traffic,
queue admission/expiry, ownership, bot binding, and rejection of forged tokens.
Run the browser check after builds finish: rebuilding
contracts while Vite runs can hot-reload the editor and reset its transient state.

A live protocol smoke uploaded a valid 36,000,000-byte MP4 from Chromium on the
production public origin directly to the MAX-issued upload URL. Multipart upload
returned HTTP 200 and `GET /videos/{token}` confirmed a playable video. The fixture
was local to the test machine; the VPS handled session/readiness metadata only.
No chat/channel message was sent, and signed URLs/tokens were not logged or saved.

## Delivery And Limits

The shared contract/API change requires all shared API roles and both active static
components, with green exact-SHA CI and normal release smokes. No Prisma migration,
stateful-service recreation, proxy limit increase, or VPS media cleanup is required.
Old byte-backed videos are left intact. API rollback must retain support for the
internal remote-video marker while publications reference it; a static-only rollback
does not change saved assets. Native MAX Desktop 26.31.0 on Windows 11
still requires user confirmation; browser automation is not that native client.

MAX upload protocol reference: <https://dev.max.ru/docs-api/methods/POST/uploads>.
