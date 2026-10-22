# Major networks bundle boundaries

The production build measures gzip bytes with the real VITE_API_BASE. Existing public
cold-launch paths remain independent of the Major home, network forms, attachment preparation
and VK settings. Code splitting must preserve these boundaries; moving bytes into the startup
baseline does not establish a faster direct launch.

## Measured limits for the first interface release

Networks reuse the individual settings tiles, panels, fields and styles. The complete supported
set contains nineteen chat sections and four channel sections, including speech style, rules,
message retention, advertising and channel suggestions. The original provisional budgets
covered the earlier incomplete form set and its separate presentation. They are replaced with
explicit measurements of the complete shared interface:

| Path                                           |      Previous limit |      Release limit |            Production measurement |
| ---------------------------------------------- | ------------------: | -----------------: | --------------------------------: |
| Startup JS                                     |           126,592 B | 130,688 B (+4 KiB) | 128.2 KiB including API allowance |
| Individual chat settings JS, incremental       |           149,120 B |          155,648 B |                         150.9 KiB |
| Individual chat settings CSS, incremental      |              76 KiB |             78 KiB |                          76.9 KiB |
| Network forms JS, incremental                  |  provisional 80 KiB |            112 KiB |                         109.6 KiB |
| Network forms CSS, incremental                 |  provisional 16 KiB |             48 KiB |                          47.3 KiB |
| Network actions and advanced editors JS        |  provisional 32 KiB |             44 KiB |                          42.4 KiB |
| Network actions and advanced editors CSS       |  provisional 12 KiB |             32 KiB |                          30.7 KiB |
| Complete network editing flow JS, incremental  | provisional 104 KiB |            156 KiB |                         152.1 KiB |
| Complete network editing flow CSS, incremental |  provisional 24 KiB |             80 KiB |                          78.1 KiB |
| Network operation cold recovery JS             |             192 KiB |            192 KiB |                         184.2 KiB |
| Network operation cold recovery CSS            |  provisional 56 KiB |             66 KiB |                          64.3 KiB |

The shared favorites session adds account and assignment reconciliation to home loading.
Individual settings also gain authored-field adapters and shared presentation primitives.
The complete network budget counts every actual form, its canonical runtime validators,
preview, durable-operation actions, confirmation, rich text/clipboard, stop-word presets,
rules composer and button editor. These deferred modules remain explicitly listed and are
deduplicated through the build manifest; they are not omitted to satisfy a limit.

Keeping the shared speech preview context out of the forced individual-settings chunk removed
about 96 KiB gzip from the aggregate network forms graph. A single section loads lazily; the
complete-flow measurement is the union of all supported forms and actions. Canonical settings
and rules styles account for the CSS increase required to render the same interface.

No comments, channel-settings or Publisher limit is increased. Network cold recovery keeps its
192 KiB JavaScript cap without a home-baseline subtraction. These are build measurements,
not real-device timing or production p95 claims. Canonical schema compatibility and attachment
ownership after delayed code/file loading have focused regression coverage.

```bash
npm run build:miniapp:production
node apps/miniapp/test/networks.browser.mjs
node apps/miniapp/test/comment-dialog-attachments-async.browser.mjs
```
