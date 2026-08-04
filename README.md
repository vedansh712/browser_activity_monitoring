# Track Daily

A Chrome extension that tracks how you actually spend time in your browser, categorises it automatically, and gives you deep analytics for YouTube.

Everything runs and stays on your machine. The extension makes **no network requests to any third party** — no analytics, no telemetry, no icon CDN, no AI API.

## Features

- **Accurate time tracking** — per tab, pausing on idle and screen lock, with sleep-gap detection so a closed laptop doesn't log phantom hours
- **Automatic categorisation** — domain rules, keyword heuristics, similarity matching against your own past choices, and optional on-device AI
- **YouTube analytics** — per-video watch time, channel breakdown, and content categories, including single-page navigation between videos
- **Dashboard** — daily / weekly / monthly views, hourly activity heatmap, sortable domain table, CSV export
- **Custom categories** — create your own, with colours and domain rules

## Install (development)

```bash
git clone <repo-url>
```

Then in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the project folder

Requires Chrome 104 or later. The optional on-device AI needs Chrome 138+ with the built-in model available.

## Development

```bash
npm test
```

Tests use the Node built-in test runner — no dependencies to install. They cover the pure domain logic: time accounting, aggregation, categorisation, HTML escaping, CSV serialisation, and the AI classifier's caching and validation.

## Architecture

Three layers, with dependencies pointing inward only:

```
shared/       Domain + pure utilities. No chrome.* APIs, no DOM.
              Directly unit-testable.

background/   Application services and infrastructure adapters.
              container.js is the composition root — the single place
              where implementations are chosen and wired.

popup/        Presentation. Reads through the message router or the
dashboard/    storage adapter; contains no domain logic.
options/
content-scripts/
```

### Key modules

| Module | Responsibility |
|---|---|
| `shared/data-models.js` | Session lifecycle and daily aggregation. All time arithmetic lives here. |
| `shared/category-registry.js` | Single lookup over built-in + custom categories, used by every UI. |
| `shared/html.js` | `html\`\`` tagged template that escapes by default; `render()` rejects unescaped strings. |
| `background/aggregate-service.js` | Read-through cache over daily aggregates, with staleness validation. |
| `background/ai-classifier.js` | On-device classification with constrained decoding and prompt-injection defences. |
| `background/storage-manager.js` | The only module that touches IndexedDB and `chrome.storage`. |

### Notes for contributors

**Session timing.** A session holds `duration` (banked time from closed intervals) and `startTime` (when the current interval began). Every state transition banks the open interval before changing state, which makes pause / resume / end idempotent. Open intervals are clamped to `MAX_TRACKED_INTERVAL_MS`, because an interval longer than the flush period means the machine slept rather than the user browsing.

**MV3 lifecycle.** The service worker is destroyed after roughly 30 seconds of inactivity. Every `chrome.*` listener must be registered synchronously at module top level, and any state that must survive belongs in `chrome.storage`, never in a module variable.

**Aggregates are a cache.** Sessions are the source of truth. A daily aggregate can always be rebuilt from them, and is rebuilt whenever its recorded session count disagrees with the live count.

**Building markup.** Use the `html\`\`` tag from `shared/html.js`. It escapes interpolated values automatically, and `render()` refuses anything that is not `SafeHtml`, so user input cannot reach `innerHTML` unescaped.

## Permissions

| Permission | Why |
|---|---|
| `tabs` | Read the active tab's URL and title to attribute time |
| `idle` | Pause tracking when you step away or lock the screen |
| `storage` | Persist settings, categories, and the live session |
| `alarms` | Periodic flush of the running session |
| `webNavigation` | Detect in-app navigation on single-page sites |
| `unlimitedStorage` | Keep long browsing histories in IndexedDB |
| `favicon` | Render site icons from Chrome's local cache instead of a remote service |
| `*://*.youtube.com/*` | Extract video metadata for YouTube analytics |

There are no other host permissions and no optional permissions.

## Privacy

See [PRIVACY.md](PRIVACY.md). In short: all data stays in your browser's local storage, nothing is transmitted anywhere, and you can delete everything from the options page at any time.

## License

See [LICENSE](LICENSE).
