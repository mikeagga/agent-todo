import { createBackbone } from "./index.js";

const backbone = createBackbone();

try {
  const todo = backbone.todoService.addTodo({
    userExternalId: "local-user",
    title: "buy groceries",
    priority: "high",
    dueAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });

  const reminder = backbone.reminderService.addReminder({
    userExternalId: "local-user",
    text: "Leave in 30 min",
    remindAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    timezone: "UTC",
  });

  const openTodos = backbone.todoService.listTodos({
    userExternalId: "local-user",
    status: "open",
    limit: 20,
  });

  const due = backbone.reminderService.listDueReminders({
    userExternalId: "local-user",
    asOf: new Date(Date.now() + 45 * 60 * 1000).toISOString(),
    limit: 20,
  });

  console.log("Created todo:", todo);
  console.log("Created reminder:", reminder);
  console.log("Open todos:", openTodos.length);
  console.log("Due reminders in 45 mins:", due.length);
} finally {
  backbone.close();
}
