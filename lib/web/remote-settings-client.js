import { installVisionRouterRemoteSettingsBridge } from '../remote-settings-bridge.js'
import { installSettingsRc8ClientLifecycle } from '../settings-client-rc8-lifecycle.js'
import { installDsh017LocalSettingsTransport } from '../dsh-settings-017-compat.js'
import { installSettings017ClientCompatibility } from '../settings-client-017-compat.js'

export function installVisionRemoteSettingsClient(ctx, logger) {
  installVisionRouterRemoteSettingsBridge(ctx, logger)
  installDsh017LocalSettingsTransport(ctx)
  installSettingsRc8ClientLifecycle(ctx)
  installSettings017ClientCompatibility(ctx)
  return ctx
}
