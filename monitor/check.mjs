#!/usr/bin/env node
/**
 * gerivan.me — 24/7 DNS & uptime monitor
 * ---------------------------------------------------------------
 * Runs inside GitHub Actions (Node 20+, no dependencies).
 *  - Resolves NS / A for the apex and CNAME for every subdomain from
 *    25 vantage points (Google Public DNS + EDNS Client Subnet, RFC 7871)
 *    plus 5 public resolvers queried directly.
 *  - Probes HTTPS for every host and reads the TLS certificate expiry.
 *  - Takes a small security snapshot (DNSSEC, CAA, SPF, DMARC).
 *  - Writes DATA_DIR/status.json, history.json, daily.json, state.json.
 *  - Optionally opens a GitHub issue when an incident is confirmed and
 *    closes it when everything recovers (GitHub notifies the repo owner).
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import tls from 'node:tls';

const CONFIG = JSON.parse(await readFile(new URL('./config.json', import.meta.url), 'utf8'));
const DATA_DIR = process.env.DATA_DIR || 'data';
const TIMEOUT = 8000;
const NOW = Date.now();

/* ---------------------------------------------------------------- vantage points */
const GOOGLE = (n, t, ecs) => `https://dns.google/resolve?name=${encodeURIComponent(n)}&type=${t}${ecs ? '&edns_client_subnet=' + ecs : ''}`;
const ECS_POINTS = [
  ['mtv', 'Mountain View CA, United States', 'us', '128.12.0.0/24'],
  ['dal', 'Dallas TX, United States', 'us', '129.110.0.0/24'],
  ['nyc', 'New York NY, United States', 'us', '128.122.0.0/24'],
  ['tor', 'Toronto, Canada', 'ca', '128.100.0.0/24'],
  ['mex', 'Mexico City, Mexico', 'mx', '132.248.0.0/24'],
  ['bsb', 'Brasília, Brazil', 'br', '164.41.0.0/24'],
  ['sao', 'São Paulo, Brazil', 'br', '143.107.0.0/24'],
  ['rio', 'Rio de Janeiro, Brazil', 'br', '146.164.0.0/24'],
  ['scs', 'Santa Cruz do Sul, Brazil', 'br', '45.171.83.0/24'],
  ['bue', 'Buenos Aires, Argentina', 'ar', '157.92.0.0/24'],
  ['lon', 'London, United Kingdom', 'gb', '128.40.0.0/24'],
  ['mad', 'Madrid, Spain', 'es', '138.4.0.0/24'],
  ['par', 'Paris, France', 'fr', '134.157.0.0/24'],
  ['ams', 'Amsterdam, Netherlands', 'nl', '145.18.0.0/24'],
  ['ber', 'Berlin, Germany', 'de', '141.20.0.0/24'],
  ['jnb', 'Johannesburg, South Africa', 'za', '146.141.0.0/24'],
  ['del', 'New Delhi, India', 'in', '14.139.0.0/24'],
  ['sin', 'Singapore', 'sg', '137.132.0.0/24'],
  ['sel', 'Seoul, South Korea', 'kr', '147.46.0.0/24'],
  ['tyo', 'Tokyo, Japan', 'jp', '133.11.0.0/24'],
  ['syd', 'Sydney, Australia', 'au', '129.78.0.0/24'],
].map(([id, city, cc, ecs]) => ({ id, city, cc, ecs, url: (n, t) => GOOGLE(n, t, ecs) }));

const DIRECT = [
  ['cf', 'Cloudflare 1.1.1.1', (n, t) => `https://cloudflare-dns.com/dns-query?ct=application/dns-json&name=${encodeURIComponent(n)}&type=${t}`],
  ['gg', 'Google 8.8.8.8', (n, t) => GOOGLE(n, t)],
  ['q9', 'Quad9 9.9.9.9', (n, t) => `https://dns.quad9.net:5053/dns-query?name=${encodeURIComponent(n)}&type=${t}`],
  ['ag', 'AdGuard DNS', (n, t) => `https://dns.adguard-dns.com/resolve?name=${encodeURIComponent(n)}&type=${t}`],
  ['ali', 'AliDNS 223.5.5.5', (n, t) => `https://dns.alidns.com/resolve?name=${encodeURIComponent(n)}&type=${t}`],
].map(([id, city, url]) => ({ id, city, cc: 'globe', url }));

const POINTS = [...ECS_POINTS, ...DIRECT];
const TYPE = { A: 1, NS: 2, CNAME: 5, SOA: 6, TXT: 16, CAA: 257, DS: 43 };
const RCODE = { 1: 'FORMERR', 2: 'SERVFAIL', 3: 'NXDOMAIN', 4: 'NOTIMP', 5: 'REFUSED' };
const RANK = { operational: 0, unknown: 1, degraded: 2, outage: 3 };
const CODE = { operational: 'o', degraded: 'd', outage: 'x', unknown: 'u' }; // compact history codes
const worst = (...s) => s.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'operational');

