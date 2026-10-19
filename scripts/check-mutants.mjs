// Negative controls for the two consequential safety fences. Runs complete
// real-handler suites against temporary source copies, never production I/O.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repo = fileURLToPath(new URL('../', import.meta.url));
const variants = [
  ['cooldown bypass', 'if (record.nextAttempt > now)', 'if (false && record.nextAttempt > now)', 'concurrent visitors share one upstream call and cooldown survives restart'],
  ['unrelated payload leak', 'points: ordered.slice(-MAX_POINTS), latest,', 'points: ordered.slice(-MAX_POINTS), latest, cost: payload.cost,', 'normalization keeps source time, deduplicates, sorts and strips unrelated fields'],
];
for (const [label, before, after, expectedFailure] of variants) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'tai-location-mutant-'));
  try {
    await fs.cp(path.join(repo, 'src'), path.join(temp, 'src'), { recursive: true });
    await fs.cp(path.join(repo, 'test'), path.join(temp, 'test'), { recursive: true });
    await fs.writeFile(path.join(temp, 'package.json'), '{"type":"module"}');
    const modulePath = path.join(temp, 'src', 'map-model.js');
    await fs.writeFile(modulePath, (await fs.readFile(modulePath, 'utf8')).replace("from 'd3-geo'", 'from ' + JSON.stringify(pathToFileURL(path.join(repo, 'node_modules/d3-geo/src/index.js')).href)));
    const target = path.join(temp, 'src', 'locations.js');
    const original = await fs.readFile(target, 'utf8');
    if (original.split(before).length !== 2) throw new Error('Mutation target is ambiguous');
    await fs.writeFile(target, original.replace(before, after));
    const result = spawnSync(process.execPath, ['--test', path.join(temp, 'test', 'locations.test.mjs')], { encoding: 'utf8', timeout: 30_000 });
    const output = result.stdout + result.stderr;
    if (result.status === 0 || !output.includes(expectedFailure) || !output.includes('AssertionError')) throw new Error('Mutant was not killed by the intended assertion: ' + label);
    console.log('Killed: ' + label);
  } finally {
    const resolved = path.resolve(temp), root = path.resolve(os.tmpdir());
    if (path.dirname(resolved) !== root || !path.basename(resolved).startsWith('tai-location-mutant-')) throw new Error('Unsafe temporary cleanup path');
    await fs.rm(resolved, { recursive: true });
  }
}
