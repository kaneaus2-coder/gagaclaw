#!/usr/bin/env node
/**
 * Gagaclaw Discord interface.
 * New Antigravity only: per-channel Session, mention/reply routing, preview edits, permission buttons.
 */

const fs = require('fs');
const path = require('path');
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    Client,
    Events,
    GatewayIntentBits,
    Partials,
} = require('discord.js');

const {
    connectAndAuth,
    createExtraSession,
    MODELS,
    MODEL_BY_ID,
    MODES,
    loadConfig,
    splitText,
    LOCAL_VERSION,
    checkUpdate,
    getUsage,
} = require('./core');

const cfg = loadConfig();
const DISCORD_TOKEN = process.env.DISCORD_TOKEN
    || (process.argv.find((arg) => arg.startsWith('--token=')) || '').slice(8)
    || cfg.discord?.token
    || '';
const APP_NAME = cfg.app?.name || 'Antigravity';
const PREFIX = cfg.discord?.prefix || '!';
const REQUIRE_MENTION_IN_GUILDS = cfg.discord?.requireMentionInGuilds !== false;
const ALLOW_BOT_MENTIONS = cfg.discord?.allowBotMentions !== false;
const ALLOWED_USERS = new Set((cfg.discord?.allowedUsers || []).map(String));
const ALLOWED_GUILDS = new Set((cfg.discord?.allowedGuilds || []).map(String));
const ALLOWED_CHANNELS = new Set((cfg.discord?.allowedChannels || []).map(String));
const ADMIN_CHANNEL_ID = cfg.discord?.adminChannelId || '';

const SESSION_MAP_PATH = path.join(__dirname, 'discord_sessions.json');
function loadSessionMap() { try { return JSON.parse(fs.readFileSync(SESSION_MAP_PATH, 'utf8')); } catch { return {}; } }
function saveSessionMap(map) { fs.writeFileSync(SESSION_MAP_PATH, JSON.stringify(map, null, 2) + '\n'); }

if (!DISCORD_TOKEN) {
    console.error('No Discord token. Set discord.token in gagaclaw.json or DISCORD_TOKEN env.');
    process.exit(1);
}

const MODEL_KEYS = Object.keys(MODELS).sort();
const MODE_KEYS = Object.keys(MODES).sort();
const PREVIEW_LIMIT = 1800;
const FINAL_LIMIT = 1900;
const thinkingTimers = new Set();
const responseTimers = new Set();

const discordLog = fs.createWriteStream(path.join(__dirname, 'discord.log'), { flags: 'w' });
const logTs = () => new Date().toISOString().slice(11, 23);
function dlog(msg) {
    discordLog.write(`[${logTs()}] ${msg}\n`);
}

function coreLogger(level, msg) {
    dlog(`[${level}] ${msg}`);
    console.log(`[${level}] ${msg}`);
}

function sendPayload(content, extra = {}) {
    return {
        content: String(content || '(empty)').slice(0, 2000),
        allowedMentions: { parse: [], repliedUser: false },
        ...extra,
    };
}

function trimPreview(text, maxLen = PREVIEW_LIMIT) {
    const src = String(text || '');
    return src.length > maxLen ? `...${src.slice(-maxLen)}` : src;
}

function isAllowedUser(userId) {
    return ALLOWED_USERS.size === 0 || ALLOWED_USERS.has(String(userId));
}

function isAllowedChannel(channel) {
    if (!channel) return false;
    if (ALLOWED_CHANNELS.size > 0 && !ALLOWED_CHANNELS.has(String(channel.id))) return false;
    if (channel.guild && ALLOWED_GUILDS.size > 0 && !ALLOWED_GUILDS.has(String(channel.guild.id))) return false;
    return true;
}

function isReplyToBot(message, client) {
    const replied = message.mentions?.repliedUser;
    return !!(replied && replied.id === client.user.id);
}

function stripOwnMention(text, botId) {
    return String(text || '')
        .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
        .trim();
}

