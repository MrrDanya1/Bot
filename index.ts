import { createClient } from "npm:@supabase/supabase-js@2";

const BOT_TOKEN = Deno.env.get("GIFT_BOT_TOKEN") ?? "";
const WEBHOOK_SECRET = Deno.env.get("SERVERS_WEBHOOK_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const LEGACY_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
let SERVICE_KEY = LEGACY_KEY;
try {
  const keys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!SERVICE_KEY && keys) SERVICE_KEY = JSON.parse(keys).default ?? "";
} catch {}

const OWNER_IDS = new Set([5478458473, 8835610032]);
const API = "https://api.telegram.org/bot" + BOT_TOKEN;
const TIMER_KEY = "gift-bot-timer-9d6e2f4b8a1c7e3d5f0a6b9c2e4d7f1a";
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

async function tg(method: string, body: Record<string, unknown> = {}) {
  const response = await fetch(API + "/" + method, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!data.ok) throw new Error(data.description || ("Telegram API error: " + method));
  return data.result;
}
async function setBotCommands() {
  await tg("setMyCommands", {
    commands: [
      { command: "start", description: "Главная" },
      { command: "startivent1", description: "Запустить ивент" },
      { command: "stopivent1", description: "Остановить ивент" },
    ],
    scope: { type: "all_private_chats" },
  });
}
async function send(chatId: number | string, text: string, extra: Record<string, unknown> = {}) {
  const numericChatId = Number(chatId);
  if (OWNER_IDS.has(numericChatId) && String(chatId) === String(numericChatId)) {
    const current = await db.from("gift_admin_sessions").select("state,payload").eq("admin_id", numericChatId).maybeSingle();
    const payload = current.data?.payload || {};
    const messageId = Number(payload.ui_message_id || 0);
    if (messageId) {
      try {
        return await tg("editMessageText", { chat_id: chatId, message_id: messageId, text, ...extra });
      } catch (error) {
        if (String(error).includes("message is not modified")) return { message_id: messageId };
      }
    }
    const sent = await tg("sendMessage", { chat_id: chatId, text, ...extra });
    await db.from("gift_admin_sessions").upsert({
      admin_id: numericChatId, state: current.data?.state || "idle",
      payload: { ...payload, ui_message_id: sent.message_id },
      updated_at: new Date().toISOString(),
    }, { onConflict: "admin_id" });
    return sent;
  }
  return tg("sendMessage", { chat_id: chatId, text, ...extra });
}
async function deletePrivateInput(message: any) {
  try { await tg("deleteMessage", { chat_id: message.chat.id, message_id: message.message_id }); } catch {}
}
async function answerCallback(id: string, text = "") {
  try { await tg("answerCallbackQuery", { callback_query_id: id, text }); } catch {}
}
function isOwner(id?: number) { return typeof id === "number" && OWNER_IDS.has(id); }
function esc(value: unknown) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
async function sessionFor(id: number) {
  const result = await db.from("gift_admin_sessions").select("*").eq("admin_id", id).maybeSingle();
  return result.data;
}
async function saveSession(id: number, state: string, payload: Record<string, unknown>) {
  const current = await db.from("gift_admin_sessions").select("payload").eq("admin_id", id).maybeSingle();
  const uiMessageId = current.data?.payload?.ui_message_id;
  await db.from("gift_admin_sessions").upsert({
    admin_id: id, state,
    payload: { ...payload, ...(uiMessageId ? { ui_message_id: uiMessageId } : {}) },
    updated_at: new Date().toISOString()
  }, { onConflict: "admin_id" });
}
async function deleteSession(id: number) {
  const current = await db.from("gift_admin_sessions").select("payload").eq("admin_id", id).maybeSingle();
  const uiMessageId = current.data?.payload?.ui_message_id;
  if (uiMessageId) {
    await db.from("gift_admin_sessions").upsert({
      admin_id: id, state: "idle", payload: { ui_message_id: uiMessageId },
      updated_at: new Date().toISOString()
    }, { onConflict: "admin_id" });
  } else {
    await db.from("gift_admin_sessions").delete().eq("admin_id", id);
  }
}
async function listGroups() {
  const result = await db.from("gift_groups").select("id,group_number,chat_id,username,title,is_active").eq("is_active", true).order("group_number");
  if (result.error) throw result.error;
  return result.data || [];
}
async function findDraft(groupId: string, mode?: string) {
  let query = db.from("gift_events").select("*").eq("group_id", groupId).eq("status", "draft");
  if (mode) query = query.eq("mode", mode);
  const result = await query.order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (result.error) throw result.error;
  return result.data;
}
async function showMenu(chatId: number, eventId: string) {
  const result = await db.from("gift_events").select("*").eq("id", eventId).single();
  if (result.error || !result.data) return send(chatId, "Не удалось загрузить настройки.");
  const ev = result.data;
  const groupResult = await db.from("gift_groups").select("group_number,title").eq("id", ev.group_id).single();
  const group = groupResult.data;
  if (ev.mode === "last_message") {
    const seconds = Number(ev.hold_seconds || 60);
    const duration = seconds >= 60 ? (seconds % 60 === 0 ? (seconds / 60) + " мин." : Math.floor(seconds / 60) + " мин. " + (seconds % 60) + " сек.") : seconds + " сек.";
    const timerText = "⏱ <b>Ивент «НА ПЕРЕБИВ»</b>\n\nГруппа: <b>№" + esc(group?.group_number) + " — " + esc(group?.title) + "</b>\nВремя без перебива: <b>" + duration + "</b>\nПриз: <b>" + esc(ev.prize_name) + "</b>\n\nВладелец группы, администраторы и боты не участвуют и не сбрасывают таймер.";
    return send(chatId, timerText, { parse_mode: "HTML", reply_markup: { inline_keyboard: [
      [{ text: "⏱ Время без перебива", callback_data: "edit:hold" }],
      [{ text: "🎁 Приз", callback_data: "edit:prize" }],
      [{ text: "✅ Готово", callback_data: "done" }],
    ] } });
  }
  const excluded = (ev.excluded_user_ids || []).join(", ") || "нет";
  const text =
    "🎁 <b>Настройка ивента</b>\n\n" +
    "Группа: <b>№" + esc(group?.group_number) + " — " + esc(group?.title) + "</b>\n" +
    "Количество призов: <b>" + ev.prizes_total + "</b>\n" +
    "Приз: <b>" + esc(ev.prize_name) + "</b>\n" +
    "Шанс: <b>" + String(ev.win_chance).replace(".", ",") + "%</b>\n" +
    "Повторный выигрыш: <b>" + ev.repeat_gap + "</b>\n" +
    "Не участвуют: " + (ev.exclude_group_owner ? "владелец, " : "") + (ev.exclude_group_admins ? "администраторы, " : "") + "боты, выбранные пользователи\n" +
    "Исключённые ID: <code>" + esc(excluded) + "</code>\n\n" +
    "Настройки сохраняются автоматически. Запуск: /startivent" + esc(group?.group_number);
  const keyboard = { inline_keyboard: [
    [{ text: "🔢 Количество призов", callback_data: "edit:qty" }, { text: "🎁 Сам приз", callback_data: "edit:prize" }],
    [{ text: "🎲 Шанс выигрыша", callback_data: "edit:chance" }, { text: "🔁 Повтор", callback_data: "edit:repeat" }],
    [{ text: (ev.exclude_group_owner ? "☑ " : "☐ ") + "Владелец", callback_data: "toggle:owner" },
     { text: (ev.exclude_group_admins ? "☑ " : "☐ ") + "Админы", callback_data: "toggle:admins" }],
    [{ text: "🚫 Выбранные пользователи", callback_data: "edit:users" }],
    [{ text: "✅ Готово", callback_data: "done" }],
  ] };
  return send(chatId, text, { parse_mode: "HTML", reply_markup: keyboard });
}
async function openEvent(chatId: number) {
  const groups = await listGroups();
  if (!groups.length) return send(chatId, "Сначала добавь бота в группу и выдай ему права администратора. Затем отправь:\n/addgroup @username_группы");
  const keyboard = groups.map((g: any) => [{ text: "№" + g.group_number + " · " + g.title, callback_data: "group:" + g.id }]);
  return send(chatId, "Выбери группу для настройки ивента:", { reply_markup: { inline_keyboard: keyboard } });
}
async function addGroup(chatId: number, adminId: number, identifier: string) {
  let chatIdToLookup: string | number;
  if (identifier.startsWith("@")) chatIdToLookup = identifier;
  else if (/^-\\d+$/.test(identifier)) {
    const numericId = Number(identifier);
    if (!Number.isSafeInteger(numericId)) return send(chatId, "Некорректный ID группы.");
    chatIdToLookup = numericId;
  } else return send(chatId, "Укажи @username или числовой ID группы, например -1001234567890.");
  const chat = await tg("getChat", { chat_id: chatIdToLookup });
  if (chat.type !== "group" && chat.type !== "supergroup") return send(chatId, "Это не группа. Укажи @username или ID группы.");
  const me = await tg("getMe");
  const member = await tg("getChatMember", { chat_id: chat.id, user_id: me.id });
  if (member.status !== "administrator") return send(chatId, "Сначала добавь бота в эту группу и выдай ему права администратора.");
  const row = { chat_id: chat.id, username: chat.username || null, title: chat.title || identifier, is_active: true, added_by: adminId };
  const old = await db.from("gift_groups").select("id").eq("chat_id", chat.id).maybeSingle();
  let saved;
  if (old.data) saved = await db.from("gift_groups").update(row).eq("chat_id", chat.id).select("group_number").single();
  else saved = await db.from("gift_groups").insert(row).select("group_number").single();
  if (saved.error) throw saved.error;
  return send(chatId, "✅ Группа подключена!\nНомер группы: " + saved.data.group_number + "\nТеперь настрой ивент через /event.");
}

