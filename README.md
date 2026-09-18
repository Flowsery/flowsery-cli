# Flowsery CLI

Privacy-first web analytics and AI-detected session issues, from your terminal.

`flowsery` talks to the Flowsery REST API and nothing else. It prints traffic, revenue and realtime figures as tables for humans or as one JSON document for `jq`, breaks any of 25 dimensions down with filters the server would otherwise strip silently, runs a live dashboard in an alternate screen buffer, and tails AI-detected issues into any command you hand it.

Runs on Node 22.12 or newer. Also ships as a standalone binary with no Node requirement.

## Install

```bash
# npm, the usual path
npm install -g @flowsery/cli

# or run it without installing
npx -p @flowsery/cli flowsery --help

# macOS and Linux, standalone binary, no Node required
brew trust Flowsery/tap && brew install Flowsery/tap/flowsery

# or
curl -fsSL https://flowsery.com/install.sh | sh
```

`npx @flowsery/cli` prompts instead of running, because npx resolves a bin named after the unscoped package. Use `npx -p @flowsery/cli flowsery`. Plain `npx flowsery` resolves to the unscoped `flowsery` package, which is the browser tracking script, not this CLI.

Homebrew 7 refuses to load a formula from a third-party tap until you trust it, which is
what `brew trust` does. Skip it and both `brew install` and `brew upgrade` stop with
"Refusing to load formula ... from untrusted tap".

The install script downloads the release archive for your platform, verifies its checksum, and puts the binary in `~/.local/bin`. It never edits your shell rc files; it prints the `export PATH` line for you to add. Override the destination with `FLOWSERY_INSTALL_DIR`.

Both bins run the same program. `fsy` is the short one.

## Authentication

Create an API token at <https://flowsery.com/api-tokens> and hand it to `login`:

```bash
flowsery login
```

The command opens the token page, reads the token from a hidden prompt, checks the prefix locally, verifies it with one `GET /websites`, and writes it to `~/.config/flowsery/credentials.json` at mode 0600. Nothing is written if verification fails.

There are two kinds of token and they behave differently:

| Prefix | Kind | Scope |
|---|---|---|
| `flow_ws_` | Workspace token | Every website in the workspace. Reporting commands need a website selector |
| `flow_` | Website key | One website. The selector is ignored by the server, so the CLI stops sending it |

`login` accepts both and prints which one you pasted. With a website key, `--site` is unnecessary and never silently mismatches.

For CI, pipe the token in and skip the prompt:

```bash
echo "$FLOWSERY_TOKEN" | flowsery login --token-stdin --profile ci
```

Or skip `login` entirely and export `FLOWSERY_API_TOKEN`. The CLI reads it on every command. `FLOWSERY_API_KEY` works too, which is the spelling the MCP server uses.

There is no OAuth or device-code flow yet. There is also no `/me` endpoint on the API, so `whoami` reconstructs your identity from `GET /websites` and says so.

`logout` removes the profile from the credentials file. It does not revoke the token; do that in the dashboard.

## Quick start

```
$ flowsery login
  Opening https://flowsery.com/api-tokens in your browser.
  Create a token, then paste it here.

  Token (starts with flow_ws_): ****************************

  ✓ Token valid
    profile    default
    token      flow_ws_9f3a… (workspace token, all websites)
    api        https://analytics.flowsery.com/analytics/api/v1
    websites   4  (acme.com, blog.acme.com, docs.acme.com, +1 more)
    stored in  ~/.config/flowsery/credentials.json (0600)

  ℹ pick a default: flowsery config set defaultWebsite acme.com
```

```
$ flowsery whoami
  profile    default
  token      flow_ws_9f3a… (workspace token, all websites, from credentials file)
  api        https://analytics.flowsery.com/analytics/api/v1
  websites   4  (acme.com, blog.acme.com, docs.acme.com, +1 more)
  default    acme.com  (from config.json)
  limits     598 of 600 requests left this minute
```

```
$ flowsery stats overview --site acme.com --from -30d --timezone Europe/Berlin
  acme.com · Aug 19 → now · Europe/Berlin

  Visitors          48,210
  Sessions          61,004
  Bounce rate       42.10%
  Avg session       2m 14s
  Avg engaged time  1m 02s

  Revenue            $18,402.00
    new              $14,120.00
    renewal          $4,282.00
    refunded         $310.00
  Revenue / visitor  $0.38
  Conversion rate    1.42%

  KPI  1,204.00  ($0.02 / visitor, 2.49%)

  ℹ new revenue is revenue minus renewal revenue; the API does not send it.
```

