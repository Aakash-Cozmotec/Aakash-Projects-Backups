#!/usr/bin/env node

/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║              PostgreSQL Multi-Connection Backup              ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * HOW TO USE:
 *   1. Copy .env.example → .env and define BACKUP_CONN_COUNT + BACKUP_CONN_0_* (see .env.example).
 *   2. Run:  node script.js
 *
 * OUTPUT STRUCTURE:
 *   backup/
 *   └── <CONNECTION_NAME>-DD-MM-YYYY-hh-mm-ssAMPM/
 *       ├── logs/
 *       │   ├── run.log                        ← full run log for this connection
 *       │   ├── <dbName>/
 *       │   │   ├── db.log                     ← log for this database
 *       │   │   └── <schemaName>.log           ← log per schema
 *       ├── <dbName>-DD-MM-YYYY-hh-mm-ssAMPM/
 *       │   └── <schemaName>/
 *       │       └── dump_<schemaName>.dump     ← pg_dump -Fc (restore: pg_restore or DBeaver Restore)
 *
 * REQUIREMENTS:
 *   - Node.js (any modern version, zero npm dependencies)
 *   - pg_dump + psql in PATH
 *       Ubuntu/Debian : sudo apt install postgresql-client
 *       macOS         : brew install libpq && brew link --force libpq
 *       Windows       : install PostgreSQL and add its bin/ folder to PATH
 *   - git in PATH (for the auto-commit at the end)
 */

"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

/** Load project root .env into process.env (KEY=VALUE; # comments; no deps). */
function loadEnvFile() {
  const envPath = path.join(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key) process.env[key] = val;
  }
}

/**
 * Connections live only in .env:
 *   BACKUP_CONN_COUNT=N
 *   BACKUP_CONN_0_CONNECTION_NAME, BACKUP_CONN_0_DB_HOST, BACKUP_CONN_0_DB_PORT (optional, default 5432),
 *   BACKUP_CONN_0_DB_USER, BACKUP_CONN_0_DB_PASSWORD,
 *   BACKUP_CONN_0_DATABASES — comma-separated list, or empty / * for all non-system DBs on server.
 * Repeat for BACKUP_CONN_1_*, etc.
 */
function loadConnectionsFromEnv() {
  const count = parseInt(process.env.BACKUP_CONN_COUNT || "", 10);
  if (!Number.isFinite(count) || count < 1) {
    console.error(
      "  ✖  Set BACKUP_CONN_COUNT in .env (number of connections). See .env.example."
    );
    process.exit(1);
  }

  const list = [];
  for (let i = 0; i < count; i++) {
    const pre = `BACKUP_CONN_${i}_`;
    const CONNECTION_NAME = process.env[`${pre}CONNECTION_NAME`];
    const DB_HOST = process.env[`${pre}DB_HOST`];
    const portRaw = process.env[`${pre}DB_PORT`];
    const DB_USER = process.env[`${pre}DB_USER`];
    const DB_PASSWORD = process.env[`${pre}DB_PASSWORD`];
    const dbsRaw = process.env[`${pre}DATABASES`];

    if (!CONNECTION_NAME || !DB_HOST || !DB_USER) {
      console.error(
        `  ✖  Missing ${pre}CONNECTION_NAME, DB_HOST, or DB_USER in .env`
      );
      process.exit(1);
    }
    if (DB_PASSWORD === undefined) {
      console.error(
        `  ✖  Missing ${pre}DB_PASSWORD in .env (connection: ${CONNECTION_NAME})`
      );
      process.exit(1);
    }

    let DATABASES = null;
    if (dbsRaw != null && String(dbsRaw).trim() !== "" && String(dbsRaw).trim() !== "*") {
      DATABASES = String(dbsRaw)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (DATABASES.length === 0) DATABASES = null;
    }

    const DB_PORT = portRaw != null && String(portRaw).trim() !== ""
      ? parseInt(portRaw, 10)
      : 5432;
    if (!Number.isFinite(DB_PORT)) {
      console.error(`  ✖  Invalid ${pre}DB_PORT`);
      process.exit(1);
    }

    list.push({
      CONNECTION_NAME,
      DB_HOST,
      DB_PORT,
      DB_USER,
      DB_PASSWORD,
      DATABASES,
    });
  }
  return list;
}

