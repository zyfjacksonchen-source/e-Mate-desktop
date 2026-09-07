import '@pdf-lib/fontkit'

// Fixed fontkit 1.1.1 implements this non-mutating method (dist/fontkit.es.js).
// Its bundled Path declaration omits it; keep the actual return type here.
declare module '@pdf-lib/fontkit' {
  interface Path { scale(scaleX: number, scaleY?: number): Path }
}
