# gerivan-status · 24/7 DNS & uptime monitor

Server-side monitor for **[gerivan.me](https://gerivan.me)** that runs on GitHub Actions every 15 minutes, around the clock, even when nobody has the status page open.

Live page: **https://gerivan.me/status.html**

## What it checks (every run)

| Check | Details |
|---|---|
| **NS** of `gerivan.me` | From 21 cities (Google Public DNS + EDNS Client Subnet, RFC 7871), including Santa Cruz do Sul (BR), plus 5 public resolvers |
| **A** of `gerivan.me` | Same 26 checkpoints, consensus + divergence per location |
| **CNAME** of `dnapass`, `entropy`, `transformers`, `xphrase` | Must point to `gerivanc.github.io` |
| **HTTPS** of every host | HTTP status code and response time |
| **TLS certificate** | Trust chain and days until expiry (warning at 14 days) |
| **Security snapshot** | DNSSEC, CAA, SPF, DMARC |

## How it works

```
main branch                         data branch (single commit, force-pushed)
├─ .github/workflows/dns-monitor.yml   ├─ status.json   ← read by status.html
├─ monitor/check.mjs                   ├─ history.json  (7 days, compact)
└─ monitor/config.json                 ├─ daily.json    (90 daily buckets)
                                       └─ state.json    (incident tracking)
```

1. The workflow restores the previous results from the `data` branch.
2. `monitor/check.mjs` runs all checks (Node 20, no dependencies).
3. The results are force-pushed as a **single commit** to `data`, so the repository never grows.
4. `status.html` fetches `https://raw.githubusercontent.com/gerivanc/gerivan-status/data/status.json` every 5 minutes and shows the 24 h / 7 / 30 / 90-day uptime, the 90-day bar chart and recent incidents.

## Alerts

When a problem is confirmed in **2 consecutive runs**, the monitor opens a GitHub **issue** in this repository, and GitHub notifies you by e-mail and in the app. When everything recovers, it comments and closes the issue on its own. Turn this off with `"githubIssues": false` in `monitor/config.json`.

## Configuration — `monitor/config.json`

| Key | Meaning |
|---|---|
| `zone` | Apex domain |
| `subdomains` | Hosts checked as CNAME + HTTPS |
| `expectCname` | Expected CNAME target |
| `certWarnDays` | Days before expiry that count as degraded |
| `historyDays` / `dailyDays` | Retention |
| `alerts.confirmRuns` | Consecutive failed runs before an incident is opened |

## Notes

- Keep this repository **public**: GitHub Actions is free and unlimited for public repositories. A private repository would use up the monthly free minutes in a few weeks.
- GitHub may delay scheduled runs by a few minutes when it is busy; the page marks the data as *stale* if no run happened for 45 minutes.
- GitHub can pause scheduled workflows in repositories with no activity for 60 days. If that happens, open **Actions → DNS monitor → Enable workflow**.
- Run it at any time: **Actions → DNS monitor → Run workflow**.

MIT License · © 2025-2026 Gerivan Costa dos Santos
