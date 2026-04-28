import { cp, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_CONTEXT_PATH_PLACEHOLDER = '/__BUN_ADAPTER_CONTEXT_PATH__';

// Re-exported alias for package consumers who want to reference the default.
export const CONTEXT_PATH_PLACEHOLDER = DEFAULT_CONTEXT_PATH_PLACEHOLDER;

export function resolveContextPathPlaceholder(
  option: string | false | undefined
): string | false {
  if (option === false) return false;
  return option ?? DEFAULT_CONTEXT_PATH_PLACEHOLDER;
}

export function generateStartScript(placeholder: string): string {
  const escapedPlaceholder = JSON.stringify(placeholder);
  return `import { cp } from 'node:fs/promises';
import path from 'node:path';

const scriptDir = import.meta.dirname;
const projectDir = path.join(scriptDir, '..');
const templateDir = path.join(scriptDir, 'template');
const liveDir = path.join(scriptDir, 'live');
const nextTemplateDir = path.join(projectDir, '.next-template');
const nextDir = path.join(projectDir, '.next');
const PLACEHOLDER = ${escapedPlaceholder};

const raw = (process.env.CONTEXT_PATH ?? '').replace(/\\/+$/, '');

if (raw !== '' && !raw.startsWith('/')) {
  console.error(\`[adapter-bun] Invalid CONTEXT_PATH: "\${raw}". Must be empty or start with "/".\`);
  process.exit(1);
}

await cp(nextTemplateDir, nextDir, { recursive: true, force: true });
await cp(templateDir, liveDir, { recursive: true, force: true });

for (const dir of [liveDir, nextDir]) {
  for (const pattern of ['**/*.js', '**/*.json', '**/*.html']) {
    const glob = new Bun.Glob(pattern);
    for await (const relPath of glob.scan({ cwd: dir })) {
      const filePath = path.join(dir, relPath);
      const text = await Bun.file(filePath).text();
      if (!text.includes(PLACEHOLDER)) continue;
      await Bun.write(filePath, text.replaceAll(PLACEHOLDER, raw));
    }
  }
}

await Bun.write(path.join(liveDir, '.context-path'), raw);
await import('./live/server.js');
`;
}

async function copyIfExists(src: string, dest: string): Promise<void> {
  const srcStat = await stat(src).catch(() => null);
  if (!srcStat) return;
  await cp(src, dest, { recursive: true, force: true });
}

export async function stageTemplateDir(outDir: string): Promise<void> {
  const templateDir = path.join(outDir, 'template');
  await mkdir(templateDir, { recursive: true });

  for (const item of [
    'static',
    'runtime',
    'cache.db',
    'deployment-manifest.json',
    'runtime-next-config.json',
    'server.js',
  ]) {
    await copyIfExists(path.join(outDir, item), path.join(templateDir, item));
  }
}

export async function stageNextTemplate(
  projectDir: string,
  distDir: string
): Promise<void> {
  const resolvedDistDir = path.isAbsolute(distDir)
    ? distDir
    : path.join(projectDir, distDir);
  const dest = path.join(projectDir, '.next-template');
  await cp(resolvedDistDir, dest, { recursive: true, force: true });
}

async function appendMissingLines(filePath: string, lines: string[]): Promise<void> {
  const existing = await stat(filePath).catch(() => null);
  if (!existing) return;
  const content = await Bun.file(filePath).text();
  const currentLines = new Set(content.split('\n').map((l) => l.trim()));
  const toAdd = lines.filter((l) => !currentLines.has(l));
  if (toAdd.length === 0) return;
  const suffix = content.endsWith('\n') ? '' : '\n';
  await Bun.write(filePath, content + suffix + toAdd.join('\n') + '\n');
}

export async function appendToIgnoreFiles(projectDir: string): Promise<void> {
  await appendMissingLines(path.join(projectDir, '.gitignore'), [
    '.next-template/',
    'bun-dist/live/',
  ]);
  await appendMissingLines(path.join(projectDir, '.dockerignore'), [
    'bun-dist/live/',
  ]);
}
