'use strict';

const { DatabaseSync } = require('node:sqlite');
const { createHash, randomUUID } = require('node:crypto');

const iso = () => new Date().toISOString();
const publicSource = row => ({ id: row.id, name: row.name, kind: row.kind, count: row.count, createdAt: row.created_at });
const initialCounts = () => ({ total: 0, downloaded: 0, skipped: 0, missing: 0, failed: 0 });

class Store {
  constructor(file) {
    this.db = new DatabaseSync(file, { allowExtension: false });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS assets (
        source TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        pid TEXT NOT NULL, kind TEXT NOT NULL, page INTEGER NOT NULL,
        PRIMARY KEY (source, pid, kind, page)
      ) WITHOUT ROWID, STRICT;
      CREATE INDEX IF NOT EXISTS asset_identity ON assets(pid, kind, page);
      CREATE TABLE IF NOT EXISTS download_files (
        pid TEXT NOT NULL, kind TEXT NOT NULL, page INTEGER NOT NULL, relative_path TEXT NOT NULL,
        PRIMARY KEY (pid, kind, page)
      ) WITHOUT ROWID, STRICT;
      CREATE TABLE IF NOT EXISTS artists (
        source TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        uid TEXT NOT NULL, PRIMARY KEY (source, uid)
      ) WITHOUT ROWID, STRICT;
      CREATE TABLE IF NOT EXISTS jobs (
        seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, spec TEXT NOT NULL, status TEXT NOT NULL,
        progress TEXT NOT NULL, message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS job_status ON jobs(status, seq);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    `);
    this.db.prepare("INSERT OR IGNORE INTO sources VALUES ('downloads', 'WebUI 下载记录', 'download', ?)").run(iso());
    this.hasArchiveEntry = this.db.prepare("SELECT 1 FROM assets WHERE pid = ? AND kind = ? AND page = ? AND source <> 'downloads' LIMIT 1");
    this.insertAsset = this.db.prepare('INSERT OR IGNORE INTO assets VALUES (?, ?, ?, ?)');
    this.findFile = this.db.prepare('SELECT relative_path FROM download_files WHERE pid = ? AND kind = ? AND page = ?');
    this.saveFile = this.db.prepare('INSERT OR REPLACE INTO download_files VALUES (?, ?, ?, ?)');
    this.saveProgress = this.db.prepare('UPDATE jobs SET status = ?, progress = ?, message = ?, updated_at = ? WHERE id = ?');
  }

  close() { this.db.close(); }

  setting(key) { return this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null; }

  setSetting(key, value) {
    if (value === null) this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    else this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?, ?)').run(key, value);
  }

  library(canScan) {
    if (!this.libraryCache) {
      const counts = this.db.prepare('SELECT COUNT(*) AS assets, COUNT(DISTINCT pid) AS works FROM (SELECT DISTINCT pid, kind, page FROM assets)').get();
      const sources = this.db.prepare(`
        SELECT sources.*, (SELECT COUNT(*) FROM assets WHERE source = sources.id) AS count
        FROM sources ORDER BY kind = 'download' DESC, created_at DESC, id
      `).all().map(publicSource);
      this.libraryCache = { ...counts, sources };
    }
    return { ...this.libraryCache, canScan };
  }

  artistIds() { return this.db.prepare('SELECT DISTINCT uid FROM artists ORDER BY uid').all().map(row => row.uid); }

  archived(key) { return Boolean(this.hasArchiveEntry.get(...key)); }

  downloaded(key) { return this.findFile.get(...key)?.relative_path; }

  markDownloaded(key, relative) {
    this.saveFile.run(...key, relative);
    if (this.insertAsset.run('downloads', ...key).changes) this.libraryCache = null;
  }

  replaceSource(id, name, kind, manifest) {
    const timestamp = iso();
    const insertArtist = this.db.prepare('INSERT OR IGNORE INTO artists VALUES (?, ?)');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM sources WHERE id = ?').run(id);
      this.db.prepare('INSERT INTO sources VALUES (?, ?, ?, ?)').run(id, name, kind, timestamp);
      for (const asset of manifest.assets) this.insertAsset.run(id, ...asset);
      for (const artist of manifest.artists) insertArtist.run(id, artist);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.libraryCache = null;
    return { id, name, kind, count: manifest.assets.length, createdAt: timestamp };
  }

  importSource(name, manifest) {
    const id = `manifest-${createHash('sha256').update(JSON.stringify(manifest)).digest('hex').slice(0, 32)}`;
    const existing = this.library(false).sources.find(source => source.id === id);
    if (existing) return existing;
    if (this.libraryCache.sources.length >= 64) throw new Error('已达到索引来源上限，请先移除不用的来源。');
    return this.replaceSource(id, name, 'manifest', manifest);
  }

  removeSource(id) {
    if (id === 'downloads') return false;
    const { changes } = this.db.prepare('DELETE FROM sources WHERE id = ?').run(id);
    if (changes) this.libraryCache = null;
    return Boolean(changes);
  }

  serializeJob(row) {
    if (!row) return null;
    return { id: row.id, ...JSON.parse(row.spec), status: row.status, ...JSON.parse(row.progress), message: row.message, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  job(id) { return this.serializeJob(this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id)); }

  jobs() {
    return this.db.prepare("SELECT * FROM jobs ORDER BY status IN ('running', 'queued') DESC, seq DESC LIMIT 100").all().map(row => this.serializeJob(row));
  }

  next() { return this.serializeJob(this.db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY seq LIMIT 1").get()); }

  queueCounts() {
    const row = this.db.prepare("SELECT COUNT(*) FILTER (WHERE status = 'running') AS active, COUNT(*) FILTER (WHERE status = 'queued') AS queued FROM jobs WHERE status IN ('running','queued')").get();
    return { ...row };
  }

  addJob(spec) {
    const id = randomUUID();
    const at = iso();
    this.db.prepare("INSERT INTO jobs (id, spec, status, progress, message, created_at, updated_at) VALUES (?, ?, 'queued', ?, NULL, ?, ?)")
      .run(id, JSON.stringify(spec), JSON.stringify(initialCounts()), at, at);
    this.db.exec("DELETE FROM jobs WHERE status NOT IN ('queued','running') AND seq < (SELECT MAX(seq) - 1000 FROM jobs)");
    return this.job(id);
  }

  updateJob(id, status, counters, message) {
    this.saveProgress.run(status, JSON.stringify(counters), message ?? null, iso(), id);
  }

  recoverJobs() {
    this.db.prepare("UPDATE jobs SET status = 'queued', progress = ?, message = '服务器重启后重新检查，已完成的文件不会重复下载。', updated_at = ? WHERE status = 'running'")
      .run(JSON.stringify(initialCounts()), iso());
  }
}

module.exports = { Store, initialCounts };
