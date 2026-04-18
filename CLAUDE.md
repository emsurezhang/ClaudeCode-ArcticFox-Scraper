# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

- `npm start` — Start the Fastify server (uses `tsx`).
- `npm run dev` — Start with `tsx watch` for hot reload during development.
- `npm run build` — Compile TypeScript to `dist/` (`tsc`).
- `npm run clean` — Remove `dist/` and `cache/`.
- **Debug mode**: append `-- --debug` to `npm start` or `npm run dev`. This passes `--debug` to the server process, which sets `isDebugMode = true`. In debug mode, Playwright runs non-headless so browser windows are visible. This is useful for troubleshooting DOM scraping.

There is **no test framework, linter, or formatter** configured in this project.

## Architecture Overview

This is a **Fastify-based API server** for scraping social media content. It uses a **plugin architecture** where each platform (YouTube, DouYin, X/Twitter, LinkedIn) is a dynamically loaded plugin.

### Core Modules

- **`src/core/server.ts`** — Entry point. Loads `config.json`, initializes `CookieManager` and `PluginManager`, registers Fastify routes (`/health`, `/api/plugins`, `/api/scrape`, `/api/plugins/:name/reload`). The `--debug` CLI flag is parsed here and merged into scrape options.
- **`src/core/plugin-manager.ts`** — Scans `plugins/` subdirectories, reads each `package.json` for a `plugin` manifest, then dynamically imports `index.ts` via `import(pathToFileURL(indexPath).href + '?t=' + Date.now())`. Supports chokidar-based hot reload: watches for `index.ts` and `package.json` changes and calls `reloadPlugin()`.
- **`src/core/cookie-manager.ts`** — Manages cookie caching in `./cache/cookies/<platform>_<browser>.txt`. When cookies expire (based on `ttlHours`), it spawns `yt-dlp --cookies-from-browser <browser>` to re-extract them.
- **`src/utils/whisper-transcriber.ts`** — Local audio transcription using `whisper-cli` (from `whisper.cpp` / Homebrew `whisper-cpp`). Requires `ffmpeg` for audio splitting. Models live in `./models/ggml-<name>.bin`. Long audio (>5 min) is auto-split into segments before transcription.
- **`src/interfaces/index.ts`** — Central type definitions: `IPlatformPlugin`, `ScrapeResult`, `ScrapeOptions`, `ServerConfig`, etc.

### Plugin Structure

Each plugin is a directory under `plugins/<name>/` containing:

- `package.json` — Must include a `plugin` field (type `PluginManifest`) with `name`, `hostnames`, and `capabilities`.
- `index.ts` — Must `export default` a class implementing `IPlatformPlugin`.

The plugin class must have:
- `readonly name`, `readonly hostnames`, `readonly capabilities`
- `canHandle(url: string): boolean`
- `scrape(url: string, options: ScrapeOptions): Promise<ScrapeResult>`

Plugins are loaded at runtime via dynamic `import()`. When modifying a plugin file, use the HTTP endpoint `POST /api/plugins/:name/reload` or rely on the file watcher (if `hotReload: true` in config).

### Cookie Flow

Plugins that need authenticated sessions (e.g., DouYin, X) typically:
1. Load cached cookies from `./cache/cookies/` via their own file-reading logic (see `DouYinPlugin.injectCookies`).
2. Inject them into the Playwright `BrowserContext` via `context.addCookies()`.
3. The `CookieManager` handles extraction from the system browser using `yt-dlp` when cache is missing or expired.

### Scrape Modes

- `detail` (default) — Scrape a single content item (video, tweet, post).
- `list` — Scrape a user/channel timeline or video list. Supported by YouTube (`maxItems`), X/Twitter (`maxItems` + `scrollStrategy`), and DouYin.

### External Dependencies

- **`yt-dlp`** — Used by YouTube plugin for audio/video download and by `CookieManager` for cookie extraction.
- **`whisper-cli`** (from `whisper.cpp` or Homebrew `whisper-cpp`) — Used for local audio transcription.
- **`ffmpeg`** — Required by WhisperTranscriber for audio conversion and splitting.
- **`playwright`** — Used by DouYin, X, and LinkedIn plugins for browser-based scraping.

## Known Issues & Technical Debt

Below is a prioritized inventory of known problems identified during codebase review. These should be checked before claiming the codebase is "production-ready".

### Critical (Security / Stability)

1. **No authentication by default** — `config.json` ships with `"token": ""`, which disables auth entirely. The API starts exposed to anyone who can reach the port.
2. **Permissive CORS** — `src/core/server.ts:87` sets `origin: true`, allowing cross-origin requests from any domain.
3. **No spawn timeouts** — `yt-dlp`, `ffmpeg`, and `ffprobe` are spawned without timeout wrappers. If the external binary hangs, the request hangs forever.
4. **No input validation on `/api/scrape`** — The endpoint accepts arbitrary request bodies. No limit on `urls` array length, no URL format validation, and no validation of numeric fields like `maxItems` or `timeout`.

### High (Reliability / Performance)

5. **LinkedIn plugin lacks cookie injection** — Unlike DouYin and X, it does not load cached cookies, so authenticated content cannot be scraped.
6. **X plugin hardcodes a 30-second wait** — `plugins/x/index.ts:293` unconditionally waits 30 s after finding the primary column, making every scrape take at least 30 s.
7. **URLs scraped sequentially** — `src/core/server.ts:140-168` loops over URLs in a `for...of`. Total time scales linearly with URL count.
8. **Temporary files never cleaned up** — Audio and subtitle files in `cache/temp/` accumulate indefinitely. YouTube and DouYin plugins never delete downloaded media.

### Medium (Maintainability)

9. **Heavy use of `any`** — 30+ occurrences across plugins, especially the X plugin where `Page` and `BrowserContext` are typed as `any`.
10. **Silent empty catch blocks** — 20+ `} catch { }` patterns swallow errors, making debugging difficult.
11. **Brittle DOM selectors** — DouYin uses obfuscated CSS class names (e.g., `.lC6iS6Aq`) and X relies on `data-testid` attributes that change frequently.
12. **No tests, linter, or formatter configured** — `package.json` has no `test` script and no dev tooling for code quality.

### Low (Observability / Polish)

13. **Unstructured logging** — Uses `console.log`/`console.error` everywhere instead of a structured logger with levels.
14. **README is entirely in Chinese** — Limits accessibility for non-Chinese-speaking contributors.
15. **No graceful shutdown** — `SIGTERM`/`SIGINT` handlers are missing; in-flight requests and browser instances are not cleaned up on exit.
16. **No dependency health checks** — Server startup does not verify that `yt-dlp`, `whisper-cli`, or `ffmpeg` are installed and working.

## Important Notes

- The project is **ESM only** (`"type": "module"`). Dynamic imports use `pathToFileURL()`.
- `tsconfig.json` targets `ES2022` with `moduleResolution: "node16"`. Source files must use `.js` extensions in import specifiers (e.g., `../interfaces/index.js`).
- `config.json` is optional; defaults are merged in `server.ts`.
- The DouYin plugin uses **Playwright response interception** to capture audio URLs from network traffic, then downloads the audio via `axios`. It also extracts `publishedAt` by parsing the DOM element `[data-e2e="detail-video-publish-time"]` (format: `发布时间：YYYY-MM-DD HH:mm`).
