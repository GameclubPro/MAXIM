# Major networks bundle boundaries

The later [Zod security baseline](zod-security-bundle-baseline-2026-10-24.md)
updates nine JavaScript caps for the patched validator runtime. The table below
records the original interface release; current caps are in `route-budgets.json`.

The production build measures gzip bytes with `VITE_API_BASE=https://major-maksimov.ru/api/v1`.
The network catalogue, individual settings, shared forms, advanced editors and operation recovery
remain separate loading boundaries. Public comment/suggestion and Publisher launches do not
load the network editor. Moving code into the startup baseline is not an optimization.

## Canonical interface limits

Networks mount the original individual settings controls: nineteen chat sections and four channel
sections, with the original hints, presets, sliders, duration controls, speech/media sheets,
stop-word editor, source pickers, admin contact, allowlist and channel signature preview. Earlier
aggregate limits described reduced controls and did not represent this complete interface.
The following limits explicitly replace them; no deferred module is removed from measurement.

| Path                                           | Previous limit | Canonical release limit |       Production measurement |
| ---------------------------------------------- | -------------: | ----------------------: | ---------------------------: |
| Startup JS, configured base                    |      130,688 B |               131,584 B | 128.7 KiB with API allowance |
| Individual chat settings JS, incremental       |        152 KiB |                 154 KiB |                    152.8 KiB |
| Individual chat settings CSS, incremental      |         78 KiB |                  78 KiB |                     77.1 KiB |
| Network forms JS, incremental                  |        112 KiB |                 165 KiB |                    161.4 KiB |
| Network forms CSS, incremental                 |         51 KiB |                  66 KiB |                     65.0 KiB |
| Network actions and advanced editors JS        |         44 KiB |                  49 KiB |                     47.6 KiB |
| Network actions and advanced editors CSS       |         32 KiB |                  33 KiB |                     32.5 KiB |
| Complete network editing flow JS, incremental  |        156 KiB |                 214 KiB |                    209.0 KiB |
| Complete network editing flow CSS, incremental |         82 KiB |                 100 KiB |                     97.5 KiB |
| Network operation cold recovery JS             |        192 KiB |                 192 KiB |                    185.2 KiB |
| Network operation cold recovery CSS            |         66 KiB |                  66 KiB |                     64.3 KiB |
| Chat events JS, incremental                    |         46 KiB |                  47 KiB |                     46.4 KiB |

The startup change is 896 bytes of configured headroom. Its existing 512-byte absolute-API
allowance is unchanged. The shared viewport fix also applies to existing drilldown panels:
it keeps their input inside the visible viewport when a native keyboard opens. The individual
settings and events limits include the resulting shared module boundary, rather than omitting it.
No channel-settings, comments, suggestion, Publisher or catalogue limit is increased.

## Optimizations and accounting

The subscription picker imports only the original selectors it needs, preserving their cascade
and computed presentation. This removes 6.3 KiB gzip of unrelated giveaway styles. Component
semantic tokens retain the original values and its new stylesheet is scoped to Major. Shared
icons use the existing `AppIcon` sprite with the same Iconoir artwork and original dimensions
and stroke width. The robot portrait remains a separate cacheable image.

A measured grouping of static form leaves saved only 1.6 KiB and broadened other callers, so it
is not retained. Combining the entire manifest would produce larger theoretical compression
savings but would also load later editors and unrelated routes early. The release retains those
loading boundaries. The remaining increase pays for the actual original controls, their
validators and styles; it is not presented as a loading-speed improvement.

The complete-flow budget is the union of every supported form, preview, durable-operation
recovery, explicit confirmation, speech/media editing, rich text/clipboard, stop-word presets,
rules composer, button editor, night time wheels and exact time input. Modules loaded by a user
action are explicitly listed in `route-budgets.json` and deduplicated through the manifest. A
single opened section loads a subset of this aggregate. The individual settings budget measures
its entry closure, so it is not directly comparable to the union of every network action.

These are production build sizes, not real-device timing or production latency claims. Original
controls and layout are covered by focused iPhone/Android browser cases and comparison of the
single and group forms, including mixed values, invalid buffers and keyboard visibility.

```bash
npm run build:miniapp:production
node apps/miniapp/test/networks.browser.mjs
node apps/miniapp/test/rules-image-picker.browser.mjs
```