async function autoRegisterGroup(chat: any) {
  if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return;
  const me = await tg("getMe");
  const botMember = await tg("getChatMember", { chat_id: chat.id, user_id: me.id });
  if (botMember.status !== "administrator") return;
  const admins = await tg("getChatAdministrators", { chat_id: chat.id });
  const matchingOwner = admins.find((item: any) =>
    item.user && OWNER_IDS.has(Number(item.user.id)) &&
    (item.status === "creator" || item.status === "administrator")
  );
  if (!matchingOwner) return;
  const row = {
    chat_id: chat.id,
    username: chat.username || null,
    title: chat.title || String(chat.id),
    is_active: true,
    added_by: Number(matchingOwner.user.id),
  };
  const old = await db.from("gift_groups").select("id").eq("chat_id", chat.id).maybeSingle();
  let saved;
  if (old.data) saved = await db.from("gift_groups").update(row).eq("chat_id", chat.id).select("group_number").single();
  else saved = await db.from("gift_groups").insert(row).select("group_number").single();
  if (saved.error) throw saved.error;
  try {
    await send(Number(matchingOwner.user.id),
      "✅ Группа автоматически подключена!\n№" + saved.data.group_number + " — " + (chat.title || chat.id) +
      "\nБот является администратором, и один из владельцев бота тоже администратор группы. Настроить ивент: /event");
  } catch (error) {
    console.error("group notification failed:", error);
  }
}

