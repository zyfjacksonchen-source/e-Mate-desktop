"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DSH_012_RANGE = exports.LEGACY_SHARED_RANGE = exports.LEGACY_CLIENT_RANGE = void 0;
exports.activeDshVersion = activeDshVersion;
exports.sessionProfileTarget = sessionProfileTarget;
const node_fs_1 = require("node:fs");
const node_module_1 = require("node:module");
const node_path_1 = require("node:path");
const node_url_1 = require("node:url");
const semver_1 = __importDefault(require("semver"));
exports.LEGACY_CLIENT_RANGE = '>=0.1.1-rc.2 <0.1.2-0';
exports.LEGACY_SHARED_RANGE = '>=0.1.0-rc.8 <0.1.2-0';
exports.DSH_012_RANGE = '>=0.1.2-alpha.4 <0.1.3-0';
function activeDshVersion() {
    const entry = process.env.DSH_HARMONY_ACTIVE_DSH_ENTRY ?? process.env.DSH_HARMONY_DSH_ENTRY;
    if (entry !== undefined) {
        const manifestPath = (0, node_module_1.findPackageJSON)('@deepseek-ai/dsh', (0, node_url_1.pathToFileURL)((0, node_path_1.resolve)(entry)));
        if (manifestPath === undefined) {
            throw new Error('dsh-harmony: cannot locate the active @deepseek-ai/dsh package');
        }
        return JSON.parse((0, node_fs_1.readFileSync)(manifestPath, 'utf8')).version;
    }
    const require = (0, node_module_1.createRequire)(__filename);
    return require('@deepseek-ai/dsh/package.json').version;
}
function sessionProfileTarget(version) {
    return semver_1.default.gte(version, '0.1.2-0')
        ? {
            package: '@deepseek-ai/dsh-api-session-controller',
            version: exports.DSH_012_RANGE,
            file: 'lib/client.js',
        }
        : {
            package: '@deepseek-ai/dsh-client-runtime',
            version: exports.LEGACY_SHARED_RANGE,
            file: 'lib/client.js',
        };
}
