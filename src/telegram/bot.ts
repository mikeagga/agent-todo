import "dotenv/config";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { DateTime } from "luxon";
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
const PI_PROMPT_PREFIX = (process.env.PI_PROMPT_PREFIX ?? "").trim();

const REMINDER_NOTIFICATIONS_ENABLED = (process.env.REMINDER_NOTIFICATIONS_ENABLED ?? "true").toLowerCase() !== "false";
const REMINDER_POLL_SECONDS = Number.parseInt(process.env.REMINDER_POLL_SECONDS ?? "30", 10) || 30;
const REMINDER_USER_EXTERNAL_ID = process.env.TODO_USER_ID ?? "local-user";
const TELEGRAM_REMINDER_CHAT_ID = process.env.TELEGRAM_REMINDER_CHAT_ID;
const REMINDER_DISPATCH_STALE_SECONDS = Number.parseInt(process.env.REMINDER_DISPATCH_STALE_SECONDS ?? "120", 10) || 120;
const REMINDER_SEND_MAX_RETRIES = Number.parseInt(process.env.REMINDER_SEND_MAX_RETRIES ?? "3", 10) || 3;
const REMINDER_SEND_RETRY_BASE_MS = Number.parseInt(process.env.REMINDER_SEND_RETRY_BASE_MS ?? "1000", 10) || 1000;

const AUTO_PI_SCHEDULES_FILE = path.resolve(process.cwd(), ".pi", "auto-pi-schedules.json");
const AUTO_PI_DEFAULT_TIMEZONE = withDefaultTimezone(process.env.DEFAULT_TIMEZONE);
const RELAY_DEFAULT_TIMEZONE = withDefaultTimezone(process.env.DEFAULT_TIMEZONE);
const PI_RPC_IDLE_MINUTES = Number.parseInt(process.env.PI_RPC_IDLE_MINUTES ?? "30", 10) || 30;

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

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
let rpc: PiRpcClient | null = null;
let rpcIdleTimer: NodeJS.Timeout | null = null;
let rpcLastActivityAt = Date.now();
const backbone = createBackbone({ filePath: process.env.DB_PATH });
let reminderInterval: NodeJS.Timeout | null = null;
let reminderPollingInFlight = false;
let reminderChatWarningShown = false;

let queue: Promise<void> = Promise.resolve();
let autoPiScheduleInterval: NodeJS.Timeout | null = null;

type AutoPiSchedule = {
  id: string;
  timeHHMM: string;
  prompt: string;
  timezone: string;
  chatId: number | null;
};

type AutoPiSchedulesConfig = {
  enabled: boolean;
  pollSeconds: number;
  defaultChatId: number | null;
  defaultTimezone: string;
  schedules: AutoPiSchedule[];
  source: string;
};

function ensureRpc(): PiRpcClient {
  if (!rpc) {
    rpc = new PiRpcClient();
    rpc.on("stderr", (line) => {
      console.error(`[pi-rpc stderr] ${String(line)}`);
    });

    rpc.on("parse_error", (err) => {
      console.error(`[pi-rpc parse error] ${JSON.stringify(err)}`);
    });

    rpc.on("exit", (err) => {
      console.error(`[pi-rpc exit] ${err instanceof Error ? err.message : String(err)}`);
      rpc = null;
    });

    console.log("[pi-rpc] started");
  }
  return rpc;
}

function touchRpcActivity() {
  rpcLastActivityAt = Date.now();
  if (PI_RPC_IDLE_MINUTES <= 0) return;
  if (rpcIdleTimer) clearTimeout(rpcIdleTimer);

  rpcIdleTimer = setTimeout(() => {
    const idleMs = Date.now() - rpcLastActivityAt;
    const thresholdMs = PI_RPC_IDLE_MINUTES * 60 * 1000;
    if (idleMs < thresholdMs || !rpc) return;

    console.log(`[pi-rpc] idle for ${Math.floor(idleMs / 1000)}s, shutting down instance`);
    rpc.close();
    rpc = null;
  }, PI_RPC_IDLE_MINUTES * 60 * 1000 + 1000);
}

async function runPromptViaRpc(prompt: string): Promise<string> {
  touchRpcActivity();
  const client = ensureRpc();
  try {
    const reply = await client.runPrompt(prompt);
    touchRpcActivity();
    return reply;
  } catch (error) {
    touchRpcActivity();
    throw error;
  }
}

function parseChatId(value?: string | number | null): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function getReminderChatId(): number | null {
  return parseChatId(TELEGRAM_REMINDER_CHAT_ID) ?? parseChatId(ALLOWED_CHAT_ID);
}