## Website resolution, once, for every command

Every reporting command takes `--site <id|domain>`. Resolution order:

1. `--site`
2. `defaultWebsite` in `config.json`
3. The single website a `flow_` website key resolves to

With a workspace token and nothing resolvable, the command stops before the network with exit 2:

```
✗ No website selected.

  Pass --site <domain> or run: flowsery config set defaultWebsite acme.com
```

A value that looks like a domain is sent as `domain=`, a value that looks like an id as `websiteId=`.

## Shared reporting flags

| Flag | Default | Meaning |
|---|---|---|
| `--site <id\|domain>` | config | Website to report on |
| `--from <date>` | 30 days ago | ISO 8601, or an offset like `-7d` |
| `--to <date>` | now | ISO 8601, or an offset |
| `--timezone <tz>` | website timezone | IANA name |
| `--limit <n>` | 100 | 1 to 1000 |
| `--offset <n>` | 0 | |
| `--all` | false | Page until the server says there is no more |
| `-F, --filter <expr>` | none | Repeatable, see below |

`--filter` maps onto the twenty `filter_*` query params:

| Syntax | Meaning |
|---|---|
| `name=value` | equals |
| `name!=value` | not equals |
| `name~value` | contains |
| `name!~value` | does not contain |
| `name=a\|b\|c` | one of |

Names are `country region city device browser os referrer ref source via utm_source utm_medium utm_campaign utm_term utm_content page hostname entry_page channel goal`.

```bash
flowsery stats overview -F 'country=DE|AT|CH' -F 'page~/blog' -F 'device!=Mobile'
```

An unknown filter name is a usage error with exit 2, and that matters: the server strips unknown params without complaining, so a typo would otherwise return unfiltered numbers that look right.

`Unknown` and `Direct/None` are printed exactly as the API returns them. They match NULL or empty columns and work as filter values.

## The parts worth the install

**A live dashboard in the terminal.** `flowsery live` takes one alternate screen buffer and redraws it on a tick. Realtime every 10 s, today's totals and referrers every 60 s, open issues every 120 s, which is about 10 requests a minute out of 600. Every panel keeps its last good value and dims when its own fetch fails, so one bad endpoint does not blank the screen.

```
  acme.com                                          live · 17 visitors · 09:41:22

  RIGHT NOW                          TODAY
    17 visitors                        Visitors           6,204
                                       Sessions           7,910
  TOP PAGES NOW                        Revenue        $2,110.00
    /pricing                6          Conv rate           1.5%
    /                       4
    /docs/api               3        TOP REFERRERS TODAY
    /blog/cli-launch        2          google.com         2,880
                                       Direct/None        2,104
  WHERE                                reddit.com           612
    Berlin, DE              4
    Austin, US              3        OPEN ISSUES
    Lisbon, PT              2          critical  Checkout button d…  412
    London, GB              2          high      Rage clicks on /p…   88

  q quit · r refresh · o open dashboard
```

`--compact` prints one refreshing line instead, for a tmux status bar:

```
$ flowsery live --compact
acme.com · 17 now · 6,204 today · $2,110.00 · 1.5% · 4 open issues
```

**Tail issues into anything.** `flowsery issue tail` polls `GET /issues?sort=recency` and reports an issue when its id is new to the run or, unless `--new-only`, when its `lastSeenAt` moves forward. A moved `lastSeenAt` is the signal that a known issue is happening again right now.

```
$ flowsery issue tail --severity critical --severity high
  Tailing acme.com issues, severity ≥ high, every 120s. Ctrl-C to stop.
  09:41  NEW       critical  iss_4f2…  Checkout button does nothing on Safari 17  (412 sessions)
  09:43  RECURRED  high      iss_91b…  Rage clicks on /pricing plan toggle        (+12 sessions)
```

`--exec <cmd>` runs a child process per report with `FS_ID`, `FS_SEVERITY`, `FS_STATUS`, `FS_TITLE`, `FS_SESSIONS` and `FS_URL` set, which is the whole integration:

```bash
flowsery issue tail --severity critical --exec 'curl -s -X POST "$SLACK_WEBHOOK" \
  -d "{\"text\":\"[$FS_SEVERITY] $FS_TITLE ($FS_SESSIONS sessions) $FS_URL\"}"'
```