/* ---------------------------------------------------------------- DNS helpers */
const norm = (tn, d) => {
  d = String(d ?? '').trim();
  if (tn === 16) { const p = d.match(/"((?:[^"\\]|\\.)*)"/g); return p ? p.map(x => x.slice(1, -1)).join('') : d; }
  if (tn === 257) d = d.replace(/"/g, '');
  return d.toLowerCase().replace(/\.(?=\s|$)/g, '').replace(/\s+/g, ' ').trim();
};

async function doh(url) {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return { ok: true, ms: performance.now() - t0, json: await res.json() };
  } catch (e) {
    return { ok: false, ms: performance.now() - t0, error: e.name === 'TimeoutError' ? 'timeout' : (e.message || 'unreachable') };
  }
}

function toCell(r, tn) {
  if (!r.ok) return { state: 'down', key: null, ans: [], ms: r.ms, err: r.error };
  const j = r.json;
  if (j.Status === 3) return { state: 'nx', key: 'NXDOMAIN', ans: [], ms: r.ms };
  if (j.Status !== 0) return { state: 'err', key: RCODE[j.Status] || 'RCODE ' + j.Status, ans: [], ms: r.ms };
  const rr = (j.Answer || []).filter(a => a.type === tn);
  const ans = [...new Set(rr.map(a => norm(tn, a.data)))].sort();
  if (!ans.length) return { state: 'empty', key: 'NODATA', ans, ms: r.ms };
  return { state: 'ok', key: ans.join('\n'), ans, ms: r.ms, ttl: Math.min(...rr.map(a => a.TTL)) };
}

async function checkRecord(id, host, type, { expect } = {}) {
  const tn = TYPE[type];
  const cells = Object.fromEntries(await Promise.all(POINTS.map(async p => [p.id, toCell(await doh(p.url(host, tn)), tn)])));
  const reach = POINTS.filter(p => cells[p.id].state !== 'down');
  const counts = new Map();
  for (const p of reach) counts.set(cells[p.id].key, (counts.get(cells[p.id].key) || 0) + 1);
  let majority = null, best = -1;
  for (const [k, c] of counts) {
    const okKey = reach.some(p => cells[p.id].key === k && cells[p.id].state === 'ok');
    if (c > best || (c === best && okKey)) { best = c; majority = k; }
  }
  const majState = majority == null ? null : cells[reach.find(p => cells[p.id].key === majority).id].state;
  const agree = reach.filter(p => cells[p.id].key === majority).length;
  const ttls = reach.map(p => cells[p.id].ttl).filter(x => x != null);
  const reasons = [];
  let status;
  if (!reach.length) { status = 'unknown'; reasons.push('no resolver reachable'); }
  else if (majState !== 'ok') { status = 'outage'; reasons.push(`${type} ${host}: ${majority === 'NODATA' ? 'no record' : majority}`); }
  else {
    status = 'operational';
    if (expect && majority !== expect) { status = 'degraded'; reasons.push(`${host} points to ${majority}, expected ${expect}`); }
    if (agree < reach.length) { status = worst(status, 'degraded'); reasons.push(`${host} ${type}: ${reach.length - agree} location(s) disagree`); }
  }
  return {
    id, host, type, status, reasons,
    majority: majority == null ? null : majority.split('\n'),
    agree, reach: reach.length, total: POINTS.length,
    ttl: ttls.length ? Math.max(...ttls) : null,
    medianMs: median(reach.map(p => cells[p.id].ms)),
    divergent: reach.filter(p => cells[p.id].key !== majority).map(p => ({ id: p.id, city: p.city, answer: cells[p.id].key })),
    unreachable: POINTS.filter(p => cells[p.id].state === 'down').map(p => p.id),
    points: Object.fromEntries(POINTS.map(p => [p.id, cells[p.id].state === 'ok' ? (cells[p.id].key === majority ? 'ok' : 'drift') : cells[p.id].state])),
  };
}

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2); };

/* ---------------------------------------------------------------- HTTPS + TLS */
function certInfo(host) {
  return new Promise((resolve) => {
    const sock = tls.connect({ host, port: 443, servername: host, timeout: TIMEOUT }, () => {
      const c = sock.getPeerCertificate();
      const validTo = c && c.valid_to ? new Date(c.valid_to) : null;
      resolve({ authorized: sock.authorized, error: sock.authorizationError ? String(sock.authorizationError) : null,
        issuer: c?.issuer?.O || c?.issuer?.CN || null, validTo: validTo ? validTo.toISOString() : null,
        daysLeft: validTo ? Math.floor((validTo - NOW) / 864e5) : null });
      sock.end();
    });
    sock.on('timeout', () => { sock.destroy(); resolve({ authorized: false, error: 'timeout' }); });
    sock.on('error', (e) => resolve({ authorized: false, error: e.code || e.message }));
  });
}