function canHandleConversationMessage(message, client) {
    if (!message || !client.user) return false;
    if (message.author.id === client.user.id) return false;
    if (!isAllowedChannel(message.channel)) return false;

    const mentioned = message.mentions?.has(client.user) || false;
    const replied = isReplyToBot(message, client);

    // Bot authors bypass allowedUsers — only require mention/reply + allowBotMentions
    if (message.author.bot) {
        if (message.channel.type === ChannelType.DM) return false;
        return ALLOW_BOT_MENTIONS && (mentioned || replied);
    }

    if (!isAllowedUser(message.author.id)) return false;

    const isDm = message.channel.type === ChannelType.DM;
    if (isDm) return true;

    if (!REQUIRE_MENTION_IN_GUILDS) return true;
    return mentioned || replied;
}

function formatThinking(text) {
    const preview = trimPreview(text, 1500);
    return `Thinking...\n${preview || '(waiting for model output)'}`.slice(0, 2000);
}

function formatToolCall(tc) {
    const name = tc.toolName || tc.tool || 'tool';
    const detail = tc.CommandLine || tc.AbsolutePath || tc.Url || tc.Query || tc.query || tc.Task || tc.task || '';
    return detail ? `[tool] ${name}: ${detail}` : `[tool] ${name}`;
}

function formatPermission(perm) {
    const ctx = perm.contextTool || {};
    if (perm.type === 'run_command') {
        const cmd = perm.CommandLine || ctx.CommandLine || '(command)';
        const cwd = ctx.Cwd ? `\nCWD: ${ctx.Cwd}` : '';
        return `Permission required: run_command\n${cmd}${cwd}`;
    }
    if (perm.type === 'file') {
        const fp = perm.permissionPath || ctx.DirectoryPath || ctx.AbsolutePath || ctx.TargetFile || ctx.targetFile || '(path)';
        const tool = ctx.toolName ? `\nTool: ${ctx.toolName}` : '';
        return `Permission required: file\n${fp}${tool}`;
    }
    if (perm.type === 'browser') {
        const url = ctx.Url || ctx.PageIdToReplace || '(url)';
        return `Permission required: browser\n${url}`;
    }
    if (perm.type === 'mcp') {
        return `Permission required: mcp\n${ctx.toolName || '(tool)'}`;
    }
    return `Permission required: ${perm.type}`;
}

function createChannelState(channelId) {
    return {
        channelId,
        session: null,
        sessionPromise: null,
        busy: false,
        queue: [],
        thinkingText: '',
        responseText: '',
        thinkingMessageId: null,
        responseMessageId: null,
        requestMessageId: null,
        lastThinkingContent: '',
        lastResponseContent: '',
        thinkingTimer: null,
        responseTimer: null,
    };
}