**Breakdowns that do not lie.** All 25 dimensions are accepted, `via` included, and eleven of them have named aliases that hit the dedicated routes. An unknown dimension is caught against the enum client-side with the full list, instead of letting the server 400.

**One visitor, end to end.** `flowsery visitor get <id>` prints the profile, the revenue, the time to conversion and the timeline of pageviews, goals and payments, with a footer saying every sub-list is capped at 100 server-side.

## Commands

Grammar is noun then verb, space-separated. `ls` works wherever `list` does, `rm` wherever `delete` does, and `view` wherever `get` does. Plural nouns are aliases: `sites`, `goals`, `payments`, `issues`, `visitors`.

### site

| Command | Key flags | Notes |
|---|---|---|
| `site list` | | Every website, with tracking id, API key prefix and KPI. Takes no parameters |
| `site metadata` | `--site` | Timezone, currency, KPI and logo for one website |

```
$ flowsery site list
  ID        DOMAIN         TZ             CUR  TRACKING ID  API KEY    KPI
  w_8f21…   acme.com       Europe/Berlin  USD  flid_9a2c…   flow_abcd  signups
  w_3b90…   blog.acme.com  Europe/Berlin  USD  flid_77de…   flow_ef01  —
  w_c012…   docs.acme.com  UTC            EUR  flid_1b4f…   —          —

  3 websites · default: acme.com
```

### stats

| Command | Key flags | Notes |
|---|---|---|
| `stats overview` | reporting flags | One row of totals, plus the revenue split and the KPI |
| `stats timeseries` | `--interval hour\|day\|week\|month` | One row per bucket with a bar. `--limit` and `--offset` are ignored, because the server ignores them |
| `stats realtime` | `--site` | Visitors in the last five minutes. Alias `now` |
| `stats map` | `--limit`, `--offset`, `--all` | The visitors on the site right now, newest first, capped at 1000 by the API |

```
$ flowsery stats timeseries --interval day --from -7d
  DATE      VISITORS  SESSIONS     REVENUE  CONV
  Sep 11       6,204     7,910   $2,110.00  1.5%  ▄▄▄▄▄▄
  Sep 12       6,880     8,402   $2,480.00  1.6%  ▅▅▅▅▅▅▅
  Sep 13       4,102     5,001   $1,204.00  1.1%  ▃▃▃
  …
```

```
$ flowsery stats map --limit 3
  WHERE       PAGE        SOURCE      SEEN  VIEWS  REVENUE
  Berlin, DE  /pricing    google       12s      4    $0.00
  Austin, US  /           Direct       31s      1    $0.00
  Lisbon, PT  /docs/api   reddit.com   48s      7   $49.00  ★ customer

  3 of 17 visitors
  ℹ next: flowsery stats map --offset 3 --limit 3
  ℹ the API caps this endpoint at 1000 visitors, most recent first.
```

### breakdown

`breakdown <dimension>` takes the reporting flags and any of the 25 dimensions. Eleven aliases hit the dedicated routes:

| Alias | Route |
|---|---|
| `pages` | `GET /pages` |
| `referrers` | `GET /referrers` |
| `channels` | `GET /channels` |
| `campaigns` | `GET /campaigns` |
| `hostnames` | `GET /hostnames` |
| `countries` | `GET /countries` |
| `regions` | `GET /regions` |
| `cities` | `GET /cities` |
| `devices` | `GET /devices` |
| `browsers` | `GET /browsers` |
| `os` | `GET /operating-systems` |

Anything else goes to `GET /breakdown` with `dimension=`. All 25 are accepted, `via` included: `device page entry_page exit_link hostname referrer channel campaign goal country region city browser browser_version os os_version utm_source utm_medium utm_campaign utm_term utm_content ref source via all_params`.

```
$ flowsery breakdown referrers --limit 5
  REFERRER              VISITORS   SHARE     REVENUE
  Direct/None             21,004   43.6%   $6,120.00
  google.com              14,882   30.9%   $7,402.00
  reddit.com               5,120   10.6%   $2,880.00
  news.ycombinator.com     2,004    4.2%     $920.00
  Unknown                  1,880    3.9%     $180.00

  5 of 62 rows
  ℹ next: flowsery breakdown referrers --offset 5 --limit 5
```

