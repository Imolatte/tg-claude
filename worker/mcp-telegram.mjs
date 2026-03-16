#!/usr/bin/env node

/**
 * MCP server: gives Claude tools to send messages and files to the bot owner in Telegram.
 * Protocol: stdio JSON-RPC (MCP spec)
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { createInterface } from "readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, "..", "config.json"), "utf-8"));
const BOT_TOKEN = config.botToken;
const CHAT_ID = config.chatId;

// WS bridge removed — using /opt/axon-team/ file-based channel

async function sendTelegram(text, chatId) {
  const targetId = String(chatId || CHAT_ID);
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: targetId, text, parse_mode: "HTML" }),
  });
  const data = await res.json();
  return data.ok ? "Message sent" : `Failed: ${JSON.stringify(data)}`;
}

async function sendFile(filePath, caption, chatId) {
  if (!existsSync(filePath)) return `File not found: ${filePath}`;

  const fileBuffer = readFileSync(filePath);
  const fileName = basename(filePath);
  const form = new FormData();
  form.append("chat_id", chatId || CHAT_ID);
  form.append("document", new Blob([fileBuffer]), fileName);
  if (caption) form.append("caption", caption);

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, {
    method: "POST",
    body: form,
  });
  const data = await res.json();
  return data.ok ? `File "${fileName}" sent` : `Failed: ${JSON.stringify(data)}`;
}

// MCP JSON-RPC over stdio
const rl = createInterface({ input: process.stdin });
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

rl.on("line", async (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }

  const { id, method, params } = req;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "telegram-notify", version: "1.0.0" },
        capabilities: { tools: {} },
      },
    });
    return;
  }

  if (method === "notifications/initialized") return;

  if (method === "tools/list") {
    send({
      jsonrpc: "2.0", id,
      result: {
        tools: [
          {
            name: "send_telegram",
            description: "Send a text message to the user in Telegram. Use this when you need to ask a question, report progress, or notify about an issue.",
            inputSchema: {
              type: "object",
              properties: {
                message: { type: "string", description: "The message text (supports HTML: <b>, <i>, <code>, <pre>)" },
                chat_id: { type: "string", description: "Target chat ID. Omit to send to the bot owner's DM." },
              },
              required: ["message"],
            },
          },
          {
            name: "send_file_telegram",
            description: "Send a file to the user in Telegram. Use this to share configs, logs, scripts, or any file the user needs. The file will appear as a downloadable attachment.",
            inputSchema: {
              type: "object",
              properties: {
                file_path: { type: "string", description: "Absolute path to the file to send" },
                caption: { type: "string", description: "Optional caption for the file" },
                chat_id: { type: "string", description: "Target chat ID. Omit to send to the bot owner's DM." },
              },
              required: ["file_path"],
            },
          },
        ],
      },
    });
    return;
  }

  if (method === "tools/call") {
    const toolName = params?.name;
    const args = params?.arguments || {};

    if (toolName === "send_telegram") {
      try {
        const result = await sendTelegram(args.message || "(empty)", args.chat_id);
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: result }] } });
      } catch (err) {
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true } });
      }
      return;
    }

    if (toolName === "send_file_telegram") {
      try {
        const result = await sendFile(args.file_path, args.caption, args.chat_id);
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: result }] } });
      } catch (err) {
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true } });
      }
      return;
    }

    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool: ${toolName}` } });
    return;
  }

  // Unknown method
  if (id) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } });
  }
});
