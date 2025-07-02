const Database = require('better-sqlite3');
const db = new Database('./leveling.db');

// Create XP table
db.prepare(`
CREATE TABLE IF NOT EXISTS xp (
    user_id TEXT PRIMARY KEY,
    guild_id TEXT,
    xp INTEGER DEFAULT 0,
    level INTEGER DEFAULT 0
)

`).run();

module.exports = db;