### goal

| Command | Key flags | Notes |
|---|---|---|
| `goal list` | `--site`, paging | Every goal with its completion count |
| `goal track <name>` | `--meta k=v`, `--visitor-uid`, `--session-uid`, `--timezone` | Name must match `^[a-z0-9_-]+$`, at most 64 characters. Repeated calls double-count |
| `goal delete` | `--name`, `--visitor`, `--from`, `--to`, `--yes` | At least one filter is required, enforced before the request |

```
$ flowsery goal delete --name signup_clicked --from 2026-09-01
  Delete goal completions matching: name=signup_clicked, startAt=2026-09-01.
  This cannot be undone.
  ? Delete them? › No / Yes
  ✓ Deleted 412 completions. The goal definition still exists.
    api said  deleted 412 goal completions
```

The delete filters are plain equality. The `!`, `~` and `|` operators do not apply there.

### payment

| Command | Key flags | Notes |
|---|---|---|
| `payment track` | `--amount`, `--currency`, `--transaction-id`, `--email`, `--name`, `--customer-id`, `--renewal`, `--refund`, `--at`, `--visitor-uid`, `--session-uid`, `--force` | Amount is in major units. `--amount 0` records a `free_trial` goal instead of a `payment` goal, and the CLI says so |
| `payment delete` | `--transaction-id`, `--visitor`, `--from`, `--to`, `--yes` | At least one filter is required |

`--amount`, `--currency` and `--transaction-id` are required unless you pass `--force`, because a payment with no transaction id can never be deleted. A repeated transaction id is rejected by the server rather than deduplicated, which is exit 6.

### issue

| Command | Key flags | Notes |
|---|---|---|
| `issue list` | `--status`, `--severity`, `--search`, `--sort severity\|recency`, paging | `--status` and `--severity` repeat. Date and `--filter` flags are refused here, because the API accepts them and then ignores them |
| `issue get <id>` | `--site` | Issue, steps to replicate, occurrences by offset, linked sessions, ticket and comments |
| `issue status <id> <status>` | `--site` | `open`, `in_progress`, `resolved`, `suspended`. Reversible; there is no delete |
| `issue tail` | `--severity`, `--interval`, `--exec`, `--new-only` | Above |

```
$ flowsery issue list --severity high --severity critical
  ID        SEV       STATUS       SESSIONS  LAST SEEN  TITLE
  iss_4f2…  critical  open              412  8m ago     Checkout button does nothing on Safari 17
  iss_91b…  high      in_progress        88  1h ago     Rage clicks on /pricing plan toggle
  iss_c30…  high      open               31  3h ago     Form submit 500s when coupon is applied

  open 4 · in progress 1 · resolved 9
  3 of 14 issues
  ℹ next: flowsery issue list --offset 3 --limit 100
  ℹ suspended issues appear only with --status suspended
```

On a free trial the API answers `Upgrade to view this issue` past the first ten. The CLI prints that verbatim with exit 9 and the billing URL.

### visitor

| Command | Key flags | Notes |
|---|---|---|
| `visitor get <id>` | `--site` | Profile, revenue, time to conversion and the timeline. Every sub-list is capped at 100 server-side |

### live

| Command | Key flags | Notes |
|---|---|---|
| `live` | `--site`, `--interval <seconds>`, `--compact` | Above. `q` or Ctrl-C restores the screen and exits 0 |

### Everywhere else

| Command | Key flags | Notes |
|---|---|---|
| `login` | `--token-stdin`, `--profile`, `--api-url`, `--name` | |
| `logout` | `--profile`, `--all` | |
| `whoami` | | Prints the token kind and which source each of the token and the API URL came from |
| `config list \| get \| set \| unset \| path` | | Reads and writes `config.json` |
| `open [what] [id]` | | `dashboard`, `site <id>`, `sites`, `issue <id>`, `issues`, `visitor <id>`, `realtime`, `tokens`, `billing` |
| `doctor` | `--json` | Node version, files, permissions, token, API reachability, the OpenAPI document, rate limit, default website |
| `completion <shell>` | | `bash`, `zsh`, `fish`, `powershell` |
| `mcp` | `--client`, `--local`, `--install` | Prints or installs the MCP client config |
| `api <method> <path>` | `-q/--query`, `-d/--data`, `-H/--header`, `-i/--include` | Raw authenticated request |

