import "dotenv/config";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import { StringDecoder } from "node:string_decoder";
import TelegramBot, { type Message } from "node-telegram-bot-api";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_BOT_TOKEN) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN in environment.");
}

const ALLOWED_CHAT_ID = process.env.TELEGRAM_ALLOWED_CHAT_ID;
const PI_BIN = process.env.PI_BIN ?? "pi";
const PI_PROVIDER = process.env.PI_PROVIDER;
const PI_MODEL = process.env.PI_MODEL;
const PI_EXTRA_ARGS = (process.env.PI_EXTRA_ARGS ?? "").trim();

const TELEGRAM_MODE = (process.env.TELEGRAM_MODE ?? "polling").toLowerCase();
const TELEGRAM_WEBHOOK_URL = process.env.TELEGRAM_WEBHOOK_URL;
const TELEGRAM_WEBHOOK_PATH = process.env.TELEGRAM_WEBHOOK_PATH ?? "/telegram/webhook";
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const TELEGRAM_WEBHOOK_HOST = process.env.TELEGRAM_WEBHOOK_HOST ?? "0.0.0.0";
const TELEGRAM_WEBHOOK_PORT = Number.parseInt(process.env.TELEGRAM_WEBHOOK_PORT ?? "8788", 10) || 8788;

type RpcResponse = {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  error?: string;
  data?: unknown;
};

type RpcEvent = Record<string, unknown> & { type: string };

class PiRpcClient {
  private proc: ChildProcessWithoutNullStreams;
  private decoder = new StringDecoder("utf8");
  private buffer = "";
  private nextId = 1;
  private pending = new Map<string, { resolve: (value: RpcResponse) => void; reject: (err: Error) => void }>();
  private events = new EventEmitter();

