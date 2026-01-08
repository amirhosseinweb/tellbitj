const Database = require("better-sqlite3");

function initDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS managers (
      user_id INTEGER PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS nicknames (
      chat_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      display_name TEXT,
      username TEXT,
      nickname TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (chat_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS originals (
      chat_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      display_name TEXT,
      username TEXT,
      type TEXT NOT NULL,
      text TEXT,
      file_id TEXT,
      caption TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (chat_id, user_id)
    );
  `);

  // ---- lightweight migration for existing DBs (adds missing columns) ----
  const ensureColumn = (table, col, type) => {
    const cols = db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((x) => x.name);
    if (!cols.includes(col)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
    }
  };

  ensureColumn("nicknames", "display_name", "TEXT");
  ensureColumn("nicknames", "username", "TEXT");
  ensureColumn("originals", "display_name", "TEXT");
  ensureColumn("originals", "username", "TEXT");

  return db;
}

function DbRepo(db) {
  const now = () => Date.now();

  // Managers
  const isManagerStmt = db.prepare(`SELECT 1 FROM managers WHERE user_id = ?`);
  const addManagerStmt = db.prepare(
    `INSERT OR IGNORE INTO managers(user_id) VALUES (?)`
  );
  const listManagersStmt = db.prepare(
    `SELECT user_id FROM managers ORDER BY user_id ASC`
  );

  // Nicknames
  const upsertNicknameStmt = db.prepare(`
    INSERT INTO nicknames(chat_id, user_id, display_name, username, nickname, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id, user_id)
    DO UPDATE SET
      display_name = excluded.display_name,
      username = excluded.username,
      nickname = excluded.nickname,
      updated_at = excluded.updated_at
  `);

  const getNicknameStmt = db.prepare(
    `SELECT nickname FROM nicknames WHERE chat_id = ? AND user_id = ?`
  );

  const listNicknamesStmt = db.prepare(`
    SELECT user_id, display_name, username, nickname, updated_at
    FROM nicknames
    WHERE chat_id = ?
    ORDER BY updated_at DESC
  `);

  // Originals
  const upsertOriginalStmt = db.prepare(`
    INSERT INTO originals(chat_id, user_id, display_name, username, type, text, file_id, caption, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id, user_id)
    DO UPDATE SET
      display_name = excluded.display_name,
      username = excluded.username,
      type = excluded.type,
      text = excluded.text,
      file_id = excluded.file_id,
      caption = excluded.caption,
      updated_at = excluded.updated_at
  `);

  const getOriginalStmt = db.prepare(`
    SELECT type, text, file_id, caption, updated_at
    FROM originals
    WHERE chat_id = ? AND user_id = ?
  `);

  const listOriginalsStmt = db.prepare(`
    SELECT user_id, display_name, username, type, updated_at
    FROM originals
    WHERE chat_id = ?
    ORDER BY updated_at DESC
  `);

  return {
    isManager(userId) {
      return !!isManagerStmt.get(userId);
    },
    addManager(userId) {
      addManagerStmt.run(userId);
    },

    setNickname(chatId, userId, meta, nickname) {
      upsertNicknameStmt.run(
        chatId,
        userId,
        meta?.display_name || null,
        meta?.username || null,
        nickname,
        now()
      );
    },
    getNickname(chatId, userId) {
      const row = getNicknameStmt.get(chatId, userId);
      return row?.nickname || null;
    },
    listNicknames(chatId) {
      return listNicknamesStmt.all(chatId);
    },

    setOriginal(chatId, userId, meta, payload) {
      const { type, text = null, file_id = null, caption = null } = payload;
      upsertOriginalStmt.run(
        chatId,
        userId,
        meta?.display_name || null,
        meta?.username || null,
        type,
        text,
        file_id,
        caption,
        now()
      );
    },
    getOriginal(chatId, userId) {
      return getOriginalStmt.get(chatId, userId) || null;
    },
    listOriginals(chatId) {
      return listOriginalsStmt.all(chatId);
    },
    listManagers() {
      return listManagersStmt.all();
    },
    // حذف اصل کاربر
    deleteOriginal(chatId, userId) {
      const stmt = db.prepare(
        "DELETE FROM originals WHERE chat_id = ? AND user_id = ?"
      );
      stmt.run(chatId, userId);
    },
    // حذف لقب کاربر
    deleteNickname(chatId, userId) {
      const stmt = db.prepare(
        "DELETE FROM nicknames WHERE chat_id = ? AND user_id = ?"
      );
      stmt.run(chatId, userId);
    },
    // ذخیره اصل کاربر
    upsertOriginal(chatId, userId, originalText) {
      const stmt = db.prepare(`
    INSERT INTO originals (chat_id, user_id, original_text)
    VALUES (?, ?, ?)
    ON CONFLICT(chat_id, user_id)
    DO UPDATE SET original_text = excluded.original_text
  `);
      stmt.run(chatId, userId, originalText);
    },
  };
}

module.exports = { initDb, DbRepo };
