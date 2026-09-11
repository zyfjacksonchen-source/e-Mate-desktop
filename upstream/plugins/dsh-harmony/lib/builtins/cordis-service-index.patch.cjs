"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
function exactlyOne(nodes, description) {
    if (nodes.length !== 1)
        throw new Error(`expected one ${description}, found ${nodes.length}`);
    return nodes[0];
}
const patch = {
    id: 'cordis-service-waiter-index',
    description: 'Skips Fibers in unrelated plugin runtimes while preserving Cordis notification order.',
    target: {
        package: '@deepseek-ai/cordis',
        version: '>=4.0.1',
        file: 'lib/index.js',
    },
    select: 'SourceFile',
    expect: 1,
    apply({ sourceFile, edit, query, ts: typescript }) {
        const reflectClass = exactlyOne(query('VariableDeclaration').filter(node => {
            const declaration = node;
            return typescript.isIdentifier(declaration.name) && declaration.name.text === 'ReflectService'
                && declaration.initializer !== undefined && typescript.isClassExpression(declaration.initializer);
        }).map(node => node.initializer), 'ReflectService class');
        const notify = exactlyOne(query('MethodDeclaration', reflectClass).filter(node => {
            const method = node;
            return method.name.getText(sourceFile) === 'notify';
        }), 'ReflectService.notify method');
        const registryLoop = exactlyOne(query('ForOfStatement', notify).filter(node => {
            const loop = node;
            return loop.expression.getText(sourceFile) === 'this.ctx.registry.values()';
        }), 'Registry scan in ReflectService.notify');
        const fiberLoop = exactlyOne(query('ForOfStatement', registryLoop).filter(node => {
            const loop = node;
            return loop.expression.getText(sourceFile) === 'runtime.fibers';
        }), 'Fiber scan in ReflectService.notify');
        edit.prependLeft(notify.getStart(sourceFile), `_harmonyDependents = new Map();
	_harmonyTrack(fiber) {
		if (fiber.uid === null) return;
		for (const name of Object.keys(fiber.inject)) {
			const runtimes = this._harmonyDependents.get(name) ?? new Map();
			const fibers = runtimes.get(fiber.runtime) ?? new Set();
			fibers.add(fiber);
			runtimes.set(fiber.runtime, fibers);
			this._harmonyDependents.set(name, runtimes);
		}
	}
	_harmonyUntrack(fiber) {
		for (const name of Object.keys(fiber.inject)) {
			const runtimes = this._harmonyDependents.get(name);
			const fibers = runtimes?.get(fiber.runtime);
			fibers?.delete(fiber);
			if (fibers?.size === 0) runtimes.delete(fiber.runtime);
			if (runtimes?.size === 0) this._harmonyDependents.delete(name);
		}
	}
	`);
        edit.overwrite(registryLoop.getStart(sourceFile), fiberLoop.statement.getStart(sourceFile), `const _harmonyRuntimes = new Map();
		for (const name of names) for (const [runtime, fibers] of this._harmonyDependents.get(name) ?? []) {
			const selected = _harmonyRuntimes.get(runtime) ?? new Set();
			for (const fiber of fibers) selected.add(fiber);
			_harmonyRuntimes.set(runtime, selected);
		}
		for (const runtime of this.ctx.registry.values()) {
			const _harmonyFibers = _harmonyRuntimes.get(runtime);
			if (!_harmonyFibers) continue;
			for (const fiber of runtime.fibers) `);
        edit.appendRight(registryLoop.getEnd(), '\n\t\t}');
        edit.prependLeft(fiberLoop.statement.getStart(sourceFile) + 1, '\n\t\t\t\tif (!_harmonyFibers.has(fiber)) continue;');
        const fiberClass = exactlyOne(query('VariableDeclaration').filter(node => {
            const declaration = node;
            return typescript.isIdentifier(declaration.name) && declaration.name.text === 'Fiber'
                && declaration.initializer !== undefined && typescript.isClassExpression(declaration.initializer);
        }).map(node => node.initializer), 'Fiber class');
        const constructor = exactlyOne(query('Constructor', fiberClass), 'Fiber constructor');
        const publication = exactlyOne(query('TryStatement', constructor).filter(node => node.getText(sourceFile).includes('this.context.emit("internal/plugin", this)')), 'Fiber publication');
        edit.appendRight(publication.getEnd(), '\n\t\t\tthis.ctx.reflect._harmonyTrack(this);');
        const uidDisposal = exactlyOne(query('ExpressionStatement', constructor).filter(node => node.getText(sourceFile) === 'this.uid = null;'), 'Fiber uid disposal');
        edit.prependLeft(uidDisposal.getStart(sourceFile), 'this.context.reflect._harmonyUntrack(this);\n\t\t\t\t');
    },
};
module.exports = patch;