async function checkHttps(host, critical) {
  const t0 = performance.now();
  let code = null, error = null, location = null;
  try {
    const res = await fetch(`https://${host}/`, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'url-status-monitor/1.0 (+https://url-status.gerivan.me/)' } });
    code = res.status; location = res.headers.get('location');
    await res.body?.cancel();
  } catch (e) { error = e.name === 'TimeoutError' ? 'timeout' : (e.cause?.code || e.message); }
  const ms = Math.round(performance.now() - t0);
  const cert = await certInfo(host);
  const reasons = [];
  let status = 'operational';
  if (error || code >= 500) { status = critical ? 'outage' : 'degraded'; reasons.push(`https://${host} ${error || 'HTTP ' + code}`); }
  else if (code >= 400) { status = 'degraded'; reasons.push(`https://${host} HTTP ${code}`); }
  if (!cert.authorized) { status = worst(status, critical ? 'outage' : 'degraded'); reasons.push(`${host} TLS: ${cert.error || 'not trusted'}`); }
  else if (cert.daysLeft != null && cert.daysLeft <= CONFIG.certWarnDays) { status = worst(status, 'degraded'); reasons.push(`${host} certificate expires in ${cert.daysLeft} day(s)`); }
  return { host, status, reasons, code, location, ms, error, cert };
}

/* ---------------------------------------------------------------- security snapshot */
async function q(name, type, extra = '') { const r = await doh(GOOGLE(name, TYPE[type]) + extra); return r.ok ? r.json : null; }
const txts = (j) => j ? (j.Answer || []).filter(a => a.type === 16).map(a => norm(16, a.data)) : [];
async function security(zone) {
  const [soa, ds, caa, root, dmarc] = await Promise.all([q(zone, 'SOA', '&do=1'), q(zone, 'DS'), q(zone, 'CAA'), q(zone, 'TXT'), q('_dmarc.' + zone, 'TXT')]);
  const spf = txts(root).find(r => /^v=spf1(\s|$)/i.test(r)) || null;
  const dm = txts(dmarc).find(r => /^v=DMARC1/i.test(r)) || null;
  return {
    dnssec: soa ? (soa.AD ? 'validated' : (ds && (ds.Answer || []).some(a => a.type === 43) ? 'broken' : 'unsigned')) : 'unknown',
    caa: caa ? (caa.Answer || []).filter(a => a.type === 257).map(a => norm(257, a.data)) : null,
    spf, dmarc: dm,
  };
}

/* ---------------------------------------------------------------- persistence */
async function load(name, fallback) { try { return JSON.parse(await readFile(`${DATA_DIR}/${name}`, 'utf8')); } catch { return fallback; } }
async function save(name, data, pretty = false) { await writeFile(`${DATA_DIR}/${name}`, JSON.stringify(data, null, pretty ? 2 : 0) + '\n'); }

