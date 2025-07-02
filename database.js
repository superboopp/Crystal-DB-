const Database = require('better-sqlite3');
const db = new Database('./warnings.db'); // You can rename this to something more general if needed

// Create `warnings` table
db.prepare(`
CREATE TABLE IF NOT EXISTS warnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    date TEXT NOT NULL
)
`).run();

// Create `modlogs` table
db.prepare(`
CREATE TABLE IF NOT EXISTS modlogs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT,
    target_id TEXT,
    moderator_id TEXT,
    action TEXT,
    reason TEXT,
    timestamp INTEGER
)
`).run();

module.exports = db;
