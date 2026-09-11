import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import z from '@deepseek-ai/schemastery';
const Config = z.object({});
export const inject = ['settings'];
export function apply(ctx) {
    ctx.settings.register(settingsNamespace('dsh-harmony'), Config, { applies: 'restart' });
}
