/** Fetch decodes compressed bodies while retaining the encoded Content-Length header. */
export function decodedContentLength(response: Response): string | null {
  const encoding = response.headers.get('content-encoding')?.trim().toLowerCase()
  return encoding === undefined || encoding === '' || encoding === 'identity'
    ? response.headers.get('content-length') : null
}
