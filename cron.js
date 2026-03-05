#!/usr/bin/env node
/**
 * Gagaclaw Cron v1.1 — Standalone scheduler process
 * Pure scheduling + writes queue files, no auth/session needed
 * telegram.js / cli.js consume queue when idle
 */

const { loadConfig } = require('./core');
const cron = require('./cronjob');

const cfg = loadConfig();
const APP_NAME = cfg.app?.name || 'Antigravity';

// ─── Logger (buffered, shows in log area) ────────────────────────────────────
const ts = () => new Date().toISOString().slice(11, 23);
const LOG_MAX = 15;
const _logs = [];

function logger(level, msg) {
    const prefix = level === 'error' ? '✗' : level === 'info' ? '✓' : 'ℹ';
    const line = `[${ts()}] [${prefix}] ${msg}`;
    _logs.push(line);
    if (_logs.length > LOG_MAX) _logs.shift();
    // During startup (before dashboard), also print to stdout
    if (!_dashboardStarted) console.log(line);
}

// ─── Dashboard ───────────────────────────────────────────────────────────────
let _dashboardStarted = false;
let _dashboardTimer = null;

function formatCountdown(nextRun) {
    if (!nextRun) return '—';
    const diff = new Date(nextRun).getTime() - Date.now();
    if (diff <= 0) return 'due!';
    const m = Math.floor(diff / 60000);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d > 0) return `${d}d ${h % 24}h`;
    if (h > 0) return `${h}h ${m % 60}m`;
    return `${m}m`;
}

function renderDashboard() {
    const jobs = cron.listAllJobs();
    const now = new Date();

    // Clear screen + cursor to top
    process.stdout.write('\x1b[2J\x1b[H');

    // Header
    console.log(`═══════════════════════════════════════════════`);
    console.log(`  ${APP_NAME} Cron Scheduler`);
    console.log(`═══════════════════════════════════════════════`);
    const st = cron.getStatus();
    const checkStr = st.lastCheck ? st.lastCheck.toLocaleTimeString() : '—';
    console.log(`  ${now.toLocaleString()}  hash:${st.hash}  chk:${checkStr}`);
    console.log(`───────────────────────────────────────────────`);

    // Jobs table
    if (jobs.length === 0) {
        console.log(`  (no jobs — edit cronjobs.json)`);
    } else {
        for (const j of jobs) {
            const status = j.enabled ? '\x1b[32mON \x1b[0m' : '\x1b[90mOFF\x1b[0m';
            const countdown = j.enabled ? formatCountdown(j.nextRun) : '—';
            const nextStr = j.nextRun ? new Date(j.nextRun).toLocaleTimeString() : '—';
            const prompt = j.prompt.length > 35 ? j.prompt.slice(0, 35) + '…' : j.prompt;
            const model = j.model || 'def';
            console.log(`  ${status} \x1b[36m${j.id.padEnd(16)}\x1b[0m ${j.cron.padEnd(15)} \x1b[33m${countdown.padEnd(6)}\x1b[0m → ${nextStr}`);
            console.log(`     \x1b[90m${model} · ${prompt}\x1b[0m`);
        }
    }

    // Log area
    console.log(`───────────────────────────────────────────────`);
    for (const line of _logs) {
        console.log(`  ${line}`);
    }
    // Pad empty lines so screen doesn't jump
    for (let i = _logs.length; i < LOG_MAX; i++) {
        console.log('');
    }
}

function startDashboard() {
    _dashboardStarted = true;
    renderDashboard();
    _dashboardTimer = setInterval(renderDashboard, 60000);
}

// ─── Main ────────────────────────────────────────────────────────────────────
function main() {
    console.log(`\n═══════════════════════════════════════════════`);
    console.log(`  ${APP_NAME} Cron Scheduler`);
    console.log(`═══════════════════════════════════════════════\n`);

    const jobs = cron.listAllJobs();
    const enabled = jobs.filter(j => j.enabled);
    console.log(`[✓] ${jobs.length} jobs loaded, ${enabled.length} enabled\n`);

    // Start scheduler (no auth needed — just writes queue files)
    cron.startScheduler(logger);
    cron.setOnTick(renderDashboard);
    logger('info', 'Scheduler running');

    // Switch to dashboard mode
    startDashboard();
}

try {
    main();
} catch (err) {
    logger('error', `Fatal: ${err.message}`);
    process.exit(1);
}
