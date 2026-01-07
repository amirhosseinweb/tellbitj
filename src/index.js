require("dotenv").config();
const { Telegraf } = require("telegraf");
const { initDb, DbRepo } = require("./db");
const {
  normalizeText,
  isGroupChat,
  getUserDisplayName,
  stripPrefix,
  formatNowCalendars,
  guessOriginalTypeLabel
} = require("./utils");

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN در فایل .env تنظیم نشده");
  process.exit(1);
}

const SUPER_ADMIN_ID = Number(process.env.SUPER_ADMIN_ID || "1667208294");
const DB_PATH = process.env.DB_PATH || "./data.sqlite";

const db = initDb(DB_PATH);
const repo = DbRepo(db);

const bot = new Telegraf(BOT_TOKEN, {
  handlerTimeout: 30_000
});

// ----------------- Helpers -----------------
function isSuperAdmin(ctx) {
  return ctx.from && Number(ctx.from.id) === SUPER_ADMIN_ID;
}

function requireManager(ctx) {
  const uid = ctx.from?.id;
  if (!uid) return false;
  if (uid === SUPER_ADMIN_ID) return true;
  return repo.isManager(uid);
}

function escapeMdV2(s) {
    // Escape for Telegram MarkdownV2
    return String(s).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
  }
  
  function mentionUserMdV2(userId, name) {
    const safe = escapeMdV2(name || "کاربر");
    return `[${safe}](tg://user?id=${userId})`;
  }
  

async function isGroupAdmin(ctx, chatId, userId) {
  try {
    const m = await ctx.telegram.getChatMember(chatId, userId);
    return m && (m.status === "administrator" || m.status === "creator");
  } catch {
    return false;
  }
}

function extractTargetFromReply(ctx) {
  const msg = ctx.message || ctx.editedMessage;
  const reply = msg?.reply_to_message;
  const targetUser = reply?.from;
  if (!reply || !targetUser) return null;
  return { reply, targetUser };
}

function getUserMeta(user) {
  const display = getUserDisplayName(user);
  return { display_name: display, username: user?.username || null };
}

function getMessageContentPayload(msg) {
  if (!msg) return { type: "unknown" };

  if (msg.text) {
    return { type: "text", text: msg.text };
  }

  if (msg.photo && msg.photo.length) {
    const best = msg.photo[msg.photo.length - 1];
    return { type: "photo", file_id: best.file_id, caption: msg.caption || null };
  }

  if (msg.video) return { type: "video", file_id: msg.video.file_id, caption: msg.caption || null };
  if (msg.voice) return { type: "voice", file_id: msg.voice.file_id, caption: msg.caption || null };
  if (msg.audio) return { type: "audio", file_id: msg.audio.file_id, caption: msg.caption || null };
  if (msg.document) return { type: "document", file_id: msg.document.file_id, caption: msg.caption || null };
  if (msg.animation) return { type: "animation", file_id: msg.animation.file_id, caption: msg.caption || null };
  if (msg.sticker) return { type: "sticker", file_id: msg.sticker.file_id, caption: null };
  if (msg.video_note) return { type: "video_note", file_id: msg.video_note.file_id, caption: null };

  return { type: "unknown" };
}

async function sendPayload(ctx, chatId, payload, replyToMessageId = null) {
  const extra = {};
  if (replyToMessageId) extra.reply_to_message_id = replyToMessageId;

  switch (payload.type) {
    case "text":
      return ctx.telegram.sendMessage(chatId, payload.text || "", extra);

    case "photo":
      return ctx.telegram.sendPhoto(chatId, payload.file_id, { ...extra, caption: payload.caption || undefined });

    case "video":
      return ctx.telegram.sendVideo(chatId, payload.file_id, { ...extra, caption: payload.caption || undefined });

    case "voice":
      return ctx.telegram.sendVoice(chatId, payload.file_id, { ...extra, caption: payload.caption || undefined });

    case "audio":
      return ctx.telegram.sendAudio(chatId, payload.file_id, { ...extra, caption: payload.caption || undefined });

    case "document":
      return ctx.telegram.sendDocument(chatId, payload.file_id, { ...extra, caption: payload.caption || undefined });

    case "animation":
      return ctx.telegram.sendAnimation(chatId, payload.file_id, { ...extra, caption: payload.caption || undefined });

    case "sticker":
      return ctx.telegram.sendSticker(chatId, payload.file_id, extra);

    case "video_note":
      return ctx.telegram.sendVideoNote(chatId, payload.file_id, extra);

    default:
      return ctx.telegram.sendMessage(chatId, "این نوع پیام قابل ارسال نیست.", extra);
  }
}

