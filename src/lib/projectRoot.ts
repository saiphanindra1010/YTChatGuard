import fs from 'fs';
import path from 'path';

/**
 * Resolves the package root whether code runs from emitted `dist/**` or from
 * sources via `tsx` (where `dist/` may not exist).
 */
export function projectRoot(fromDir = __dirname): string {
  let dir = path.resolve(fromDir);
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(fromDir, '..');
}

/** Static assets (`dashboard.html`, `css/`, `js/`). */
export function publicDir(): string {
  return path.join(projectRoot(__dirname), 'src', 'public');
}
