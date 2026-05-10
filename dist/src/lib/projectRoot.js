"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.projectRoot = projectRoot;
exports.publicDir = publicDir;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
/**
 * Resolves the package root whether code runs from emitted `dist/**` or from
 * sources via `tsx` (where `dist/` may not exist).
 */
function projectRoot(fromDir = __dirname) {
    let dir = path_1.default.resolve(fromDir);
    for (let i = 0; i < 12; i++) {
        if (fs_1.default.existsSync(path_1.default.join(dir, 'package.json')))
            return dir;
        const parent = path_1.default.dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return path_1.default.resolve(fromDir, '..');
}
/** Static assets (`dashboard.html`, `css/`, `js/`). */
function publicDir() {
    return path_1.default.join(projectRoot(__dirname), 'src', 'public');
}
//# sourceMappingURL=projectRoot.js.map