/**
 * store.ts — the agent channel's local SQLite store (PROTOCOL.md D9–D11: CLI SQLite,
 * no secrets).
 *
 * Machine state only: which local sessions linked to which Workspace, and which
 * local session holds which send (its id, attempt and lease). Never a credential,
 * never the prompt or anything else a person wrote. It lives beside the global
 * config (`agent-channel.sqlite` in `getConfigDir()`).
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

export interface AgentChannelStore {
  linkSession(sessionId: string, workspaceId: string): void
  /** A send's newest attempt replaces the row of an older one. */
  holdSend(send: Omit<HeldSend, 'receivedAt'>): void
  linkedSessions(): LinkedSession[]
  heldSends(): HeldSend[]
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
`

export async function openAgentChannelStore(dir: string = getConfigDir()): Promise<AgentChannelStore> {
  let sqlite: typeof import('node:sqlite')
  try {
    sqlite = await import('node:sqlite')
  } catch {
    throw new SqliteUnavailableError()
  }
  fs.mkdirSync(dir, { recursive: true })
  const db: DatabaseSync = new sqlite.DatabaseSync(path.join(dir, STORE_BASENAME))
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
    close() {
      db.close()
    },
  }
}
