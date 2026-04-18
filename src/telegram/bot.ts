import "dotenv/config";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import { StringDecoder } from "node:string_decoder";
import TelegramBot, { type Message } from "node-telegram-bot-api";
import { withDefaultTimezone } from "../config.js";
import { createBackbone } from "../index.js";
import type { Reminder } from "../models.js";

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

const REMINDER_NOTIFICATIONS_ENABLED = (process.env.REMINDER_NOTIFICATIONS_ENABLED ?? "true").toLowerCase() !== "false";
const REMINDER_POLL_SECONDS = Number.parseInt(process.env.REMINDER_POLL_SECONDS ?? "30", 10) || 30;
const REMINDER_USER_EXTERNAL_ID = process.env.TODO_USER_ID ?? "local-user";
const TELEGRAM_REMINDER_CHAT_ID = process.env.TELEGRAM_REMINDER_CHAT_ID;
const REMINDER_DISPATCH_STALE_SECONDS = Number.parseInt(process.env.REMINDER_DISPATCH_STALE_SECONDS ?? "120", 10) || 120;
const REMINDER_SEND_MAX_RETRIES = Number.parseInt(process.env.REMINDER_SEND_MAX_RETRIES ?? "3", 10) || 3;
const REMINDER_SEND_RETRY_BASE_MS = Number.parseInt(process.env.REMINDER_SEND_RETRY_BASE_MS ?? "1000", 10) || 1000;

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
const backbone = createBackbone({ filePath: process.env.DB_PATH });
let webhookServer: Server | null = null;
let reminderInterval: NodeJS.Timeout | null = null;
let reminderPollingInFlight = false;
let reminderChatWarningShown = false;

let queue: Promise<void> = Promise.resolve();

function parseChatId(value?: string): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function getReminderChatId(): number | null {
  return parseChatId(TELEGRAM_REMINDER_CHAT_ID) ?? parseChatId(ALLOWED_CHAT_ID);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDateTime12h(iso: string, timezone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;

  try {
    return new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: withDefaultTimezone(timezone),
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(date);
  }
}

function formatReminderMessage(reminder: Reminder, nowIso: string): string {
  const when = formatDateTime12h(reminder.remindAt, reminder.timezone);
  const dueMs = Date.parse(reminder.remindAt);
  const nowMs = Date.parse(nowIso);
  const isLate = Number.isFinite(dueMs) && Number.isFinite(nowMs) && dueMs < nowMs;

  return `⏰ Reminder${isLate ? " (late)" : ""}\n${reminder.text}\nWhen: ${when}${reminder.todoId ? `\nTodo: #${reminder.todoId}` : ""}`;
}

async function sendReminderWithRetry(chatId: number, reminder: Reminder, nowIso: string): Promise<void> {
  let attempt = 0;
  let lastError: unknown;

  while (attempt < REMINDER_SEND_MAX_RETRIES) {
    try {
      await sendTelegramText(chatId, formatReminderMessage(reminder, nowIso));
      return;
    } catch (error) {
      lastError = error;
      attempt += 1;
      if (attempt >= REMINDER_SEND_MAX_RETRIES) break;

      const backoffMs = REMINDER_SEND_RETRY_BASE_MS * 2 ** (attempt - 1);
      await sleep(backoffMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function pollAndPushDueReminders(): Promise<void> {
  if (!REMINDER_NOTIFICATIONS_ENABLED || reminderPollingInFlight) return;

  const chatId = getReminderChatId();
  if (chatId === null) {
    if (!reminderChatWarningShown) {
      console.warn("Reminder notifications are enabled, but no chat id is configured. Set TELEGRAM_REMINDER_CHAT_ID or TELEGRAM_ALLOWED_CHAT_ID.");
      reminderChatWarningShown = true;
    }
    return;
  }

  reminderPollingInFlight = true;
  const nowIso = new Date().toISOString();
  let fetched = 0;
  let claimed = 0;
  let sent = 0;
  let failed = 0;

  try {
    const due = backbone.reminderService.listDueReminders({
      userExternalId: REMINDER_USER_EXTERNAL_ID,
      asOf: nowIso,
      limit: 200,
    });
    fetched = due.length;

    for (const reminder of due) {
      const claimToken = randomUUID();
      const wasClaimed = backbone.reminderService.claimReminderForDispatch(reminder.id, {
        claimToken,
        staleAfterSeconds: REMINDER_DISPATCH_STALE_SECONDS,
      });
      if (!wasClaimed) continue;

      claimed += 1;

      try {
        await sendReminderWithRetry(chatId, reminder, nowIso);
        backbone.reminderService.markReminderSent(reminder.id);
        backbone.reminderService.markReminderDispatchSent(reminder.id, claimToken);
        sent += 1;
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        backbone.reminderService.markReminderDispatchFailed(reminder.id, message, claimToken);
        console.error(`[reminder dispatcher] send failed reminderId=${reminder.id} error=${message}`);
      }
    }

    if (fetched > 0 || failed > 0) {
      console.log(
        `[reminder dispatcher] poll due=${fetched} claimed=${claimed} sent=${sent} failed=${failed} user=${REMINDER_USER_EXTERNAL_ID}`,
      );
    }
  } catch (error) {
    console.error(`[reminder dispatcher] ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    reminderPollingInFlight = false;
  }
}

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
    if (reminderInterval) {
      clearInterval(reminderInterval);
      reminderInterval = null;
    }

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
    backbone.close();
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

  if (REMINDER_NOTIFICATIONS_ENABLED) {
    await pollAndPushDueReminders();
    reminderInterval = setInterval(() => {
      void pollAndPushDueReminders();
    }, REMINDER_POLL_SECONDS * 1000);

    console.log(
      `Reminder dispatcher active (poll every ${REMINDER_POLL_SECONDS}s, user=${REMINDER_USER_EXTERNAL_ID}, chatId=${getReminderChatId() ?? "not-configured"}).`,
    );
  } else {
    console.log("Reminder dispatcher disabled (REMINDER_NOTIFICATIONS_ENABLED=false).");
  }
})();