async function startEvent(chatId: number, number: number) {
  const groupResult = await db.from("gift_groups").select("*").eq("group_number", number).eq("is_active", true).maybeSingle();
  const group = groupResult.data;
  if (!group) return send(chatId, "Группа №" + number + " не найдена или бот не подключён.");
  const active = await db.from("gift_events").select("id").eq("group_id", group.id).eq("status", "active").maybeSingle();
  if (active.data) return send(chatId, "В группе №" + number + " уже идёт ивент.");
  const draft = await findDraft(group.id);
  if (!draft) return send(chatId, "Сначала настрой ивент через /event.");
  const update = await db.from("gift_events").update({ status: "active", started_at: new Date().toISOString(), ended_at: null, current_user_id: null, current_username: null, current_first_name: null, deadline_at: null, timer_message_id: null, countdown_message_id: null, countdown_last_value: null }).eq("id", draft.id).eq("status", "draft");
  if (update.error) return send(chatId, "Не удалось запустить ивент: " + update.error.message);
  const startText = draft.mode === "last_message"
    ? "⏱ <b>ИВЕНТ «НА ПЕРЕБИВ» НАЧАЛСЯ!</b>\n━━━━━━━━━━━━━━━━━━\n🎁 <b>Приз:</b> " + esc(draft.prize_name) + "\n⌛ <b>Время без перебива:</b> " + draft.hold_seconds + " сек.\n━━━━━━━━━━━━━━━━━━\nПоследний участник, чьё сообщение останется последним до конца таймера, получит приз.\nВладелец группы, администраторы и боты не участвуют и не сбрасывают таймер."
    :    "🚀 <b>СТАРТОВАЛ ИВЕНТ АКТИВНОСТИ</b>\n" +
    "━━━━━━━━━━━━━━━━━━\n" +
    "🎁 <b>Приз:</b> " + esc(draft.prize_name) + "\n" +
    "🎲 <b>Шанс на выигрыш за каждое отправленное сообщение:</b> " + String(draft.win_chance).replace(".", ",") + "%\n" +
    "📦 <b>Количество призов:</b> " + draft.prizes_total + "\n" +
    "━━━━━━━━━━━━━━━━━━\n" +
    "Участвуй в общении и получай шанс выиграть!";
  const notice = await send(group.chat_id, startText, { parse_mode: "HTML" });
  if (notice?.message_id) await db.from("gift_events").update({ timer_message_id: notice.message_id }).eq("id", draft.id);
  try {
    await tg("pinChatMessage", { chat_id: group.chat_id, message_id: notice.message_id, disable_notification: false });
  } catch (error) {
    console.error("pin start notice failed:", error);
  }
  return send(chatId, "✅ Ивент запущен в группе №" + number + ". Уведомление опубликовано и закреплено (если у бота есть право закреплять сообщения).");
}
async function stopEvent(chatId: number, number: number) {
  const groupResult = await db.from("gift_groups").select("*").eq("group_number", number).maybeSingle();
  const group = groupResult.data;
  if (!group) return send(chatId, "Группа №" + number + " не найдена.");
  const eventResult = await db.from("gift_events").select("*").eq("group_id", group.id).eq("status", "active").maybeSingle();
  const ev = eventResult.data;
  if (!ev) return send(chatId, "В группе №" + number + " нет активного ивента.");
  const winsResult = await db.from("gift_wins").select("id,user_id").eq("event_id", ev.id);
  if (winsResult.error) throw winsResult.error;
  const wins = winsResult.data || [];
  const won = wins.length;
  const total = Number(ev.prizes_total || 0);
  const stopped = await db.from("gift_events")
    .update({ status: "stopped", ended_at: new Date().toISOString() })
    .eq("id", ev.id).eq("status", "active").select("id").maybeSingle();
  if (stopped.error) throw stopped.error;
  if (!stopped.data) return send(chatId, "Ивент уже остановлен или не найден.");
  if (ev.countdown_message_id) {
    try { await tg("deleteMessage", { chat_id: group.chat_id, message_id: ev.countdown_message_id }); }
    catch (error) { console.error("countdown delete on stop failed:", error); }
  }
  if (ev.timer_message_id) {
    try { await tg("unpinChatMessage", { chat_id: group.chat_id, message_id: ev.timer_message_id }); }
    catch (error) { console.error("unpin start notice failed:", error); }
  }
  const report =
    "⏹ <b>ИВЕНТ ОСТАНОВЛЕН</b>\n" +
    "━━━━━━━━━━━━━━━━━━\n" +
    "🎁 <b>Приз:</b> " + esc(ev.prize_name) + "\n" +
    "🏆 <b>Выиграно призов:</b> " + won + " из " + total + "\n" +
    "━━━━━━━━━━━━━━━━━━";
  try { await send(group.chat_id, report, { parse_mode: "HTML" }); }
  catch (error) { console.error("group stop notice failed:", error); }
  return send(chatId, "✅ Ивент в группе №" + number + " остановлен.\nВыиграно призов: " + won + " из " + total + ".");
}
async function handleInput(message: any, session: any) {
  const chatId = message.chat.id;
  const adminId = message.from.id;
  const eventId = session.payload?.event_id;
  const raw = String(message.text || "").trim();
  const found = await db.from("gift_events").select("*").eq("id", eventId).eq("status", "draft").maybeSingle();
  if (!found.data) {
    await deleteSession(adminId);
    return send(chatId, "Черновик не найден. Открой /event заново.");
  }
  const ev = found.data;
  let patch: Record<string, unknown> = {};
  if (session.state === "wait_qty") {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 10000) return send(chatId, "Введи целое число от 1 до 10000.");
    patch = { prizes_total: n, prizes_remaining: n, repeat_gap: Math.min(ev.repeat_gap, n) };
  } else if (session.state === "wait_prize") {
    if (!raw || raw.length > 120) return send(chatId, "Название должно быть от 1 до 120 символов.");
    patch = { prize_name: raw };
  } else if (session.state === "wait_hold") {
    const match = raw.match(/^(\d+)\s*(с|сек|секунд[аы]?|м|мин|минут[аы]?)?$/i);
    if (!match) return send(chatId, "Введи время, например 30с или 5м. Можно просто число секунд.");
    const amount = Number(match[1]);
    const unit = (match[2] || "с").toLowerCase();
    const seconds = amount * (unit.startsWith("м") ? 60 : 1);
    if (!Number.isInteger(seconds) || seconds < 5 || seconds > 86400) return send(chatId, "Время должно быть от 5 секунд до 24 часов.");
    patch = { hold_seconds: seconds };
  } else if (session.state === "wait_chance") {
    const n = Number(raw.replace(",", "."));
    if (!Number.isFinite(n) || n < 0 || n > 100) return send(chatId, "Введи число от 0 до 100. Например: 1,23");
    patch = { win_chance: n };
  } else if (session.state === "wait_repeat") {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > ev.prizes_total) return send(chatId, "Введи целое число от 0 до " + ev.prizes_total + ".");
    patch = { repeat_gap: n };
  } else if (session.state === "wait_users") {
    if (raw.toLowerCase() === "нет" || raw.toLowerCase() === "очистить") patch = { excluded_user_ids: [] };
    else {
      const ids = raw.split(/[,\s]+/).filter(Boolean).map((v: string) => Number(v));
      if (!ids.length || ids.some((v: number) => !Number.isSafeInteger(v) || v <= 0)) return send(chatId, "Отправь Telegram ID через запятую. Для очистки напиши «нет».");
      patch = { excluded_user_ids: Array.from(new Set(ids)) };
    }
  }
  const updated = await db.from("gift_events").update({ ...patch, created_at: new Date().toISOString() }).eq("id", eventId).eq("status", "draft").select("id").maybeSingle();
  if (updated.error) return send(chatId, "Не удалось сохранить черновик: " + updated.error.message);
  if (!updated.data) return send(chatId, "Черновик не найден или уже не редактируется. Открой /event заново.");
  await saveSession(adminId, "editing", { event_id: eventId });
  return showMenu(chatId, eventId);
}
async function handleCallback(q: any) {
  const adminId = q.from?.id;
  const chatId = q.message?.chat?.id;
  if (!isOwner(adminId) || q.message?.chat?.type !== "private") {
    await answerCallback(q.id, "Нет доступа");
    return;
  }
  const data = String(q.data || "");
  if (data === "home:event") {
    await answerCallback(q.id);
    return openEvent(chatId);
  }
  if (data === "home:winners") {
    await answerCallback(q.id);
    return showWinners(chatId);
  }
  if (data === "home:main") {
    await answerCallback(q.id);
    return showHome(chatId);
  }
  if (data === "home:connect") {
    await answerCallback(q.id);
    return send(chatId, "Чтобы подключить закрытую группу:\n1. Добавь бота в группу и назначь администратором.\n2. Убедись, что один из владельцев бота тоже администратор.\n3. Отправь в группе команду /connect.");
  }
  if (data === "home:groups") {
    await answerCallback(q.id);
    const groups = await listGroups();
    if (!groups.length) return send(chatId, "Пока нет подключённых групп.");
    return send(chatId, "👥 <b>Подключённые группы</b>\n\n" + groups.map((g: any) => "№" + g.group_number + " — " + esc(g.title)).join("\n"), { parse_mode: "HTML" });
  }
  const homeStart = data.match(/^home:start:(\d+)$/);
  if (homeStart) {
    await answerCallback(q.id);
    return startEvent(chatId, Number(homeStart[1]));
  }
  const homeStop = data.match(/^home:stop:(\d+)$/);
  if (homeStop) {
    await answerCallback(q.id);
    return stopEvent(chatId, Number(homeStop[1]));
  }
  if (data.startsWith("group:")) {
    const groupId = data.slice(6);
    const groupResult = await db.from("gift_groups").select("id,group_number,title").eq("id", groupId).eq("is_active", true).maybeSingle();
    if (!groupResult.data) return answerCallback(q.id, "Группа не найдена");
    await answerCallback(q.id);
    return send(chatId, "Выбери вид ивента для группы №" + groupResult.data.group_number + " — " + esc(groupResult.data.title) + ":", { parse_mode: "HTML", reply_markup: { inline_keyboard: [
      [{ text: "🎁 Подарки за активность", callback_data: "mode:" + groupId + ":activity_gifts" }],
      [{ text: "⏱ На перебив", callback_data: "mode:" + groupId + ":last_message" }]
    ] } });
  }
  const modeChoice = data.match(/^mode:([0-9a-f-]+):(activity_gifts|last_message)$/i);
  if (modeChoice) {
    const groupId = modeChoice[1], mode = modeChoice[2];
    const groupResult = await db.from("gift_groups").select("id").eq("id", groupId).eq("is_active", true).maybeSingle();
    if (!groupResult.data) return answerCallback(q.id, "Группа не найдена");
    let ev = await findDraft(groupId, mode);
    if (!ev) {
      const defaults = mode === "last_message"
        ? { mode, prizes_total: 1, prizes_remaining: 1, prize_name: "Подарок", win_chance: 0, repeat_gap: 0, exclude_group_owner: true, exclude_group_admins: true, excluded_user_ids: [], hold_seconds: 60, created_by: adminId }
        : { mode, prizes_total: 1, prizes_remaining: 1, prize_name: "Подарок", win_chance: 1, repeat_gap: 0, exclude_group_owner: false, exclude_group_admins: false, excluded_user_ids: [], created_by: adminId };
      const created = await db.from("gift_events").insert({ group_id: groupId, status: "draft", ...defaults }).select("*").single();
      if (created.error) throw created.error;
      ev = created.data;
    }
    await db.from("gift_events").update({ created_at: new Date().toISOString() }).eq("id", ev.id).eq("status", "draft");
    await saveSession(adminId, "editing", { event_id: ev.id });
    await answerCallback(q.id, "Вид ивента выбран");
    return showMenu(chatId, ev.id);
  }
  const session = await sessionFor(adminId);
  const eventId = session?.payload?.event_id;
  if (!eventId) return answerCallback(q.id, "Сначала выбери группу в /event");
  const found = await db.from("gift_events").select("*").eq("id", eventId).eq("status", "draft").maybeSingle();
  if (!found.data) return answerCallback(q.id, "Черновик не найден");
  const ev = found.data;
  if (data === "done") {
    const savedDraft = await db.from("gift_events").select("id,mode,prizes_total,prize_name,win_chance,hold_seconds").eq("id", eventId).eq("status", "draft").maybeSingle();
    if (savedDraft.error) return answerCallback(q.id, "Ошибка проверки сохранения");
    if (!savedDraft.data) return answerCallback(q.id, "Черновик не найден");
    await deleteSession(adminId);
    await answerCallback(q.id, "Черновик сохранён");
    const group = await db.from("gift_groups").select("group_number").eq("id", ev.group_id).single();
    if (savedDraft.data.mode === "last_message") {
      const seconds = Number(savedDraft.data.hold_seconds || 60);
      const duration = seconds >= 60 ? (seconds % 60 === 0 ? (seconds / 60) + " мин." : Math.floor(seconds / 60) + " мин. " + (seconds % 60) + " сек.") : seconds + " сек.";
      return send(chatId, "💾 <b>НАСТРОЙКИ ИВЕНТА СОХРАНЕНЫ</b>\n\n⏱ <b>Время без перебива:</b> " + duration + "\n🎁 <b>Приз:</b> " + esc(savedDraft.data.prize_name) + "\n\n▶ <b>Команда запуска:</b> <code>/startivent" + group.data.group_number + "</code>", { parse_mode: "HTML" });
    }
    return send(chatId, "💾 <b>НАСТРОЙКИ ИВЕНТА СОХРАНЕНЫ</b>\n\n" + "🎁 <b>Приз:</b> " + esc(savedDraft.data.prize_name) + "\n" + "📦 <b>Количество призов:</b> " + savedDraft.data.prizes_total + "\n" + "🎲 <b>Шанс выигрыша за каждое сообщение:</b> " + String(savedDraft.data.win_chance).replace(".", ",") + "%\n\n" + "▶ <b>Команда запуска:</b> <code>/startivent" + group.data.group_number + "</code>", { parse_mode: "HTML" });
  }
  if (data === "toggle:owner" || data === "toggle:admins") {
    const key = data === "toggle:owner" ? "exclude_group_owner" : "exclude_group_admins";
    const result = await db.from("gift_events").update({ [key]: !ev[key] }).eq("id", eventId);
    if (result.error) throw result.error;
    await answerCallback(q.id, "Сохранено");
    return showMenu(chatId, eventId);
  }
  const prompts: Record<string, [string, string]> = {
    "edit:qty": ["wait_qty", "Введи количество одинаковых призов. Например: 10"],
    "edit:prize": ["wait_prize", "Введи название приза. Например: Мишка"],
    "edit:hold": ["wait_hold", "Введи время без перебива. Например: 30с или 5м. Минимум 5 секунд, максимум 24 часа."],
    "edit:chance": ["wait_chance", "Введи шанс от 0 до 100. Можно с запятой: 1,23"],
    "edit:repeat": ["wait_repeat", "Сколько других победителей должно быть между выигрышами одного человека? Введи число от 0 до " + ev.prizes_total + "."],
    "edit:users": ["wait_users", "Введи Telegram ID пользователей через запятую. Для очистки напиши «нет». Боты исключаются автоматически."],
  };
  if (prompts[data]) {
    await saveSession(adminId, prompts[data][0], { event_id: eventId });
    await answerCallback(q.id);
    return send(chatId, prompts[data][1]);
  }
}