function normalizeTimeHHMM(input: string): string | null {
  const trimmed = input.trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (!match) return null;
  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function parseScheduleList(raw: unknown, defaults: { timezone: string; chatId: number | null }): AutoPiSchedule[] {
  if (!Array.isArray(raw)) return [];

  const schedules: AutoPiSchedule[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const id = typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : `schedule-${schedules.length + 1}`;
    const timeHHMM = typeof obj.time === "string" ? normalizeTimeHHMM(obj.time) : null;
    const prompt = typeof obj.prompt === "string" ? obj.prompt.trim() : "";
    const timezone = withDefaultTimezone(typeof obj.timezone === "string" ? obj.timezone : defaults.timezone);
    const chatId = parseChatId(
      typeof obj.chatId === "string" || typeof obj.chatId === "number" ? (obj.chatId as string | number) : null,
    );

    if (!timeHHMM || !prompt) continue;
    schedules.push({ id, timeHHMM, prompt, timezone, chatId: chatId ?? defaults.chatId });
  }

  const seen = new Set<string>();
  return schedules.filter((schedule) => {
    if (seen.has(schedule.id)) return false;
    seen.add(schedule.id);
    return true;
  });
}

function loadAutoPiSchedulesConfig(): AutoPiSchedulesConfig {
  const defaults = {
    timezone: AUTO_PI_DEFAULT_TIMEZONE,
    chatId: getReminderChatId(),
    pollSeconds: 30,
  };

  if (!existsSync(AUTO_PI_SCHEDULES_FILE)) {
    return {
      enabled: false,
      pollSeconds: defaults.pollSeconds,
      defaultChatId: defaults.chatId,
      defaultTimezone: defaults.timezone,
      schedules: [],
      source: AUTO_PI_SCHEDULES_FILE,
    };
  }

  try {
    const rawText = readFileSync(AUTO_PI_SCHEDULES_FILE, "utf8").trim();
    if (!rawText) {
      return {
        enabled: false,
        pollSeconds: defaults.pollSeconds,
        defaultChatId: defaults.chatId,
        defaultTimezone: defaults.timezone,
        schedules: [],
        source: AUTO_PI_SCHEDULES_FILE,
      };
    }

    const parsed = JSON.parse(rawText) as unknown;

    if (Array.isArray(parsed)) {
      const schedules = parseScheduleList(parsed, { timezone: defaults.timezone, chatId: defaults.chatId });
      return {
        enabled: schedules.length > 0,
        pollSeconds: defaults.pollSeconds,
        defaultChatId: defaults.chatId,
        defaultTimezone: defaults.timezone,
        schedules,
        source: AUTO_PI_SCHEDULES_FILE,
      };
    }

    if (parsed && typeof parsed === "object") {
      const cfg = parsed as Record<string, unknown>;
      const enabled = cfg.enabled === undefined ? true : cfg.enabled === true;
      const pollSeconds =
        typeof cfg.pollSeconds === "number" && Number.isFinite(cfg.pollSeconds) && cfg.pollSeconds >= 5
          ? Math.floor(cfg.pollSeconds)
          : defaults.pollSeconds;
      const defaultTimezone = withDefaultTimezone(
        typeof cfg.defaultTimezone === "string" ? cfg.defaultTimezone : defaults.timezone,
      );
      const defaultChatId = parseChatId(
        typeof cfg.defaultChatId === "string" || typeof cfg.defaultChatId === "number"
          ? (cfg.defaultChatId as string | number)
          : defaults.chatId,
      );
      const schedules = parseScheduleList(cfg.schedules, { timezone: defaultTimezone, chatId: defaultChatId });

      return {
        enabled: enabled && schedules.length > 0,
        pollSeconds,
        defaultChatId,
        defaultTimezone,
        schedules,
        source: AUTO_PI_SCHEDULES_FILE,
      };
    }

    console.warn(`[auto-pi-schedule] Invalid JSON format in ${AUTO_PI_SCHEDULES_FILE}. Expected object or array.`);
  } catch (error) {
    console.warn(
      `[auto-pi-schedule] Failed to load ${AUTO_PI_SCHEDULES_FILE}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    enabled: false,
    pollSeconds: defaults.pollSeconds,
    defaultChatId: defaults.chatId,
    defaultTimezone: defaults.timezone,
    schedules: [],
    source: AUTO_PI_SCHEDULES_FILE,
  };
}

const autoPiScheduleConfig = loadAutoPiSchedulesConfig();
const autoPiSchedules = autoPiScheduleConfig.schedules;
const autoPiLastRunBySchedule = new Map<string, string>();

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

function applyPromptPrefix(userPrompt: string): string {
  const basePrefix = `Default user timezone: ${RELAY_DEFAULT_TIMEZONE}. Assume this timezone unless the user explicitly provides a different one. Do not ask for timezone if not required.`;
  const mergedPrefix = PI_PROMPT_PREFIX ? `${PI_PROMPT_PREFIX}\n${basePrefix}` : basePrefix;
  return `${mergedPrefix}\n\nUser request:\n${userPrompt}`;
}

async function sendTelegramText(chatId: number, text: string): Promise<void> {
  await bot.sendMessage(chatId, text, {
    disable_web_page_preview: true,
  });
}

function enqueueAgentPrompt(chatId: number, prompt: string, originLabel?: string): void {
  queue = queue
    .then(async () => {
      const reply = await runPromptViaRpc(applyPromptPrefix(prompt));
      const header = originLabel ? `🗓️ ${originLabel}\n\n` : "";
      await sendTelegramText(chatId, `${header}${reply}`);
    })
    .catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[auto-pi-schedule] ${message}`);
      await sendTelegramText(chatId, `Scheduled prompt failed: ${message}`);
    });
}

