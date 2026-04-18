import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as chrono from "chrono-node";
import { DateTime } from "luxon";
import { withDefaultTimezone } from "../../../src/config.ts";
import { createBackbone } from "../../../src/index.ts";

function toText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function isIsoDateTime(value: string): boolean {
  if (!value || !value.includes("T")) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}

function isValidRecurrenceRule(rule: string): boolean {
  const parts = rule
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) return false;

  const kv = new Map<string, string>();
  for (const part of parts) {
    const [rawKey, ...rest] = part.split("=");
    const key = rawKey?.trim().toUpperCase();
    const value = rest.join("=").trim();
    if (!key || !value) continue;
    kv.set(key, value);
  }

  const freq = kv.get("FREQ")?.toUpperCase();
  if (!freq || !["MINUTELY", "HOURLY", "DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) {
    return false;
  }

  const intervalRaw = kv.get("INTERVAL");
  if (intervalRaw !== undefined) {
    const interval = Number.parseInt(intervalRaw, 10);
    if (!Number.isFinite(interval) || interval <= 0) return false;
  }

  const countRaw = kv.get("COUNT");
  if (countRaw !== undefined) {
    const count = Number.parseInt(countRaw, 10);
    if (!Number.isFinite(count) || count <= 0) return false;
  }

  const untilRaw = kv.get("UNTIL");
  if (untilRaw !== undefined) {
    const compactUtc = /^\d{8}T\d{6}Z$/.test(untilRaw);
    const compactDate = /^\d{8}$/.test(untilRaw);
    const iso = Date.parse(untilRaw);
    if (!compactUtc && !compactDate && !Number.isFinite(iso)) {
      return false;
    }
  }

  return true;
}

function formatDisplayDateTime(iso: string, timezone?: string): string {
  const zone = withDefaultTimezone(timezone);
  const dt = DateTime.fromISO(iso, { zone: "utc" }).setZone(zone);
  if (!dt.isValid) return iso;
  return dt.toFormat("MMM d, yyyy h:mm a ZZZZ");
}

function clarification(question: string, details?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: question }],
    details: { responseType: "clarification", needsClarification: true, question, ...details },
  };
}

type TimeResolution = {
  ok: boolean;
  isoUtc?: string;
  timezoneUsed?: string;
  confidence: "high" | "medium" | "low";
  needsClarification: boolean;
  reason?: string;
  parsedText?: string;
};

type DayRange = {
  ok: boolean;
  day?: string;
  timezoneUsed?: string;
  fromUtcIso?: string;
  toUtcIso?: string;
  reason?: string;
};

function resolveDayRange(input: { day?: string; timezone?: string }): DayRange {
  const zone = withDefaultTimezone(input.timezone);
  const day = (input.day ?? DateTime.utc().setZone(zone).toFormat("yyyy-MM-dd")).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return { ok: false, reason: "day must be in YYYY-MM-DD format" };
  }

  const localStart = DateTime.fromFormat(day, "yyyy-MM-dd", { zone }).startOf("day");
  const localEnd = localStart.endOf("day");
  if (!localStart.isValid || !localEnd.isValid) {
    return { ok: false, reason: "Invalid day or timezone" };
  }

  const fromUtcIso = localStart.toUTC().toISO();
  const toUtcIso = localEnd.toUTC().toISO();
  if (!fromUtcIso || !toUtcIso) {
    return { ok: false, reason: "Could not resolve day range" };
  }

  return {
    ok: true,
    day,
    timezoneUsed: zone,
    fromUtcIso,
    toUtcIso,
  };
}

function resolveTimeExpression(input: {
  expression: string;
  timezone?: string;
  requireTime?: boolean;
  referenceIso?: string;
}): TimeResolution {
  const zone = withDefaultTimezone(input.timezone);
  const reference = input.referenceIso ? new Date(input.referenceIso) : new Date();
  if (Number.isNaN(reference.getTime())) {
    return {
      ok: false,
      confidence: "low",
      needsClarification: true,
      reason: "Invalid reference time",
    };
  }

  const results = chrono.parse(input.expression, reference, { forwardDate: true });
  if (results.length === 0) {
    return {
      ok: false,
      confidence: "low",
      needsClarification: true,
      reason: "Could not parse time expression",
    };
  }

  const best = results[0];
  const start = best.start;

  const dt = DateTime.fromObject(
    {
      year: start.get("year"),
      month: start.get("month"),
      day: start.get("day"),
      hour: start.get("hour"),
      minute: start.get("minute"),
      second: start.get("second"),
      millisecond: start.get("millisecond"),
    },
    { zone },
  );

  if (!dt.isValid) {
    return {
      ok: false,
      confidence: "low",
      needsClarification: true,
      reason: `Parsed date is invalid (${dt.invalidExplanation ?? "unknown reason"})`,
    };
  }

  const hasCertainHour = start.isCertain("hour");
  const requireTime = input.requireTime ?? true;
  const multipleCandidates = results.length > 1;

  const needsClarification = (requireTime && !hasCertainHour) || multipleCandidates;
  const confidence: TimeResolution["confidence"] = needsClarification
    ? "medium"
    : hasCertainHour
      ? "high"
      : "medium";

  return {
    ok: true,
    isoUtc: dt.toUTC().toISO() ?? undefined,
    timezoneUsed: zone,
    confidence,
    needsClarification,
    reason: needsClarification
      ? multipleCandidates
        ? "Expression matched multiple possible dates"
        : "Time was not explicit"
      : undefined,
    parsedText: best.text,
  };
}