async function showHome(chatId: number) {
  const groups = await listGroups();
  const keyboard: any[] = [
    [{ text: "🎁 Настроить ивент", callback_data: "home:event" }],
    [{ text: "🏆 Победители", callback_data: "home:winners" }],
    [{ text: "👥 Мои группы", callback_data: "home:groups" }],
    [{ text: "➕ Подключить группу", callback_data: "home:connect" }],
  ];
  for (const g of groups) keyboard.push([
    { text: "▶ Запустить №" + g.group_number, callback_data: "home:start:" + g.group_number },
    { text: "⏹ Остановить №" + g.group_number, callback_data: "home:stop:" + g.group_number },
  ]);
  const intro = groups.length
    ? "Выбери действие ниже. Группы подключаются автоматически, когда бот и один из владельцев являются администраторами."
    : "Добавь бота в группу и выдай ему права администратора. Группа подключится автоматически, если один из владельцев бота тоже является администратором.";
  return send(chatId, "🎁 <b>Подарочный бот</b>\\n\\n" + intro, {
    parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard },
  });
}
async function showWinners(chatId: number) {
  const winsResult = await db.from("gift_wins")
    .select("event_id,group_id,user_id,username,first_name,prize_name,win_number,created_at")
    .order("created_at", { ascending: false }).limit(20);
  if (winsResult.error) throw winsResult.error;
  const wins = winsResult.data || [];
  if (!wins.length) return send(chatId, "🏆 <b>Победители</b>\n\nПока ещё никто не выигрывал.", {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: "⬅️ В главное меню", callback_data: "home:main" }]] },
  });
  const groupIds = Array.from(new Set(wins.map((w: any) => w.group_id)));
  const groupsResult = await db.from("gift_groups").select("id,group_number,title").in("id", groupIds);
  if (groupsResult.error) throw groupsResult.error;
  const groups = new Map((groupsResult.data || []).map((g: any) => [g.id, g]));

  // Combine all winners from the same event into one display row.
  const contests = new Map<string, any[]>();
  for (const win of wins) {
    const key = String(win.event_id || (win.group_id + ":" + win.created_at));
    if (!contests.has(key)) contests.set(key, []);
    contests.get(key)!.push(win);
  }

  const lines = Array.from(contests.values()).map((contest: any[], index: number) => {
    const latest = contest[0];
    const group: any = groups.get(latest.group_id);
    const seenUsers = new Set<string>();
    const names = contest
      .filter((w: any) => {
        const id = String(w.user_id);
        if (seenUsers.has(id)) return false;
        seenUsers.add(id);
        return true;
      })
      .map((w: any) => '<a href="tg://user?id=' + w.user_id + '">' +
        esc(w.first_name || w.username || ("ID " + w.user_id)) + "</a>");
    const prizeNames = Array.from(new Set(contest.map((w: any) => String(w.prize_name || "Приз"))));
    const date = new Date(latest.created_at).toLocaleString("ru-RU", {
      timeZone: "Europe/Moscow", dateStyle: "short", timeStyle: "short"
    });
    const groupLabel = group ? "№" + group.group_number + " — " + esc(group.title) : "группа";
    return (index + 1) + ". " + names.join(", ") + " — 🎁 " + esc(prizeNames.join(", ")) +
      " · 👥 " + groupLabel + " · " + date;
  });

  return send(chatId, "🏆 <b>ПОБЕДИТЕЛИ</b>\n<i>Последние " + wins.length + " выигрышей</i>\n\n" + lines.join("\n"), {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: "⬅️ В главное меню", callback_data: "home:main" }]] },
  });
}
async function handlePrivate(message: any) {
  const chatId = message.chat.id;
  const userId = message.from?.id;
  if (!isOwner(userId)) return send(chatId, "Бот работает только в группе.");
  await deletePrivateInput(message);
  const text = String(message.text || "").trim();
  const command = text.split(/\s+/)[0].split("@")[0];
  if (command === "/start") {
    await setBotCommands();
    return showHome(chatId);
  }
  if (command === "/winners") return showWinners(chatId);
  if (command === "/help") {
    return send(chatId, "Команды: /start — главное меню, /event — настройка ивента, /groups — список групп. Запуск и остановка доступны кнопками в меню.");
  }
  if (command === "/event") return openEvent(chatId);
  if (command === "/addgroup") {
    const identifier = text.split(/\\s+/)[1];
    if (!identifier) return send(chatId, "Использование: /addgroup @username или /addgroup -1001234567890");
    if (!identifier.startsWith("@") && !/^-\\d+$/.test(identifier)) return send(chatId, "Укажи @username или числовой ID группы, например -1001234567890.");
    try { return await addGroup(chatId, userId, identifier); }
    catch (error) {
      console.error("addgroup error:", error);
      return send(chatId, "Не получилось подключить группу. Проверь ID/@username, добавление бота и его права администратора.");
    }
  }
  if (command === "/groups") {
    const groups = await listGroups();
    if (!groups.length) return send(chatId, "Пока нет подключённых групп.");
    return send(chatId, groups.map((g: any) => "№" + g.group_number + " — " + esc(g.title) + (g.username ? " (@" + esc(g.username) + ")" : "")).join("\n"), { parse_mode: "HTML" });
  }
  const start = command.match(/^\/startivent(\d+)$/i);
  if (start) return startEvent(chatId, Number(start[1]));
  const stop = command.match(/^\/stopivent(\d+)$/i);
  if (stop) return stopEvent(chatId, Number(stop[1]));
  const session = await sessionFor(userId);
  if (session && session.state.startsWith("wait_") && message.text) return handleInput(message, session);
  return send(chatId, "Неизвестная команда. Напиши /help.");
}
async function processTimerEvents() {
  const countdowns = await db.from("gift_events").select("id,group_id,hold_seconds,deadline_at,current_first_name,current_username,countdown_message_id,countdown_last_value").eq("mode", "last_message").eq("status", "active").not("deadline_at", "is", null).limit(100);
  if (countdowns.error) throw countdowns.error;
  for (const ev of countdowns.data || []) {
    const remaining = Math.max(0, Math.ceil((new Date(ev.deadline_at).getTime() - Date.now()) / 1000));
    const total = Number(ev.hold_seconds || 60);
    const threshold = total <= 20 ? Math.max(3, Math.ceil(total * 0.3)) : 10;
    if (remaining > threshold + 1 || remaining <= 0) continue;
    const displayValue = total <= 20 ? Math.min(threshold, remaining) : (remaining <= 2 ? remaining : Math.ceil(remaining / 2) * 2);
    const groupResult = await db.from("gift_groups").select("chat_id").eq("id", ev.group_id).maybeSingle();
    if (!groupResult.data) continue;
    const countdownText = "⏳ <b>До победы осталось: " + displayValue + " сек.</b>";
    try {
      if (!ev.countdown_message_id) {
        const sent = await tg("sendMessage", { chat_id: groupResult.data.chat_id, text: countdownText, parse_mode: "HTML" });
        await db.from("gift_events").update({ countdown_message_id: sent.message_id, countdown_last_value: displayValue }).eq("id", ev.id).eq("status", "active");
      } else if (Number(ev.countdown_last_value) !== displayValue) {
        await tg("editMessageText", { chat_id: groupResult.data.chat_id, message_id: ev.countdown_message_id, text: countdownText, parse_mode: "HTML" });
        await db.from("gift_events").update({ countdown_last_value: displayValue }).eq("id", ev.id).eq("status", "active");
      }
    } catch (error) { console.error("countdown update failed:", error); }
  }
  const due = await db.from("gift_events").select("id").eq("mode", "last_message").eq("status", "active").not("deadline_at", "is", null).lte("deadline_at", new Date().toISOString()).limit(50);
  if (due.error) throw due.error;
  for (const item of due.data || []) {
    const claimed = await db.rpc("giftbot_claim_timer_winner", { p_event_id: item.id, p_now: new Date().toISOString() });
    if (claimed.error) { console.error("timer claim failed:", claimed.error); continue; }
    const ev = claimed.data;
    if (!ev) continue;
    const groupResult = await db.from("gift_groups").select("chat_id").eq("id", ev.group_id).maybeSingle();
    if (!groupResult.data) continue;
    if (ev.countdown_message_id) {
      try { await tg("deleteMessage", { chat_id: groupResult.data.chat_id, message_id: ev.countdown_message_id }); }
      catch (error) { console.error("final countdown delete failed:", error); }
    }
    if (ev.timer_message_id) {
      try { await tg("unpinChatMessage", { chat_id: groupResult.data.chat_id, message_id: ev.timer_message_id }); }
      catch (error) { console.error("unpin start notice failed:", error); }
    }
    const winnerName = esc(ev.current_first_name || ev.current_username || "Участник");
    const winnerLink = '<a href="tg://user?id=' + ev.current_user_id + '">' + winnerName + '</a>';
    const text = "🏆 <b>ПОБЕДИТЕЛЬ ИВЕНТА «НА ПЕРЕБИВ»!</b>\n━━━━━━━━━━━━━━━━━━\n👤 " + winnerLink + " продержался без перебива!\n🎁 <b>Приз:</b> " + esc(ev.prize_name) + "\n━━━━━━━━━━━━━━━━━━";
    try {
      await tg("sendMessage", { chat_id: groupResult.data.chat_id, text, parse_mode: "HTML" });
    } catch (error) {
      console.error("timer winner announcement failed:", error);
    }
  }
}

