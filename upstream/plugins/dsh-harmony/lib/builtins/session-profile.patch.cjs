"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const dsh_compat_cjs_1 = require("./dsh-compat.cjs");
const patch = {
    id: 'session-profile-guard',
    description: 'Checks a session-bound Patch profile before its history is loaded.',
    target: (0, dsh_compat_cjs_1.sessionProfileTarget)((0, dsh_compat_cjs_1.activeDshVersion)()),
    select: 'SourceFile',
    expect: 1,
    apply({ sourceFile, edit, query }) {
        const opens = query('MethodDeclaration').filter((node) => {
            const method = node;
            return method.name.getText(sourceFile) === 'open'
                && method.body?.getText(sourceFile).includes('this.doOpen(this.openGeneration)') === true;
        });
        if (opens.length !== 1)
            throw new Error(`expected one Session.open declaration, found ${opens.length}`);
        const calls = query('CallExpression', opens[0]).filter(node => node.getText(sourceFile) === 'this.doOpen(this.openGeneration)');
        if (calls.length !== 1)
            throw new Error(`expected one Session.doOpen call, found ${calls.length}`);
        edit.overwrite(calls[0].getStart(sourceFile), calls[0].getEnd(), `Promise.resolve(
          globalThis.__dshHarmonyBeforeSessionOpen?.(this.sessionId) ?? true
        ).then((allowed) => allowed ? this.doOpen(this.openGeneration) : undefined)`);
    },
};
module.exports = patch;
