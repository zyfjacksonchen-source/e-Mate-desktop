export type HarmonyLocale = 'en' | 'zh';
export declare function terminalLocale(env?: NodeJS.ProcessEnv, systemLocale?: string): HarmonyLocale;
export declare function terminalText(locale: HarmonyLocale, english: string, chinese: string): string;
