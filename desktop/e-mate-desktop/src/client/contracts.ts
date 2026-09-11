/**
 * Desktop-owned slot seats. The frame's native child slots (sidebar, main,
 * rightbar, shell.overlay) are declared by the pinned ui-layout contract and
 * typed by its client entry; this file carries only the e-Mate extension the
 * native table does not have.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Native title-strip utilities, ordered left-to-right beside the panel toggles. */
    'desktop.titlebar.utilities': { kind: 'list'; scope: 'session-maybe'; owner: Record<never, never> }
  }
}
