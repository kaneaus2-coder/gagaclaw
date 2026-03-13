/**
 * Discord-related MCP tools for gagaclaw_recommend_mcp.
 * Uses Discord REST API v10 directly (no Gateway WebSocket needed).
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const FormData = require("form-data");

const configPath = path.join(__dirname, "..", "gagaclaw.json");

function readConfig() {
    try {
        return JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
    } catch {
        return {};
    }
}

function pickDiscordConfig(raw) {
    if (raw && raw.discord) return raw;
    const instances = raw && raw.instances && typeof raw.instances === "object" ? raw.instances : {};
    for (const name of ["discord-bot", "research"]) {
        if (instances[name] && instances[name].discord) return instances[name];
    }
    if (typeof raw.defaultInstance === "string" && instances[raw.defaultInstance]?.discord) {
        return instances[raw.defaultInstance];
    }
    for (const inst of Object.values(instances)) {
        if (inst && inst.discord) return inst;
    }
    return {};
}

function getDiscordToken() {
    const raw = readConfig();
    const cfg = pickDiscordConfig(raw);
    return cfg.discord?.token || "";
}
const API_BASE = "/api/v10";

// ─── Low-level Discord REST helper ──────────────────────────────────────────

function discordApi(method, apiPath, body) {
    return new Promise((resolve, reject) => {
        const headers = {
            "Authorization": `Bot ${getDiscordToken()}`,
            "User-Agent": "GagaclawMCP/1.0",
        };

        let payload = null;
        if (body && !(body instanceof FormData)) {
            payload = JSON.stringify(body);
            headers["Content-Type"] = "application/json";
            headers["Content-Length"] = Buffer.byteLength(payload);
        }

        const opts = {
            hostname: "discord.com",
            path: `${API_BASE}${apiPath}`,
            method,
            headers,
        };

        // FormData (multipart) support for file uploads
        if (body instanceof FormData) {
            Object.assign(opts.headers, body.getHeaders());
        }

        const req = https.request(opts, (res) => {
            let data = "";
            res.on("data", (c) => data += c);
            res.on("end", () => {
                // 204 No Content (e.g. kick success)
                if (res.statusCode === 204) return resolve({ success: true });
                try {
                    const json = JSON.parse(data);
                    if (res.statusCode >= 400) {
                        return reject(new Error(`Discord API ${res.statusCode}: ${json.message || data}`));
                    }
                    resolve(json);
                } catch {
                    reject(new Error(`Discord API parse error (${res.statusCode}): ${data.slice(0, 300)}`));
                }
            });
        });

        req.on("error", reject);

        if (body instanceof FormData) {
            body.pipe(req);
        } else {
            if (payload) req.write(payload);
            req.end();
        }
    });
}

// ─── Tool Definitions ───────────────────────────────────────────────────────

const discordTools = [
    {
        name: "discord_list_guilds",
        description: "List all guilds (servers) the bot is in. Returns id, name, icon, owner.",
        inputSchema: { type: "object", properties: {}, required: [] }
    },
    {
        name: "discord_list_channels",
        description: "List all channels in a guild. Returns id, name, type, position, parent_id.",
        inputSchema: {
            type: "object",
            properties: { guildId: { type: "string", description: "Guild (server) ID" } },
            required: ["guildId"]
        }
    },
    {
        name: "discord_list_members",
        description: "List members of a guild. Returns user id, username, nickname, roles, joined_at. Requires Server Members Intent if > 100.",
        inputSchema: {
            type: "object",
            properties: {
                guildId: { type: "string", description: "Guild (server) ID" },
                limit: { type: "number", description: "Max members to fetch (1-1000, default 100)" }
            },
            required: ["guildId"]
        }
    },
    {
        name: "discord_get_channel_messages",
        description: "Get recent messages from a channel. Returns id, author, content, timestamp, attachments.",
        inputSchema: {
            type: "object",
            properties: {
                channelId: { type: "string", description: "Channel ID" },
                limit: { type: "number", description: "Number of messages (1-100, default 20)" }
            },
            required: ["channelId"]
        }
    },
    {
        name: "discord_send_message",
        description: "Send a text message to a Discord channel.",
        inputSchema: {
            type: "object",
            properties: {
                channelId: { type: "string", description: "Channel ID to send to" },
                content: { type: "string", description: "Message content (max 2000 chars)" }
            },
            required: ["channelId", "content"]
        }
    },
    {
        name: "discord_send_file",
        description: "Upload a file to a Discord channel with optional message text.",
        inputSchema: {
            type: "object",
            properties: {
                channelId: { type: "string", description: "Channel ID to upload to" },
                filePath: { type: "string", description: "Absolute path to the file" },
                content: { type: "string", description: "Optional message text to accompany the file" }
            },
            required: ["channelId", "filePath"]
        }
    },
    {
        name: "discord_get_guild_info",
        description: "Get detailed info about a guild (server): name, owner, member count, boosts, features, etc.",
        inputSchema: {
            type: "object",
            properties: { guildId: { type: "string", description: "Guild (server) ID" } },
            required: ["guildId"]
        }
    },
    {
        name: "discord_get_user_info",
        description: "Get info about a Discord user: username, discriminator, avatar, banner, etc.",
        inputSchema: {
            type: "object",
            properties: { userId: { type: "string", description: "User ID" } },
            required: ["userId"]
        }
    },
    {
        name: "discord_kick_member",
        description: "Kick a member from a guild (server). Requires KICK_MEMBERS permission.",
        inputSchema: {
            type: "object",
            properties: {
                guildId: { type: "string", description: "Guild (server) ID" },
                userId: { type: "string", description: "User ID to kick" },
                reason: { type: "string", description: "Reason for kicking (shows in audit log)" }
            },
            required: ["guildId", "userId"]
        }
    },
];

// ─── Tool Handlers ──────────────────────────────────────────────────────────

async function handleDiscordTool(name, args) {
    if (!getDiscordToken()) {
        return { content: [{ type: "text", text: "Error: No discord.token configured in gagaclaw.json" }], isError: true };
    }

    try {
        switch (name) {

            case "discord_list_guilds": {
                const guilds = await discordApi("GET", "/users/@me/guilds");
                const summary = guilds.map(g => `• ${g.name} (ID: ${g.id})${g.owner ? " [Owner]" : ""}`).join("\n");
                return ok(`Found ${guilds.length} guild(s):\n${summary}`);
            }

            case "discord_list_channels": {
                const { guildId } = args;
                const channels = await discordApi("GET", `/guilds/${guildId}/channels`);
                // Sort by position, group by type
                const typeNames = { 0: "Text", 2: "Voice", 4: "Category", 5: "Announcement", 13: "Stage", 15: "Forum" };
                const sorted = channels.sort((a, b) => (a.position || 0) - (b.position || 0));
                const lines = sorted.map(c => {
                    const typeName = typeNames[c.type] || `Type ${c.type}`;
                    return `• [${typeName}] #${c.name} (ID: ${c.id})`;
                });
                return ok(`${channels.length} channel(s) in guild ${guildId}:\n${lines.join("\n")}`);
            }

            case "discord_list_members": {
                const { guildId, limit } = args;
                const lim = Math.min(Math.max(limit || 100, 1), 1000);
                const members = await discordApi("GET", `/guilds/${guildId}/members?limit=${lim}`);
                const lines = members.map(m => {
                    const u = m.user;
                    const nick = m.nick ? ` (${m.nick})` : "";
                    const bot = u.bot ? " [BOT]" : "";
                    const roles = m.roles?.length ? ` roles: ${m.roles.length}` : "";
                    return `• ${u.username}${nick}${bot} (ID: ${u.id})${roles}`;
                });
                return ok(`${members.length} member(s) in guild ${guildId}:\n${lines.join("\n")}`);
            }

            case "discord_get_channel_messages": {
                const { channelId, limit } = args;
                const lim = Math.min(Math.max(limit || 20, 1), 100);
                const messages = await discordApi("GET", `/channels/${channelId}/messages?limit=${lim}`);
                const lines = messages.map(m => {
                    const author = m.author?.username || "unknown";
                    const time = m.timestamp ? new Date(m.timestamp).toLocaleString("zh-TW") : "";
                    const text = (m.content || "").slice(0, 200);
                    const attachments = m.attachments?.length ? ` [${m.attachments.length} file(s)]` : "";
                    return `[${time}] ${author}: ${text}${attachments}`;
                });
                return ok(`${messages.length} message(s) in channel ${channelId}:\n${lines.join("\n")}`);
            }

            case "discord_send_message": {
                const { channelId, content } = args;
                const result = await discordApi("POST", `/channels/${channelId}/messages`, { content: content.slice(0, 2000) });
                return ok(`Message sent (ID: ${result.id}) to channel ${channelId}`);
            }

            case "discord_send_file": {
                const { channelId, filePath, content } = args;
                const absolutePath = path.resolve(filePath);
                if (!fs.existsSync(absolutePath)) {
                    return { content: [{ type: "text", text: `File not found: ${absolutePath}` }], isError: true };
                }
                const form = new FormData();
                form.append("files[0]", fs.createReadStream(absolutePath), { filename: path.basename(absolutePath) });
                if (content) {
                    form.append("payload_json", JSON.stringify({ content: content.slice(0, 2000) }), { contentType: "application/json" });
                }
                const result = await discordApi("POST", `/channels/${channelId}/messages`, form);
                return ok(`File uploaded (Message ID: ${result.id}) to channel ${channelId}`);
            }

            case "discord_get_guild_info": {
                const { guildId } = args;
                const guild = await discordApi("GET", `/guilds/${guildId}?with_counts=true`);
                const lines = [
                    `Name: ${guild.name}`,
                    `ID: ${guild.id}`,
                    `Owner ID: ${guild.owner_id}`,
                    `Members: ~${guild.approximate_member_count || "?"}`,
                    `Online: ~${guild.approximate_presence_count || "?"}`,
                    `Boosts: ${guild.premium_subscription_count || 0} (Tier ${guild.premium_tier || 0})`,
                    `Features: ${(guild.features || []).join(", ") || "none"}`,
                    `Created: ${new Date(Number(BigInt(guild.id) >> 22n) + 1420070400000).toLocaleString("zh-TW")}`,
                ];
                return ok(lines.join("\n"));
            }

            case "discord_get_user_info": {
                const { userId } = args;
                const user = await discordApi("GET", `/users/${userId}`);
                const lines = [
                    `Username: ${user.username}`,
                    `Display: ${user.global_name || user.username}`,
                    `ID: ${user.id}`,
                    `Bot: ${user.bot ? "Yes" : "No"}`,
                    `Created: ${new Date(Number(BigInt(user.id) >> 22n) + 1420070400000).toLocaleString("zh-TW")}`,
                ];
                if (user.avatar) lines.push(`Avatar: https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`);
                if (user.banner) lines.push(`Banner: https://cdn.discordapp.com/banners/${user.id}/${user.banner}.png`);
                return ok(lines.join("\n"));
            }

            case "discord_kick_member": {
                const { guildId, userId, reason } = args;
                const headers = {};
                if (reason) headers["X-Audit-Log-Reason"] = encodeURIComponent(reason);
                // discordApi doesn't support extra headers natively, so we do a manual call
                await kickMember(guildId, userId, reason);
                return ok(`Kicked user ${userId} from guild ${guildId}${reason ? ` (reason: ${reason})` : ""}`);
            }

            default:
                return { content: [{ type: "text", text: `Unknown discord tool: ${name}` }], isError: true };
        }
    } catch (err) {
        return { content: [{ type: "text", text: `Discord API error: ${err.message}` }], isError: true };
    }
}

function ok(text) {
    return { content: [{ type: "text", text }] };
}

// Kick requires X-Audit-Log-Reason header — special-cased
function kickMember(guildId, userId, reason) {
    return new Promise((resolve, reject) => {
        const headers = {
            "Authorization": `Bot ${getDiscordToken()}`,
            "User-Agent": "GagaclawMCP/1.0",
        };
        if (reason) headers["X-Audit-Log-Reason"] = encodeURIComponent(reason);

        const req = https.request({
            hostname: "discord.com",
            path: `${API_BASE}/guilds/${guildId}/members/${userId}`,
            method: "DELETE",
            headers,
        }, (res) => {
            let data = "";
            res.on("data", (c) => data += c);
            res.on("end", () => {
                if (res.statusCode === 204) return resolve({ success: true });
                try {
                    const json = JSON.parse(data);
                    if (res.statusCode >= 400) return reject(new Error(`Discord API ${res.statusCode}: ${json.message || data}`));
                    resolve(json);
                } catch {
                    reject(new Error(`Discord API ${res.statusCode}: ${data.slice(0, 300)}`));
                }
            });
        });
        req.on("error", reject);
        req.end();
    });
}

module.exports = { discordTools, handleDiscordTool };
