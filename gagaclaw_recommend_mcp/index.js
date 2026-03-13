const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const fs = require("fs");
const path = require("path");
const https = require("https");
const FormData = require("form-data");
const { discordTools, handleDiscordTool } = require("./discord-related");

const configPath = path.join(__dirname, "..", "gagaclaw.json");
let config = {};
try { config = JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "")); } catch (err) { process.exit(1); }

function getInstances(raw) {
    return raw && raw.instances && typeof raw.instances === "object" ? raw.instances : {};
}

function pickConfigWithKey(raw, key, preferredNames = []) {
    if (raw && raw[key]) return raw;
    const instances = getInstances(raw);
    for (const name of preferredNames) {
        if (instances[name] && instances[name][key]) return instances[name];
    }
    if (typeof raw.defaultInstance === "string" && instances[raw.defaultInstance]?.[key]) {
        return instances[raw.defaultInstance];
    }
    for (const inst of Object.values(instances)) {
        if (inst && inst[key]) return inst;
    }
    return {};
}

const telegramCfg = pickConfigWithKey(config, "telegram", ["telegram-agent", "main"]);
const tgToken = telegramCfg.telegram?.token || "";
const tgChatId = telegramCfg.telegram?.adminChatId || (telegramCfg.telegram?.allowedUsers || [])[0];
const groqApiKey = config.groq?.apiKey;

const server = new Server({ name: "gagaclaw_recommend_mcp", version: "1.2.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "groq_transcribe",
            description: "Translate audio file to text using Groq Whisper. Pass absolute file path.",
            inputSchema: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] }
        },
        {
            name: "telegram_send_file",
            description: "Send file to Telegram admin. Auto-converts .md to .html.",
            inputSchema: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] }
        },
        ...discordTools
    ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    switch (request.params.name) {
        case "groq_transcribe": {
            const { filePath } = request.params.arguments;
            const absoluteFilePath = path.resolve(filePath);
            if (!fs.existsSync(absoluteFilePath)) return { content: [{ type: "text", text: "File not found" }], isError: true };
            try {
                const formData = new FormData();
                formData.append("file", fs.createReadStream(absoluteFilePath));
                formData.append("model", "whisper-large-v3");
                const result = await new Promise((resolve, reject) => {
                    const req = https.request({
                        hostname: "api.groq.com", path: "/openai/v1/audio/transcriptions", method: "POST",
                        headers: { Authorization: `Bearer ${groqApiKey}`, ...formData.getHeaders() }
                    }, res => {
                        let data = ""; res.on("data", c => data += c);
                        res.on("end", () => resolve(JSON.parse(data).text));
                    });
                    formData.pipe(req);
                });
                return { content: [{ type: "text", text: result }] };
            } catch (err) { return { content: [{ type: "text", text: err.message }], isError: true }; }
        }
        case "telegram_send_file": {
            const { filePath } = request.params.arguments;
            const absoluteFilePath = path.resolve(filePath);
            if (!fs.existsSync(absoluteFilePath)) return { content: [{ type: "text", text: "File not found" }], isError: true };
            try {
                let fileName = path.basename(absoluteFilePath);
                let fileData = fs.readFileSync(absoluteFilePath);
                if (fileName.endsWith(".md")) {
                    const md = fileData.toString("utf8")
                        .replace(/^### (.*$)/gim, "<h3>$1</h3>")
                        .replace(/^## (.*$)/gim, "<h2>$1</h2>")
                        .replace(/^# (.*$)/gim, "<h1>$1</h1>");
                    fileData = Buffer.from(`<html><body>${md}</body></html>`, "utf8");
                    fileName = fileName.replace(".md", ".html");
                }
                const formData = new FormData();
                formData.append("chat_id", tgChatId);
                formData.append("document", fileData, { filename: fileName });
                const result = await new Promise((resolve, reject) => {
                    const req = https.request({
                        hostname: "api.telegram.org", path: `/bot${tgToken}/sendDocument`, method: "POST",
                        headers: formData.getHeaders()
                    }, res => {
                        let data = ""; res.on("data", c => data += c);
                        res.on("end", () => resolve(JSON.parse(data).result.message_id));
                    });
                    formData.pipe(req);
                });
                return { content: [{ type: "text", text: `Success: ${result}` }] };
            } catch (err) { return { content: [{ type: "text", text: err.message }], isError: true }; }
        }
        default: {
            // Route discord_* tools to discord-related handler
            if (request.params.name.startsWith("discord_")) {
                return await handleDiscordTool(request.params.name, request.params.arguments);
            }
            throw new Error("Unknown tool");
        }
    }
});

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("MCP Server running");
}
main().catch(console.error);