async function safeDeleteMessage(ctx, chatId, messageId) {
  try {
    await ctx.telegram.deleteMessage(chatId, messageId);
  } catch {
    // اگر دسترسی نداشت یا پیام قابل حذف نبود، سکوت
  }
}

function isBotCommandText(text) {
  const t = normalizeText(text || "");
  if (!t) return false;

  if (t.startsWith("تنظیم لقب")) return true;
  if (t === "لیست لقب") return true;

  if (t === "ثبت اصل") return true;
  if (t === "اصل") return true;
  if (t === "لیست اصل") return true;

  if (t.startsWith("اکو")) return true;

  if (["سیک", "بن", "ban", "sik"].includes(t.toLowerCase())) return true;

  if (t === "تنظیم مدیر") return true;

  if (t === "ترجمه فارسی" || t === "ترجمه انگلیسی") return true;

  if (t === "امروز" || t === "تقویم") return true;

  return false;
}

// ----------------- Translation (Free, no key) -----------------
async function translateWithMyMemory(text, toLang) {
  const base = "https://api.mymemory.translated.net/get";
  const url = `${base}?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(`auto|${toLang}`)}`;

  const res = await fetch(url, { method: "GET" });
  if (!res.ok) throw new Error("Translate API error");

  const data = await res.json();
  const translated = data?.responseData?.translatedText;
  if (!translated) throw new Error("Translate response invalid");

  return translated;
}

// ----------------- Nickname auto info on replies -----------------
async function handleNicknameAutoInfo(ctx) {
  const msg = ctx.message;
  if (!msg || !msg.reply_to_message) return;

  const text = normalizeText(msg.text || msg.caption || "");
  if (isBotCommandText(text)) return; // ✅ روی دستورها لقب نفرست

  const chatId = msg.chat.id;
  const targetUser = msg.reply_to_message.from;
  if (!targetUser || targetUser.is_bot) return;

  const nick = repo.getNickname(chatId, targetUser.id);
  if (!nick) return;

  await ctx.reply(`لقب کاربر: ${nick} می‌باشد`);
}

// ----------------- Commands -----------------
async function handleSetNickname(ctx, text) {
  if (!requireManager(ctx)) return;

  const msg = ctx.message;
  const chatId = msg.chat.id;

  const target = extractTargetFromReply(ctx);
  if (!target) return ctx.reply("این دستور باید روی پیام کاربر ریپلای شود.");

  const rest = stripPrefix(text, "تنظیم لقب");
  if (rest === null) return;
  if (!rest) return ctx.reply("بعد از «تنظیم لقب» متن لقب را بنویس.");

  const meta = getUserMeta(target.targetUser);
  repo.setNickname(chatId, target.targetUser.id, meta, rest);

  await ctx.reply(`لقب کاربر (${meta.display_name}) به «${rest}» تنظیم شد.`);
}

async function handleListNicknames(ctx) {
  if (!requireManager(ctx)) return;

  const chatId = ctx.message.chat.id;
  const rows = repo.listNicknames(chatId);

  if (!rows.length) return ctx.reply("هیچ لقبی ثبت نشده است.");

  const lines = rows.map((r) => {
    const name = r.display_name || (r.username ? `@${r.username}` : "کاربر");
    return `لقب کاربر "${name}" : "${r.nickname}"`;
  });

  await ctx.reply(lines.join("\n"));
}

async function handleSetOriginal(ctx) {
  if (!requireManager(ctx)) return;

  const msg = ctx.message;
  const chatId = msg.chat.id;

  const target = extractTargetFromReply(ctx);
  if (!target) return ctx.reply("این دستور باید روی پیام کاربر ریپلای شود.");

  const payload = getMessageContentPayload(target.reply);
  if (payload.type === "unknown") return ctx.reply("این نوع پیام برای ثبت اصل پشتیبانی نمی‌شود.");

  const meta = getUserMeta(target.targetUser);
  repo.setOriginal(chatId, target.targetUser.id, meta, payload);

  await ctx.reply(`اصل کاربر (${meta.display_name}) ثبت شد.`);
}

async function handleSendOriginal(ctx) {
  if (!requireManager(ctx)) return;

  const msg = ctx.message;
  const chatId = msg.chat.id;

  const target = extractTargetFromReply(ctx);
  if (!target) return ctx.reply("این دستور باید روی پیام کاربر ریپلای شود.");

  const original = repo.getOriginal(chatId, target.targetUser.id);
  if (!original) return ctx.reply("برای این کاربر «اصل» ثبت نشده است.");

  // ✅ فقط اصل ارسال شود، هیچ پیام لقب اینجا ارسال نمی‌شود (قبلاً هم با فیلتر handleNicknameAutoInfo حل شد)
  await sendPayload(ctx, chatId, original, msg.message_id);
}