async function handleGroup(message: any) {
  if (!message.from || message.from.is_bot || (message.chat.type !== "group" && message.chat.type !== "supergroup")) return;
  const groupCommand = String(message.text || "").trim().split(" ")[0].split("@")[0];
  if (groupCommand === "/connect") {
    if (!isOwner(Number(message.from.id))) return send(message.chat.id, "Подключить группу может только владелец бота.");
    await autoRegisterGroup(message.chat);
    const saved = await db.from("gift_groups").select("group_number").eq("chat_id", message.chat.id).maybeSingle();
    if (saved.data) return send(message.chat.id, "✅ Группа подключена! Её номер: №" + saved.data.group_number + ". Настройки доступны владельцу бота в личке через /event.");
    return send(message.chat.id, "Не удалось подключить группу. Проверь, что бот назначен администратором, а один из владельцев бота тоже является администратором.");
  }
  const groupResult = await db.from("gift_groups").select("id").eq("chat_id", message.chat.id).eq("is_active", true).maybeSingle();
  if (!groupResult.data) return;
  await processTimerEvents();
  const eventResult = await db.from("gift_events").select("*").eq("group_id", groupResult.data.id).eq("status", "active").maybeSingle();
  const ev = eventResult.data;
  if (!ev) return;
  if (ev.mode === "last_message") {
    let member: any;
    try { member = await tg("getChatMember", { chat_id: message.chat.id, user_id: message.from.id }); }
    catch (error) { console.error("timer participant check failed:", error); return; }
    if (member.status === "creator" || member.status === "administrator" || member.status === "left" || member.status === "kicked") return;
    // The current leader cannot reset their own timer by sending another message.
    if (Number(ev.current_user_id) === Number(message.from.id)) return;
    const deadline = new Date(Date.now() + Number(ev.hold_seconds || 60) * 1000).toISOString();
    if (ev.countdown_message_id) {
      try { await tg("deleteMessage", { chat_id: message.chat.id, message_id: ev.countdown_message_id }); }
      catch (error) { console.error("old countdown delete failed:", error); }
    }
    const updated = await db.from("gift_events").update({ current_user_id: message.from.id, current_username: message.from.username || null, current_first_name: message.from.first_name || null, deadline_at: deadline, countdown_message_id: null, countdown_last_value: null }).eq("id", ev.id).eq("status", "active").select("id").maybeSingle();
    if (updated.error || !updated.data) return;
    const participant = esc(message.from.first_name || message.from.username || "Участник");
    const statusText = "🎁 <b>Перебито!</b>\n\nНовый лидер: <b>" + participant + "</b>.\nДо конца ивента: <b>" + Number(ev.hold_seconds || 60) + "</b> сек.";
    try {
      await tg("sendMessage", { chat_id: message.chat.id, text: statusText, parse_mode: "HTML" });
    } catch (error) { console.error("timer status send failed:", error); }
    return;
  }
  if (Number(ev.prizes_remaining) <= 0) return;
  const chance = Number(ev.win_chance);
  if (chance <= 0 || Math.random() * 100 >= chance) return;
  let isGroupOwner = false;
  let isGroupAdmin = false;
  if (ev.exclude_group_owner || ev.exclude_group_admins) {
    try {
      const member = await tg("getChatMember", { chat_id: message.chat.id, user_id: message.from.id });
      isGroupOwner = member.status === "creator";
      isGroupAdmin = isGroupOwner || member.status === "administrator";
    } catch { return; }
  }
  const claim = await db.rpc("giftbot_claim_prize", {
    p_event_id: ev.id,
    p_user_id: message.from.id,
    p_username: message.from.username || null,
    p_first_name: message.from.first_name || null,
    p_is_group_owner: isGroupOwner,
    p_is_group_admin: isGroupAdmin,
    p_is_bot: Boolean(message.from.is_bot),
  });
  if (claim.error || claim.data !== true) return;
  const winResult = await db.from("gift_wins").select("win_number,prize_name").eq("event_id", ev.id).eq("user_id", message.from.id).order("win_number", { ascending: false }).limit(1).maybeSingle();
  const after = await db.from("gift_events").select("prizes_remaining,status").eq("id", ev.id).single();
  const name = esc(message.from.first_name || message.from.username || "Участник");
  const prizeName = esc(winResult.data?.prize_name || ev.prize_name);
  const remaining = Number(after.data?.prizes_remaining ?? 0);
  const plural = (n: number) => {
    const n10 = n % 10, n100 = n % 100;
    if (n10 === 1 && n100 !== 11) return "штука";
    if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return "штуки";
    return "штук";
  };
  const announcement =
    "🎉 <b>ПОЗДРАВЛЯЕМ С ПОБЕДОЙ!</b>\n" +
    "━━━━━━━━━━━━━━━━━━\n" +
    "👤 <a href=\"tg://user?id=" + message.from.id + "\">" + name + "</a> выиграл приз!\n" +
    "🎁 <b>Приз:</b> " + prizeName + "\n" +
    "🎲 <b>Шанс был:</b> " + String(ev.win_chance).replace(".", ",") + "%\n" +
    "📦 <b>Осталось:</b> " + remaining + " " + plural(remaining) +
    (after.data?.status === "completed" ? "\n━━━━━━━━━━━━━━━━━━\n🏁 <b>Все призы разыграны! Ивент завершён.</b>" : "");
  await send(message.chat.id, announcement, { parse_mode: "HTML" });
  if (after.data?.status === "completed" && ev.timer_message_id) {
    try { await tg("unpinChatMessage", { chat_id: message.chat.id, message_id: ev.timer_message_id }); }
    catch (error) { console.error("unpin completed activity notice failed:", error); }
  }
}

