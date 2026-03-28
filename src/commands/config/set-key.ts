import { setGlobalConfig } from '../../lib/config.js'

export function handleSetKey(key: string): void {
  setGlobalConfig({ apiKey: key })
}