function runAutoPiSchedulesTick(): void {
  if (!autoPiScheduleConfig.enabled) return;
  if (autoPiSchedules.length === 0) return;

  const fallbackChatId = autoPiScheduleConfig.defaultChatId ?? getReminderChatId();

  for (const schedule of autoPiSchedules) {
    const nowInZone = DateTime.utc().setZone(schedule.timezone);
    if (!nowInZone.isValid) continue;

    const currentHHMM = nowInZone.toFormat("HH:mm");
    if (currentHHMM !== schedule.timeHHMM) continue;

    const todayKey = nowInZone.toISODate() ?? nowInZone.toFormat("yyyy-MM-dd");
    const lastRunKey = autoPiLastRunBySchedule.get(schedule.id);
    if (lastRunKey === todayKey) continue;

    const chatId = schedule.chatId ?? fallbackChatId;
    if (chatId === null) {
      console.warn(
        `[auto-pi-schedule] schedule=${schedule.id} skipped: no chat id configured (set defaultChatId in ${autoPiScheduleConfig.source} or TELEGRAM_REMINDER_CHAT_ID).`,
      );
      continue;
    }

    autoPiLastRunBySchedule.set(schedule.id, todayKey);
    enqueueAgentPrompt(chatId, schedule.prompt, `Scheduled (${schedule.id} @ ${schedule.timeHHMM} ${schedule.timezone})`);
  }
}

async function handleMessage(msg: Message): Promise<void> {
  if (!msg.text) return;
  if (denyUnauthorized(msg)) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text === "/start" || text === "/help") {
    await sendTelegramText(chatId, "reyaly mode active");
    return;
  }

  const reply = await runPromptViaRpc(applyPromptPrefix(text));
  await sendTelegramText(chatId, reply);
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

async function shutdown() {
  try {
    if (reminderInterval) {
      clearInterval(reminderInterval);
      reminderInterval = null;
    }

    if (autoPiScheduleInterval) {
      clearInterval(autoPiScheduleInterval);
      autoPiScheduleInterval = null;
    }

  } finally {
    if (rpcIdleTimer) {
      clearTimeout(rpcIdleTimer);
      rpcIdleTimer = null;
    }
    if (rpc) {
      rpc.close();
      rpc = null;
    }
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
  console.log("Telegram bot started (relay mode, polling).");
  console.log(`[pi-rpc] idle restart enabled: ${PI_RPC_IDLE_MINUTES} minute(s)`);

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

  if (autoPiScheduleConfig.enabled) {
    runAutoPiSchedulesTick();
    autoPiScheduleInterval = setInterval(() => {
      runAutoPiSchedulesTick();
    }, autoPiScheduleConfig.pollSeconds * 1000);

    console.log(
      `Auto PI schedules active (poll every ${autoPiScheduleConfig.pollSeconds}s, schedules=${autoPiSchedules.length}, defaultTimezone=${autoPiScheduleConfig.defaultTimezone}, source=${autoPiScheduleConfig.source}).`,
    );
    if (autoPiSchedules.length > 0) {
      console.log(
        `[auto-pi-schedules] ${autoPiSchedules
          .map((s) => `${s.id}@${s.timeHHMM}(${s.timezone})`)
          .join(", ")}`,
      );
    }
  } else {
    console.log(`Auto PI schedules disabled (configure ${autoPiScheduleConfig.source}).`);
  }
})();
