import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, "state.json");

let currentLang = "en";

export function getLang() { return currentLang; }

export function setLang(lang) {
  if (!locales[lang]) return false;
  currentLang = lang;
  // Persist to state.json
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    state.lang = lang;
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch {}
  return true;
}

export function loadLang() {
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    if (state.lang && locales[state.lang]) currentLang = state.lang;
  } catch {}
}

export function t(key, params = {}) {
  const template = locales[currentLang]?.[key] || locales.en[key] || key;
  return template.replace(/\{(\w+)\}/g, (_, k) => params[k] ?? `{${k}}`);
}

export function availableLangs() {
  return Object.keys(locales);
}

const locales = {
  en: {
    // ── Sessions ──
    "sessions.empty": "No sessions.",
    "sessions.title": "📋 <b>Sessions:</b>\n\n",
    "sessions.new_btn": "🆕 New session",
    "sessions.detach_btn": "🔌 Detach",
    "sessions.new_status": "🆕 New session (no --resume)",
    "sessions.new_created": "🆕 New session — next message starts fresh.",
    "sessions.ask_name": "📝 What should we call this session? (or just send a message to skip)",
    "sessions.new_named": '🆕 New session "{name}". Send a message.',
    "sessions.new_prompt": "🆕 Name the session? Use /new name or just /new and type.",
    "sessions.detached": "🔌 Detached from session.",
    "sessions.group_ask_name": "📝 What should we call this session?",
    "sessions.group_named": '✅ Session "{name}". Working on it...',
    "sessions.deleted": "🗑 Deleted",
    "sessions.not_found": "❌ Session not found",
    "sessions.no_active": "❌ No active session.",
    "sessions.renamed": '✅ Session renamed to <b>{name}</b>',
    "sessions.name_usage": "Usage: /name title",
    "sessions.attached": '▶️ Attached to: <b>{title}</b>\n<code>{msg}</code>',

    // ── Time ──
    "time.now": "just now",
    "time.min": "{n}m",
    "time.hour": "{n}h",
    "time.day": "{n}d",

    // ── Help ──
    "help.header": "🤖 <b>TG Claude</b>\n\n",
    "help.sessions": "<b>Sessions:</b>\n/sessions — list\n/new [name] — new session\n/name [title] — rename\n/detach — disconnect\n\n",
    "help.control": "<b>Control:</b>\n/stop — stop Claude\n/status — mode, model, session, tokens (scope + total)\n/git — git panel (status/diff/log/push)\n/undo — rollback last commit\n/plan — toggle Plan/Build mode\n/compact — compress context within session\n/screenshot URL — take screenshot\n/model — sonnet/opus/haiku\n/mode — terminal/hybrid/telegram\n/display — tools/thoughts output mode\n/allow, /revoke, /allowed — manage group users\n/lang — voice language (ru/en/auto)\n/botlang — bot UI language\n/cd — working directory\n/setup — re-run setup wizard\n\n",
    "help.quick": "<b>Quick:</b>\n/sh [cmd] — shell without Claude\n/sys — CPU, RAM, disk, battery\n/clip — clipboard (get/set)\n/dl [path] — download file\n/cron 2h text — reminder\n\n",
    "help.mac": "<b>Mac:</b>\n/sleep · /lock · /shutdown · /reboot\n\n",
    "help.footer": "📎 Photo/files → Claude analyzes\n🎤 Voice → Groq STT → Claude\n↩️ Forwarded → Claude analyzes\n💬 Claude can message you (MCP)",
    "help.auto": "(auto)",
    "help.auto_session": "(auto from session)",

    // ── Errors ──
    "error.generic": "❌ Error: {msg}",
    "error.not_git": '❌ <code>{cwd}</code> — not a git repository.',
    "error.no_commits": "❌ No commits.",
    "error.photo_download": "❌ Failed to download photo.",
    "error.file_download": "❌ Failed to download file.",
    "error.voice_recognize": "❌ Failed to recognize voice.",
    "error.voice_error": "❌ Recognition error: {msg}",
    "error.file_not_found": "❌ File not found: {path}",
    "error.screenshot": "❌ Screenshot failed: {msg}",
    "error.invalid_modes": "❌ Available modes: terminal, hybrid, telegram",
    "error.display_denied": "⛔ Dangerous operation blocked — only the bot owner can approve this.\n\n<code>{detail}</code>",
    "error.display_denied_owner": "⚠️ Dangerous operation in group by user <code>{userId}</code> — blocked:\n\n<code>{detail}</code>",
    "error.invalid_models": "❌ Available models: sonnet, opus, haiku",
    "error.no_staging": "❌ Nothing in staging. Press 📦 Stage all first.",

    // ── Status / Progress ──
    "status.thinking": "🤔 Thinking...",
    "status.writing": "📝 Writing response...",
    "status.recognizing": "🎤 Recognizing...",
    "status.screenshotting": "📸 Taking screenshot...",
    "status.generating_commit": "💾 Generating commit message...",
    "status.claude_error": "❌ Error:\n{output}",

    // ── Commands ──
    "cmd.stopped": "🛑 Claude stopped.",
    "cmd.nothing_running": "Nothing is running.",
    "cmd.cost": "📊 Session: ↓{input} ↑{output} ({total} total)",
    "cmd.mode_current": '📡 Mode: <b>{mode}</b>',
    "cmd.mode_set": '✅ Mode: <b>{mode}</b>',
    "cmd.model_current": '🤖 Model: <b>{model}</b>',
    "cmd.model_set": '✅ Model: <b>{model}</b>',
    "cmd.cd_current": '📂 Directory: <code>{cwd}</code>',
    "cmd.cd_set": '📂 Directory: <code>{dir}</code>',
    "cmd.cd_reset": "📂 Directory reset (auto from session)",
    "cmd.lang_current": '🎤 Language: <b>{lang}</b>',
    "cmd.lang_set": '✅ Voice language: <b>{lang}</b>',
    "cmd.botlang_current": '🌐 Bot language: <b>{lang}</b>',
    "cmd.botlang_set": '✅ Bot language: <b>{lang}</b>',
    "cmd.plan_mode": "{emoji} Mode: <b>{label}</b>",
    "cmd.locked": "🔒 Screen locked.",
    "cmd.confirm_action": "{emoji} Are you sure you want to {action}?",
    "cmd.screenshot_usage": "Usage: /screenshot https://example.com",
    "cmd.clipboard_copied": "📋 Copied ({len} chars)",
    "cmd.no_data": "❌ No data",
    "cmd.empty": "(empty)",

    // ── Git ──
    "git.clean": "✅ Clean, no changes.",
    "git.more_files": "<i>...and {n} more files</i>",
    "git.no_changes": "No changes.",
    "git.push_confirm": "🚀 Push to remote?",
    "git.push_result": "🚀 Push:\n<pre>{out}</pre>",
    "git.push_cancelled": "❌ Push cancelled.",
    "git.pull_result": "⬇️ Pull:\n<pre>{out}</pre>",
    "git.staged_all": "📦 All files added to staging.",
    "git.undo_confirm": "⏪ Rollback last commit?\n\n<code>{log}</code>\n\n<pre>{diff}</pre>",
    "git.undo_soft_btn": "⏪ Soft reset (keep changes)",
    "git.undo_hard_btn": "💥 Hard reset (delete all)",
    "git.undo_soft": "⏪ Commit rolled back (soft reset). Changes preserved in staging.\n\n<pre>{status}</pre>",
    "git.undo_hard": "💥 Hard reset done.\n\n<pre>{out}</pre>",
    "git.undo_cancelled": "❌ Rollback cancelled.",
    "git.undo_impossible": "❌ Not a git repo, undo impossible.",

    // ── Mac ──
    "mac.cancelled": "❌ Cancelled.",
    "mac.shutting_down": "⏻ Shutting down...",
    "mac.rebooting": "🔄 Rebooting...",
    "mac.action_shutdown": "shut down",
    "mac.action_reboot": "reboot",

    // ── Sleep ──
    "sleep.goodnight": "Goodnight!",
    "sleep.going": "😴 Going to sleep. Goodnight!",
    "sleep.continue": "Continue!",
    "sleep.continuing": "👍 Continuing work.",
    "sleep.ask": "No activity for 30 minutes. Put Mac to sleep?",
    "sleep.yes_btn": "✅ Yes, sleep",
    "sleep.no_btn": "❌ No, keep working",
    "sleep.no_response": "No response — going to sleep.",

    // ── Approval ──
    "approval.dangerous_op": "DANGEROUS OPERATION",
    "approval.what": "What:",
    "approval.why": "Why:",
    "approval.irreversible": "May be irreversible",
    "approval.approved": "Approved",
    "approval.denied": "Denied",
    "approval.timeout": "Timeout",
    "approval.yes_btn": "✅ Yes",
    "approval.no_btn": "❌ No",
    "approval.cancel_btn": "❌ Cancel",
    "approval.pending_terminal": "⚠️ Approval waiting in terminal for {min} min:\n<b>{tool}</b>\n<code>{detail}</code>",

    // ── Notify hook ──
    "hook.task_done": "Task completed",
    "hook.reason": "Reason:",

    // ── Cron ──
    "cron.empty": "📅 No active tasks.",
    "cron.list": "📅 Tasks:\n{list}",
    "cron.deleted": "🗑 Deleted: {label}",
    "cron.not_found": "❌ No such task.",
    "cron.usage": "Format: /cron 2h check deploy\n/cron 30m remind me\n/cron list\n/cron del 1",
    "cron.reminder": "⏰ Reminder: {label}",
    "cron.set": "⏰ Will remind in {time}: {label}",

    // ── Forwards ──
    "fwd.from": 'Forwarded from "{from}":\n---\n{content}\n---',
    "fwd.unknown": "unknown",
    "fwd.file_saved": "[file saved: {path}]",
    "fwd.file_download_failed": "[failed to download file: {name}]",
    "fwd.photo_saved": "[photo: {path}]",
    "fwd.photo_failed": "[photo: failed to download]",
    "fwd.media_caption": "[media] {caption}",
    "fwd.media_no_text": "[media without text]",
    "fwd.describe_photo": "Describe what's in this image",
    "fwd.look_at_image": "Look at the image {path}\n\n{caption}",
    "fwd.file_inline": "File {name}:\n```\n{content}\n```",
    "fwd.file_at": "File saved at {path} ({name})",

    // ── Token rotation ──
    "rotation.ask": "♻️ Session limit reached ({limit} tokens). Start a new session or compress context?",
    "rotation.btn_new": "🆕 New session",
    "rotation.btn_compress": "🗜 Compress",
    "rotation.summarizing": "⏳ Summarizing session...",
    "rotation.compressing": "⏳ Compressing context...",
    "rotation.compressed": "✅ Context compressed, continuing in new session.",
    "rotation.ask_delete": "Delete the old session?",
    "rotation.btn_delete": "🗑 Delete",
    "rotation.btn_keep": "📌 Keep",
    "rotation.deleted_old": "🗑 Old session deleted.",
    "rotation.kept_old": "📌 Old session kept.",
    "rotation.summarize": "Make a brief summary of our current work: what we're doing, key decisions made, what's in progress, what still needs to be done. No more than 500 words. Facts only.",
    "rotation.continue": "[New session, previous context]\n\n{summary}\n\nContinue working with this context.",
    "rotation.handoff_saving": "⏳ Token limit reached — saving context to file...",
    "rotation.handoff_done": "✅ Context saved to <code>{file}</code>. Starting fresh session.",

    // ── Token warning ──
    "tokens.warn_limit": "⚠️ <b>Context is nearly full</b> ({used}/200k)\n\nClaude will auto-compress soon. Consider <code>/new</code> for a fresh session if quality drops.",

    // ── Plan mode ──
    "plan.prefix": "[PLAN MODE] Only plan, do NOT write code or create files. Describe the plan, steps, architecture. Ask if clarification needed.\n\n{prompt}",

    // ── Status ──
    "status.cmd": "📊 <b>Status</b>\n\n🤖 Model: <b>{model}</b>\n📡 Mode: <b>{mode}</b>\n📂 Dir: <code>{cwd}</code>\n🎯 Session: <b>{session}</b>\n\n🪙 Scope: {bar}\n💰 Total: ↓{input} ↑{output}",
    "status.no_session": "none",

    // ── Setup wizard ──
    "setup.os_prompt": "⚙️ <b>Step 1/3 — Operating system</b>\n\nWhat OS is this machine running?",
    "setup.os_mac": "🍎 macOS",
    "setup.os_linux": "🐧 Linux",
    "setup.mode_prompt": "⚙️ <b>Step 2/3 — Output mode</b>\n\nWhere should Claude send responses?",
    "setup.mode_terminal": "🖥 Terminal — responses in terminal (you're at your Mac)",
    "setup.mode_hybrid": "🔀 Hybrid — responses in terminal, approvals on phone",
    "setup.mode_telegram": "📱 Telegram — everything on your phone",
    "setup.diff_prompt": "⚙️ <b>Step 3/3 — Code diff</b>\n\nWhen Claude edits a file, show what changed in the status message?\n\n<i>Toggle anytime with /codediff</i>",
    "setup.diff_on": "✅ Yes",
    "setup.diff_off": "❌ No",
    "setup.tokens_prompt": "⚙️ <b>Step 4/4 — Token rotation limit</b>\n\nWhen to compress context and start a fresh session?\n\n<i>Higher = more context, higher cost per session.</i>",
    "setup.tokens_unlimited": "♾️ No limit (never rotate)",
    "setup.done": "✅ <b>Setup complete!</b>\n\nJust start typing to use Claude.",
    "setup.cmd": "⚙️ <b>Setup</b>\n\nRe-run first-time configuration.",

    // ── Welcome ──
    "welcome.title": "👋 <b>Welcome to TG Claude!</b>",
    "welcome.subtitle": "Your Mac is now a remote terminal. Send any message — Claude Code will handle it with full tool access: run commands, edit files, browse the web, manage git.",
    "welcome.sessions": "<b>Sessions:</b> /sessions · /new · /detach",
    "welcome.control": "<b>Control:</b> /stop · /model · /mode · /git · /undo · /plan",
    "welcome.quick": "<b>Quick:</b> /sh · /sys · /clip · /dl · /cron · /screenshot",
    "welcome.attachments": "<b>Also works:</b> 📎 files · 📷 photos · 🎤 voice messages",
    "welcome.modes": "<b>Output modes:</b> <code>terminal</code> · <code>hybrid</code> · <code>telegram</code>\nUse /mode to switch. Hybrid = responses in terminal, approvals on your phone.",
    "welcome.tip": "💡 Just start typing — no commands needed.",
    "welcome.lang_set": "🌐 Language auto-detected: <b>{lang}</b>. Use /botlang to change.",
  },

  ru: {
    // ── Sessions ──
    "sessions.empty": "Нет сессий.",
    "sessions.title": "📋 <b>Сессии:</b>\n\n",
    "sessions.new_btn": "🆕 Новая сессия",
    "sessions.detach_btn": "🔌 Отключиться",
    "sessions.new_status": "🆕 Новая сессия (без --resume)",
    "sessions.new_created": "🆕 Новая сессия — следующее сообщение создаст свежую.",
    "sessions.ask_name": "📝 Как назовём сессию? (или просто отправь сообщение)",
    "sessions.new_named": '🆕 Новая сессия «{name}». Отправь сообщение.',
    "sessions.new_prompt": "🆕 Как назвать сессию? Отправь /new имя или просто /new и пиши.",
    "sessions.detached": "🔌 Отключено от сессии.",
    "sessions.group_ask_name": "📝 Как назовём эту сессию?",
    "sessions.group_named": '✅ Сессия «{name}». Работаю...',
    "sessions.deleted": "🗑 Удалена",
    "sessions.not_found": "❌ Сессия не найдена",
    "sessions.no_active": "❌ Нет активной сессии.",
    "sessions.renamed": "✅ Сессия переименована в <b>{name}</b>",
    "sessions.name_usage": "Использование: /name имя",
    "sessions.attached": '▶️ Подключен к: <b>{title}</b>\n<code>{msg}</code>',

    // ── Time ──
    "time.now": "только что",
    "time.min": "{n}м",
    "time.hour": "{n}ч",
    "time.day": "{n}д",

    // ── Help ──
    "help.header": "🤖 <b>TG Claude</b>\n\n",
    "help.sessions": "<b>Сессии:</b>\n/sessions — список\n/new [имя] — новая сессия\n/name [имя] — переименовать\n/detach — отключиться\n\n",
    "help.control": "<b>Управление:</b>\n/stop — остановить Claude\n/status — режим, модель, сессия, токены (скоуп + total)\n/git — git панель (status/diff/log/push)\n/undo — откатить последний коммит\n/plan — переключить Plan/Build режим\n/compact — сжать контекст сессии\n/screenshot URL — скриншот страницы\n/model — sonnet/opus/haiku\n/mode — terminal/hybrid/telegram\n/display — режим вывода (tools/thoughts)\n/allow, /revoke, /allowed — пользователи групп\n/lang — язык голоса (ru/en/auto)\n/botlang — язык интерфейса\n/cd — рабочая директория\n/setup — повторная настройка\n\n",
    "help.quick": "<b>Быстрые:</b>\n/sh [cmd] — shell без Claude\n/sys — CPU, RAM, диск, батарея\n/clip — буфер обмена (get/set)\n/dl [path] — скачать файл\n/cron 2h текст — напоминание\n\n",
    "help.mac": "<b>Mac:</b>\n/sleep · /lock · /shutdown · /reboot\n\n",
    "help.footer": "📎 Фото/файлы → Claude анализирует\n🎤 Голосовое → Groq STT → Claude\n↩️ Форвард сообщения → Claude анализирует\n💬 Claude может сам писать в чат (MCP)",
    "help.auto": "(авто)",
    "help.auto_session": "(авто из сессии)",

    // ── Errors ──
    "error.generic": "❌ Ошибка: {msg}",
    "error.not_git": '❌ <code>{cwd}</code> — не git-репозиторий.',
    "error.no_commits": "❌ Нет коммитов.",
    "error.photo_download": "❌ Не удалось скачать фото.",
    "error.file_download": "❌ Не удалось скачать файл.",
    "error.voice_recognize": "❌ Не удалось распознать голос.",
    "error.voice_error": "❌ Ошибка распознавания: {msg}",
    "error.file_not_found": "❌ Файл не найден: {path}",
    "error.screenshot": "❌ Скриншот не удался: {msg}",
    "error.invalid_modes": "❌ Доступные режимы: terminal, hybrid, telegram",
    "error.display_denied": "⛔ Опасная операция заблокирована — только владелец бота может подтвердить.\n\n<code>{detail}</code>",
    "error.display_denied_owner": "⚠️ Опасная операция в группе от пользователя <code>{userId}</code> — заблокирована:\n\n<code>{detail}</code>",
    "error.invalid_models": "❌ Доступные модели: sonnet, opus, haiku",
    "error.no_staging": "❌ Нет файлов в staging. Нажми 📦 Stage all сначала.",

    // ── Status / Progress ──
    "status.thinking": "🤔 Думает...",
    "status.writing": "📝 Пишет ответ...",
    "status.recognizing": "🎤 Распознаю...",
    "status.screenshotting": "📸 Делаю скриншот...",
    "status.generating_commit": "💾 Генерирую commit message...",
    "status.claude_error": "❌ Ошибка:\n{output}",

    // ── Commands ──
    "cmd.stopped": "🛑 Claude остановлен.",
    "cmd.nothing_running": "Ничего не выполняется.",
    "cmd.cost": "📊 Сессия: ↓{input} ↑{output} ({total} всего)",
    "cmd.mode_current": '📡 Режим: <b>{mode}</b>',
    "cmd.mode_set": '✅ Режим: <b>{mode}</b>',
    "cmd.model_current": '🤖 Модель: <b>{model}</b>',
    "cmd.model_set": '✅ Модель: <b>{model}</b>',
    "cmd.cd_current": '📂 Директория: <code>{cwd}</code>',
    "cmd.cd_set": '📂 Директория: <code>{dir}</code>',
    "cmd.cd_reset": "📂 Директория сброшена (авто из сессии)",
    "cmd.lang_current": '🎤 Язык: <b>{lang}</b>',
    "cmd.lang_set": '✅ Язык голоса: <b>{lang}</b>',
    "cmd.botlang_current": '🌐 Язык бота: <b>{lang}</b>',
    "cmd.botlang_set": '✅ Язык бота: <b>{lang}</b>',
    "cmd.plan_mode": "{emoji} Режим: <b>{label}</b>",
    "cmd.locked": "🔒 Экран заблокирован.",
    "cmd.confirm_action": "{emoji} Точно {action}?",
    "cmd.screenshot_usage": "Использование: /screenshot https://example.com",
    "cmd.clipboard_copied": "📋 Скопировано ({len} символов)",
    "cmd.no_data": "❌ Нет данных",
    "cmd.empty": "(пусто)",

    // ── Git ──
    "git.clean": "✅ Чисто, нет изменений.",
    "git.more_files": "<i>...и ещё {n} файлов</i>",
    "git.no_changes": "Нет изменений.",
    "git.push_confirm": "🚀 Push в remote?",
    "git.push_result": "🚀 Push:\n<pre>{out}</pre>",
    "git.push_cancelled": "❌ Push отменён.",
    "git.pull_result": "⬇️ Pull:\n<pre>{out}</pre>",
    "git.staged_all": "📦 Все файлы добавлены в staging.",
    "git.undo_confirm": "⏪ Откатить последний коммит?\n\n<code>{log}</code>\n\n<pre>{diff}</pre>",
    "git.undo_soft_btn": "⏪ Soft reset (сохранить изменения)",
    "git.undo_hard_btn": "💥 Hard reset (удалить всё)",
    "git.undo_soft": "⏪ Коммит откачен (soft reset). Изменения сохранены в staging.\n\n<pre>{status}</pre>",
    "git.undo_hard": "💥 Hard reset выполнен.\n\n<pre>{out}</pre>",
    "git.undo_cancelled": "❌ Откат отменён.",
    "git.undo_impossible": "❌ Не git-репо, undo невозможен.",

    // ── Mac ──
    "mac.cancelled": "❌ Отменено.",
    "mac.shutting_down": "⏻ Выключаюсь...",
    "mac.rebooting": "🔄 Перезагружаюсь...",
    "mac.action_shutdown": "выключить",
    "mac.action_reboot": "перезагрузить",

    // ── Sleep ──
    "sleep.goodnight": "Спокойной ночи!",
    "sleep.going": "😴 Ухожу в сон. Спокойной ночи!",
    "sleep.continue": "Продолжаем!",
    "sleep.continuing": "👍 Продолжаем работу.",
    "sleep.ask": "Нет активности 30 минут. Отправить мак в сон?",
    "sleep.yes_btn": "✅ Да, спать",
    "sleep.no_btn": "❌ Нет, работаем",
    "sleep.no_response": "Нет ответа — ухожу в сон.",

    // ── Approval ──
    "approval.dangerous_op": "ОПАСНАЯ ОПЕРАЦИЯ",
    "approval.what": "Что:",
    "approval.why": "Зачем:",
    "approval.irreversible": "Может быть необратимо",
    "approval.approved": "Одобрено",
    "approval.denied": "Отклонено",
    "approval.timeout": "Таймаут",
    "approval.yes_btn": "✅ Да",
    "approval.no_btn": "❌ Нет",
    "approval.cancel_btn": "❌ Отмена",
    "approval.pending_terminal": "⚠️ Approval ждёт в терминале уже {min} мин:\n<b>{tool}</b>\n<code>{detail}</code>",

    // ── Notify hook ──
    "hook.task_done": "Задача завершена",
    "hook.reason": "Причина:",

    // ── Cron ──
    "cron.empty": "📅 Нет активных задач.",
    "cron.list": "📅 Задачи:\n{list}",
    "cron.deleted": "🗑 Удалена: {label}",
    "cron.not_found": "❌ Нет такой задачи.",
    "cron.usage": "Формат: /cron 2h проверь деплой\n/cron 30m напомни\n/cron list\n/cron del 1",
    "cron.reminder": "⏰ Напоминание: {label}",
    "cron.set": "⏰ Напомню через {time}: {label}",

    // ── Forwards ──
    "fwd.from": 'Переслано от "{from}":\n---\n{content}\n---',
    "fwd.unknown": "неизвестно",
    "fwd.file_saved": "[файл сохранён: {path}]",
    "fwd.file_download_failed": "[не удалось скачать файл: {name}]",
    "fwd.photo_saved": "[фото: {path}]",
    "fwd.photo_failed": "[фото: не удалось скачать]",
    "fwd.media_caption": "[медиа] {caption}",
    "fwd.media_no_text": "[медиа без текста]",
    "fwd.describe_photo": "Опиши что на этом изображении",
    "fwd.look_at_image": "Посмотри на изображение {path}\n\n{caption}",
    "fwd.file_inline": "Файл {name}:\n```\n{content}\n```",
    "fwd.file_at": "Файл сохранён в {path} ({name})",

    // ── Token rotation ──
    "rotation.ask": "♻️ Достигнут лимит сессии ({limit} токенов). Начать новую сессию или сжать контекст?",
    "rotation.btn_new": "🆕 Новая сессия",
    "rotation.btn_compress": "🗜 Сжать",
    "rotation.summarizing": "⏳ Составляю резюме сессии...",
    "rotation.compressing": "⏳ Сжимаю контекст...",
    "rotation.compressed": "✅ Контекст сжат, продолжаем в новой сессии.",
    "rotation.ask_delete": "Удалить старую сессию?",
    "rotation.btn_delete": "🗑 Удалить",
    "rotation.btn_keep": "📌 Оставить",
    "rotation.deleted_old": "🗑 Старая сессия удалена.",
    "rotation.kept_old": "📌 Старая сессия сохранена.",
    "rotation.summarize": "Сделай краткое резюме нашей текущей работы: что мы делаем, какие ключевые решения приняты, что в процессе, что ещё нужно сделать. Не более 500 слов. Только факты.",
    "rotation.continue": "[Новая сессия, контекст предыдущей]\n\n{summary}\n\nПродолжай работу с этим контекстом.",
    "rotation.handoff_saving": "⏳ Лимит токенов — сохраняю контекст в файл...",
    "rotation.handoff_done": "✅ Контекст сохранён в <code>{file}</code>. Стартую новую сессию.",

    // ── Token warning ──
    "tokens.warn_limit": "⚠️ <b>Контекст почти заполнен</b> ({used}/200k)\n\nClaude скоро автоматически сожмёт контекст. Если качество упадёт — <code>/new</code> для чистой сессии.",

    // ── Plan mode ──
    "plan.prefix": "[PLAN MODE] Только планируй, НЕ пиши код и НЕ создавай файлы. Опиши план, шаги, архитектуру. Спроси если нужны уточнения.\n\n{prompt}",

    // ── Status ──
    "status.cmd": "📊 <b>Статус</b>\n\n🤖 Модель: <b>{model}</b>\n📡 Режим: <b>{mode}</b>\n📂 Директория: <code>{cwd}</code>\n🎯 Сессия: <b>{session}</b>\n\n🪙 Скоуп: {bar}\n💰 Всего: ↓{input} ↑{output}",
    "status.no_session": "нет",

    // ── Setup wizard ──
    "setup.os_prompt": "⚙️ <b>Шаг 1/3 — Операционная система</b>\n\nКакая ОС на этой машине?",
    "setup.os_mac": "🍎 macOS",
    "setup.os_linux": "🐧 Linux",
    "setup.mode_prompt": "⚙️ <b>Шаг 2/3 — Режим вывода</b>\n\nКуда Claude должен отправлять ответы?",
    "setup.mode_terminal": "🖥 Terminal — ответы в терминале (ты за маком)",
    "setup.mode_hybrid": "🔀 Hybrid — ответы в терминале, апрувы на телефоне",
    "setup.mode_telegram": "📱 Telegram — всё на телефоне",
    "setup.diff_prompt": "⚙️ <b>Шаг 3/3 — Code diff</b>\n\nКогда Claude редактирует файл — показывать что именно изменилось в статус-сообщении?\n\n<i>Можно включить/выключить в любой момент через /codediff</i>",
    "setup.diff_on": "✅ Да",
    "setup.diff_off": "❌ Нет",
    "setup.tokens_prompt": "⚙️ <b>Шаг 4/4 — Лимит токенов</b>\n\nПри каком количестве токенов сжимать контекст и начинать новую сессию?\n\n<i>Больше = больше контекста, выше стоимость сессии.</i>",
    "setup.tokens_unlimited": "♾️ Без лимита (не ротировать)",
    "setup.done": "✅ <b>Настройка завершена!</b>\n\nПросто начни писать — Claude готов.",
    "setup.cmd": "⚙️ <b>Настройка</b>\n\nПовторная первоначальная настройка.",

    // ── Welcome ──
    "welcome.title": "👋 <b>Добро пожаловать в TG Claude!</b>",
    "welcome.subtitle": "Твой Mac теперь удалённый терминал. Пиши любое сообщение — Claude Code выполнит его с полным доступом к инструментам: команды, файлы, браузер, git.",
    "welcome.sessions": "<b>Сессии:</b> /sessions · /new · /detach",
    "welcome.control": "<b>Управление:</b> /stop · /model · /mode · /git · /undo · /plan",
    "welcome.quick": "<b>Быстрые:</b> /sh · /sys · /clip · /dl · /cron · /screenshot",
    "welcome.attachments": "<b>Также работает:</b> 📎 файлы · 📷 фото · 🎤 голосовые",
    "welcome.modes": "<b>Режимы вывода:</b> <code>terminal</code> · <code>hybrid</code> · <code>telegram</code>\n/mode для переключения. Hybrid = ответы в терминале, апрувы на телефоне.",
    "welcome.tip": "💡 Просто начни писать — команды не нужны.",
    "welcome.lang_set": "🌐 Язык определён автоматически: <b>{lang}</b>. Используй /botlang для смены.",
  },
};