async function handleListOriginals(ctx) {
  if (!requireManager(ctx)) return;

  const chatId = ctx.message.chat.id;
  const rows = repo.listOriginals(chatId);

  if (!rows.length) return ctx.reply("هیچ «اصل»ی ثبت نشده است.");

  const lines = rows.map((r) => {
    const name = r.display_name || (r.username ? `@${r.username}` : "کاربر");
    const label = guessOriginalTypeLabel(r.type);
    return `اصل کاربر "${name}" : "${label}"`;
  });

  await ctx.reply(lines.join("\n"));
}

async function handleEchoFromMessage(ctx, msg) {
  if (!requireManager(ctx)) return;

  const chatId = msg.chat.id;
  const replyTo = msg.reply_to_message ? msg.reply_to_message.message_id : null;

  // TEXT
  if (msg.text) {
    const rest = stripPrefix(msg.text, "اکو");
    if (rest === null) return;

    await ctx.telegram.sendMessage(
      chatId,
      rest || "",
      replyTo ? { reply_to_message_id: replyTo } : undefined
    );

    // ✅ حذف پیام اصلی کاربر
    await safeDeleteMessage(ctx, chatId, msg.message_id);
    return;
  }

  // MEDIA with caption
  if (msg.caption) {
    const rest = stripPrefix(msg.caption, "اکو");
    if (rest === null) return;

    const payload = getMessageContentPayload(msg);
    if (payload.type === "unknown" || payload.type === "text") return;

    payload.caption = rest || "";

    await sendPayload(ctx, chatId, payload, replyTo);

    // ✅ حذف پیام اصلی کاربر
    await safeDeleteMessage(ctx, chatId, msg.message_id);
  }
}
async function handleTagManagers(ctx) {
    if (!requireManager(ctx)) return;
  
    const msg = ctx.message;
    const chatId = msg.chat.id;
  
    if (!msg.reply_to_message) {
      return ctx.reply("دستور «تگ» باید روی پیام ریپلای شود.");
    }
  
    const senderId = Number(msg.from?.id);
  
    // مدیران ربات از دیتابیس
    const rows = repo.listManagers(); // [{user_id: ...}, ...]
    const managerIds = new Set(rows.map(r => Number(r.user_id)));
  
    // سوپرادمین هم همیشه جزو مدیرهاست
    managerIds.add(SUPER_ADMIN_ID);
  
    // ✅ کسی که دستور تگ داده تگ نشه
    if (senderId) managerIds.delete(senderId);
  
    // اگر بعد از حذف، کسی برای تگ موند؟
    if (managerIds.size === 0) {
      return ctx.reply("مدیر دیگری برای تگ کردن وجود ندارد.");
    }
  
    // اسم مدیران رو از تلگرام می‌گیریم تا منشن خوشگل باشه
    const mentions = [];
    for (const uid of managerIds) {
      try {
        const m = await ctx.telegram.getChatMember(chatId, uid);
        const user = m?.user;
  
        const name =
          ((user?.first_name || "") + (user?.last_name ? ` ${user.last_name}` : "")).trim();
  
        const display =
          name || (user?.username ? `@${user.username}` : `ID:${uid}`);
  
        mentions.push(mentionUserMdV2(uid, display));
      } catch {
        // اگر نتونست اطلاعات بگیره، با ID منشن کن (باز هم کار می‌کنه)
        mentions.push(mentionUserMdV2(uid, `ID:${uid}`));
      }
    }
  
    const text = mentions.join("  ");
  
    await ctx.telegram.sendMessage(chatId, text, {
      reply_to_message_id: msg.reply_to_message.message_id,
      parse_mode: "MarkdownV2",
      disable_web_page_preview: true
    });
  }
  
async function handleBan(ctx) {
  if (!requireManager(ctx)) return;

  const msg = ctx.message;
  const chatId = msg.chat.id;

  const target = extractTargetFromReply(ctx);
  if (!target) return ctx.reply("این دستور باید روی پیام کاربر ریپلای شود.");

  const targetId = target.targetUser.id;

  // محافظت مدیران ربات و سوپرادمین
  if (targetId === SUPER_ADMIN_ID || repo.isManager(targetId)) {
    return ctx.reply("این کاربر مدیر ربات است و ریموو نمی‌شود.");
  }

  // محافظت ادمین‌های گروه
  const admin = await isGroupAdmin(ctx, chatId, targetId);
  if (admin) return ctx.reply("کاربر ادمین گروه میباشد.");

  try {
    await ctx.telegram.banChatMember(chatId, targetId);
    await ctx.reply("کاربر با موفقیت از گروه حذف شد.");
  } catch {
    await ctx.reply("خطا: بات دسترسی کافی برای حذف کاربر ندارد یا عملیات ممکن نیست.");
  }
}