`api` is the escape hatch. A command we have not written yet never blocks you:

```bash
flowsery api GET /overview -q domain=acme.com -q startAt=2026-08-01
flowsery api GET /breakdown -q domain=acme.com -q dimension=via
flowsery api POST /goals -d '{"domain":"acme.com","name":"signup_clicked"}'
flowsery api POST /goals -d @body.json
```

Repeat `-q` with the same key for an array parameter. `-d @-` reads the body from stdin. An `Authorization` header is rejected, because the token comes from the resolved profile and the CLI never sends it anywhere but the configured API host.

## Global flags

Accepted at any position.

| Flag | Default | Meaning |
|---|---|---|
| `-p, --profile <name>` | `current` | Credential profile |
| `--json` | auto | Force machine mode |
| `-q, --quiet` | false | No spinners, hints or notices |
| `--no-color` | auto | Strip ANSI |
| `--debug` | false | Request log to stderr, token redacted |
| `--api-url <url>` | production | Override the base URL, for staging |
| `--token <token>` | resolved | One-shot token, highest precedence |
| `-y, --yes` | false | Skip confirmation prompts |
| `--no-input` | auto | Never prompt; fail with exit 2 instead |
| `--lang <code>` | unset | `en`, `fr`, `de`, `es`, `pt` |
| `--full-ids` | false | Print identifiers in full instead of truncating |
| `-V, --version` | | Prints `flowsery/1.3.2 node-v22.14.0 darwin-arm64` |
| `-h, --help` | | |

`--no-input` is implied when stdin is not a TTY.

## JSON output

Output mode is chosen for you. Human tables when stdout is a TTY, one JSON document when it is not, when `--json` is passed, when `CI` is set, or when `FLOWSERY_JSON=1`. So `flowsery breakdown pages | jq '.data[0].value'` works with no flag.

```json
{
  "ok": true,
  "command": "breakdown",
  "data": [{ "value": "/pricing", "visitors": 6204, "revenue": 211000 }],
  "meta": {
    "total": 62,
    "limit": 100,
    "offset": 0,
    "hasMore": false,
    "rateLimit": { "limit": 600, "remaining": 598, "resetSeconds": 41 }
  }
}
```

Four rules that will not change without a major version:

1. `data` is the API's payload unmodified. No renamed keys, no computed fields. The field is `sessionsCount`, not `sessionsAffected`.
2. `data` is an array for list commands, an object for single-object commands, `null` for commands with no payload.
3. `meta` carries paging and rate-limit information and nothing else.
4. Errors go to stderr as `{ "ok": false, "command": "...", "error": { "code", "status", "message", "details" } }` and the process exits non-zero. stdout stays clean.

In human mode every spinner, prompt, hint, warning and notice goes to stderr, so a pipe never swallows them and never receives them. `FLOWSERY_FORCE_TTY=1` keeps human output when piped, which is how the tables in this file were captured.

Add `--json` to a list command and the available field names are printed to stderr, so `flowsery issue list --json 2>&1 >/dev/null` documents the shape.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Generic failure, including 5xx |
| 2 | Usage error: bad flag, missing argument, unknown enum or filter name, no website selected, prompt needed under `--no-input` |
| 3 | Auth failure: 401, 403, missing or malformed token |
| 4 | Not found: 404 |
| 5 | Validation or other 400 |
| 6 | Conflict: 409, duplicate transaction id |
| 7 | Rate limited: 429 after retries |
| 8 | Network failure or timeout |
| 9 | Quota or plan limit: 402, `Upgrade to view this issue` |
| 130 | Interrupted with Ctrl-C |

## Configuration and profiles

