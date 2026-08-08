#!/usr/bin/env node
/**
 * 透传给 Hugo，必要时先把它下下来。
 *
 *   npm run hugo -- version
 *   npm run hugo -- server        # 在**当前目录**跑，通常你想要的是 npm run serve
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureHugo } from '../src/hugo-bin.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const { path } = await ensureHugo({
  cacheDir: join(HERE, '..', '.hugo'),
  log: (m) => console.error(m),
});
spawn(path, process.argv.slice(2), { stdio: 'inherit' })
  .on('exit', (code) => process.exit(code ?? 1));
