export function terminalLocale(env = process.env, systemLocale = Intl.DateTimeFormat().resolvedOptions().locale) {
    const locale = env.LC_ALL || env.LC_MESSAGES || env.LANG || systemLocale;
    return /^zh(?:[-_]|$)/i.test(locale) ? 'zh' : 'en';
}
export function terminalText(locale, english, chinese) {
    return locale === 'zh' ? chinese : english;
}
