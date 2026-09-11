/** Renderer-session authentication against the browser-authenticated Web root. */

/** Final response surface of one session Fetch, after redirects. */
export interface RendererAuthResponse {
  /** HTTP status of the response that ended the redirect chain. */
  readonly status: number
  /** Cancelled without being read once the exchange succeeded. */
  readonly body?: { cancel(): Promise<void> } | null
}

/**
 * The cookie-jar Fetch of one renderer session. Electron's `Session.fetch`
 * runs on Chromium's network stack, so a redirect it follows stores the
 * response cookie in the same jar the renderer's later requests read.
 */
export interface RendererSessionAuth {
  /**
   * Request one URL with this session's cookies.
   * @param input - absolute URL to request.
   * @param init - redirect-following GET options accepted by the session Fetch.
   * @returns the response that ended the redirect chain.
   */
  fetch(input: string, init: {
    method: 'GET'
    credentials: 'include'
    redirect: 'follow'
    cache: 'no-store'
  }): Promise<RendererAuthResponse>
}

/**
 * Exchange the Host process token inside the renderer's own session before its
 * marker-bearing Web root is loaded. The token URL answers with the redirect
 * that mints the browser-session cookie; keeping the exchange separate
 * preserves the Desktop query markers across that redirect and keeps the
 * launch token out of renderer history.
 * @param session - the BrowserWindow session that will load the Web root.
 * @param authenticationUrl - process-token URL from the Connection owner.
 */
export async function authenticateRendererSession(
  session: RendererSessionAuth,
  authenticationUrl: string,
): Promise<void> {
  const response = await session.fetch(authenticationUrl, {
    method: 'GET',
    credentials: 'include',
    redirect: 'follow',
    cache: 'no-store',
  })
  if (response.status !== 200) {
    throw new Error(`@e-mate/desktop: browser authentication failed with HTTP ${String(response.status)}`)
  }
  await response.body?.cancel()
}
