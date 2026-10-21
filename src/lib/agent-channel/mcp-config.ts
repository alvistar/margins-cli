/**
 * mcp-config.ts — linking a session turns the old `channel.mjs` channel off (spec #289
 * D18 #10, PROTOCOL.md D15).
 *
 * Margins Light's `channel.mjs` pushes every new margin comment into the session that
 * loaded it, with an instruction to act on it: a comment acted on without a send. A
 * session linked through `discuss wait` must receive only sends, so the link removes
 * that server from the project's MCP config (`.mcp.json`, nearest the session's
 * directory, as `margins mcp-config` writes it). Every other server stays. The
 * retirement of `channel.mjs` itself stays open (D15); this only keeps the two adapters
 * from running together.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const MCP_CONFIG_BASENAME = '.mcp.json'
/** The name `margins mcp-config` gives the channel. */
const CHANNEL_SERVER_NAME = 'margins_channel'
const CHANNEL_SCRIPT = /(^|[\\/])channel\.mjs$/

export interface ChannelRemoval {
  file: string
  /** The server names removed. */
  removed: string[]
}

function nearestMcpConfig(startDir: string): string | undefined {
  let dir = path.resolve(startDir)
  for (;;) {
    const candidate = path.join(dir, MCP_CONFIG_BASENAME)
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

function isChannelServer(name: string, server: unknown): boolean {
  if (name === CHANNEL_SERVER_NAME) return true
  const args = (server as { args?: unknown } | null)?.args
  return Array.isArray(args) && args.some((a) => typeof a === 'string' && CHANNEL_SCRIPT.test(a))
}

/**
 * Remove every `channel.mjs` server from the nearest `.mcp.json`. Null when there is
 * no config or nothing to remove; the file is then left untouched. Throws when the
 * config cannot be read as JSON, so the caller can say the channel may still be on.
 */
export function removeChannelServer(startDir: string): ChannelRemoval | null {
  const file = nearestMcpConfig(startDir)
  if (!file) return null
  const config = JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers?: Record<string, unknown> } | null
  const servers = config?.mcpServers
  if (!servers || typeof servers !== 'object') return null

  const removed = Object.keys(servers).filter((name) => isChannelServer(name, servers[name]))
  if (removed.length === 0) return null
  for (const name of removed) delete servers[name]
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n')
  return { file, removed }
}
