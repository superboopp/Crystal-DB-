const Database = require('better-sqlite3');
const db = new Database('./mutes.db');

// Add this to your database initialization
db.prepare(`
CREATE TABLE IF NOT EXISTS mutes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    reason TEXT,
    muted_by TEXT NOT NULL,
    mute_start INTEGER NOT NULL,
    mute_end INTEGER NOT NULL,
    active INTEGER DEFAULT 1
)`).run();

db.prepare(`
CREATE INDEX IF NOT EXISTS idx_active_mutes
ON mutes (user_id, guild_id, active)
`).run();

module.exports = db;
