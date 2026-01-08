function normalizeText(s) {
  if (!s) return "";
  return String(s).replace(/\s+/g, " ").trim();
}

function isGroupChat(chat) {
  return chat && (chat.type === "group" || chat.type === "supergroup");
}

function getUserDisplayName(user) {
  if (!user) return "کاربر";
  const parts = [];
  if (user.first_name) parts.push(user.first_name);
  if (user.last_name) parts.push(user.last_name);
  const full = parts.join(" ").trim();
  return full || user.username || `ID:${user.id}`;
}

function stripPrefix(text, prefix) {
  const t = normalizeText(text);
  if (!t) return null;
  if (t === prefix) return "";
  if (t.startsWith(prefix + " ")) return t.slice(prefix.length + 1).trim();
  return null;
}

function toPersianDigits(str) {
  const map = {
    0: "۰",
    1: "۱",
    2: "۲",
    3: "۳",
    4: "۴",
    5: "۵",
    6: "۶",
    7: "۷",
    8: "۸",
    9: "۹",
  };
  return String(str).replace(/[0-9]/g, (d) => map[d]);
}

function formatNowCalendars(date = new Date()) {
  // Europe/Brussels timezone will be used by Node's locale formatting; but Telegram servers may differ.
  // We format using Intl with explicit timezone to be deterministic.
  const tz = "Asia/Tehran";

  const gregorian = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);

  const persian = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);

  // Hijri (Umm al-Qura)
  const hijri = new Intl.DateTimeFormat("ar-SA-u-ca-islamic-umalqura", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);

  const time = new Intl.DateTimeFormat("fa-IR", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);

  return { persian, hijri, gregorian, time };
}

function guessOriginalTypeLabel(type) {
  const map = {
    text: "پیام متنی",
    photo: "عکس",
    video: "ویدیو",
    voice: "پیام صوتی",
    audio: "صوت",
    document: "فایل",
    animation: "گیف",
    sticker: "استیکر",
    video_note: "ویدیو مسیج",
    unknown: "نامشخص",
  };
  return map[type] || "نامشخص";
}

module.exports = {
  normalizeText,
  isGroupChat,
  getUserDisplayName,
  stripPrefix,
  toPersianDigits,
  formatNowCalendars,
  guessOriginalTypeLabel,
};
