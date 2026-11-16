# iCloud Desk

**English | [简体中文](README.zh-CN.md)**

iCloud Desk is an unofficial native Windows desktop client for iCloud, styled after iCloud.com, paired with an AI-Agent-friendly JSON CLI (`icd`). It supports **Calendar**, **Reminders**, **Notes (read & write)**, **iCloud Drive**, **Photos**, **Contacts**, **Find My**, **Hide My Email**, and **Account**.

- **Sign in once**: Authenticate with your Apple Account password + Two-Factor Authentication; your trusted session persists locally.
- **Native Windows integration**: Per-user installer with Start Menu shortcut, `App Paths` registration, `Apps & Features` uninstaller, system tray residency, and global hotkey.
- **Multilingual (`English` & `简体中文`)**: Follows your system language automatically and switches live in the UI without reloading.
- **Agent-ready `icd` CLI**: Every module can be read and modified via structured JSON on stdout, sharing the desktop app’s background daemon and session.

## Installation

1. Download `iCloudDesk-Setup-<version>.exe` from [GitHub Releases](https://github.com/CanderFlower/icloud-desk/releases) (or build `dist\iCloudDesk-Setup-<version>.exe` locally) and run it. Installs per-user — no administrator privileges required.
   - Install directory: `%LOCALAPPDATA%\Programs\iCloud Desk`.
   - Registers Start Menu shortcuts, an uninstaller entry, and Windows `App Paths` (launch via `Win+R` → `iCloudDesk` or `icd`).
   - Installer wizard supports English and Simplified Chinese; **Add `icd` to PATH** is checked by default (open a new terminal to use `icd`).
2. Launch **iCloud Desk**, sign in with your Apple Account, and complete Two-Factor Authentication.
3. Silent install: `iCloudDesk-Setup-x.y.z.exe /VERYSILENT /TASKS=addtopath`

Requires the Microsoft Edge WebView2 Runtime (preinstalled on Windows 10 and Windows 11).

### Window & System Tray

- Closing the window (`✕` or `Alt+F4`) hides it to the system tray by default instead of quitting. Right-click the tray icon to **Quit** or toggle **Hide to tray when closing**.
- Global shortcut `Ctrl+Alt+R` shows or hides the window from anywhere (displays `(in use)` in the tray menu if another app already claimed the hotkey).
- Launching `iCloudDesk` again brings the existing hidden window to the foreground.

### Multilingual Support (`English` / `简体中文`)

- **Auto-detection & live switching**: Defaults to `System` (Simplified Chinese on `zh*` locales, English otherwise).
- **UI switcher**: Click the globe icon on the top-right of the sign-in screen, or open the bottom-left account menu → **Language** (`System`, `简体中文`, `English`) to switch live without reloading.
- **Full-stack sync**: Switching languages updates the web UI, date/weekday formatting, native Windows tray menu, error views, and localized backend messages simultaneously.
- **CLI language**: `icd` detects the OS language automatically, or accepts `--lang {auto,zh,en}` and `ICD_LANG=en`.

### Local Snapshot Cache

Calendar, Reminders, Notes lists, and Drive folders keep account-scoped local snapshots so switching modules or reopening the window renders immediately while revalidating in the background (stale after 60 seconds, retained up to 7 days). Manual refresh (`F5` or toolbar button) always fetches live data; offline sync errors preserve cached views with a toast notice.

Snapshots are isolated by Apple Account and region (`icloud.com` vs `icloud.com.cn`), invalidated automatically on writes, and wiped on sign-out. Note bodies are still fetched live before editing. On startup, the desktop shell also reuses an already-running local daemon directly.

## CLI (for Scripts & AI Agents)

```powershell
icd guide                       # Complete self-contained reference — hand this output to any AI Agent
icd calendar events --days 7
icd calendar add --title "Team Sync" --start "tomorrow" --duration 60 --calendar Work
icd reminders add --title "Submit report" --due +2d --priority high
icd notes add --folder Notes --text "Title`n- [ ] First item`nBody text"
icd notes get <ID> --format markdown
icd drive upload .\a.pdf --to /Documents
icd api GET /api/account        # Raw access to any local REST endpoint
```

- **Output format**: Structured JSON on `stdout`; errors emit `{"error": ...}` on `stderr`.
- **Exit codes**:

  | Code | Meaning |
  |---|---|
  | 0 | Success |
  | 1 | Runtime / API error |
  | 2 | Invalid CLI usage |
  | 3 | Not signed in |
  | 4 | Resource not found |
  | 5 | Conflict or locked |

- **Global flags**: `--compact` (single-line JSON), `--ascii` (escape non-ASCII as `\uXXXX`), `--demo` (in-memory demo data), `--lang {auto,zh,en}`.
- **Shared daemon**: `icd` automatically starts `icd daemon` on demand and shares the same login session as the desktop app.
- **UTF-8 piping on Windows**: Set `$env:ICD_UTF8=1` or pass `--ascii` if your shell pipe mangles non-ASCII characters.

## Features

| Module | Capabilities |
|---|---|
| Calendar | Read/Write: Month, Week, Day, and List views; drag to create/move/resize; create/edit/delete events & calendars |
| Reminders | Read/Write: User lists & smart lists (Today, Scheduled, All, Flagged, Completed), inline editing, due dates, priority, flags, subtasks |
| Notes | Read/Write: Folder tree, block rich-text editor (headings, lists, checklists, bold/italic/underline/strikethrough, code blocks, links), auto-save, Recently Deleted & recovery; locked notes are read-only |
| iCloud Drive | Read/Write: Finder-style icon & list views, drag-and-drop upload, mkdir, rename, move, Recently Deleted, Quick Look (`Space`) |
| Photos | Read/Write: Library & albums, justified day-grouped grid, lightbox viewer, favorites, upload, delete, original download |
| Contacts | Read-only: Pinyin & Latin alphabetical index, upcoming birthday badges, vCard (`.vcf`) export |
| Find My | Devices, battery status, OpenStreetMap location view, Play Sound, Send Message, Lost Mode |
| Hide My Email | Generate random aliases, create, edit label/note, deactivate/reactivate, delete |
| Account | Profile, iCloud storage breakdown, signed-in Apple devices, Family Sharing |

Writable Notes support (`app/notes_*.py`) speaks the same CloudKit `records/modify` API and CRDT/protobuf (`TTMergeableString`) format as iCloud.com Notes, including optimistic concurrency checks via `recordChangeTag`.

## Authentication Notes

- **App-specific passwords do not work.** Apple restricts app-specific passwords to CalDAV, CardDAV, and IMAP; iCloud web services (Notes, Drive, Photos, Find My, Hide My Email) require your primary Apple Account password + 2FA.
- Session cookies and trust tokens are stored in `%APPDATA%\icloud-desk` (override with `ICLOUD_DESK_HOME`).
- When **Keep me signed in** is checked, your password is saved in **Windows Credential Manager** so expired web sessions renew silently without repeating 2FA.
- For China mainland accounts operated by GCBD, check **China mainland iCloud account (`icloud.com.cn`)**.

## Architecture

```
iCloudDesk.exe  (shell/)       C# .NET 8 + WebView2 native shell: custom caption bar, tray, hotkey, single-instance
      │ spawns or reuses
      ▼
icd.exe daemon  (app/, PyInstaller)
      Per-user loopback HTTP service (127.0.0.1, Bearer/HttpOnly-cookie token auth)
      FastAPI + pyicloud, serves web/ static ES modules and localized /api/* JSON endpoints
      ▲
icd.exe <command>  (app/cli.py)  CLI client talking to the same background daemon
```

| Path | Description |
|---|---|
| `app/daemon.py` | Background daemon lifecycle & discovery (`%APPDATA%\icloud-desk\daemon.json`) |
| `app/i18n.py` | Backend & CLI locale context (`zh-CN` / `en`) |
| `app/server.py`, `app/routes/*.py` | FastAPI REST endpoints (`/api/<module>/...`) |
| `app/demo.py` | In-memory demo mode (`--demo`) with localized sample data |
| `web/` | Buildless native ES Module frontend |
| `web/styles.css`, `web/css/<module>.css` | Design system & module stylesheets |
| `web/js/i18n.js` | Frontend localization, live switcher, and pluralization helpers |
| `web/js/cache.js` | Account-scoped snapshot cache with background revalidation |
| `web/js/ui.js` | Shared UI components: modal, menu, popover, toast, icons, locale-aware date formatting |
| `web/js/modules/*.js` | Feature modules (`export default { id, get title(), app, mount(el) }`) |
| `web/assets/icons.svg` | Lucide icon sprite generated by `scripts/build_icons.py` from `web/assets/icons.txt` |
| `web/assets/apps/` | iCloud application icons |
| `shell/` | C# WinForms + WebView2 desktop shell (including `shell/I18n.cs`) |

## Development

```bat
run.bat                         :: Creates .venv on first run and opens the UI in browser (real account)
run.bat --demo ui               :: Launches with in-memory demo data (no Apple Account needed)
run.bat --demo daemon restart   :: Restart the local Python daemon after backend edits
.venv\Scripts\python -m pytest  :: Run Python tests (Notes CRDT/protobuf codec, Drive cache, i18n)
node --test tests\*.test.mjs    :: Run frontend cache & i18n unit tests
```

Frontend files need no bundler — edit under `web/` and refresh.

### Packaging

Prerequisites:

- Python 3.11+
- .NET 8 SDK
- [Inno Setup 6](https://jrsoftware.org/isdl.php)
- `pip install -r requirements-build.txt`

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build.ps1            # Full build -> dist\iCloudDesk-Setup-x.y.z.exe
powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -SkipShell # Repackage Python core only
```

The version number lives in `app/__init__.py`.

## Known Limitations

- **Notes**: Notes containing attachments, tables, or drawings default to read-only. You can force-edit (`Edit Anyway` in UI or `--force` in CLI), which overwrites the body without attachments.
- **Contacts**: Currently read-only.
- **Calendar**: Repeating events and invitee events are currently view-only.
- Powered by [pyicloud](https://github.com/timlaing/pyicloud); upstream changes to Apple’s private web APIs may require updating `pyicloud` and repackaging.

## License & Disclaimer

- Released under the [MIT License](LICENSE).
- Unofficial third-party client, not affiliated with or endorsed by Apple Inc. “iCloud” and iCloud application icons are trademarks/copyrights of Apple Inc.; UI icons are from [Lucide](https://lucide.dev/) (ISC License).