Deno.serve(async (req: Request) => {
  try {
    if (!BOT_TOKEN || !SUPABASE_URL || !SERVICE_KEY) return new Response("Missing bot or Supabase secrets", { status: 500 });
    const url = new URL(req.url);
    if (req.method === "GET" && url.searchParams.has("setup")) {
      if (!WEBHOOK_SECRET || url.searchParams.get("setup") !== WEBHOOK_SECRET) return new Response("Forbidden", { status: 403 });
      const webhookUrl = SUPABASE_URL + "/functions/v1/gift-bot";
      const result = await tg("setWebhook", {
        url: webhookUrl,
        secret_token: WEBHOOK_SECRET,
        allowed_updates: ["message", "callback_query", "my_chat_member"],
        drop_pending_updates: true,
      });
      return Response.json({ ok: true, webhook: result, url: webhookUrl });
    }
    if (req.method !== "POST") return new Response("Gift bot is running", { status: 200 });
    if (req.headers.get("x-gift-timer-key") === TIMER_KEY) {
      await processTimerEvents();
      return Response.json({ ok: true, action: "timer_tick" });
    }
    if (!WEBHOOK_SECRET || req.headers.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) return new Response("Forbidden", { status: 403 });
    const update = await req.json();
    if (update.callback_query) {
      await handleCallback(update.callback_query);
      return new Response("ok");
    }
    if (update.my_chat_member) {
      const membership = update.my_chat_member;
      const status = membership.new_chat_member?.status;
      if (status === "administrator" || status === "creator") {
        await autoRegisterGroup(membership.chat);
      }
      return new Response("ok");
    }
    const message = update.message;
    if (!message) return new Response("ok");
    if (message.chat?.type === "private") await handlePrivate(message);
    else await handleGroup(message);
    return new Response("ok");
  } catch (error) {
    console.error("gift-bot error:", error);
    return new Response("ok", { status: 200 });
  }
});