/* ---------------------------------------------------------------- GitHub issues (alerts) */
const GH = process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY && CONFIG.alerts?.githubIssues;
async function gh(method, path, body) {
  if (!GH) return null;
  const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${path}`, {
    method, body: body ? JSON.stringify(body) : undefined,
    headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' },
  });
  if (!res.ok) { console.warn(`GitHub API ${method} ${path} → ${res.status}`); return null; }
  return res.json();
}

/* ---------------------------------------------------------------- main */
const t0 = performance.now();
await mkdir(DATA_DIR, { recursive: true });
const zone = CONFIG.zone;
const hosts = CONFIG.subdomains.map(s => `${s}.${zone}`);

const [nsCheck, aCheck, ...cnameChecks] = await Promise.all([
  checkRecord('apex-ns', zone, 'NS'),
  checkRecord('apex-a', zone, 'A'),
  ...hosts.map(h => checkRecord('cname-' + h.split('.')[0], h, 'CNAME', { expect: CONFIG.expectCname })),
]);
const httpsChecks = await Promise.all([checkHttps(zone, true), ...hosts.map(h => checkHttps(h, false))]);
const sec = await security(zone);

const checks = [nsCheck, aCheck, ...cnameChecks];
// apex DNS failures are a full outage; anything else is a partial (degraded) problem
let overall = worst(nsCheck.status, aCheck.status, httpsChecks[0].status);
for (const c of [...cnameChecks, ...httpsChecks.slice(1)]) overall = worst(overall, c.status === 'outage' ? 'degraded' : c.status);
const reasons = [...checks, ...httpsChecks].flatMap(c => c.reasons);
const failing = [...checks.filter(c => c.status !== 'operational').map(c => c.id), ...httpsChecks.filter(c => c.status !== 'operational').map(c => 'https-' + c.host)];

// history (compact, rolling)
const history = (await load('history.json', [])).filter(h => h.t > NOW / 1000 - CONFIG.historyDays * 86400);
history.push({ t: Math.floor(NOW / 1000), s: CODE[overall], f: failing.length ? failing : undefined });

// daily buckets (UTC)
const today = new Date(NOW).toISOString().slice(0, 10);
const daily = await load('daily.json', []);
let bucket = daily.find(d => d.d === today);
if (!bucket) { bucket = { d: today, n: 0, op: 0, deg: 0, out: 0 }; daily.push(bucket); }
bucket.n++; bucket[{ operational: 'op', degraded: 'deg', outage: 'out', unknown: 'deg' }[overall]]++;
daily.sort((a, b) => a.d.localeCompare(b.d));
while (daily.length > CONFIG.dailyDays) daily.shift();

// uptime (up = not a full outage)
const uptimeOver = (sec) => { const h = history.filter(x => x.t > NOW / 1000 - sec); return h.length ? +(100 * h.filter(x => x.s !== 'x').length / h.length).toFixed(3) : null; };
const uptimeDays = (n) => { const d = daily.slice(-n); const tot = d.reduce((a, b) => a + b.n, 0); return tot ? +(100 * (tot - d.reduce((a, b) => a + b.out, 0)) / tot).toFixed(3) : null; };

// incidents + alert issues
const state = await load('state.json', { streak: 0, open: null, incidents: [] });
const confirm = Math.max(1, CONFIG.alerts?.confirmRuns || 2);
if (overall !== 'operational' && overall !== 'unknown') {
  state.streak = (state.streak || 0) + 1;
  if (state.streak === 1) state.firstBadAt = new Date(NOW).toISOString();
  if (!state.open && state.streak >= confirm) {
    state.open = { start: state.firstBadAt, status: overall, reasons: reasons.slice(0, 10) };
    const issue = await gh('POST', '/issues', {
      title: `🔴 ${overall === 'outage' ? 'Outage' : 'Degraded'}: ${zone} — ${reasons[0] || 'check failed'}`,
      body: `The 24/7 monitor confirmed a problem after ${confirm} consecutive checks.\n\n**Status:** ${overall}\n**Since:** ${state.firstBadAt}\n\n${reasons.map(r => '- ' + r).join('\n')}\n\nLive view: https://${zone}/status.html\n\n_This issue closes automatically when everything recovers._`,
    });
    if (issue) state.open.issue = issue.number;
  } else if (state.open) {
    state.open.status = worst(state.open.status, overall);
    state.open.reasons = [...new Set([...state.open.reasons, ...reasons])].slice(0, 10);
  }
} else if (overall === 'operational') {
  state.streak = 0; state.firstBadAt = null;
  if (state.open) {
    const end = new Date(NOW).toISOString();
    const inc = { ...state.open, end, minutes: Math.round((NOW - Date.parse(state.open.start)) / 60000) };
    state.incidents = [inc, ...(state.incidents || [])].slice(0, 30);
    if (state.open.issue) {
      await gh('POST', `/issues/${state.open.issue}/comments`, { body: `✅ Recovered at ${end} after ~${inc.minutes} min. All checks are operational again.` });
      await gh('PATCH', `/issues/${state.open.issue}`, { state: 'closed', state_reason: 'completed' });
    }
    state.open = null;
  }
}

const status = {
  version: 1,
  generator: 'url-status-monitor',
  generatedAt: new Date(NOW).toISOString(),
  durationMs: Math.round(performance.now() - t0),
  intervalMinutes: 15,
  zone, overall, reasons,
  points: POINTS.map(p => ({ id: p.id, city: p.city, cc: p.cc, ecs: p.ecs || null })),
  checks, https: httpsChecks, security: sec,
  uptime: { h24: uptimeOver(86400), d7: uptimeOver(7 * 86400), d30: uptimeDays(30), d90: uptimeDays(90) },
  daily, recent: history.slice(-96),
  incident: state.open, incidents: (state.incidents || []).slice(0, 10),
};

await save('status.json', status, true);
await save('history.json', history);
await save('daily.json', daily);
await save('state.json', state, true);

console.log(`[${status.generatedAt}] overall=${overall} in ${status.durationMs} ms`);
for (const c of checks) console.log(`  ${c.status.padEnd(11)} ${c.type.padEnd(5)} ${c.host} → ${c.majority?.join(', ') ?? '—'} (${c.agree}/${c.reach})`);
for (const h of httpsChecks) console.log(`  ${h.status.padEnd(11)} HTTPS ${h.host} → ${h.code ?? h.error} · ${h.ms} ms · cert ${h.cert.daysLeft ?? '?'} d`);
if (reasons.length) console.log('Reasons:\n  - ' + reasons.join('\n  - '));
