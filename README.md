# heroku-dash

A keyboard-driven Heroku dashboard in your terminal, inspired by **gh-dash**.

Run **`heroku dash`** inside a Git repository to open its Heroku pipeline. Browse teams, pipelines, and apps; inspect resources and settings; scale dynos; and manage config without leaving your terminal.

## Install from this checkout

Requires a current [Heroku CLI](https://devcenter.heroku.com/articles/heroku-cli), Node.js 22+, and an interactive terminal. The minimum terminal size is 80 × 24; 120 × 36 or larger is recommended.

For the dashboard's icons, select a **[Nerd Font](https://www.nerdfonts.com/)** in your terminal settings. A **Nerd Font Mono** variant, such as **JetBrainsMono Nerd Font Mono** or **FiraCode Nerd Font Mono**, keeps icons aligned to the terminal grid. Missing or boxed icons usually mean the terminal is using an unpatched font.

```sh
npm ci
npm run build
heroku plugins:link .
heroku dash
```

Authentication uses your existing Heroku CLI login, including `HEROKU_API_KEY` when set. Run `heroku login` first if needed.

Try the offline demo without making any Heroku requests:

```sh
heroku dash --demo
```

To unlink the development plugin:

```sh
heroku plugins:unlink heroku-dash
```

## Usage

```sh
heroku dash                            # Detect the current repository's pipeline
heroku dash --pipeline my-pipeline     # Pipeline name or ID
heroku dash --app my-app               # App name or ID
heroku dash --remote staging           # App attached to a specific Git remote
heroku dash --team my-team             # Start in a team
heroku dash --read-only                # Disable all remote changes
heroku dash --refresh 60               # Refresh the current app every minute
heroku dash --refresh 0                # Manual refresh only
```

`--app`, `--pipeline`, `--remote`, and `--team` are mutually exclusive. The default refresh interval is 30 seconds; nonzero intervals must be at least 10 seconds.

### Repository detection

1. Explicit flags take precedence.
2. Detect Heroku HTTPS/SSH Git remotes, including named staging/production remotes and `heroku-accounts` SSH aliases. Look up each app's pipeline coupling.
3. If the remotes resolve to one pipeline, open its **pipeline overview**, rather than choosing a deployment implicitly.
4. Otherwise, match a pipeline to the **Git repository root directory name**, including when invoked from a subdirectory.
5. A single remote app without a pipeline opens directly. If no match exists, start in the workspace browser.

When remotes span multiple pipelines, the browser asks you to choose one. Use `--remote` to disambiguate. Duplicate pipeline names can be selected by ID with `--pipeline`.

### Workspace

The left sidebar browses teams, pipelines, or apps. Choosing a team scopes its pipelines and apps; **All teams / personal** clears the scope. Pipelines list apps ordered by stage. Open an app to see its seven views, with a selectable resource list above a scrollable details pane.

Nerd Font icons identify teams, pipelines, apps, process types, databases, and the app views. **Green** indicates healthy/successful states, **amber** indicates pending states or maintenance, **red** indicates failures, and **gray** indicates inactive or unknown states. Config rows use a lock for masked values and an amber eye for revealed values. Status text remains visible alongside icons and colors.

Pipeline stages are color-coded: **blue** development, **purple** review, **amber** staging, and **green** production. The active view and focused pane use Heroku purple. On narrower terminals, inactive tabs show their number and icon; the active tab keeps its name.

While data is loading, an OpenCode-inspired purple scanner (`■` / `⬝`) sweeps back and forth in the status bar, with a fading trail and a brief pause at each turn. It updates every 40 ms alongside the operation in progress. It covers pipeline/app loads, config vars, workspace refreshes, and confirmed changes, and stops when the work finishes.

| View | What you can do |
| --- | --- |
| **1 Overview** | Inspect app identity, team, region, stack, URLs, formation, and latest release |
| **2 Resources** | Inspect process commands, desired quantity, dyno size, individual dyno states and ages; scale quantity and size |
| **3 Add-ons** | Inspect services, plans, provisioning state, billing app, and local/shared attachments |
| **4 Config** | View config keys; reveal a selected value; create, replace, or delete variables |
| **5 Settings** | Inspect domains, ACM state, buildpacks, region, stack, and space; toggle maintenance mode |
| **6 Releases** | Inspect the latest 20 releases, including status, author, description, and timestamp |
| **7 Metrics** | View current dyno health, desired/running counts by process, crashed/starting counts, dyno ages, and recent deployment outcomes |

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| `t` / `p` / `a` | Browse teams / pipelines / apps |
| `j` / `k`, `↑` / `↓` | Move selection, or scroll the focused details pane |
| `Enter` | Open the selected item |
| `Tab` / `Shift-Tab` | Focus the next / previous pane |
| `/` | Filter sidebar names; submit an empty filter to clear |
| `Esc` | Return to pipeline / workspace, clear a sidebar filter, or cancel a prompt |
| `1`–`7` | Select an app view |
| `h` / `l`, `[` / `]`, `←` / `→` | Previous / next app view |
| `R` | Refresh the current app, pipeline, or workspace catalog |
| `Ctrl-L` | Redraw the terminal |
| `o` | Open the corresponding Heroku web dashboard page |
| `?` | Show keyboard help |
| `q` / `Ctrl-C` | Quit (`q` closes help; `Ctrl-C` also exits from input prompts) |

App actions:

| Key | View | Action |
| --- | --- | --- |
| `s` | Resources | Scale the selected process row (server icon, `[s] scale`); enter quantity and dyno size |
| `v` | Config | Reveal / hide the selected value |
| `e` | Config | Replace the selected variable's value |
| `n` | Config | Create a variable (or explicitly replace an existing key) |
| `d` | Config | Delete the selected variable |
| `m` | Settings | Toggle maintenance mode |

In prompts, `Enter` continues, `Esc` cancels, and `Ctrl-U` clears the input. Config-value input is masked. Editing replaces the complete value and currently supports single-line input; existing multiline values can be inspected but should be edited through the standard CLI or web dashboard.

## Remote changes and config values

Every write displays the target app and proposed change, then requires typing the **exact app name**. Scaling can change billing and restart dynos. Config changes create a release and restart the app. Maintenance mode affects request serving.

`--read-only` blocks all non-GET requests at the plugin's API boundary, in addition to disabling mutation prompts. The offline demo also runs read-only.

Config values are fetched only when opening Config. They stay masked until you press `v`; moving to another config row, switching views/apps, or manually refreshing hides them again. The plugin keeps fetched values in memory for the selected app and does not write config values to disk. Automatic refresh updates operational app data; use `R` to refresh config values.

## Metrics and current scope

The Metrics view uses real snapshots from the public Heroku Platform API. It counts `up` and `idle` formation dynos as healthy, excludes one-off processes from desired-formation health, and shows recent release outcomes. Dyno age is time since creation, not a historical uptime guarantee. During deploys, overlapping dynos can exceed the desired count.

**CPU, memory, throughput, and request-latency time series are not available through the public Platform API used here.** Press `o` in Metrics to open Heroku's metrics dashboard.

Add-on provisioning/plan changes, pipeline promotions, log streaming, domain/buildpack edits, and historical monitoring are outside this initial version. Settings other than maintenance mode are displayed read-only. Individual section failures are shown without preventing other sections from loading.

## Development and verification

Plain JavaScript ESM, an oclif/Heroku command, and Blessed terminal widgets. No application compilation step is required; `npm run build` generates the oclif command manifest.

```sh
npm run check             # Lint, automated tests, command manifest
npm pack --dry-run        # Inspect the publishable package
```

Tests use mocked transports and in-memory terminal streams. They cover repository resolution, pagination, partial API failures, read-only guards, confirmation validation, all three mutation paths, config masking, keyboard navigation, stale-response handling, and terminal cleanup.

### Explicit read-only integration checks

These are opt-in and use the current Heroku CLI account:

```sh
npm run test:live -- ~/work/hermod ~/work/heimdall
```

The live-check transport **rejects every method except GET**. It verifies repository-to-pipeline resolution and renders all seven app views, printing counts rather than config values. It reads every app in the detected pipelines.

After linking the plugin, macOS/Linux users with Python 3 can exercise the actual CLI in a pseudo-terminal:

```sh
python3 scripts/terminal-check.py
python3 scripts/terminal-check.py --repo ~/work/hermod
python3 scripts/terminal-check.py --repo ~/work/heimdall
```

Without `--repo`, this uses the offline demo. Live terminal checks always pass `--read-only --refresh 0`; mutation behavior is tested only with mocked APIs.

### Layout

```text
src/commands/dash.js   Command flags, authentication, startup
src/project.js         Git context and pipeline resolution
src/api.js             Platform API reads, pagination, guarded writes
src/ui/dashboard.js    Terminal navigation, prompts, refresh, lifecycle
src/ui/views.js        View models, config masking, operational metrics
src/ui/theme.js        Nerd Font icons, semantic colors, styled labels
src/ui/text.js         Terminal-safe text sanitization
src/demo.js            Offline demo data
test/                  API, project, view, and keyboard integration tests
scripts/               Explicit GET-only live and pseudo-terminal checks
```

## License

MIT
