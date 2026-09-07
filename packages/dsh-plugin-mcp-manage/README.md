# @e-mate/dsh-plugin-mcp-manage

Codex-like management plane for external MCP connections. Non-secret definitions use DSH Settings; bearer and OAuth credentials use DSH Credentials; every active connection is mounted through the official `@deepseek-ai/dsh-mcp-client` plugin.

For OAuth MCP servers, the plugin reuses the official MCP TypeScript SDK for protected-resource discovery, dynamic client registration, Authorization Code + PKCE, refresh-token rotation, and the fixed loopback callback. It opens the provider page through the DSH subprocess boundary, so authorization URLs, codes, and tokens never enter Agent arguments or results. Generic installation and removal retain their native user-question interactions. Xin connection goes directly to the real OAuth consent page; its readiness requires a current capability proof from real MCP tools.

The companion `dsh_plugin_manage` tool is a thin model-facing adapter over Desktop's packaged `dsh plugin`/pnpm service. It accepts only `github:owner/repo#<40-character commit>` sources, requires confirmation, checks that the package became a profile bundle, preserves the dependency across managed profile repair, and then requests an orderly Desktop restart. It does not add another plugin loader.

## Xin grant changes and revocation

The existing native Credentials owner stores the OAuth credential and a separate
secret-free `_STATE` journal scoped to the same enterprise tenant/user. It records
authorization-code, refresh, and revocation mutations before submission, plus
local disconnection state. Token responses bind pending changes to the issuer's
opaque `xin_grant` family; successful atomic save and capability verification
settle the matching mutation. Definitive OAuth rejection clears only that request.
Submission with a lost/invalid response remains unknown across restart.

Revocation uses the existing verified discovery and bounded HTTPS transport. It
adds `receipt_version=1`, a fresh `request_id`, and the exact MCP `resource` to
the original form. A complete result requires a v1 `xin-oauth-revocation` receipt
with the matching request, issuer, resource and grant, a 64-hex receipt ID,
`complete:true`, and `status:"revoked"`. Empty HTTP 200/204, old issuer responses,
unprovable historical lineage and incomplete receipts are `unknown`. No credential
is forwarded to another resource, renderer or Agent.

If a new authorization later fails or is cancelled, its grant is revoked before
restoring the previous credential, or its unknown cleanup is durably retained.
A successful old-grant revocation never clears another pending authorization.
Failure to both record and revoke preserves the credential for retry rather than
reporting forgotten. A durable disconnection blocks background restoration even
if an old credential snapshot remains. Only a new explicit connection can reopen
the consent flow; it does not erase unknown prior grants.

The optional `authorization_unknown:true` result field exposes uncertainty without
secrets. Local stopped/forgotten and remote revoked/unknown/not-required remain
separate. Roll out the issuer's lineage migration and all related readers before
claiming production revocation completeness. Keep native Credentials state when
rolling back the application; dropping it would lose unresolved server outcomes.

## Native knowledge Host access

The existing connection also provides `emateXinKnowledge.capture(exec)` to the
trusted knowledge plugin. Capture verifies the current enterprise owner and, for
an Agent request, its original native tool call. The resulting Host-only closure
can continue that knowledge operation across later turns; account changes,
disconnect, disposal and cancellation invalidate it. It only admits the fixed
knowledge/import methods and uses the same ensure, Loader, ToolRuntime and MCP
client. It is not exposed as a renderer RPC or a generic MCP Tool.

Lease-bearing compilation methods and upload-ticket creation are Host-only. Their
native Tool execution has no Agent/parent, so the workflow can retain the private
receipt without writing it into a user Session. Other model-facing MCP calls keep
their existing Agent authorization and Tool Search restrictions. The server still
checks current project read/write permissions on every call.
