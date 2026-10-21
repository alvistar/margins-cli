/**
 * store.ts — the agent channel's local SQLite store (PROTOCOL.md D9–D11: CLI SQLite,
 * no secrets).
 *
 * Machine state only: which local sessions linked to which Workspace, which
 * local session holds which send (its id, attempt and lease), and the outbox of
 * actions sent but not yet answered (PROTOCOL.md "Idempotency": the key and the
 * request, so a resend after a lost response is the same request). Never a
 * credential (the agent key lives in the credential store, `agent-key.ts`), never
 * the prompt or anything else a person wrote. It lives beside the global config
 * (`agent-channel.sqlite` in `getConfigDir()`).
 *
 * `node:sqlite` is loaded on open, not at import, so a Node without it fails only
 * this command, with an upgrade hint.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { getConfigDir } from '../config.js'
import { MarginsError } from '../errors.js'

const STORE_BASENAME = 'agent-channel.sqlite'
const BUSY_TIMEOUT_MS = 2_000

export interface LinkedSession {
  sessionId: string
  workspaceId: string
  /** ISO 8601: first `wait` of this session in this Workspace. */
  linkedAt: string
  /** ISO 8601: the latest `wait`. */
  lastWaitAt: string
}

export interface HeldSend {
  sendId: string
  attempt: number
  workspaceId: string
  discussionId: string
  /** The local session that ran the `wait` which received this attempt. */
  sessionId: string
  /** ISO 8601, server clock, as the `send` event gave it. */
  leaseExpiresAt: string
  /** ISO 8601, local clock. */
  receivedAt: string
}

/** One action sent and not yet answered. */
export interface OutboxEntry {
  idempotencyKey: string
  sendId: string
  workspaceId: string
  action: string
  attempt: number
  /** The request body as sent, JSON: a resend must be byte-for-byte the same request. */
  body: string
  /** ISO 8601, local clock. */
  createdAt: string
}

export interface AgentChannelStore {
  linkSession(sessionId: string, workspaceId: string): void
  /** A send's newest attempt replaces the row of an older one. */
  holdSend(send: Omit<HeldSend, 'receivedAt'>): void
  linkedSessions(): LinkedSession[]
  heldSends(): HeldSend[]
  /** The pending entry for this exact request, if one was sent and never answered. */
  pendingAction(sendId: string, action: string, attempt: number, body: string): OutboxEntry | undefined
  queueAction(entry: Omit<OutboxEntry, 'createdAt'>): void
  /** The action was answered: its entry goes. */
  settleAction(idempotencyKey: string): void
  /** The send is closed or superseded: no entry of it can ever land. */
  dropSend(sendId: string): void
  outbox(): OutboxEntry[]
  close(): void
}

