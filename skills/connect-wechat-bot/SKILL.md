---
name: connect-wechat-bot
description: Connect a WeChat bot to e-Mate through the audited on-demand DSH iLink connector and QR pairing. Use when the user asks to connect 微信, 微信 Bot, or receive and answer Agent requests from WeChat while keeping tokens and account credentials outside chat.
---

# Connect WeChat Bot

Use the existing DSH plugin/profile and Session path. Do not request a bot token or create a parallel message bridge.

The connector installation and credential are device-global. A new e-Mate session must reuse an online connector and must not generate another QR unless the provider reports expiry or revocation.

## Workflow

1. Call `dsh_plugin_manage` with `action: "list"`. If `@xmanrui/dsh-im` is active, continue to authorization.
2. Otherwise install the exact audited connector:

   ```json
   {
     "action": "install",
     "packageName": "@xmanrui/dsh-im"
   }
   ```

   Resume after the native application restart.
3. Ask the user to open `设置 → IM 机器人 → 微信` and generate the iLink QR code. Pause only for the user to scan and confirm in WeChat. If WeChat displays a pairing number, ask only for that one-time number through the authorization UI; never place it in chat or persist it.
4. Keep polling the same provisioning attempt until the connector stores the credential in DSH Credentials and reports iLink long polling online. Regenerate expired QR codes and fail closed on an unknown state.
5. The first normal message from the connected WeChat account must enter the existing DSH Workspace/Session and receive the Agent reply before reporting the connection as end to end.
