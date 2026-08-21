# Privacy Policy — Track Daily

_Last updated: 2026-08-01_

## Summary

Track Daily records your browsing activity so it can show it back to you. All of that data is stored locally in your own browser and is never transmitted anywhere. The extension makes no network requests to any third-party service.

There is no server, no account, no analytics, and no telemetry.

## What is collected

The extension stores the following, locally:

- **Page visits** — URL, page title, domain, start and end time, and duration
- **Categories** — the category assigned to each visit, your manual overrides, and any categories you create
- **YouTube metadata** (when YouTube Deep Tracking is enabled) — video ID, title, channel name, video category, and duration, for videos you watch
- **Settings** — your preferences, such as idle threshold and retention period

## Where it is stored

| Data | Location | Lifetime |
|---|---|---|
| Page visits, daily summaries, learned categorisations | IndexedDB (`track_daily_db`) | Until the retention period expires or you delete it |
| Settings, categories, domain overrides | `chrome.storage.local` | Until you delete it |
| The in-progress session, pending categorisations, AI result cache | `chrome.storage.session` | Cleared when you close the browser |

All of these live inside your Chrome profile on your own device.

## What is transmitted

**Nothing.**

The extension has no backend. It contains no analytics or crash reporting. It does not load remote fonts, scripts, stylesheets, or images.

Site icons are read from Chrome's own local favicon cache via the `favicon` permission, so displaying them does not contact any server.

## On-device AI classification

The extension can optionally use Chrome's built-in AI model to categorise sites it does not recognise.

- It is **off by default** and must be explicitly enabled in settings
- The model runs **entirely on your device**; the domain and page title are given to a local model and are not sent over the network
- No API key is required, and no third-party AI provider is involved
- The large model download only ever starts when you click the download button yourself

Earlier versions of this extension supported sending data to external AI providers (OpenAI, Anthropic, Google). **That capability has been removed entirely.** If you had previously saved an API key, it is deleted automatically when the extension updates.

## What is never collected

- Passwords, form contents, or anything you type
- Page content beyond the title and meta description
- Cookies, credentials, or authentication tokens
- Any personally identifying information
- Browsing in Incognito windows (unless you explicitly allow the extension there)

## Your control over your data

From the extension's options page you can:

- **Exclude domains** so they are never tracked
- **Set a retention period** — data older than this is deleted automatically
- **Disable tracking** entirely at any time
- **Clear browsing history** — deletes all recorded visits and summaries, keeping your settings
- **Reset everything** — deletes all data and settings, returning the extension to its initial state

You can also export your data as a CSV file from the dashboard.

Uninstalling the extension removes all of its stored data from your browser.

## Data sharing

There is no data sharing. Your data is never sold, transmitted, or made available to anyone, including the developer, because it never leaves your device.

## Changes

If this policy changes in a way that affects what is collected or transmitted, the change will be described in the extension's release notes.

## Contact

Please open an issue in the project's repository with any questions about this policy.
