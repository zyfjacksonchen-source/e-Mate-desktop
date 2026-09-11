---
name: connect-dingtalk
description: Connect an e-Mate Agent to DingTalk by installing the audited on-demand DSH connector and completing DingTalk QR authorization. Use when the user asks to connect 钉钉, create a DingTalk bot, or receive and answer Agent requests from DingTalk without entering Client ID or Client Secret.
---

# Connect DingTalk

Use the existing DSH plugin/profile, Workspace, Session, Credentials, and approval paths. Never ask the user to paste DingTalk credentials into chat.

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
3. Ask the user to open `设置 → IM 机器人 → 钉钉` and generate the one-time QR code. Then pause only for the user to scan with a DingTalk account that belongs to an organization and approve bot creation.
4. Keep the page open while the plugin completes authorization, stores credentials in DSH Credentials, and starts the DingTalk Stream connection. Refresh an expired QR; do not fall back to manual secrets.
5. Require the page to show the Stream connection online. The first normal DingTalk message must enter the existing DSH Session and receive an Agent reply before reporting an end-to-end connection.
