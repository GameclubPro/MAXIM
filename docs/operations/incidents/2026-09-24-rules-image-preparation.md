# Rules Image Preparation Complaint

## Evidence And Limits

The supplied screenshot shows the generic error formerly produced by
`apps/miniapp/src/lib/broadcast-image.ts`. This is local image preparation,
before settings persistence or upload to MAX. A server, network, nginx body
limit, or MAX upload failure is not established by this message.

The full-width photo button resembles `BotSpeechMessageEditorSheet`; the post
rules composer uses `BroadcastContentComposer`. Both call the same preparation
function. The cropped screenshot does not prove which screen or release was
used, so the fix covers both callers.

No original file, device/OS/MAX version, precise failure time, or client trace
was supplied. Therefore no single format, decoder, or device is asserted as
the proven cause of this user's failure. The defects below are established
from code and targeted reproductions, not inferred production statistics.

## Confirmed Defects

| Defect                                                               | Consequence                                                                              | Implemented Correction                                                                     |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Generic nonempty native MIME overrides the filename                  | An otherwise usable JPEG loses its original-byte fallback                                | Normalize native MIME and consult extension and a bounded 32-byte format hint              |
| Missing/misleading filename or MIME is trusted                       | Native files may be rejected or given the wrong output format                            | Recognized raster signatures take precedence; unknown HEIF is not relabeled HEIC           |
| OffscreenCanvas is selected solely by its presence                   | Broken contexts/encoders prevent conversion even when DOM canvas works                   | Retry DOM canvas after render, encode, or timeout failure                                  |
| Every canvas uses `alpha: false`                                     | Transparent PNGs become opaque, often with black backgrounds                             | Preserve PNG alpha and explicitly flatten JPEG onto white                                  |
| Canvas surfaces are not explicitly released                          | Multiple compression attempts increase WebView memory pressure                           | Release canvas buffers, image bitmaps, object URLs, readers, timers, and listeners         |
| Small image dimensions repeat across the compression ladder          | Identical encodes are repeated without improving size                                    | Visit each output dimension once and fail unavailable encoders promptly                    |
| Only per-operation timeouts exist                                    | Many encodes can keep the editor busy far longer than ten seconds                        | One 45-second preparation deadline, retaining ten-second operation bounds                  |
| Cancelling/unmounting only ignores some late callbacks               | Work continues and a closed speech editor can mutate its parent                          | Abort propagation and operation ownership; close/reset/done handling                       |
| Rules save/publish/autosave ignore preparation                       | Rules can persist or publish without the selected photo                                  | State plus immediate ref guard, paused autosave, disabled submit actions                   |
| Draft validation/save/server hydration clears image-selection errors | Failed photo silently disappears from the user's feedback                                | Keep selection errors until another selection/removal/reset; associate them with the input |
| Raw preparation errors conflate distinct failures                    | User cannot distinguish empty, oversized, unreadable, undecodable, and unencodable files | Typed error codes and specific Russian messages                                            |
| Output filename has no length cap                                    | A valid image can subsequently fail the 128-character contract                           | Keep the normalized extension within the contract limit                                    |

## Compatibility Boundaries

- Rules use up to 6,000,000 prepared bytes. The speech editor retains its
  existing 4,000,000-byte target. The source limit remains 64,000,000 bytes.
- The rules API limit is derived from the same 8,000,000-character base64
  limit. No evidence justified raising API, nginx, or contract limits.
- Original JPEG, PNG, GIF, BMP, TIFF and supported HEIC can still bypass a
  missing browser decoder within the prepared-byte limit. The server remains
  responsible for validating actual bytes and dimensions. A header hint is
  not a security validator or proof that a corrupted file is valid.
- WebP/AVIF still require browser conversion. The API's separate normalization
  helper is used by publication-import flows, not ordinary rules uploads;
  forwarding those originals to MAX would just move the failure downstream.
- HEIF containers are not automatically HEIC. Recognized HEIC bytes with a
  misleading `.heif` name are normalized; generic HEIF is not falsely claimed
  to be uploadable. Unsupported or oversized native HEIF receives a specific
  error. No heavyweight browser codec or new server upload endpoint is added.
- Animated GIFs are not silently flattened into one frame. Oversized GIFs
  remain subject to the existing prepared-byte limit.
- Existing text and attached images survive a failed replacement. Cancelling
  a multi-image run preserves images already prepared successfully.
- Native decoder APIs cannot forcibly stop all underlying browser work;
  cancelled results are ignored, late bitmaps are closed, and no new fallback
  stage starts after abort. Browser event-loop suspension can delay timers.

## Implemented Plan

1. Trace the screenshot's error through both editors, shared preparation,
   contracts, rules persistence, and MAX validation.
2. Repair metadata handling and browser fallback without changing API trust
   boundaries or adding dependencies.
3. Bound preparation, propagate cancellation, and release resources.
4. Gate rules submit/autosave and guard speech-editor lifecycle; retain
   actionable inline errors independently of text persistence.
5. Add unit and browser regression checks, verify mobile screenshots, run
   the full mini app checks and production-origin build.
6. Submit only owned paths, require exact-SHA CI, and deploy only
   `miniapp-major-static` through the guarded VPS wrapper. No migrations,
   API-role restarts, database operations, or test messages to real chats.

## Verification

Focused tests cover native/generic MIME, recognizable byte signatures,
filename caps, empty/oversized/unknown sources, unsupported decode, original
fallback, bounded reads/encodes, timeout, cancellation, late bitmap cleanup,
DOM canvas fallback, and duplicate compression dimensions.

`node apps/miniapp/test/rules-image-picker.browser.mjs` uses a randomly
allocated local Vite server and blocks external origins. It checks real PNG,
JPEG and WebP bytes, transparent/white pixels, bitmap-to-HTML fallback,
Offscreen-to-DOM fallback, native picker inputs, persistent errors across
autosave, same-file retry, cancellation, submit gating, preview-only rules
save/publication, closed-editor results, and failed replacement retention.
The matrix covers iPhone 15 light, iPhone SE dark, Pixel 7 light/dark and
desktop, using the safe MAX bridge shim. Screenshots are temporary artifacts,
not repository assets. This is browser/device emulation, not an assertion
that physical MAX iOS/Android clients were tested.

For an exact reproduction of the original complaint, request the original
file privately and record only its format/size, OS/MAX version, selected
screen and observed stage. Do not log image bytes, base64, names, chat IDs,
or init data. Client-local preparation failures need no production database
scan. Production smoke establishes delivery/health, not physical-device
decoding or successful publication to a real chat.