export default function todoRemindersExtension(pi: ExtensionAPI) {
  let backbone: ReturnType<typeof createBackbone> | null = null;

  const defaultUserExternalId = process.env.TODO_USER_ID ?? "local-user";

  const getBackbone = () => {
    if (!backbone) {
      backbone = createBackbone({ filePath: process.env.DB_PATH });
    }
    return backbone;
  };

  const idleTimeoutMinutes = Number.parseInt(process.env.SESSION_IDLE_MINUTES ?? "60", 10) || 60;
  const pendingActionTtlMinutes = Number.parseInt(process.env.PENDING_ACTION_TTL_MINUTES ?? "15", 10) || 15;

  const ensureConversationSession = (userExternalId: string) => {
    const services = getBackbone();
    services.memoryService.expireStalePendingActions();
    const session = services.memoryService.getOrStartConversationSession(userExternalId, {
      idleTimeoutMinutes,
    });
    return services.memoryService.touchConversationSession(session.id);
  };

  const requireConfirmation = async (args: {
    userExternalId: string;
    action: string;
    targetId: number;
    confirmed?: boolean;
    confirmationToken?: string;
  }) => {
    const services = getBackbone();
    const session = ensureConversationSession(args.userExternalId);

    if (args.confirmed) {
      if (!args.confirmationToken) {
        return { ok: true as const, confirmationToken: undefined };
      }

      const pending = services.memoryService.getPendingActionByToken(args.confirmationToken);
      if (!pending) {
        return {
          ok: false as const,
          result: clarification("I couldn't find that confirmation token. Please confirm again.", {
            responseType: "confirmation_required",
            action: args.action,
            targetId: args.targetId,
          }),
        };
      }

      if (pending.status !== "pending") {
        return {
          ok: false as const,
          result: clarification("That confirmation request is no longer pending. Please confirm again.", {
            responseType: "confirmation_required",
            action: args.action,
            targetId: args.targetId,
            confirmationToken: args.confirmationToken,
            status: pending.status,
          }),
        };
      }

      if (Date.parse(pending.expiresAt) < Date.now()) {
        services.memoryService.updatePendingActionStatus(args.confirmationToken, "expired");
        return {
          ok: false as const,
          result: clarification("That confirmation expired. Please confirm again.", {
            responseType: "confirmation_required",
            action: args.action,
            targetId: args.targetId,
            confirmationToken: args.confirmationToken,
            status: "expired",
          }),
        };
      }

      const payloadTargetId = Number((pending.payload as { targetId?: unknown }).targetId);
      if (pending.actionType !== args.action || payloadTargetId !== args.targetId) {
        return {
          ok: false as const,
          result: clarification("Confirmation does not match this action. Please confirm again.", {
            responseType: "confirmation_required",
            action: args.action,
            targetId: args.targetId,
            confirmationToken: args.confirmationToken,
          }),
        };
      }

      services.memoryService.updatePendingActionStatus(args.confirmationToken, "confirmed");
      services.memoryService.touchConversationSession(session.id);
      return { ok: true as const, confirmationToken: args.confirmationToken };
    }

    const pending = services.memoryService.createPendingAction({
      userExternalId: args.userExternalId,
      actionType: args.action,
      payload: { targetId: args.targetId },
      conversationSessionId: session.id,
      ttlMinutes: pendingActionTtlMinutes,
    });

    return {
      ok: false as const,
      result: clarification(
        `Please confirm: ${args.action} #${args.targetId}. Reply with "yes" and I will proceed.`,
        {
          responseType: "confirmation_required",
          action: args.action,
          targetId: args.targetId,
          confirmationToken: pending.token,
          expiresAt: pending.expiresAt,
        },
      ),
    };
  };

  const markConfirmedActionExecuted = (token?: string) => {
    if (!token) return;
    try {
      getBackbone().memoryService.updatePendingActionStatus(token, "executed");
    } catch {
      // ignore stale/missing token updates
    }
  };

  pi.on("input", async (_event, _ctx) => {
    ensureConversationSession(defaultUserExternalId);
    return { action: "continue" as const };
  });

  pi.on("session_shutdown", async () => {
    if (backbone) {
      backbone.close();
      backbone = null;
    }
  });

  pi.registerTool({
    name: "resolve_time_expression",
    label: "Resolve Time Expression",
    description:
      "Resolve natural-language date/time expressions (e.g. 'tomorrow at 9') into an ISO UTC datetime with confidence.",
    promptSnippet: "Resolve natural-language time phrases into precise ISO UTC datetimes.",
    promptGuidelines: [
      "Use this tool when user provides relative or fuzzy time language.",
      "Call this before add_todo/update_todo/add_reminder/update_reminder when dueAt/remindAt is not already explicit ISO.",
    ],
    parameters: Type.Object({
      expression: Type.String({ description: "Natural language time phrase, e.g. 'tomorrow at 9'" }),
      timezone: Type.Optional(Type.String({ description: "IANA timezone, e.g. America/New_York" })),
      requireTime: Type.Optional(Type.Boolean({ description: "If true, require explicit hour/minute" })),
      referenceIso: Type.Optional(
        Type.String({ description: "Reference time in ISO, defaults to now (useful for testing/repro)" }),
      ),
    }),
    async execute(_toolCallId, params) {
      const resolved = resolveTimeExpression({
        expression: params.expression,
        timezone: params.timezone,
        requireTime: params.requireTime,
        referenceIso: params.referenceIso,
      });

      if (!resolved.ok) {
        return clarification(`Could not resolve "${params.expression}". ${resolved.reason ?? ""}`.trim(), {
          expression: params.expression,
          ...resolved,
        });
      }

      const message = resolved.needsClarification
        ? `Resolved "${params.expression}" to ${resolved.isoUtc}, but clarification is recommended (${resolved.reason}).`
        : `Resolved "${params.expression}" to ${resolved.isoUtc} (${resolved.timezoneUsed}).`;

      return {
        content: [{ type: "text", text: message }],
        details: { expression: params.expression, ...resolved },
      };
    },
  });

  pi.registerTool({
    name: "add_todo",
    label: "Add Todo",
    description: "Create a todo in the local SQLite todo/reminder database",
    promptSnippet: "Create todo items in the local database with optional due date and priority.",
    promptGuidelines: [
      "Prefer this tool when the user asks to create a task or todo.",
      "If user gives natural language time, call resolve_time_expression first and pass dueAt as ISO UTC.",
      "Use ISO date-time strings for dueAt when the time is known.",
    ],
    parameters: Type.Object({
      userExternalId: Type.Optional(Type.String({ description: "User id (defaults to TODO_USER_ID or local-user)" })),
      title: Type.String({ description: "Todo title" }),
      notes: Type.Optional(Type.String({ description: "Additional details" })),
      dueAt: Type.Optional(Type.String({ description: "ISO date-time, e.g. 2026-04-20T18:00:00Z" })),
      timeExpression: Type.Optional(Type.String({ description: "Natural-language time phrase, e.g. tomorrow at 9" })),
      timezone: Type.Optional(Type.String({ description: "IANA timezone used when parsing timeExpression" })),
      priority: Type.Optional(StringEnum(["low", "normal", "high", "urgent"] as const)),
      source: Type.Optional(Type.String({ description: "Origin tag" })),
    }),
    async execute(_toolCallId, params) {
      let dueAt = params.dueAt;

      if (dueAt && !isIsoDateTime(dueAt)) {
        return clarification("dueAt must be an ISO date-time (e.g. 2026-04-20T18:00:00Z).", {
          field: "dueAt",
          received: dueAt,
        });
      }

      if (!dueAt && params.timeExpression) {
        const resolved = resolveTimeExpression({
          expression: params.timeExpression,
          timezone: params.timezone,
          requireTime: true,
        });

        if (!resolved.ok) {
          return clarification(`Could not resolve todo time: ${resolved.reason ?? "unknown reason"}`, {
            expression: params.timeExpression,
            ...resolved,
          });
        }

        if (resolved.needsClarification) {
          return clarification(
            `Resolved "${params.timeExpression}" to ${resolved.isoUtc}, but it may be ambiguous (${resolved.reason}). Confirm exact time.`,
            { expression: params.timeExpression, ...resolved },
          );
        }

        dueAt = resolved.isoUtc;
      }

      const created = getBackbone().todoService.addTodo({
        userExternalId: params.userExternalId ?? defaultUserExternalId,
        title: params.title,
        notes: params.notes,
        dueAt,
        priority: params.priority,
        source: params.source ?? "pi-agent",
      });

      return {
        content: [{ type: "text", text: `Added todo #${created.id}: ${created.title}` }],
        details: created,
      };
    },
  });

  pi.registerTool({
    name: "update_todo",
    label: "Update Todo",
    description: "Update an existing todo (title, notes, priority, and/or due date/time)",
    promptSnippet: "Edit an existing todo without recreating it.",
    promptGuidelines: [
      "Use this tool when the user asks to edit or reschedule an existing todo.",
      "Pass clearDueAt=true when the user wants to remove the due date.",
      "Pass clearNotes=true when the user wants to remove notes.",
      "If user gives natural language time, call resolve_time_expression first and pass dueAt as ISO UTC.",
    ],
    parameters: Type.Object({
      userExternalId: Type.Optional(Type.String({ description: "User id (defaults to TODO_USER_ID or local-user)" })),
      todoId: Type.Number({ description: "Todo id to update" }),
      title: Type.Optional(Type.String({ description: "Updated todo title" })),
      notes: Type.Optional(Type.String({ description: "Updated todo notes" })),
      clearNotes: Type.Optional(Type.Boolean({ description: "Set true to remove notes" })),
      priority: Type.Optional(StringEnum(["low", "normal", "high", "urgent"] as const)),
      dueAt: Type.Optional(Type.String({ description: "ISO date-time, e.g. 2026-04-20T18:00:00Z" })),
      timeExpression: Type.Optional(Type.String({ description: "Natural-language time phrase, e.g. tomorrow at 9" })),
      timezone: Type.Optional(Type.String({ description: "IANA timezone used when parsing timeExpression" })),
      clearDueAt: Type.Optional(Type.Boolean({ description: "Set true to remove due date/time" })),
    }),
    async execute(_toolCallId, params) {
      if (params.clearDueAt && (params.dueAt || params.timeExpression)) {
        return clarification("Use either clearDueAt=true OR a new dueAt/timeExpression, not both.", {
          field: "clearDueAt",
        });
      }

      if (params.clearNotes && params.notes !== undefined) {
        return clarification("Use either clearNotes=true OR notes, not both.", {
          field: "clearNotes",
        });
      }

      let dueAt = params.dueAt;

      if (dueAt && !isIsoDateTime(dueAt)) {
        return clarification("dueAt must be an ISO date-time (e.g. 2026-04-20T18:00:00Z).", {
          field: "dueAt",
          received: dueAt,
        });
      }

      if (!dueAt && params.timeExpression) {
        const resolved = resolveTimeExpression({
          expression: params.timeExpression,
          timezone: params.timezone,
          requireTime: true,
        });

        if (!resolved.ok) {
          return clarification(`Could not resolve todo time: ${resolved.reason ?? "unknown reason"}`, {
            expression: params.timeExpression,
            ...resolved,
          });
        }

        if (resolved.needsClarification) {
          return clarification(
            `Resolved "${params.timeExpression}" to ${resolved.isoUtc}, but it may be ambiguous (${resolved.reason}). Confirm exact time.`,
            { expression: params.timeExpression, ...resolved },
          );
        }

        dueAt = resolved.isoUtc;
      }

      const hasAnyUpdate =
        params.title !== undefined ||
        params.notes !== undefined ||
        params.clearNotes === true ||
        params.priority !== undefined ||
        dueAt !== undefined ||
        params.clearDueAt === true;

      if (!hasAnyUpdate) {
        return clarification(
          "Provide at least one field to update (title, notes, priority, dueAt/timeExpression, clearNotes, clearDueAt).",
          { field: "todoId" },
        );
      }

      const updated = getBackbone().todoService.updateTodo({
        userExternalId: params.userExternalId ?? defaultUserExternalId,
        todoId: params.todoId,
        title: params.title,
        notes: params.notes,
        clearNotes: params.clearNotes,
        priority: params.priority,
        dueAt,
        clearDueAt: params.clearDueAt,
      });

      return {
        content: [
          {
            type: "text",
            text: `Updated todo #${updated.id}: ${updated.title}${updated.dueAt ? ` (due ${formatDisplayDateTime(updated.dueAt)})` : " (no due date)"}`,
          },
        ],
        details: updated,
      };
    },
  });

  pi.registerTool({
    name: "list_todos_by_day",
    label: "List Todos By Day",
    description: "List todos due on a specific local day",
    promptSnippet: "Get todos for a specific day in a timezone.",
    parameters: Type.Object({
      userExternalId: Type.Optional(Type.String({ description: "User id (defaults to TODO_USER_ID or local-user)" })),
      day: Type.Optional(Type.String({ description: "Day in YYYY-MM-DD, e.g. 2026-04-20" })),
      timezone: Type.Optional(Type.String({ description: "IANA timezone for day boundaries, e.g. America/New_York" })),
      status: Type.Optional(StringEnum(["open", "done", "cancelled"] as const)),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 1000 })),
    }),
    async execute(_toolCallId, params) {
      const range = resolveDayRange({ day: params.day, timezone: params.timezone });
      if (!range.ok) {
        return clarification(`Could not resolve day range. ${range.reason ?? "Unknown reason"}`, {
          field: "day",
          received: params.day,
          timezone: params.timezone,
        });
      }

      const todos = getBackbone().todoService
        .listTodos({
          userExternalId: params.userExternalId ?? defaultUserExternalId,
          status: params.status,
          dueBefore: range.toUtcIso,
          limit: params.limit,
        })
        .filter((todo) => !!todo.dueAt && Date.parse(todo.dueAt) >= Date.parse(range.fromUtcIso!));

      const lines = todos.length
        ? todos.map(
            (todo, index) =>
              `${index + 1}. #${todo.id} [${todo.status}] ${todo.title}${todo.dueAt ? ` (due ${formatDisplayDateTime(todo.dueAt, range.timezoneUsed)})` : ""}`,
          )
        : [`No todos due on ${range.day} (${range.timezoneUsed}).`];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          day: range.day,
          timezone: range.timezoneUsed,
          fromUtc: range.fromUtcIso,
          toUtc: range.toUtcIso,
          count: todos.length,
          todos,
        },
      };
    },
  });

  pi.registerTool({
    name: "list_todos",
    label: "List Todos",
    description: "List todos from the local SQLite todo/reminder database",
    promptSnippet: "Retrieve todos with optional status filtering.",
    promptGuidelines: [
      "Use status=open for current tasks.",
      "For older/history requests, use search_todos with includeDone/includeCancelled.",
    ],
    parameters: Type.Object({
      userExternalId: Type.Optional(Type.String({ description: "User id (defaults to TODO_USER_ID or local-user)" })),
      status: Type.Optional(StringEnum(["open", "done", "cancelled"] as const)),
      dueBefore: Type.Optional(Type.String({ description: "ISO date-time upper bound for dueAt" })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 1000 })),
    }),
    async execute(_toolCallId, params) {
      if (params.dueBefore && !isIsoDateTime(params.dueBefore)) {
        return clarification("What date/time should I use for dueBefore? Please provide ISO format or a clear phrase.", {
          field: "dueBefore",
          received: params.dueBefore,
        });
      }

      const todos = getBackbone().todoService.listTodos({
        userExternalId: params.userExternalId ?? defaultUserExternalId,
        status: params.status,
        dueBefore: params.dueBefore,
        limit: params.limit,
      });

      const lines = todos.length
        ? todos.map(
            (todo, index) =>
              `${index + 1}. #${todo.id} [${todo.status}] ${todo.title}${todo.dueAt ? ` (due ${formatDisplayDateTime(todo.dueAt)})` : ""}`,
          )
        : ["No todos found."];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { count: todos.length, todos },
      };
    },
  });

  pi.registerTool({
    name: "search_todos",
    label: "Search Todos",
    description: "Search todos (including older/completed/cancelled) by keyword and age filters",
    promptSnippet: "Search old or completed todos by keyword, status, and age.",
    promptGuidelines: [
      "Use this when user asks about older/previous/past tasks.",
      "Set includeDone/includeCancelled=true for history lookups.",
    ],
    parameters: Type.Object({
      userExternalId: Type.Optional(Type.String({ description: "User id (defaults to TODO_USER_ID or local-user)" })),
      query: Type.Optional(Type.String({ description: "Keyword search over title and notes" })),
      includeDone: Type.Optional(Type.Boolean({ description: "Include done todos" })),
      includeCancelled: Type.Optional(Type.Boolean({ description: "Include cancelled todos" })),
      olderThanDays: Type.Optional(Type.Number({ minimum: 1, maximum: 36500 })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 1000 })),
      sort: Type.Optional(StringEnum(["recent", "oldest", "due"] as const)),
    }),
    async execute(_toolCallId, params) {
      const includeDone = params.includeDone ?? true;
      const includeCancelled = params.includeCancelled ?? false;
      const sort = params.sort ?? "recent";

      const todos = getBackbone().todoService.searchTodos({
        userExternalId: params.userExternalId ?? defaultUserExternalId,
        query: params.query,
        includeDone,
        includeCancelled,
        olderThanDays: params.olderThanDays,
        limit: params.limit,
        sort,
      });

      const lines = todos.length
        ? todos.map(
            (todo, index) =>
              `${index + 1}. #${todo.id} [${todo.status}] ${todo.title}${todo.dueAt ? ` (due ${formatDisplayDateTime(todo.dueAt)})` : ""} (updated ${formatDisplayDateTime(todo.updatedAt)})`,
          )
        : ["No matching todos found."];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          count: todos.length,
          query: params.query ?? null,
          includeDone,
          includeCancelled,
          olderThanDays: params.olderThanDays ?? null,
          sort,
          todos,
        },
      };
    },
  });

  pi.registerTool({
    name: "complete_todo",
    label: "Complete Todo",
    description: "Mark an existing todo as done",
    promptSnippet: "Mark a todo as complete by id.",
    promptGuidelines: [
      "For chat platforms (Telegram), ask for explicit confirmation before destructive actions.",
      "Pass confirmed=true only after the user clearly confirms.",
    ],
    parameters: Type.Object({
      userExternalId: Type.Optional(Type.String({ description: "User id (defaults to TODO_USER_ID or local-user)" })),
      todoId: Type.Number({ description: "Todo id to mark done" }),
      confirmed: Type.Optional(Type.Boolean({ description: "Set true only after explicit user confirmation" })),
      confirmationToken: Type.Optional(Type.String({ description: "Confirmation token from previous request" })),
    }),
    async execute(_toolCallId, params) {
      const userExternalId = params.userExternalId ?? defaultUserExternalId;
      const gate = await requireConfirmation({
        userExternalId,
        action: "complete_todo",
        targetId: params.todoId,
        confirmed: params.confirmed,
        confirmationToken: params.confirmationToken,
      });
      if (!gate.ok) return gate.result;

      const updated = getBackbone().todoService.completeTodo({
        userExternalId,
        todoId: params.todoId,
      });
      markConfirmedActionExecuted(gate.confirmationToken);

      return {
        content: [{ type: "text", text: `Completed todo #${updated.id}: ${updated.title}` }],
        details: updated,
      };
    },
  });

  pi.registerTool({
    name: "cancel_todo",
    label: "Cancel Todo",
    description: "Cancel (archive) a todo so it is no longer open",
    promptSnippet: "Cancel a todo by id.",
    promptGuidelines: [
      "For chat platforms (Telegram), ask for explicit confirmation before destructive actions.",
      "Pass confirmed=true only after the user clearly confirms.",
    ],
    parameters: Type.Object({
      userExternalId: Type.Optional(Type.String({ description: "User id (defaults to TODO_USER_ID or local-user)" })),
      todoId: Type.Number({ description: "Todo id to cancel" }),
      confirmed: Type.Optional(Type.Boolean({ description: "Set true only after explicit user confirmation" })),
      confirmationToken: Type.Optional(Type.String({ description: "Confirmation token from previous request" })),
    }),
    async execute(_toolCallId, params) {
      const userExternalId = params.userExternalId ?? defaultUserExternalId;
      const gate = await requireConfirmation({
        userExternalId,
        action: "cancel_todo",
        targetId: params.todoId,
        confirmed: params.confirmed,
        confirmationToken: params.confirmationToken,
      });
      if (!gate.ok) return gate.result;

      const updated = getBackbone().todoService.cancelTodo({
        userExternalId,
        todoId: params.todoId,
      });
      markConfirmedActionExecuted(gate.confirmationToken);

      return {
        content: [{ type: "text", text: `Cancelled todo #${updated.id}: ${updated.title}` }],
        details: updated,
      };
    },
  });

  pi.registerTool({
    name: "add_reminder",
    label: "Add Reminder",
    description: "Create a reminder in the local SQLite todo/reminder database",
    promptSnippet: "Create time-based reminders in the local database.",
    promptGuidelines: [
      "Use this tool when the user asks to be reminded at a specific time.",
      "If user gives natural language time, call resolve_time_expression first and pass remindAt as ISO UTC.",
      "If reminder is for a specific todo, pass todoId so it is linked and auto-cleaned when todo completes/cancels.",
      "Pass remindAt as ISO date-time in UTC or with offset.",
    ],
    parameters: Type.Object({
      userExternalId: Type.Optional(Type.String({ description: "User id (defaults to TODO_USER_ID or local-user)" })),
      todoId: Type.Optional(Type.Number({ description: "Optional todo id this reminder belongs to" })),
      text: Type.String({ description: "Reminder text" }),
      remindAt: Type.Optional(Type.String({ description: "ISO date-time, e.g. 2026-04-20T17:00:00Z" })),
      timeExpression: Type.Optional(Type.String({ description: "Natural-language time phrase, e.g. tomorrow at 9" })),
      timezone: Type.Optional(Type.String({ description: "IANA timezone, e.g. America/New_York" })),
      recurrenceRule: Type.Optional(Type.String({ description: "RRULE string for recurrence" })),
      source: Type.Optional(Type.String({ description: "Origin tag" })),
    }),
    async execute(_toolCallId, params) {
      let remindAt = params.remindAt;

      if (remindAt && !isIsoDateTime(remindAt)) {
        return clarification("remindAt must be an ISO date-time (e.g. 2026-04-20T17:00:00Z).", {
          field: "remindAt",
          received: remindAt,
        });
      }

      if (!remindAt && params.timeExpression) {
        const resolved = resolveTimeExpression({
          expression: params.timeExpression,
          timezone: params.timezone,
          requireTime: true,
        });

        if (!resolved.ok) {
          return clarification(`Could not resolve reminder time: ${resolved.reason ?? "unknown reason"}`, {
            expression: params.timeExpression,
            ...resolved,
          });
        }

        if (resolved.needsClarification) {
          return clarification(
            `Resolved "${params.timeExpression}" to ${resolved.isoUtc}, but it may be ambiguous (${resolved.reason}). Confirm exact time.`,
            { expression: params.timeExpression, ...resolved },
          );
        }

        remindAt = resolved.isoUtc;
      }

      if (!remindAt) {
        return clarification("No exact remindAt provided. Provide remindAt or a parseable timeExpression.", {
          field: "remindAt",
        });
      }

      if (params.recurrenceRule && !isValidRecurrenceRule(params.recurrenceRule)) {
        return clarification(
          "Invalid recurrenceRule. Use FREQ=MINUTELY|HOURLY|DAILY|WEEKLY|MONTHLY|YEARLY with optional INTERVAL, COUNT, UNTIL.",
          { field: "recurrenceRule", received: params.recurrenceRule },
        );
      }

      const created = getBackbone().reminderService.addReminder({
        userExternalId: params.userExternalId ?? defaultUserExternalId,
        todoId: params.todoId,
        text: params.text,
        remindAt,
        timezone: params.timezone,
        recurrenceRule: params.recurrenceRule,
        source: params.source ?? "pi-agent",
      });

      return {
        content: [
          {
            type: "text",
            text: `Added reminder #${created.id}: ${created.text}${created.todoId ? ` (linked to todo #${created.todoId})` : ""}`,
          },
        ],
        details: created,
      };
    },
  });

  pi.registerTool({
    name: "update_reminder",
    label: "Update Reminder",
    description: "Update an existing reminder (text, time, timezone, and/or recurrence)",
    promptSnippet: "Edit an existing reminder without recreating it.",
    promptGuidelines: [
      "Use this tool when the user asks to edit/reschedule an existing reminder.",
      "If user gives natural language time, call resolve_time_expression first and pass remindAt as ISO UTC.",
      "Use clearRecurrenceRule=true to remove recurrence.",
    ],
    parameters: Type.Object({
      userExternalId: Type.Optional(Type.String({ description: "User id (defaults to TODO_USER_ID or local-user)" })),
      reminderId: Type.Number({ description: "Reminder id to update" }),
      text: Type.Optional(Type.String({ description: "Updated reminder text" })),
      remindAt: Type.Optional(Type.String({ description: "ISO date-time, e.g. 2026-04-20T17:00:00Z" })),
      timeExpression: Type.Optional(Type.String({ description: "Natural-language time phrase, e.g. tomorrow at 9" })),
      timezone: Type.Optional(Type.String({ description: "IANA timezone, e.g. America/New_York" })),
      recurrenceRule: Type.Optional(Type.String({ description: "RRULE string" })),
      clearRecurrenceRule: Type.Optional(Type.Boolean({ description: "Set true to remove recurrence" })),
    }),
    async execute(_toolCallId, params) {
      if (params.remindAt && params.timeExpression) {
        return clarification("Use either remindAt or timeExpression, not both.", {
          field: "remindAt",
        });
      }

      if (params.clearRecurrenceRule && params.recurrenceRule !== undefined) {
        return clarification("Use either recurrenceRule or clearRecurrenceRule=true, not both.", {
          field: "recurrenceRule",
        });
      }

      let remindAt = params.remindAt;

      if (remindAt && !isIsoDateTime(remindAt)) {
        return clarification("remindAt must be an ISO date-time (e.g. 2026-04-20T17:00:00Z).", {
          field: "remindAt",
          received: remindAt,
        });
      }

      if (!remindAt && params.timeExpression) {
        const resolved = resolveTimeExpression({
          expression: params.timeExpression,
          timezone: params.timezone,
          requireTime: true,
        });

        if (!resolved.ok) {
          return clarification(`Could not resolve reminder time: ${resolved.reason ?? "unknown reason"}`, {
            expression: params.timeExpression,
            ...resolved,
          });
        }

        if (resolved.needsClarification) {
          return clarification(
            `Resolved "${params.timeExpression}" to ${resolved.isoUtc}, but it may be ambiguous (${resolved.reason}). Confirm exact time.`,
            { expression: params.timeExpression, ...resolved },
          );
        }

        remindAt = resolved.isoUtc;
      }

      if (params.recurrenceRule && !isValidRecurrenceRule(params.recurrenceRule)) {
        return clarification(
          "Invalid recurrenceRule. Use FREQ=MINUTELY|HOURLY|DAILY|WEEKLY|MONTHLY|YEARLY with optional INTERVAL, COUNT, UNTIL.",
          { field: "recurrenceRule", received: params.recurrenceRule },
        );
      }

      const hasAnyUpdate =
        params.text !== undefined ||
        remindAt !== undefined ||
        params.timezone !== undefined ||
        params.recurrenceRule !== undefined ||
        params.clearRecurrenceRule === true;

      if (!hasAnyUpdate) {
        return clarification(
          "Provide at least one field to update (text, remindAt/timeExpression, timezone, recurrenceRule, clearRecurrenceRule).",
          { field: "reminderId" },
        );
      }

      const updated = getBackbone().reminderService.updateReminder({
        userExternalId: params.userExternalId ?? defaultUserExternalId,
        reminderId: params.reminderId,
        text: params.text,
        remindAt,
        timezone: params.timezone,
        recurrenceRule: params.recurrenceRule,
        clearRecurrenceRule: params.clearRecurrenceRule,
      });

      return {
        content: [
          {
            type: "text",
            text: `Updated reminder #${updated.id}: ${updated.text} @ ${formatDisplayDateTime(updated.remindAt, updated.timezone)}`,
          },
        ],
        details: updated,
      };
    },
  });

  pi.registerTool({
    name: "add_todo_reminder",
    label: "Add Todo Reminder",
    description: "Create a reminder linked to a todo, optionally relative to due time",
    promptSnippet: "Create a reminder linked to a todo id, commonly before due time.",
    promptGuidelines: [
      "Use this tool when user says 'remind me before/for this todo'.",
      "This links reminder to todo so completion/cancellation auto-cancels pending reminders.",
    ],
    parameters: Type.Object({
      userExternalId: Type.Optional(Type.String({ description: "User id (defaults to TODO_USER_ID or local-user)" })),
      todoId: Type.Number({ description: "Todo id to link reminder to" }),
      text: Type.Optional(Type.String({ description: "Reminder text (defaults to todo title)" })),
      offsetMinutesBeforeDue: Type.Optional(
        Type.Number({ description: "If provided, reminder time = dueAt - offset minutes", minimum: 1, maximum: 10080 }),
      ),
      remindAt: Type.Optional(Type.String({ description: "Explicit ISO datetime; overrides offset mode" })),
      timezone: Type.Optional(Type.String({ description: "IANA timezone, optional metadata for display" })),
      source: Type.Optional(Type.String({ description: "Origin tag" })),
    }),
    async execute(_toolCallId, params) {
      const userExternalId = params.userExternalId ?? defaultUserExternalId;
      const todo = getBackbone().todoService.getTodoById(userExternalId, params.todoId);

      if (!todo) {
        return clarification(`I couldn't find todo #${params.todoId}. Which todo should I link this reminder to?`, {
          responseType: "clarification",
          todoId: params.todoId,
        });
      }

      let remindAt = params.remindAt;
      if (!remindAt && params.offsetMinutesBeforeDue !== undefined) {
        if (!todo.dueAt) {
          return clarification(
            `Todo #${todo.id} has no due time. Please provide remindAt explicitly or set a due time first.`,
            { responseType: "clarification", todoId: todo.id },
          );
        }
        const dueMs = Date.parse(todo.dueAt);
        if (!Number.isFinite(dueMs)) {
          return clarification(`Todo #${todo.id} has an invalid due time. Please provide remindAt explicitly.`, {
            responseType: "clarification",
            todoId: todo.id,
          });
        }
        remindAt = new Date(dueMs - params.offsetMinutesBeforeDue * 60 * 1000).toISOString();
      }

      if (!remindAt) {
        return clarification(
          `Please provide remindAt or offsetMinutesBeforeDue. For example: offsetMinutesBeforeDue=60 for 1 hour before due.`,
          { responseType: "clarification", todoId: todo.id },
        );
      }

      if (!isIsoDateTime(remindAt)) {
        return clarification("remindAt must be ISO date-time.", { responseType: "clarification", remindAt });
      }

      const created = getBackbone().reminderService.addReminder({
        userExternalId,
        todoId: todo.id,
        text: params.text ?? `Reminder: ${todo.title}`,
        remindAt,
        timezone: params.timezone,
        source: params.source ?? "pi-agent",
      });

      return {
        content: [
          {
            type: "text",
            text: `Added reminder #${created.id} linked to todo #${todo.id} at ${formatDisplayDateTime(created.remindAt, created.timezone)}.`,
          },
        ],
        details: created,
      };
    },
  });

  pi.registerTool({
    name: "list_due_reminders",
    label: "List Due Reminders",
    description: "List pending reminders due up to the provided time",
    promptSnippet: "Retrieve reminders that are due now or by a provided time.",
    parameters: Type.Object({
      userExternalId: Type.Optional(Type.String({ description: "User id (defaults to TODO_USER_ID or local-user)" })),
      asOf: Type.Optional(Type.String({ description: "ISO date-time. Defaults to current time." })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
    }),
    async execute(_toolCallId, params) {
      const asOf = params.asOf ?? new Date().toISOString();
      if (!isIsoDateTime(asOf)) {
        return clarification("asOf must be an ISO date-time.", { field: "asOf", received: asOf });
      }

      const reminders = getBackbone().reminderService.listDueReminders({
        userExternalId: params.userExternalId ?? defaultUserExternalId,
        asOf,
        limit: params.limit,
      });

      const lines = reminders.length
        ? reminders.map(
            (r) =>
              `#${r.id} [${r.status}] ${r.text} @ ${formatDisplayDateTime(r.remindAt, r.timezone)}${r.todoId ? ` (todo #${r.todoId})` : ""}`,
          )
        : ["No due reminders."];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { asOf, count: reminders.length, reminders },
      };
    },
  });

  pi.registerTool({
    name: "list_reminders_by_day",
    label: "List Reminders By Day",
    description: "List reminders scheduled on a specific local day",
    promptSnippet: "Get reminders for a specific day in a timezone.",
    parameters: Type.Object({
      userExternalId: Type.Optional(Type.String({ description: "User id (defaults to TODO_USER_ID or local-user)" })),
      day: Type.Optional(Type.String({ description: "Day in YYYY-MM-DD, e.g. 2026-04-20" })),
      timezone: Type.Optional(Type.String({ description: "IANA timezone for day boundaries, e.g. America/New_York" })),
      status: Type.Optional(StringEnum(["pending", "sent", "cancelled"] as const)),
      todoId: Type.Optional(Type.Number({ description: "Optional filter by linked todo id" })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 1000 })),
    }),
    async execute(_toolCallId, params) {
      const range = resolveDayRange({ day: params.day, timezone: params.timezone });
      if (!range.ok) {
        return clarification(`Could not resolve day range. ${range.reason ?? "Unknown reason"}`, {
          field: "day",
          received: params.day,
          timezone: params.timezone,
        });
      }

      const reminders = getBackbone().reminderService.listReminders({
        userExternalId: params.userExternalId ?? defaultUserExternalId,
        status: params.status,
        todoId: params.todoId,
        from: range.fromUtcIso,
        to: range.toUtcIso,
        limit: params.limit,
      });

      const lines = reminders.length
        ? reminders.map(
            (r, index) =>
              `${index + 1}. #${r.id} [${r.status}] ${r.text} @ ${formatDisplayDateTime(r.remindAt, range.timezoneUsed)}${r.todoId ? ` (todo #${r.todoId})` : ""}`,
          )
        : [`No reminders on ${range.day} (${range.timezoneUsed}).`];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          day: range.day,
          timezone: range.timezoneUsed,
          fromUtc: range.fromUtcIso,
          toUtc: range.toUtcIso,
          count: reminders.length,
          reminders,
        },
      };
    },
  });

  pi.registerTool({
    name: "list_reminders",
    label: "List Reminders",
    description: "List reminders with optional filters (status, todo link, date range)",
    promptSnippet: "List all reminders (or filtered reminders) for the user.",
    parameters: Type.Object({
      userExternalId: Type.Optional(Type.String({ description: "User id (defaults to TODO_USER_ID or local-user)" })),
      status: Type.Optional(StringEnum(["pending", "sent", "cancelled"] as const)),
      todoId: Type.Optional(Type.Number({ description: "Filter by linked todo id" })),
      from: Type.Optional(Type.String({ description: "ISO lower bound for remindAt" })),
      to: Type.Optional(Type.String({ description: "ISO upper bound for remindAt" })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 1000 })),
    }),
    async execute(_toolCallId, params) {
      if (params.from && !isIsoDateTime(params.from)) {
        return clarification("from must be an ISO date-time.", { field: "from", received: params.from });
      }
      if (params.to && !isIsoDateTime(params.to)) {
        return clarification("to must be an ISO date-time.", { field: "to", received: params.to });
      }

      const reminders = getBackbone().reminderService.listReminders({
        userExternalId: params.userExternalId ?? defaultUserExternalId,
        status: params.status,
        todoId: params.todoId,
        from: params.from,
        to: params.to,
        limit: params.limit,
      });

      const lines = reminders.length
        ? reminders.map(
            (r, index) =>
              `${index + 1}. #${r.id} [${r.status}] ${r.text} @ ${formatDisplayDateTime(r.remindAt, r.timezone)}${r.todoId ? ` (todo #${r.todoId})` : ""}`,
          )
        : ["No reminders found."];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          count: reminders.length,
          status: params.status ?? null,
          todoId: params.todoId ?? null,
          from: params.from ?? null,
          to: params.to ?? null,
          reminders,
        },
      };
    },
  });

  pi.registerTool({
    name: "cancel_reminder",
    label: "Cancel Reminder",
    description: "Cancel a pending reminder",
    promptSnippet: "Cancel an existing reminder by id.",
    promptGuidelines: [
      "For chat platforms (Telegram), ask for explicit confirmation before destructive actions.",
      "Pass confirmed=true only after the user clearly confirms.",
    ],
    parameters: Type.Object({
      userExternalId: Type.Optional(Type.String({ description: "User id (defaults to TODO_USER_ID or local-user)" })),
      reminderId: Type.Number({ description: "Reminder id to cancel" }),
      confirmed: Type.Optional(Type.Boolean({ description: "Set true only after explicit user confirmation" })),
      confirmationToken: Type.Optional(Type.String({ description: "Confirmation token from previous request" })),
    }),
    async execute(_toolCallId, params) {
      const userExternalId = params.userExternalId ?? defaultUserExternalId;
      const gate = await requireConfirmation({
        userExternalId,
        action: "cancel_reminder",
        targetId: params.reminderId,
        confirmed: params.confirmed,
        confirmationToken: params.confirmationToken,
      });
      if (!gate.ok) return gate.result;

      const updated = getBackbone().reminderService.cancelReminder({
        userExternalId,
        reminderId: params.reminderId,
      });
      markConfirmedActionExecuted(gate.confirmationToken);

      return {
        content: [{ type: "text", text: `Cancelled reminder #${updated.id}: ${updated.text}` }],
        details: updated,
      };
    },
  });

  pi.registerCommand("todo-db-health", {
    description: "Check todo/reminder database availability",
    handler: async (_args, ctx) => {
      try {
        const service = getBackbone();
        const sample = service.todoService.listTodos({
          userExternalId: defaultUserExternalId,
          limit: 1,
        });

        ctx.ui.notify(
          `todo-reminders DB OK (${service.dbPath}). Sample query returned ${sample.length} row(s).`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(`todo-reminders DB error: ${toText(error instanceof Error ? error.message : error)}`, "error");
      }
    },
  });
}