async function handleSetManager(ctx) {
  if (!isSuperAdmin(ctx)) return;

  const target = extractTargetFromReply(ctx);
  if (!target) return ctx.reply("این دستور باید روی پیام کاربر ریپلای شود.");

  repo.addManager(target.targetUser.id);
  const name = getUserDisplayName(target.targetUser);

  await ctx.reply(`کاربر (${name}) به مدیران ربات اضافه شد.`);
}

async function handleTranslate(ctx, text) {
  if (!requireManager(ctx)) return;

  const target = extractTargetFromReply(ctx);
  if (!target) return ctx.reply("این دستور باید روی پیام موردنظر ریپلای شود.");

  function detectSourceLang(text) {
    // اگر متن شامل حروف فارسی/عربی بود => fa
    // در غیر این صورت => en
    const t = String(text || "");
    const hasFa = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(t);
    return hasFa ? "fa" : "en";
  }
  
  async function translateWithMyMemory(text, toLang) {
    const fromLang = detectSourceLang(text);
  
    // اگر مبدا و مقصد یکی شد، همون متن رو برگردون
    if (fromLang === toLang) return text;
  
    const base = "https://api.mymemory.translated.net/get";
    const langpair = `${fromLang}|${toLang}`;
    const url = `${base}?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(langpair)}`;
  
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) throw new Error("Translate API error");
  
    const data = await res.json();
    const translated = data?.responseData?.translatedText;
    if (!translated) throw new Error("Translate response invalid");
  
    return translated;
  }
  
  const t = normalizeText(text);
  const toFa = t === "ترجمه فارسی";
  const toEn = t === "ترجمه انگلیسی";
  if (!toFa && !toEn) return;

  const sourceText = target.reply.text || target.reply.caption;
  if (!sourceText) return ctx.reply("این پیام متن/کپشن ندارد که ترجمه شود.");

  try {
    const toLang = toFa ? "fa" : "en";
    const translated = await translateWithMyMemory(sourceText, toLang);
    await ctx.reply(translated);
  } catch {
    await ctx.reply("ترجمه انجام نشد (ممکن است API محدودیت داده باشد).");
  }
}

async function handleCalendar(ctx, text) {
  if (!requireManager(ctx)) return;

  const t = normalizeText(text);
  if (t !== "امروز" && t !== "تقویم") return;

  const { persian, hijri, gregorian, time } = formatNowCalendars(new Date());

  const out =
    `شمسی: ${persian}\n` +
    `قمری: ${hijri}\n` +
    `میلادی: ${gregorian}\n` +
    `ساعت: ${time} (Europe/Brussels)`;

  await ctx.reply(out);
}

// ----------------- Main listeners -----------------
bot.on("message", async (ctx) => {
  try {
    const msg = ctx.message;
    if (!msg || !isGroupChat(msg.chat)) return;

    // 1) نمایش خودکار لقب روی ریپلای‌ها (به جز دستورها)
    await handleNicknameAutoInfo(ctx);

    const text = normalizeText(msg.text || msg.caption || "");

    // تنظیم لقب
    if (text.startsWith("تنظیم لقب")) return handleSetNickname(ctx, text);

    // لیست لقب
    if (text === "لیست لقب") return handleListNicknames(ctx);

    // ثبت اصل
    if (text === "ثبت اصل") return handleSetOriginal(ctx);

    // اصل
    if (text === "اصل") return handleSendOriginal(ctx);

    // لیست اصل
    if (text === "لیست اصل") return handleListOriginals(ctx);

    // اکو
    await handleEchoFromMessage(ctx, msg);

    // بن/سیک
    if (["سیک", "بن", "ban", "sik"].includes(text.toLowerCase())) return handleBan(ctx);

    // تنظیم مدیر
    if (text === "تنظیم مدیر") return handleSetManager(ctx);

    // ترجمه
    if (text === "ترجمه فارسی" || text === "ترجمه انگلیسی") return handleTranslate(ctx, text);

    // تقویم/امروز
    if (text === "امروز" || text === "تقویم") return handleCalendar(ctx, text);
    if (text === "تگ") return handleTagManagers(ctx);

  } catch {
    // سکوت برای جلوگیری از اسپم
  }
});

// ✅ اکو روی ادیت کپشن (برای عکس/ویدیو/گیف/…)
bot.on("edited_message", async (ctx) => {
  try {
    const msg = ctx.editedMessage;
    if (!msg || !isGroupChat(msg.chat)) return;

    await handleEchoFromMessage(ctx, msg);
  } catch {
    // ignore
  }
});

// ----------------- Start -----------------
bot.launch()
  .then(() => console.log("✅ Bot is running..."))
  .catch((e) => {
    console.error("❌ Bot failed to start:", e);
    process.exit(1);
  });

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