export class SqliteUnavailableError extends MarginsError {
  constructor() {
    super(
      `node:sqlite unavailable in Node ${process.version}`,
      `margins discuss wait needs Node 22.13+ (you have ${process.version}). Upgrade Node and retry.`,
      1,
    )
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS linked_sessions (
  session_id   TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  linked_at    TEXT NOT NULL,
  last_wait_at TEXT NOT NULL,
  PRIMARY KEY (session_id, workspace_id)
);
CREATE TABLE IF NOT EXISTS held_sends (
  send_id          TEXT PRIMARY KEY,
  attempt          INTEGER NOT NULL,
  workspace_id     TEXT NOT NULL,
  discussion_id    TEXT NOT NULL,
  session_id       TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  received_at      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
  idempotency_key TEXT PRIMARY KEY,
  send_id         TEXT NOT NULL,
  workspace_id    TEXT NOT NULL,
  action          TEXT NOT NULL,
  attempt         INTEGER NOT NULL,
  body            TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
`

function outboxRow(r: Record<string, unknown>): OutboxEntry {
  return {
    idempotencyKey: String(r['idempotency_key']),
    sendId: String(r['send_id']),
    workspaceId: String(r['workspace_id']),
    action: String(r['action']),
    attempt: Number(r['attempt']),
    body: String(r['body']),
    createdAt: String(r['created_at']),
  }
}
const OUTBOX_COLUMNS = 'idempotency_key, send_id, workspace_id, action, attempt, body, created_at'

export async function openAgentChannelStore(dir: string = getConfigDir()): Promise<AgentChannelStore> {
  let sqlite: typeof import('node:sqlite')
  try {
    sqlite = await import('node:sqlite')
  } catch {
    throw new SqliteUnavailableError()
  }
  fs.mkdirSync(dir, { recursive: true })
  const db: DatabaseSync = new sqlite.DatabaseSync(path.join(dir, STORE_BASENAME))
  // Another `wait` may be writing: wait briefly for its lock rather than fail at once.
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
  db.exec(SCHEMA)

  return {
    linkSession(sessionId, workspaceId) {
      const now = new Date().toISOString()
      db.prepare(
        `INSERT INTO linked_sessions (session_id, workspace_id, linked_at, last_wait_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (session_id, workspace_id) DO UPDATE SET last_wait_at = excluded.last_wait_at`,
      ).run(sessionId, workspaceId, now, now)
    },
    holdSend(send) {
      db.prepare(
        `INSERT INTO held_sends (send_id, attempt, workspace_id, discussion_id, session_id, lease_expires_at, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (send_id) DO UPDATE SET
           attempt = excluded.attempt, workspace_id = excluded.workspace_id,
           discussion_id = excluded.discussion_id, session_id = excluded.session_id,
           lease_expires_at = excluded.lease_expires_at, received_at = excluded.received_at
         WHERE excluded.attempt >= held_sends.attempt`,
      ).run(send.sendId, send.attempt, send.workspaceId, send.discussionId, send.sessionId, send.leaseExpiresAt, new Date().toISOString())
    },
    linkedSessions() {
      return db.prepare(
        'SELECT session_id, workspace_id, linked_at, last_wait_at FROM linked_sessions ORDER BY linked_at, session_id',
      ).all().map((r) => ({
        sessionId: String(r['session_id']),
        workspaceId: String(r['workspace_id']),
        linkedAt: String(r['linked_at']),
        lastWaitAt: String(r['last_wait_at']),
      }))
    },
    heldSends() {
      return db.prepare(
        'SELECT send_id, attempt, workspace_id, discussion_id, session_id, lease_expires_at, received_at FROM held_sends ORDER BY received_at, send_id',
      ).all().map((r) => ({
        sendId: String(r['send_id']),
        attempt: Number(r['attempt']),
        workspaceId: String(r['workspace_id']),
        discussionId: String(r['discussion_id']),
        sessionId: String(r['session_id']),
        leaseExpiresAt: String(r['lease_expires_at']),
        receivedAt: String(r['received_at']),
      }))
    },
    pendingAction(sendId, action, attempt, body) {
      const row = db.prepare(
        `SELECT ${OUTBOX_COLUMNS} FROM outbox WHERE send_id = ? AND action = ? AND attempt = ? AND body = ?
         ORDER BY created_at LIMIT 1`,
      ).get(sendId, action, attempt, body)
      return row ? outboxRow(row) : undefined
    },
    queueAction(entry) {
      db.prepare(`INSERT INTO outbox (${OUTBOX_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        entry.idempotencyKey, entry.sendId, entry.workspaceId, entry.action, entry.attempt, entry.body, new Date().toISOString(),
      )
    },
    settleAction(idempotencyKey) {
      db.prepare('DELETE FROM outbox WHERE idempotency_key = ?').run(idempotencyKey)
    },
    dropSend(sendId) {
      db.prepare('DELETE FROM outbox WHERE send_id = ?').run(sendId)
    },
    outbox() {
      return db.prepare(`SELECT ${OUTBOX_COLUMNS} FROM outbox ORDER BY created_at, idempotency_key`).all().map(outboxRow)
    },
    close() {
      db.close()
    },
  }
}
