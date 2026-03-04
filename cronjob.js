/**
 * Gagaclaw Cronjob v1.0 — Cron job module
 * Pure scheduling + file queue, does not handle session/auth/notifications
 * On trigger, writes files to queue/, consumed by telegram.js / cli.js
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const JOBS_PATH = path.join(__dirname, 'cronjobs.json');
const QUEUE_DIR = path.join(__dirname, 'queue');

// Ensure queue dir exists
if (!fs.existsSync(QUEUE_DIR)) fs.mkdirSync(QUEUE_DIR, { recursive: true });

// ─── Jobs persistence ────────────────────────────────────────────────────────
function loadJobs() {
    try { return JSON.parse(fs.readFileSync(JOBS_PATH, 'utf8')); } catch { return { jobs: [] }; }
}

function saveJobs(data) {
    const content = JSON.stringify(data, null, 4) + '\n';
    fs.writeFileSync(JOBS_PATH, content);
    _lastHash = hashStr(content);
}

// ─── Cron parser (minute hour day month weekday) ─────────────────────────────
function parseCronField(field, min, max) {
    const values = new Set();
    for (const part of field.split(',')) {
        const stepMatch = part.match(/^\*\/(\d+)$/);
        if (stepMatch) {
            const step = parseInt(stepMatch[1]);
            for (let i = min; i <= max; i += step) values.add(i);
            continue;
        }
        if (part === '*') {
            for (let i = min; i <= max; i++) values.add(i);
            continue;
        }
        const rangeMatch = part.match(/^(\d+)-(\d+)$/);
        if (rangeMatch) {
            const from = parseInt(rangeMatch[1]);
            const to = parseInt(rangeMatch[2]);
            for (let i = from; i <= to; i++) values.add(i);
            continue;
        }
        const num = parseInt(part);
        if (!isNaN(num)) values.add(num);
    }
    return values;
}

function matchCron(cronExpr, date) {
    const parts = cronExpr.trim().split(/\s+/);
    if (parts.length !== 5) return false;
    const [minF, hourF, dayF, monthF, wdayF] = parts;
    return parseCronField(minF, 0, 59).has(date.getMinutes())
        && parseCronField(hourF, 0, 23).has(date.getHours())
        && parseCronField(dayF, 1, 31).has(date.getDate())
        && parseCronField(monthF, 1, 12).has(date.getMonth() + 1)
        && parseCronField(wdayF, 0, 6).has(date.getDay());
}

function nextRunTime(cronExpr) {
    const now = new Date();
    const check = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes() + 1, 0, 0);
    const limit = 7 * 24 * 60;
    for (let i = 0; i < limit; i++) {
        if (matchCron(cronExpr, check)) return check;
        check.setMinutes(check.getMinutes() + 1);
    }
    return null;
}

// ─── Scheduler state ─────────────────────────────────────────────────────────
let _intervalId = null;
let _logger = null;
let _lastHash = '';
let _lastCheckTime = null;
let _lastTriggered = {};
let _onTick = null;

function _log(msg) {
    if (_logger) _logger('info', `[CRON] ${msg}`);
    else console.log(`[CRON] ${msg}`);
}

// ─── Queue: write job file for consumers ─────────────────────────────────────
function enqueueJob(job) {
    // Determine target from notify config
    const targets = [];
    if (job.notify?.telegram) targets.push('telegram');
    if (job.notify?.cli) targets.push('cli');
    if (targets.length === 0) targets.push('telegram'); // default

    for (const target of targets) {
        const fileName = `${target}_${job.id}_${Date.now()}.json`;
        const payload = {
            id: job.id,
            prompt: job.prompt,
            model: job.model || null,
            mode: job.mode || null,
            agentic: job.agentic !== undefined ? job.agentic : null,
            cascadeId: job.cascadeId || null,
            chatId: job.notify?.telegram || null,
            target,
            createdAt: new Date().toISOString(),
        };
        fs.writeFileSync(path.join(QUEUE_DIR, fileName), JSON.stringify(payload, null, 2) + '\n');
        _log(`Queued: ${fileName}`);
    }
}

// Read & consume queue files for a specific target
function consumeQueue(target) {
    try {
        const files = fs.readdirSync(QUEUE_DIR)
            .filter(f => f.startsWith(`${target}_`) && f.endsWith('.json'))
            .sort(); // oldest first
        const items = [];
        for (const f of files) {
            const fp = path.join(QUEUE_DIR, f);
            try {
                const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
                fs.unlinkSync(fp);
                items.push(data);
            } catch (e) {
                _log(`Bad queue file ${f}: ${e.message}`);
                try { fs.unlinkSync(fp); } catch {}
            }
        }
        return items;
    } catch { return []; }
}

// ─── Hash helpers ────────────────────────────────────────────────────────────
function hashStr(str) {
    return crypto.createHash('md5').update(str).digest('hex');
}

function getFileHash() {
    try { return hashStr(fs.readFileSync(JOBS_PATH, 'utf8')); } catch { return ''; }
}

// ─── Persist nextRun into cronjobs.json ──────────────────────────────────────
function calcAndSaveNextRuns() {
    const data = loadJobs();
    const now = new Date();
    let changed = false;
    for (const job of data.jobs) {
        if (!job.enabled) {
            if (job.nextRun) { job.nextRun = null; changed = true; }
            continue;
        }
        // If nextRun is in the past, force recalculate
        if (job.nextRun && new Date(job.nextRun) < now) {
            job.nextRun = null; // clear stale
        }
        const next = nextRunTime(job.cron);
        const nextStr = next ? next.toISOString() : null;
        if (job.nextRun !== nextStr) {
            job.nextRun = nextStr;
            changed = true;
        }
    }
    if (changed) saveJobs(data);
    return data;
}

// ─── Scheduler ───────────────────────────────────────────────────────────────
function startScheduler(logger) {
    _logger = logger;

    if (_intervalId) clearInterval(_intervalId);

    const data = calcAndSaveNextRuns();
    const enabled = data.jobs.filter(j => j.enabled);
    _log(`Scheduler started — ${enabled.length}/${data.jobs.length} jobs enabled`);

    _intervalId = setInterval(() => {
        const now = new Date();
        _lastCheckTime = now;
        const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;

        // Detect file changes → recalculate
        const hash = getFileHash();
        if (hash !== _lastHash) {
            _log('cronjobs.json changed, reloading...');
            _lastHash = hash;
            calcAndSaveNextRuns();
        }

        const data = loadJobs();
        let needSave = false;

        for (const job of data.jobs) {
            if (!job.enabled) continue;
            if (!job.nextRun) {
                job.nextRun = (nextRunTime(job.cron) || new Date()).toISOString();
                needSave = true;
                continue;
            }
            const next = new Date(job.nextRun);
            if (now >= next) {
                // If nextRun is stale (more than 2 min old), skip execution and just recalculate
                const staleMs = now.getTime() - next.getTime();
                if (staleMs > 2 * 60000) {
                    _log(`Job "${job.id}" nextRun is stale (${Math.round(staleMs / 60000)}m ago), skipping → recalculate`);
                    job.nextRun = (nextRunTime(job.cron) || new Date()).toISOString();
                    needSave = true;
                    continue;
                }
                if (_lastTriggered[job.id] === minuteKey) continue;
                _lastTriggered[job.id] = minuteKey;
                job.nextRun = (nextRunTime(job.cron) || new Date()).toISOString();
                needSave = true;
                enqueueJob(job);
            }
        }

        if (needSave) saveJobs(data);
        if (_onTick) _onTick();
    }, 60000);
}

function stopScheduler() {
    if (_intervalId) {
        clearInterval(_intervalId);
        _intervalId = null;
        _log('Scheduler stopped');
    }
}

// ─── Job queries & toggle ────────────────────────────────────────────────────
function listAllJobs() {
    return loadJobs().jobs;
}

function toggleJob(id, enabled) {
    const data = loadJobs();
    const job = data.jobs.find(j => j.id === id);
    if (!job) return { ok: false, msg: `Job "${id}" not found` };
    job.enabled = enabled !== undefined ? enabled : !job.enabled;
    saveJobs(data);
    return { ok: true, msg: `Job "${id}" → ${job.enabled ? 'ON' : 'OFF'}` };
}

function formatJob(job) {
    const status = job.enabled ? '✅' : '⏸️';
    const nextStr = job.nextRun ? new Date(job.nextRun).toLocaleString() : '—';
    const model = job.model || 'default';
    const prompt = job.prompt.length > 50 ? job.prompt.slice(0, 50) + '…' : job.prompt;
    return `${status} <b>${job.id}</b>\n  ⏰ ${job.cron} → next: ${nextStr}\n  📝 ${prompt}\n  🤖 ${model}`;
}

module.exports = {
    loadJobs, saveJobs,
    matchCron, nextRunTime,
    startScheduler, stopScheduler,
    enqueueJob, consumeQueue,
    listAllJobs, toggleJob, formatJob,
    setOnTick(fn) { _onTick = fn; },
    getStatus() { return { hash: _lastHash?.slice(-5) || '—', lastCheck: _lastCheckTime }; },
    QUEUE_DIR,
};
