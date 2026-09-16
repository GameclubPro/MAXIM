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

## Implemented Plan

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
6. Validate the mini app and deploy only `miniapp-major-static` through exact-SHA CI.

## Verification

```bash
npm run check:miniapp
npm run build:miniapp:production
node apps/miniapp/test/publication-video-picker.browser.mjs
```

The browser regression uses local preview transport and blocks external requests.
It checks the reported 36 MB rejection, persistence beyond the old toast lifetime,
text edits, cancellation, same-file retry, generic-MIME selection, empty files,
preservation of the old attachment, accessible errors, and visible error bounds.
Desktop light/dark, iPhone, Android dark, and narrow iPhone SE are covered. Screenshots
are generated in a temporary directory, outside the repository. Successful small-file
selection uses synthetic bytes and does not assert MAX upload or playback support.
Unit tests also cover the exact 24 MB boundary, one byte over, read failures, and
base64 length consistency. Run the browser check after builds finish: rebuilding
contracts while Vite runs can hot-reload the editor and reset its transient state.

## Larger Files

This fix makes rejection explicit; it does not enable a 36 MB upload. The immediate
workaround is reducing the video to at most 24,000,000 bytes and selecting it again.
Keep a margin below the displayed limit because operating systems may display MiB
as MB.

Larger-file support is a separate ingestion change: bounded authenticated binary or
chunked upload, durable asset references instead of base64 JSON and database bytea,
quotas and expiry, streaming validation, cancellation/progress, and retry semantics.
Review server memory, storage, proxy limits, and all publication/draft consumers before
raising the limit. MAX outbound resumable upload alone does not solve ingestion.
