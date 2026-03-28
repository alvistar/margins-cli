import { setGlobalConfig } from '../../lib/config.js'

export function handleSetUrl(url: string): void {
  setGlobalConfig({ serverUrl: url })
}