Two files, on macOS and Linux under `${XDG_CONFIG_HOME:-$HOME/.config}/flowsery/` and on Windows under `%APPDATA%\Flowsery\`:

- `credentials.json`, mode 0600, tokens only. Written to a temp file and renamed over the target, so a crash never leaves a half-written or world-readable file. The CLI refuses to read it when the mode is group or world readable and prints the `chmod 600` line.
- `config.json`, mode 0644, preferences only. Safe to commit to a dotfiles repo.

A profile is a token plus the API URL it belongs to. Use them for several workspaces, for one website key per site, or for staging:

```bash
flowsery login --profile acme --name "Acme workspace"
flowsery stats overview --profile acme
export FLOWSERY_PROFILE=acme
```

Profile resolution: `--profile`, then `FLOWSERY_PROFILE`, then `current` in `credentials.json`, then `default`.

Token resolution, highest first: `--token`, `FLOWSERY_API_TOKEN`, `FLOWSERY_API_KEY`, the resolved profile.

Base URL resolution, highest first: `--api-url`, `FLOWSERY_API_URL`, the profile's stored `apiUrl`, the compiled-in default. A base URL is only ever read from your own flags, environment or config file. The CLI never takes a host from an API response.

`config` keys:

| Key | Meaning |
|---|---|
| `defaultWebsite` | Default for `--site` |
| `language` | Default `x-language` header |
| `updateCheck` | Set false to turn off the daily version check |
| `workspaceId` | Workspace this profile talks to |

```bash
flowsery config set defaultWebsite acme.com
flowsery config list
flowsery config path
```

Run `flowsery doctor` when something is off:

```
$ flowsery doctor
  ✓ node          v22.14.0 (>= 22.12.0)
  ✓ cli           1.3.2 (latest)
  ✓ config file   ~/.config/flowsery/config.json
  ✓ credentials   ~/.config/flowsery/credentials.json (0600)
  ✓ token         flow_ws_9f3a… valid, workspace token
  ✓ api           https://analytics.flowsery.com/analytics/api/v1  212 ms
  ✓ openapi       reachable, version 1.0.0
  ✓ rate limit    600 per 60s, 599 remaining
  ⚠ proxy         HTTPS_PROXY is set to http://corp:3128
  ✗ website       config.defaultWebsite "old.example.com" is not in this workspace
                  fix: flowsery config set defaultWebsite acme.com

  1 problem found.
```

It exits 1 when any check fails, 0 when only warnings appear, and supports `--json`.

## Environment variables

| Variable | Meaning |
|---|---|
| `FLOWSERY_API_TOKEN` | API token. Read first |
| `FLOWSERY_API_KEY` | Same thing, accepted for compatibility with the MCP server and skills |
| `FLOWSERY_API_URL` | Base URL. Defaults to `https://analytics.flowsery.com/analytics/api/v1` |
| `FLOWSERY_PROFILE` | Profile name |
| `FLOWSERY_DEBUG` | Set to `1` for the request log on stderr |
| `FLOWSERY_JSON` | Set to `1` to force machine output |
| `FLOWSERY_FORCE_TTY` | Set to `1` to keep human output when piped |
| `FLOWSERY_INSTALL_DIR` | Destination for the curl installer. Defaults to `~/.local/bin` |
| `NO_COLOR`, `FORCE_COLOR` | Honoured as usual |
| `CI` | When set, machine output and no update check |

Both token spellings work and `doctor` names the one in use. There is no third spelling; if you find one in older docs, it is wrong.

## Shell completion

The script is generated from the live command tree at runtime, so it cannot go stale. Installation instructions print to stderr, which is why `eval` on the stdout works directly.

```bash
# zsh
eval "$(flowsery completion zsh)"

# bash
eval "$(flowsery completion bash)"

# fish
flowsery completion fish | source

# powershell
flowsery completion powershell | Out-String | Invoke-Expression
```

Add the line to your shell rc file to keep it. The Homebrew formula installs completions for you.

## Links

- Dashboard: <https://flowsery.com/dashboard>
- API tokens: <https://flowsery.com/api-tokens>
- MCP server, for Claude, Cursor, VS Code and Windsurf: <https://mcp.flowsery.com/mcp>. Run `flowsery mcp` to print the client config, or `flowsery mcp --install` to write it.
- AdaptlyPost CLI, for social scheduling and publishing: <https://github.com/adaptlypost/adaptlypost-cli>
- RedReplier CLI, for Reddit and Hacker News mention monitoring: <https://github.com/RedReplier/redreplier-cli>
- Issues: <https://github.com/Flowsery/flowsery-cli/issues>

`Formula/flowsery.rb` in this repo is a reference copy of the Homebrew formula. Homebrew installs from the tap repo, `Flowsery/homebrew-tap`, and the release workflow rewrites the copy there with the real checksums. Editing the file in this repo changes nothing that users install.

Releases are tagged with a leading `v`, as in `v1.2.3`. The binary asset URLs, the install script and the formula all embed that tag.

## License

MIT. See [LICENSE](./LICENSE).
