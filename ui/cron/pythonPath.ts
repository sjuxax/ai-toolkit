import path from 'path';
import fs from 'fs';
import { TOOLKIT_ROOT } from './paths';

const isWindows = process.platform === 'win32';

// Shared resolver used by both the cron worker and Next.js API routes
// so the Python interpreter is configured in exactly one place.
export const resolvePythonPath = (): string => {
  const candidates: string[] = [];

  // Explicit override wins over auto-detection; used as-is so a bad path
  // fails loudly instead of silently falling back to another interpreter
  if (process.env.AITK_PYTHON) {
    return process.env.AITK_PYTHON;
  }

  // The venv that was active when the UI was started (covers venvs living
  // outside the repo, e.g. virtualenvwrapper/virtualfish)
  if (process.env.VIRTUAL_ENV) {
    candidates.push(
      isWindows
        ? path.join(process.env.VIRTUAL_ENV, 'Scripts', 'python.exe')
        : path.join(process.env.VIRTUAL_ENV, 'bin', 'python'),
    );
  }

  if (isWindows) {
    candidates.push(path.join(TOOLKIT_ROOT, '.venv', 'Scripts', 'python.exe'));
    candidates.push(path.join(TOOLKIT_ROOT, 'venv', 'Scripts', 'python.exe'));
  } else {
    candidates.push(path.join(TOOLKIT_ROOT, '.venv', 'bin', 'python'));
    candidates.push(path.join(TOOLKIT_ROOT, 'venv', 'bin', 'python'));
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return isWindows ? 'python.exe' : 'python3';
};