async function main() {
    console.log(`${APP_NAME} Discord Bot v${LOCAL_VERSION}`);
    const auth = await connectAndAuth(coreLogger);
    console.log(`Auth ready on LS port ${auth.lsPort}`);

    checkUpdate().then((v) => {
        if (v.upToDate === false) console.log(`Update available: v${v.local} -> v${v.remote}`);
    }).catch(() => {});

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.DirectMessages,
            GatewayIntentBits.MessageContent,
        ],
        partials: [Partials.Channel],
    });

    const channelStates = new Map();
    const pendingPerms = new Map();

    function getState(channelId) {
        if (!channelStates.has(channelId)) {
            channelStates.set(channelId, createChannelState(channelId));
        }
        return channelStates.get(channelId);
    }

    async function getTextChannel(channelId) {
        const cached = client.channels.cache.get(channelId);
        if (cached) return cached;
        try {
            return await client.channels.fetch(channelId);
        } catch {
            return null;
        }
    }

    async function fetchMessage(channelId, messageId) {
        if (!messageId) return null;
        const channel = await getTextChannel(channelId);
        if (!channel || typeof channel.messages?.fetch !== 'function') return null;
        try {
            return await channel.messages.fetch(messageId);
        } catch {
            return null;
        }
    }

    async function sendMessage(channelId, content, extra = {}, replyToId = null) {
        const channel = await getTextChannel(channelId);
        if (!channel || typeof channel.send !== 'function') return null;
        const payload = sendPayload(content, extra);
        if (replyToId) payload.reply = { messageReference: replyToId };
        try {
            return await channel.send(payload);
        } catch (err) {
            dlog(`[send fail] channel=${channelId} err=${err.message}`);
            return null;
        }
    }

    async function editMessage(channelId, messageId, content, extra = {}) {
        const msg = await fetchMessage(channelId, messageId);
        if (!msg) return null;
        try {
            return await msg.edit(sendPayload(content, extra));
        } catch (err) {
            dlog(`[edit fail] channel=${channelId} msg=${messageId} err=${err.message}`);
            return null;
        }
    }

    async function deleteMessage(channelId, messageId) {
        const msg = await fetchMessage(channelId, messageId);
        if (!msg) return false;
        try {
            await msg.delete();
            return true;
        } catch {
            return false;
        }
    }

    async function sendTemp(channelId, content, ms = 60000) {
        const msg = await sendMessage(channelId, content);
        if (msg) {
            setTimeout(() => {
                deleteMessage(channelId, msg.id).catch(() => {});
            }, ms);
        }
        return msg;
    }

    function clearThinkingTimer(state) {
        if (!state.thinkingTimer) return;
        clearTimeout(state.thinkingTimer);
        thinkingTimers.delete(state.thinkingTimer);
        state.thinkingTimer = null;
    }

    function clearResponseTimer(state) {
        if (!state.responseTimer) return;
        clearTimeout(state.responseTimer);
        responseTimers.delete(state.responseTimer);
        state.responseTimer = null;
    }

    function clearRenderTimers(state) {
        clearThinkingTimer(state);
        clearResponseTimer(state);
    }

    async function ensureThinkingMessage(state) {
        if (state.thinkingMessageId) return state.thinkingMessageId;
        const msg = await sendMessage(state.channelId, 'Thinking...', {}, state.requestMessageId);
        state.thinkingMessageId = msg?.id || null;
        return state.thinkingMessageId;
    }

    function scheduleThinkingEdit(state) {
        if (state.responseText) return;
        if (state.thinkingTimer) return;
        const timer = setTimeout(async () => {
            thinkingTimers.delete(timer);
            state.thinkingTimer = null;
            if (!state.thinkingText || state.responseText) return;
            const content = formatThinking(state.thinkingText);
            if (content === state.lastThinkingContent) return;
            state.lastThinkingContent = content;
            await ensureThinkingMessage(state);
            if (!state.thinkingMessageId) return;
            const edited = await editMessage(state.channelId, state.thinkingMessageId, content);
            if (!edited) {
                const resent = await sendMessage(state.channelId, content, {}, state.requestMessageId);
                state.thinkingMessageId = resent?.id || null;
            }
        }, 1200);
        state.thinkingTimer = timer;
        thinkingTimers.add(timer);
    }

    function scheduleResponseEdit(state) {
        if (state.responseTimer) return;
        const delay = state.responseMessageId ? 1200 : 300;
        const timer = setTimeout(async () => {
            responseTimers.delete(timer);
            state.responseTimer = null;
            if (!state.responseText) return;
            const content = trimPreview(state.responseText, PREVIEW_LIMIT);
            if (content === state.lastResponseContent) return;
            state.lastResponseContent = content;
            if (!state.responseMessageId) {
                const sent = await sendMessage(state.channelId, content, {}, state.requestMessageId);
                state.responseMessageId = sent?.id || null;
                return;
            }
            const edited = await editMessage(state.channelId, state.responseMessageId, content);
            if (!edited) {
                const resent = await sendMessage(state.channelId, content, {}, state.requestMessageId);
                state.responseMessageId = resent?.id || null;
            }
        }, delay);
        state.responseTimer = timer;
        responseTimers.add(timer);
    }

    async function finalizeTurn(state) {
        clearRenderTimers(state);

        const finalText = state.responseText || state.thinkingText || '(no response)';
        const chunks = splitText(finalText, FINAL_LIMIT);

        if (state.thinkingMessageId) {
            deleteMessage(state.channelId, state.thinkingMessageId).catch(() => {});
            state.thinkingMessageId = null;
        }

        if (state.responseMessageId && chunks.length === 1) {
            const edited = await editMessage(state.channelId, state.responseMessageId, chunks[0]);
            if (!edited) {
                const resent = await sendMessage(state.channelId, chunks[0], {}, state.requestMessageId);
                state.responseMessageId = resent?.id || null;
            }
        } else {
            if (state.responseMessageId) {
                deleteMessage(state.channelId, state.responseMessageId).catch(() => {});
                state.responseMessageId = null;
            }
            for (let i = 0; i < chunks.length; i++) {
                await sendMessage(state.channelId, chunks[i], {}, i === 0 ? state.requestMessageId : null);
            }
        }

        state.busy = false;
        state.thinkingText = '';
        state.responseText = '';
        state.requestMessageId = null;
        state.thinkingMessageId = null;
        state.responseMessageId = null;
        state.lastThinkingContent = '';
        state.lastResponseContent = '';

        dequeue(state);
    }

    async function handlePermission(state, perm) {
        const buttons = [];
        if (perm.type === 'file') {
            buttons.push(
                new ButtonBuilder().setCustomId('perm_allow_turn').setLabel('Allow Turn').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('perm_allow_conv').setLabel('Allow Conversation').setStyle(ButtonStyle.Primary),
            );
        } else {
            buttons.push(
                new ButtonBuilder().setCustomId('perm_allow').setLabel('Allow').setStyle(ButtonStyle.Success),
            );
        }
        buttons.push(
            new ButtonBuilder().setCustomId('perm_deny').setLabel('Deny').setStyle(ButtonStyle.Danger),
        );

        const row = new ActionRowBuilder().addComponents(buttons);
        const msg = await sendMessage(state.channelId, formatPermission(perm), { components: [row] });
        if (msg) pendingPerms.set(msg.id, { state, perm });
    }

    async function bindSession(state, session) {
        session.on('transportMode', (mode) => {
            dlog(`[transport] channel=${state.channelId} mode=${mode}`);
            if (mode === 'polling') {
                sendMessage(state.channelId, `📡 Polling mode (Antigravity ≥1.20.5)`).catch(() => {});
            } else {
                const err = 'discord.js only supports polling mode (Antigravity ≥1.20.5). Streaming detected — destroying session.';
                console.error(err);
                dlog(err);
                sendMessage(state.channelId, `❌ ${err}`).catch(() => {});
                destroySession(state).catch(() => {});
            }
        });

        session.on('thinking', (_delta, full) => {
            state.thinkingText = full;
            scheduleThinkingEdit(state);
        });

        session.on('response', (delta) => {
            state.responseText += delta;
            scheduleResponseEdit(state);
        });

        session.on('toolCall', (tc) => {
            if (tc.toolName === 'notify_user' && tc.Message) {
                if (state.responseText) state.responseText += '\n\n';
                state.responseText += tc.Message;
                scheduleResponseEdit(state);
                return;
            }
            sendTemp(state.channelId, formatToolCall(tc)).catch(() => {});
        });

        session.on('permissionWait', (perm) => {
            handlePermission(state, perm).catch((err) => {
                dlog(`[perm fail] channel=${state.channelId} err=${err.message}`);
            });
        });

        session.on('yoloApprove', (desc) => {
            sendTemp(state.channelId, `YOLO: ${desc}`).catch(() => {});
        });

        session.on('yoloError', (desc) => {
            sendMessage(state.channelId, `YOLO error: ${desc}`).catch(() => {});
        });

        session.on('newStep', () => {
            state.thinkingText = '';
            state.lastThinkingContent = '';
            clearThinkingTimer(state);
        });

        session.on('turnDone', () => {
            finalizeTurn(state).catch((err) => {
                dlog(`[turn done fail] channel=${state.channelId} err=${err.message}`);
            });
        });

        session.on('error', (msg) => {
            dlog(`[session error] channel=${state.channelId} ${msg}`);
            sendMessage(state.channelId, `Error: ${msg}`).catch(() => {});
            state.busy = false;
            dequeue(state);
        });
    }

    async function ensureSession(state) {
        if (state.session) return state.session;
        if (!state.sessionPromise) {
            state.sessionPromise = (async () => {
                const map = loadSessionMap();
                const savedCascadeId = map[state.channelId] || null;
                const session = await createExtraSession(auth, savedCascadeId, { autoOpen: false });
                state.session = session;
                map[state.channelId] = session.cascadeId;
                saveSessionMap(map);
                await bindSession(state, session);
                session.openStream(); // open AFTER listeners are bound to catch transportMode
                dlog(`[session] channel=${state.channelId} cascade=${session.cascadeId} resumed=${!!savedCascadeId}`);
                return session;
            })().catch((err) => {
                state.sessionPromise = null;
                throw err;
            });
        }
        return state.sessionPromise;
    }

    async function destroySession(state) {
        clearRenderTimers(state);
        if (state.session) {
            try { state.session.removeAllListeners(); } catch {}
            try { state.session.destroy(); } catch {}
        }
        state.session = null;
        state.sessionPromise = null;
        state.busy = false;
        state.queue = [];
        state.thinkingText = '';
        state.responseText = '';
        state.requestMessageId = null;
        state.lastThinkingContent = '';
        state.lastResponseContent = '';
        if (state.thinkingMessageId) deleteMessage(state.channelId, state.thinkingMessageId).catch(() => {});
        if (state.responseMessageId) deleteMessage(state.channelId, state.responseMessageId).catch(() => {});
        state.thinkingMessageId = null;
        state.responseMessageId = null;

        for (const [msgId, pending] of pendingPerms.entries()) {
            if (pending.state === state) pendingPerms.delete(msgId);
        }
    }

    async function processPrompt(state, prompt, requestMessageId = null) {
        state.busy = true;
        state.thinkingText = '';
        state.responseText = '';
        state.requestMessageId = requestMessageId;
        state.lastThinkingContent = '';
        state.lastResponseContent = '';
        state.responseMessageId = null;
        clearRenderTimers(state);

        let session;
        try {
            session = await ensureSession(state);
            await ensureThinkingMessage(state);
        } catch (err) {
            state.busy = false;
            await sendMessage(state.channelId, `Error: ${err.message}`);
            return;
        }

        const ok = await session.send(prompt);
        if (!ok) {
            state.busy = false;
            if (state.thinkingMessageId) {
                await editMessage(state.channelId, state.thinkingMessageId, 'Failed to send message.');
            } else {
                await sendMessage(state.channelId, 'Failed to send message.');
            }
            dequeue(state);
        }
    }

    function enqueue(state, prompt, requestMessageId) {
        state.queue.push({ prompt, requestMessageId });
        sendTemp(state.channelId, `Queued (#${state.queue.length}).`, 15000).catch(() => {});
    }

    function dequeue(state) {
        if (state.busy) return;
        if (state.queue.length === 0) return;
        const next = state.queue.shift();
        processPrompt(state, next.prompt, next.requestMessageId).catch((err) => {
            dlog(`[dequeue fail] channel=${state.channelId} err=${err.message}`);
        });
    }

    async function handleCommand(message, state, rawText) {
        const parts = rawText.trim().split(/\s+/);
        const cmd = parts[0].toLowerCase();
        const arg = parts.slice(1).join(' ').trim();
        let session = state.session;

        switch (cmd) {
        case `${PREFIX}help`:
            await sendMessage(message.channel.id, [
                `**${APP_NAME} Discord Bot v${LOCAL_VERSION}**`,
                `\`${PREFIX}new\` — New conversation`,
                `\`${PREFIX}stop\` — Stop current turn`,
                `\`${PREFIX}list\` — List conversations`,
                `\`${PREFIX}switch N\` — Switch to conversation #N`,
                `\`${PREFIX}delete N\` — Delete conversation #N`,
                `\`${PREFIX}status\` — Show session settings`,
                `\`${PREFIX}model <${MODEL_KEYS.join('|')}>\``,
                `\`${PREFIX}mode <${MODE_KEYS.join('|')}>\``,
                `\`${PREFIX}agentic <on|off>\``,
                `\`${PREFIX}yolo <on|off>\``,
                `\`${PREFIX}usage\` — Model quota & usage`,
                '',
                'Guild channels require mention or reply by default.',
            ].join('\n'));
            return true;

        case `${PREFIX}new`:
            await destroySession(state);
            // Remove old mapping so ensureSession creates fresh
            { const map = loadSessionMap(); delete map[state.channelId]; saveSessionMap(map); }
            await ensureSession(state);
            await sendMessage(message.channel.id, `New conversation: ${state.session.cascadeId.slice(0, 8)}...`);
            return true;

        case `${PREFIX}stop`:
            session = session || await ensureSession(state);
            await session.stop();
            state.busy = false;
            state.queue = [];
            clearRenderTimers(state);
            if (state.thinkingMessageId) deleteMessage(state.channelId, state.thinkingMessageId).catch(() => {});
            if (state.responseMessageId) deleteMessage(state.channelId, state.responseMessageId).catch(() => {});
            state.thinkingMessageId = null;
            state.responseMessageId = null;
            state.thinkingText = '';
            state.responseText = '';
            await sendMessage(message.channel.id, 'Stopped.');
            return true;

        case `${PREFIX}status`:
            session = session || await ensureSession(state);
            await sendMessage(message.channel.id, [
                `Cascade: ${session.cascadeId || '(none)'}`,
                `Model: ${session.modelLabel}`,
                `Mode: ${session.modeLabel}`,
                `Agentic: ${session.agenticEnabled ? 'on' : 'off'}`,
                `YOLO: ${session.yoloMode ? 'on' : 'off'}`,
                `Busy: ${state.busy ? 'yes' : 'no'}`,
                `Queue: ${state.queue.length}`,
            ].join('\n'));
            return true;

        case `${PREFIX}model`:
            session = session || await ensureSession(state);
            if (!arg || !MODELS[arg]) {
                await sendMessage(message.channel.id, `Usage: ${PREFIX}model <${MODEL_KEYS.join('|')}>`);
                return true;
            }
            session.setModel(arg);
            await sendMessage(message.channel.id, `Model set to ${session.modelLabel}`);
            return true;

        case `${PREFIX}mode`:
            session = session || await ensureSession(state);
            if (!arg || !MODES[arg]) {
                await sendMessage(message.channel.id, `Usage: ${PREFIX}mode <${MODE_KEYS.join('|')}>`);
                return true;
            }
            session.setMode(arg);
            await sendMessage(message.channel.id, `Mode set to ${session.modeLabel}`);
            return true;

        case `${PREFIX}agentic`:
            session = session || await ensureSession(state);
            if (!['on', 'off'].includes(arg)) {
                await sendMessage(message.channel.id, `Usage: ${PREFIX}agentic <on|off>`);
                return true;
            }
            session.setAgentic(arg === 'on');
            await sendMessage(message.channel.id, `Agentic ${arg}`);
            return true;

        case `${PREFIX}yolo`:
            session = session || await ensureSession(state);
            if (!['on', 'off'].includes(arg)) {
                await sendMessage(message.channel.id, `Usage: ${PREFIX}yolo <on|off>`);
                return true;
            }
            session.setYolo(arg === 'on');
            await sendMessage(message.channel.id, `YOLO ${arg}`);
            return true;

        case `${PREFIX}list`: {
            session = session || await ensureSession(state);
            const list = await session.listCascades();
            if (list.length === 0) { await sendMessage(message.channel.id, 'No conversations.'); return true; }
            const lines = list.slice(0, 15).map((e, i) => {
                const cur = e.id === session.cascadeId ? ' ◀' : '';
                const ttl = (e.summary || '(untitled)').slice(0, 50);
                return `\`${i + 1}\` ${e.id.slice(0, 8)}… ${ttl}${cur}`;
            });
            await sendMessage(message.channel.id, `**Conversations (${list.length})**\n${lines.join('\n')}`);
            state._lastList = list;
            return true;
        }

        case `${PREFIX}switch`: {
            session = session || await ensureSession(state);
            const list = state._lastList || await session.listCascades();
            const num = parseInt(arg, 10);
            if (!num || num < 1 || num > list.length) {
                await sendMessage(message.channel.id, `Use \`${PREFIX}list\` first, then \`${PREFIX}switch 1~${list.length}\``);
                return true;
            }
            const target = list[num - 1];
            session.switchCascade(target.id);
            const map = loadSessionMap();
            map[state.channelId] = target.id;
            saveSessionMap(map);
            const ttl = (target.summary || '(untitled)').slice(0, 50);
            await sendMessage(message.channel.id, `Switched: ${target.id.slice(0, 8)}… — ${ttl}`);
            return true;
        }

        case `${PREFIX}delete`: {
            session = session || await ensureSession(state);
            const list = state._lastList || await session.listCascades();
            const num = parseInt(arg, 10);
            if (!num || num < 1 || num > list.length) {
                await sendMessage(message.channel.id, `Use \`${PREFIX}list\` first, then \`${PREFIX}delete 1~${list.length}\``);
                return true;
            }
            const target = list[num - 1];
            const ok = await session.deleteCascade(target.id);
            if (ok) {
                await sendMessage(message.channel.id, `Deleted: ${target.id.slice(0, 8)}…`);
                if (target.id === session.cascadeId) {
                    await destroySession(state);
                    const map = loadSessionMap();
                    delete map[state.channelId];
                    saveSessionMap(map);
                    await sendMessage(message.channel.id, 'Current conversation deleted. Use `!new` or `!switch`.');
                }
            } else {
                await sendMessage(message.channel.id, 'Delete failed.');
            }
            return true;
        }

        case `${PREFIX}usage`: {
            session = session || await ensureSession(state);
            try {
                const info = await getUsage(session.auth);
                const lines = [`**📊 Model Usage**\nTier: **${info.userTier}**\n`];
                if (info.models.length === 0) {
                    lines.push('No per-model quota data available.');
                } else {
                    for (const m of info.models) {
                        const pct = m.pct !== null ? m.pct : null;
                        const pctStr = pct !== null ? `${pct}%` : '?';
                        const barLen = pct !== null ? Math.round(pct / 10) : 0;
                        const bar = pct !== null ? ' `' + '█'.repeat(barLen) + '░'.repeat(10 - barLen) + '`' : '';
                        const icon = pct === null ? '❔' : pct > 50 ? '🟢' : pct > 20 ? '🟡' : '🔴';
                        const reset = m.resetTime ? `\n  ⏰ Reset: ${new Date(m.resetTime).toLocaleString('zh-TW')}` : '';
                        lines.push(`${icon} **${m.label}**\n  Remaining: ${pctStr}${bar}${reset}`);
                    }
                }
                await sendMessage(message.channel.id, lines.join('\n'));
            } catch (e) {
                await sendMessage(message.channel.id, `❌ Usage fetch failed: ${e.message}`);
            }
            return true;
        }

        default:
            return false;
        }
    }

    client.once(Events.ClientReady, async (readyClient) => {
        console.log(`Discord ready as ${readyClient.user.tag}`);
        dlog(`[ready] ${readyClient.user.tag}`);
        if (ADMIN_CHANNEL_ID) {
            sendMessage(ADMIN_CHANNEL_ID, `✅ Gagaclaw v${LOCAL_VERSION} started\nBot: ${readyClient.user.tag}\nAuth: LS port ${auth.lsPort}`).catch(() => {});
            checkUpdate().then((v) => {
                if (v.upToDate === false) {
                    sendMessage(ADMIN_CHANNEL_ID, `⬆️ Update: **v${v.local}** → **v${v.remote}**\nRun \`git pull\` to update.`).catch(() => {});
                }
            }).catch(() => {});
        }
    });

    client.on(Events.MessageCreate, async (message) => {
        try {
            if (!message.content) return;
            if (!isAllowedChannel(message.channel)) return;

            const state = getState(message.channel.id);

            if (message.content.startsWith(PREFIX)) {
                if (!isAllowedUser(message.author.id)) return;
                const handled = await handleCommand(message, state, message.content);
                if (handled) return;
            }

            if (!canHandleConversationMessage(message, client)) return;

            const prompt = stripOwnMention(message.content, client.user.id);
            if (!prompt) return;

            if (state.busy) {
                enqueue(state, prompt, message.id);
                return;
            }

            await processPrompt(state, prompt, message.id);
        } catch (err) {
            dlog(`[message fail] channel=${message.channel?.id || '?'} err=${err.message}`);
            await sendMessage(message.channel.id, `Error: ${err.message}`);
        }
    });

    client.on(Events.InteractionCreate, async (interaction) => {
        if (!interaction.isButton()) return;

        const pending = pendingPerms.get(interaction.message.id);
        if (!pending) {
            await interaction.reply({ content: 'This permission request is no longer active.', ephemeral: true });
            return;
        }
        if (!isAllowedUser(interaction.user.id)) {
            await interaction.reply({ content: 'Not authorized.', ephemeral: true });
            return;
        }

        const { state, perm } = pending;
        pendingPerms.delete(interaction.message.id);

        let allowed = false;
        let scope;
        if (interaction.customId === 'perm_allow') {
            allowed = true;
        } else if (interaction.customId === 'perm_allow_turn') {
            allowed = true;
            scope = 'PERMISSION_SCOPE_TURN';
        } else if (interaction.customId === 'perm_allow_conv') {
            allowed = true;
            scope = 'PERMISSION_SCOPE_CONVERSATION';
        } else if (interaction.customId === 'perm_deny') {
            allowed = false;
        } else {
            await interaction.reply({ content: 'Unknown permission action.', ephemeral: true });
            return;
        }

        await interaction.update(sendPayload(
            `${allowed ? 'Allowed' : 'Denied'} by ${interaction.user.username}\n${formatPermission(perm)}`,
            { components: [] },
        ));

        try {
            if (!state.session) throw new Error('session not ready');
            await state.session.approvePermission(perm, allowed, scope ? { scope } : {});
        } catch (err) {
            dlog(`[perm approve fail] channel=${state.channelId} err=${err.message}`);
            await sendMessage(state.channelId, `Permission handling failed: ${err.message}`);
        }
    });

    client.on(Events.Error, (err) => {
        dlog(`[client error] ${err.message}`);
    });

    process.on('SIGINT', async () => {
        for (const state of channelStates.values()) {
            await destroySession(state);
        }
        discordLog.end();
        await client.destroy();
        process.exit(0);
    });

    await client.login(DISCORD_TOKEN);
}

main().catch((err) => {
    console.error(err);
    dlog(`[fatal] ${err.stack || err.message}`);
    process.exit(1);
});
