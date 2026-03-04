const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const fs = require("fs");
const path = require("path");
const https = require("https");
const FormData = require("form-data");

const configPath = path.join(__dirname, "..", "..", "gagaclaw.json");
let config = {};
try { config = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch (err) { process.exit(1); }

const tgToken = config.telegram?.token;
const tgChatId = config.telegram?.adminChatId || (config.telegram?.allowedUsers || [])[0];
const groqApiKey = config.groq?.apiKey;

const server = new Server({ name: "gagaclaw_recommend_mcp", version: "1.0.0" }, { capabilities: { tools: {} } });

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
        }
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
        default: throw new Error("Unknown tool");
    }
});

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("MCP Server running");
}
main().catch(console.error);