loadEnvFile();

const CONNECTIONS = loadConnectionsFromEnv();

// ══════════════════════════════════════════════════════════════════════════════
//  Root folder for all backups
// ══════════════════════════════════════════════════════════════════════════════
const BACKUP_ROOT = path.join(process.cwd(), "backup");

// ══════════════════════════════════════════════════════════════════════════════
//  System databases — always skipped
// ══════════════════════════════════════════════════════════════════════════════
const SYSTEM_DATABASES = new Set(["postgres", "template0", "template1"]);


// ─────────────────────────────────────────────────────────────────────────────
//  Internals — no need to edit below this line
// ─────────────────────────────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
};

function pad(n) { return String(n).padStart(2, "0"); }

/** Local time suffix for folder names: DD-MM-YYYY-hh-mm-ssAMPM (12h, no space before AM/PM). */
function timestamp() {
  const d = new Date();
  let h = d.getHours();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  const datePart = `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
  const timePart = `${pad(h)}-${pad(d.getMinutes())}-${pad(d.getSeconds())}${ampm}`;
  return `${datePart}-${timePart}`;
}

function isoNow() {
  return new Date().toISOString();  // e.g. 2026-03-28T14:30:00.000Z  — used in log files
}

function safeName(str) {
  return String(str).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function mkdirp(dir) { fs.mkdirSync(dir, { recursive: true }); }

// ══════════════════════════════════════════════════════════════════════════════
//  Logger
//  - Prints to console with colours
//  - Simultaneously writes plain text to one or more log files
//  - Every line is timestamped in the log file
// ══════════════════════════════════════════════════════════════════════════════

class Logger {
  /**
   * @param  {...string} logFiles  Absolute paths of log files to write to.
   *                               Multiple files can be passed (e.g. run.log + db.log + schema.log).
   */
  constructor(...logFiles) {
    this.logFiles = logFiles;
  }

  /** Add a log file path to this logger (used when we create sub-loggers) */
  addFile(filePath) {
    if (!this.logFiles.includes(filePath)) this.logFiles.push(filePath);
    return this;
  }

  /** Write a raw line to all attached log files */
  _write(level, text) {
    const line = `[${isoNow()}] [${level.padEnd(5)}] ${text}\n`;
    for (const f of this.logFiles) {
      try { fs.appendFileSync(f, line, "utf8"); } catch (_) { }
    }
  }

  info(msg) {
    console.log(`    ${C.cyan}→${C.reset}  ${msg}`);
    this._write("INFO", msg);
  }

  ok(msg) {
    console.log(`    ${C.green}✔${C.reset}  ${msg}`);
    this._write("OK", msg);
  }

  warn(msg) {
    console.warn(`    ${C.yellow}⚠${C.reset}  ${msg}`);
    this._write("WARN", msg);
  }

  fail(msg) {
    console.error(`    ${C.red}✖${C.reset}  ${msg}`);
    this._write("ERROR", msg);
  }

  /** Plain line — no icon, just a separator or header */
  print(msg) {
    console.log(msg);
    this._write("INFO", msg.replace(/\x1b\[[0-9;]*m/g, ""));  // strip ANSI for log files
  }

  /** Write a section header to the log file (no console output) */
  section(title) {
    const line = `${"─".repeat(60)}`;
    const block = `\n${line}\n  ${title}\n${line}`;
    for (const f of this.logFiles) {
      try { fs.appendFileSync(f, block + "\n", "utf8"); } catch (_) { }
    }
  }
}

// ── Check required tools exist ───────────────────────────────────────────────
function requireTool(name) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [name]);
  if (r.status !== 0) {
    console.error(`  ${C.red}✖${C.reset}  "${name}" not found in PATH.`);
    console.error(`
  Install the PostgreSQL client tools:
    Ubuntu/Debian : sudo apt install postgresql-client
    macOS         : brew install libpq && brew link --force libpq
    Windows       : Add PostgreSQL's bin/ folder to your system PATH
`);
    process.exit(1);
  }
}

/**
 * Run a shell command synchronously.
 * PGPASSWORD injected via env — never visible in process list.
 * Returns stdout. Throws Error with stderr on failure.
 */
function runCmd(cmd, pgPassword) {
  const result = spawnSync(cmd, {
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PGPASSWORD: pgPassword || "" },
  });
  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.toString().trim() : "(no output)";
    throw new Error(stderr);
  }
  return result.stdout ? result.stdout.toString() : "";
}

// ──────────────────────────────────────────────────────────────────────────────
//  Database & schema discovery
// ──────────────────────────────────────────────────────────────────────────────

function listDatabases(conn) {
  const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DATABASES } = conn;
  const firstKnownDb = Array.isArray(DATABASES) && DATABASES.length > 0 ? DATABASES[0] : null;
  const candidates = [...new Set([firstKnownDb, DB_USER, "postgres"].filter(Boolean))];
  const query = "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname;";
  let lastError = null;

  for (const db of candidates) {
    const cmd = `psql -h "${DB_HOST}" -p ${DB_PORT} -U "${DB_USER}" -d "${db}" -t -A -c "${query}"`;
    try {
      const stdout = runCmd(cmd, DB_PASSWORD);
      return stdout.split("\n").map(l => l.trim()).filter(l => l && !SYSTEM_DATABASES.has(l));
    } catch (err) { lastError = err; }
  }
  throw lastError;
}

function listSchemas(dbName, conn) {
  const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD } = conn;
  const query = [
    "SELECT schema_name FROM information_schema.schemata",
    "WHERE schema_name NOT IN ('information_schema','pg_catalog','pg_toast')",
    "AND schema_name NOT LIKE 'pg_temp_%'",
    "AND schema_name NOT LIKE 'pg_toast_temp_%'",
    "ORDER BY schema_name;",
  ].join(" ");

  const cmd = `psql -h "${DB_HOST}" -p ${DB_PORT} -U "${DB_USER}" -d "${dbName}" -t -A -c "${query}"`;
  const stdout = runCmd(cmd, DB_PASSWORD);
  return stdout.split("\n").map(l => l.trim()).filter(Boolean);
}

// ──────────────────────────────────────────────────────────────────────────────
//  Schema backup
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Back up one schema.
 * @param {Logger} logger  Receives run.log + db.log + schema.log
 */
function backupSchema(dbName, schemaName, conn, dbFolder, runLogFile, dbLogFile) {
  const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD } = conn;

  // ── Create schema folder & its dedicated log file ──────────────────────────
  const schemaFolder = path.join(dbFolder, safeName(schemaName));
  mkdirp(schemaFolder);

  const schemaLogFile = path.join(dbFolder, "..", "logs", safeName(dbName), `${safeName(schemaName)}.log`);
  mkdirp(path.dirname(schemaLogFile));

  // Logger writes to: run.log + db.log + schema.log simultaneously
  const logger = new Logger(runLogFile, dbLogFile, schemaLogFile);

  logger.section(`Schema: ${dbName} / ${schemaName}`);
  logger.info(`Started  :  ${isoNow()}`);
  logger.info(`DB       :  ${dbName}`);
  logger.info(`Schema   :  ${schemaName}`);
  logger.info(`Folder   :  ${schemaFolder}`);

  const baseFlags = [
    `-h "${DB_HOST}"`,
    `-p ${DB_PORT}`,
    `-U "${DB_USER}"`,
    `-d "${dbName}"`,
    `-n "${schemaName}"`,
    `--no-owner`,
    `--no-acl`,
  ].join(" ");

  // ── Custom format (same idea as: pg_dump … -n schema -Fc -f dump_schema.dump) ──
  const dumpFile = path.join(schemaFolder, `dump_${safeName(schemaName)}.dump`);
  logger.info(`pg_dump -Fc  →  ${dumpFile}`);
  try {
    runCmd(`pg_dump ${baseFlags} -Fc -f "${dumpFile}"`, DB_PASSWORD);
    const size = fs.statSync(dumpFile).size;
    logger.ok(`Custom dump complete  |  size: ${(size / 1024).toFixed(1)} KB  |  file: ${dumpFile}`);
  } catch (err) {
    logger.fail(`pg_dump -Fc FAILED: ${err.message}`);
    logger.info(`Finished :  ${isoNow()}  |  status: FAILED`);
    return false;
  }

  logger.info(`Finished :  ${isoNow()}  |  status: OK`);
  return true;
}

// ──────────────────────────────────────────────────────────────────────────────
//  Database backup
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Back up all schemas of one database.
 */
function backupDatabase(dbName, conn, connFolder, runLogFile) {
  const ts = timestamp();
  const dbFolder = path.join(connFolder, `${safeName(dbName)}-${ts}`);
  mkdirp(dbFolder);

  // ── Per-database log file ──────────────────────────────────────────────────
  const dbLogDir = path.join(connFolder, "logs", safeName(dbName));
  mkdirp(dbLogDir);
  const dbLogFile = path.join(dbLogDir, "db.log");

  const logger = new Logger(runLogFile, dbLogFile);

  logger.section(`Database: ${dbName}`);
  logger.info(`Started   :  ${isoNow()}`);
  logger.info(`Database  :  ${dbName}`);
  logger.info(`Folder    :  ${dbFolder}`);

  // ── Discover schemas ───────────────────────────────────────────────────────
  let schemas;
  try {
    schemas = listSchemas(dbName, conn);
  } catch (err) {
    logger.fail(`Cannot list schemas: ${err.message}`);
    logger.info(`Finished  :  ${isoNow()}  |  status: FAILED`);
    return false;
  }

  if (schemas.length === 0) {
    logger.warn(`No user schemas found — skipping.`);
    logger.info(`Finished  :  ${isoNow()}  |  status: SKIPPED`);
    return true;
  }

  logger.info(`Schemas found (${schemas.length}): ${schemas.join(", ")}`);

  // ── Back up each schema ────────────────────────────────────────────────────
  const results = schemas.map((schemaName) => {
    console.log();
    console.log(`      ${C.bold}${dbName}  /  ${schemaName}${C.reset}`);
    return backupSchema(dbName, schemaName, conn, dbFolder, runLogFile, dbLogFile);
  });

  const passed = results.filter(Boolean).length;
  const allOk = passed === schemas.length;

  logger.info(`Schemas backed up: ${passed} / ${schemas.length}`);
  logger.info(`Finished  :  ${isoNow()}  |  status: ${allOk ? "OK" : "PARTIAL"}`);

  console.log();
  console.log(
    `    ${allOk ? C.green + "✔" : C.yellow + "⚠"}${C.reset}  ${C.bold}${dbName}${C.reset}  —  ${passed}/${schemas.length} schemas  ${C.dim}→ ${dbFolder}${C.reset}`
  );

  return allOk;
}

// ──────────────────────────────────────────────────────────────────────────────
//  Connection backup
// ──────────────────────────────────────────────────────────────────────────────

function backupConnection(conn, index, total) {
  const { CONNECTION_NAME, DB_HOST, DB_PORT, DB_USER } = conn;
  const DLINE = "═".repeat(60);
  const LINE = "─".repeat(60);

  // ── Create connection folder + logs folder ─────────────────────────────────
  const ts = timestamp();
  const connFolder = path.join(BACKUP_ROOT, `${safeName(CONNECTION_NAME)}-${ts}`);
  const logsFolder = path.join(connFolder, "logs");
  mkdirp(logsFolder);

  // run.log = master log for the entire connection run
  const runLogFile = path.join(logsFolder, "run.log");

  const logger = new Logger(runLogFile);

  // ── Console header ─────────────────────────────────────────────────────────
  console.log(LINE);
  console.log(`${C.bold}  [${index + 1} / ${total}]  ${CONNECTION_NAME}${C.reset}`);
  console.log(`  ${C.dim}Host : ${DB_HOST}:${DB_PORT}   User : ${DB_USER}${C.reset}`);
  console.log();

  // ── Log file header ────────────────────────────────────────────────────────
  logger.section(`Connection: ${CONNECTION_NAME}`);
  logger.info(`Run started    :  ${isoNow()}`);
  logger.info(`Connection     :  ${CONNECTION_NAME}`);
  logger.info(`Host           :  ${DB_HOST}:${DB_PORT}`);
  logger.info(`User           :  ${DB_USER}`);
  logger.info(`Backup folder  :  ${connFolder}`);
  logger.info(`Log file       :  ${runLogFile}`);

  // ── Validate required fields ───────────────────────────────────────────────
  const required = ["CONNECTION_NAME", "DB_HOST", "DB_PORT", "DB_USER"];
  const missing = required.filter((k) => !conn[k] && conn[k] !== 0);
  if (missing.length) {
    logger.fail(`Missing required fields: ${missing.join(", ")}`);
    logger.info(`Run finished   :  ${isoNow()}  |  status: FAILED`);
    return { success: false, databases: [], connFolder };
  }

  // ── Discover databases ─────────────────────────────────────────────────────
  let databases;
  try {
    databases = listDatabases(conn);
    logger.info(`Databases on server (${databases.length}): ${databases.join(", ")}`);
  } catch (err) {
    logger.fail(`Cannot connect to server: ${err.message}`);
    logger.info(`Run finished   :  ${isoNow()}  |  status: FAILED`);
    return { success: false, databases: [], connFolder };
  }

  if (databases.length === 0) {
    logger.fail("No user databases found on this server.");
    logger.info(`Run finished   :  ${isoNow()}  |  status: FAILED`);
    return { success: false, databases: [], connFolder };
  }

  // ── Apply DATABASES filter ─────────────────────────────────────────────────
  const filter = Array.isArray(conn.DATABASES) && conn.DATABASES.length > 0 ? conn.DATABASES : null;

  if (filter) {
    const unknown = filter.filter((n) => !databases.includes(n));
    if (unknown.length) {
      logger.warn(`Databases in DATABASES[] not found on server: ${unknown.join(", ")}`);
    }
    databases = databases.filter((n) => filter.includes(n));
    if (databases.length === 0) {
      logger.fail("None of the specified DATABASES[] were found on the server.");
      logger.info(`Run finished   :  ${isoNow()}  |  status: FAILED`);
      return { success: false, databases: [], connFolder };
    }
    logger.info(`Filtered to (${databases.length}): ${databases.join(", ")}`);
    console.log(`  ${C.blue}ℹ${C.reset}  Backing up ${databases.length} database(s): ${C.dim}${databases.join(", ")}${C.reset}\n`);
  } else {
    logger.info(`No filter — backing up all ${databases.length} database(s)`);
    console.log(`  ${C.blue}ℹ${C.reset}  Found ${databases.length} database(s): ${C.dim}${databases.join(", ")}${C.reset}\n`);
  }

  // ── Back up each database ──────────────────────────────────────────────────
  const dbResults = [];
  for (const dbName of databases) {
    console.log(`\n  ${C.bold}${C.blue}▶  ${dbName}${C.reset}`);
    logger.info(`--- Starting database: ${dbName}`);
    const ok = backupDatabase(dbName, conn, connFolder, runLogFile);
    dbResults.push({ dbName, ok });
    logger.info(`--- Finished database: ${dbName}  |  status: ${ok ? "OK" : "FAILED/PARTIAL"}`);
  }

  const allOk = dbResults.every((r) => r.ok);
  logger.info(`Databases backed up: ${dbResults.filter(r => r.ok).length} / ${dbResults.length}`);
  logger.info(`Run finished   :  ${isoNow()}  |  status: ${allOk ? "OK" : "PARTIAL/FAILED"}`);

  return { success: allOk, databases: dbResults, connFolder };
}

// ──────────────────────────────────────────────────────────────────────────────
//  Git push
// ──────────────────────────────────────────────────────────────────────────────

function gitPush() {
  const DLINE = "═".repeat(60);
  const LINE = "─".repeat(60);

  console.log(`\n${DLINE}`);
  console.log(`${C.bold}  GIT — committing & pushing backup${C.reset}`);
  console.log(LINE);

  const commands = [
    { label: "git add .", cmd: "git add ." },
    { label: "git commit", cmd: `git commit -m "backup: ${isoNow()} — refer to logs folder"` },
    { label: "git push origin master", cmd: "git push origin master" },
  ];

  for (const { label, cmd } of commands) {
    console.log(`  ${C.cyan}→${C.reset}  ${label}`);
    const result = spawnSync(cmd, {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      cwd: process.cwd(),
    });

    const stdout = result.stdout ? result.stdout.toString().trim() : "";
    const stderr = result.stderr ? result.stderr.toString().trim() : "";

    if (result.status === 0) {
      if (stdout) console.log(`     ${C.dim}${stdout}${C.reset}`);
      console.log(`  ${C.green}✔${C.reset}  ${label}  done`);
    } else {
      // "nothing to commit" is not a real error — git exits 1 for it
      if (stderr.includes("nothing to commit") || stdout.includes("nothing to commit")) {
        console.log(`  ${C.yellow}⚠${C.reset}  Nothing new to commit — working tree clean`);
      } else {
        console.error(`  ${C.red}✖${C.reset}  ${label} failed:`);
        if (stderr) console.error(`     ${C.dim}${stderr}${C.reset}`);
        if (stdout) console.error(`     ${C.dim}${stdout}${C.reset}`);
        console.error(`\n  ${C.yellow}Tip:${C.reset} Make sure this folder is a git repo (git init) and`);
        console.error(`       the remote "origin" is set (git remote add origin <url>)\n`);
        return false;
      }
    }
  }

  console.log(`${DLINE}\n`);
  return true;
}

// ──────────────────────────────────────────────────────────────────────────────
//  Main
// ──────────────────────────────────────────────────────────────────────────────

function main() {
  const DLINE = "═".repeat(60);
  const LINE = "─".repeat(60);

  console.log(`\n${C.bold}${DLINE}`);
  console.log(`     PostgreSQL Multi-Connection Backup`);
  console.log(`     Schema-level  |  pg_dump -Fc  |  Full Audit Logs`);
  console.log(`${DLINE}${C.reset}\n`);

  if (!Array.isArray(CONNECTIONS) || CONNECTIONS.length === 0) {
    console.error(`  ${C.red}✖${C.reset}  CONNECTIONS array is empty.`);
    process.exit(1);
  }

  requireTool("psql");
  requireTool("pg_dump");
  mkdirp(BACKUP_ROOT);

  const results = [];

  for (let i = 0; i < CONNECTIONS.length; i++) {
    const result = backupConnection(CONNECTIONS[i], i, CONNECTIONS.length);
    results.push({ label: CONNECTIONS[i].CONNECTION_NAME, ...result });
    console.log();
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${DLINE}`);
  console.log(`${C.bold}  SUMMARY${C.reset}`);
  console.log(LINE);

  let allOk = true;
  for (const r of results) {
    const icon = r.success ? `${C.green}✔` : `${C.red}✖`;
    console.log(`  ${icon}${C.reset}  ${C.bold}${r.label}${C.reset}`);
    for (const db of r.databases || []) {
      const dbIcon = db.ok ? `${C.green}✔` : `${C.red}✖`;
      console.log(`       ${dbIcon}${C.reset}  ${db.dbName}`);
    }
    if (r.connFolder) {
      console.log(`       ${C.dim}Backup : ${r.connFolder}${C.reset}`);
      console.log(`       ${C.dim}Logs   : ${path.join(r.connFolder, "logs")}${C.reset}`);
    }
    if (!r.success) allOk = false;
  }

  console.log(`${DLINE}\n`);

  // ── Git commit & push ──────────────────────────────────────────────────────
  gitPush();

  process.exit(allOk ? 0 : 1);
}

main();