  constructor() {
    const args = ["--mode", "rpc"];
    if (PI_PROVIDER) args.push("--provider", PI_PROVIDER);
    if (PI_MODEL) args.push("--model", PI_MODEL);
    if (PI_EXTRA_ARGS) args.push(...PI_EXTRA_ARGS.split(/\s+/).filter(Boolean));

    this.proc = spawn(PI_BIN, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stdout.on("data", (chunk) => this.onStdoutChunk(chunk));

    this.proc.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text) this.events.emit("stderr", text);
    });

    this.proc.on("exit", (code, signal) => {
      const error = new Error(`pi rpc exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
      for (const [, waiter] of this.pending) waiter.reject(error);
      this.pending.clear();
      this.events.emit("exit", error);
    });
  }

  private onStdoutChunk(chunk: Buffer | string) {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);

    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) break;

      let line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;

      try {
        const msg = JSON.parse(line) as RpcEvent | RpcResponse;
        if (msg.type === "response") {
          const response = msg as RpcResponse;
          if (response.id && this.pending.has(response.id)) {
            const waiter = this.pending.get(response.id)!;
            this.pending.delete(response.id);
            waiter.resolve(response);
          }
        } else {
          this.events.emit("event", msg);
          this.events.emit(msg.type, msg);
        }
      } catch (err) {
        this.events.emit("parse_error", { line, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  async command(command: Record<string, unknown>): Promise<RpcResponse> {
    const id = `req-${this.nextId++}`;
    const payload = { id, ...command };

    const responsePromise = new Promise<RpcResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);

    const response = await responsePromise;
    if (!response.success) {
      throw new Error(response.error ?? `RPC command failed: ${String(command.type)}`);
    }
    return response;
  }

  async runPrompt(message: string): Promise<string> {
    let text = "";

    const onUpdate = (event: RpcEvent) => {
      if (event.type !== "message_update") return;
      const assistantMessageEvent = event.assistantMessageEvent as Record<string, unknown> | undefined;
      if (!assistantMessageEvent) return;
      if (assistantMessageEvent.type === "text_delta") {
        const delta = assistantMessageEvent.delta;
        if (typeof delta === "string") text += delta;
      }
    };

    this.events.on("message_update", onUpdate);

    try {
      await this.command({ type: "prompt", message });

      await new Promise<void>((resolve, reject) => {
        const onAgentEnd = () => {
          cleanup();
          resolve();
        };
        const onExit = (err: Error) => {
          cleanup();
          reject(err);
        };

        const cleanup = () => {
          this.events.off("agent_end", onAgentEnd);
          this.events.off("exit", onExit);
        };

        this.events.on("agent_end", onAgentEnd);
        this.events.on("exit", onExit);
      });
    } finally {
      this.events.off("message_update", onUpdate);
    }

    if (text.trim()) return text.trim();

    const last = await this.command({ type: "get_last_assistant_text" });
    const maybeData = last.data as { text?: string | null } | undefined;
    const fallback = maybeData?.text;
    return typeof fallback === "string" && fallback.trim() ? fallback.trim() : "(No response text returned.)";
  }

  on(eventType: string, handler: (payload: unknown) => void) {
    this.events.on(eventType, handler);
  }

  close() {
    this.proc.kill("SIGTERM");
  }
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: TELEGRAM_MODE === "polling" });
const rpc = new PiRpcClient();
let webhookServer: Server | null = null;

let queue: Promise<void> = Promise.resolve();

function denyUnauthorized(msg: Message): boolean {
  if (!ALLOWED_CHAT_ID) return false;
  const allowed = Number.parseInt(ALLOWED_CHAT_ID, 10);
  if (Number.isNaN(allowed)) return false;
  return msg.chat.id !== allowed;
}

async function sendTelegramText(chatId: number, text: string): Promise<void> {
  try {
    await bot.sendMessage(chatId, text, {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    });
  } catch {
    await bot.sendMessage(chatId, text, {
      disable_web_page_preview: true,
    });
  }
}

async function handleMessage(msg: Message): Promise<void> {
  if (!msg.text) return;
  if (denyUnauthorized(msg)) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text === "/start" || text === "/help") {
    await sendTelegramText(
      chatId,
      "Relay mode active ✅\nI forward your exact message to the pi agent and send the agent response back here.",
    );
    return;
  }

  const reply = await rpc.runPrompt(text);
  await sendTelegramText(chatId, reply);
}

async function setupWebhookMode(): Promise<void> {
  if (!TELEGRAM_WEBHOOK_URL) {
    throw new Error("TELEGRAM_WEBHOOK_URL is required when TELEGRAM_MODE=webhook");
  }

  await bot.setWebHook(TELEGRAM_WEBHOOK_URL, {
    secret_token: TELEGRAM_WEBHOOK_SECRET,
  } as any);

  webhookServer = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain");
      res.end("ok");
      return;
    }

    const urlPath = (req.url ?? "").split("?")[0];
    if (req.method !== "POST" || urlPath !== TELEGRAM_WEBHOOK_PATH) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }

    if (TELEGRAM_WEBHOOK_SECRET) {
      const header = req.headers["x-telegram-bot-api-secret-token"];
      if (header !== TELEGRAM_WEBHOOK_SECRET) {
        res.statusCode = 401;
        res.end("unauthorized");
        return;
      }
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString("utf8");
    });

    req.on("end", async () => {
      try {
        const update = JSON.parse(body);
        bot.processUpdate(update);
        res.statusCode = 200;
        res.end("ok");
      } catch (error) {
        res.statusCode = 400;
        res.end(`invalid update: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    webhookServer!.once("error", reject);
    webhookServer!.listen(TELEGRAM_WEBHOOK_PORT, TELEGRAM_WEBHOOK_HOST, () => {
      webhookServer!.off("error", reject);
      resolve();
    });
  });
}

bot.on("message", (msg) => {
  queue = queue
    .then(() => handleMessage(msg))
    .catch(async (error) => {
      if (msg.chat?.id) {
        await sendTelegramText(msg.chat.id, `Sorry, relay error: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
});

rpc.on("stderr", (line) => {
  console.error(`[pi-rpc stderr] ${String(line)}`);
});

rpc.on("parse_error", (err) => {
  console.error(`[pi-rpc parse error] ${JSON.stringify(err)}`);
});

rpc.on("exit", (err) => {
  console.error(`[pi-rpc exit] ${err instanceof Error ? err.message : String(err)}`);
});

async function shutdown() {
  try {
    if (TELEGRAM_MODE === "webhook") {
      try {
        await bot.deleteWebHook();
      } catch {
        // ignore cleanup errors
      }
      if (webhookServer) {
        await new Promise<void>((resolve) => webhookServer!.close(() => resolve()));
      }
    }
  } finally {
    rpc.close();
  }
}

process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});

(async () => {
  if (TELEGRAM_MODE === "webhook") {
    await setupWebhookMode();
    console.log(
      `Telegram bot started (relay mode, webhook). Listening on http://${TELEGRAM_WEBHOOK_HOST}:${TELEGRAM_WEBHOOK_PORT}${TELEGRAM_WEBHOOK_PATH}`,
    );
  } else {
    console.log("Telegram bot started (relay mode, polling).");
  }
})();
