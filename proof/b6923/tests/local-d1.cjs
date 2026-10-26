const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
class LocalD1 {
  constructor(file = ':memory:', migrate = true) { this.sql = new DatabaseSync(file); this.queries = []; if (migrate) { this.sql.exec(fs.readFileSync('db/radar-reliability.sql', 'utf8')); this.sql.exec(fs.readFileSync('db/daily-readiness.sql', 'utf8')); } }
  prepare(query) {
    this.queries.push(query); const db = this; let args = [];
    const statement = {
      bind(...values) { args = values; return statement; },
      async first() { return db.sql.prepare(query).get(...args) ?? null; },
      async all() { return { results: db.sql.prepare(query).all(...args), success: true }; },
      async run() { return statement.execute(); },
      execute() { const result = db.sql.prepare(query).run(...args); return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; },
    }; return statement;
  }
  async batch(statements) { this.sql.exec('BEGIN'); try { const results = statements.map(s => s.execute()); this.sql.exec('COMMIT'); return results; } catch (e) { this.sql.exec('ROLLBACK'); throw e; } }
  count(table) { return Number(this.sql.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n); }
  raw() { return this.sql.prepare('SELECT * FROM radar_entries ORDER BY id').all().map(r => ({ ...r })); }
  close() { this.sql.close(); }
}
module.exports = { LocalD1 };
