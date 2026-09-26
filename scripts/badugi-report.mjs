/**
 * Rewrites a solve's report from its checkpoint, without solving anything.
 *
 *   node --max-old-space-size=24000 scripts/badugi-report.mjs --spot btn-bb
 *        [--label lock3b]
 *
 * The report is a summary, and what a summary should contain changes long after
 * the run that produced it has finished - a new decision worth watching, a
 * weighting that was wrong, a branch nobody thought to ask for. Re-running the
 * solve to get it would cost days.
 *
 * **This never writes a checkpoint.** The solve is read, the report is written,
 * and the gigabytes the run cost are left exactly as they were found.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stateAfter, positionNames } from '../lib/tree.js';
import { BadugiSolver, badugiConfig } from '../lib/badugi-solve.js';
import { buttonOpeningRange, rangeByShare, describeRange } from '../lib/badugi-benchmark.js';
import { badugiTable } from '../lib/badugi.js';
import { openBadugi } from '../lib/badugi-checkpoint.js';
import { walkSpots, buildReport } from '../lib/badugi-report.js';
import { spotNamed, presetFor } from '../lib/badugi-spots.js';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : fallback;
};
const number = (name, fallback) => Number(flag(name, fallback));

const key = flag('spot', 'btn-bb');
const spot = spotNamed(key);
const draws = String(flag('draws', '3,2,2')).split(',').map(Number);
const names = positionNames(6);
const btn = names.indexOf('BTN');

const config = badugiConfig({
  players: 6,
  maxToDraw: null,
  coldCallSeats: null,
  coldCallThreeBets: true,
  maxDraw: draws,
  maxDrawBySeat: null,
  limit: { smallBet: 1, bigBet: 2, bigBetFrom: 2, cap: number('cap', 4) },
  nodeLimit: 40e6,
  ...spot.over,
});

const btnRange = argv.includes('--btn-range')
  ? rangeByShare(number('btn-range'))
  : buttonOpeningRange();

const preset = presetFor(key, btn, btnRange);
const solver = new BadugiSolver({
  config,
  from: stateAfter(config, spot.line),
  seed: number('seed', 21),
  trackEv: false,
  explore: number('explore', 0.02),
  presetRanges: preset,
});

const label = flag('label', null);
const slug = label ? `${key}-${label}` : key;
const head = openBadugi(solver, resolve(here, '..', 'solves', `badugi-${slug}`));
if (!head) throw new Error(`no checkpoint for ${slug}; solve it first`);
if (head.mismatch) throw new Error(`the checkpoint describes a different game (${head.mismatch})`);

const { labels, combos } = badugiTable();
const watched = walkSpots(solver, {
  follow: spot.follow ?? null,
  branches: spot.branches ?? [],
  names,
});
const out = buildReport(solver, {
  key,
  what: spot.what,
  line: spot.line,
  config,
  preset: preset ? { seat: btn, share: btnRange.share } : null,
  labels,
  combos,
  names,
  watched,
  // A checkpoint that is being read rather than written is a finished run as
  // far as anyone reading the report is concerned.
  final: true,
});

const file = resolve(here, '..', 'data', `badugi-${slug}.json`);
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(out));

console.log(`${slug}: ${head.iterations.toLocaleString()} iterations`);
console.log(`  ${out.spots.length} decisions written to data/badugi-${slug}.json\n`);
let branch = undefined;
for (const line of out.spots) {
  if (line.branch !== branch) {
    branch = line.branch;
    console.log(`  ${branch ? `-- ${branch}` : '-- the main line'}`);
  }
  const text = line.actions.map((a, i) => `${a.label} ${line.overall[i].toFixed(1)}%`).join('  ');
  console.log(`  ${line.what.padEnd(22)} ${text}${line.reach ? '' : '   (weighted by the deck)'}`);
}
console.log(preset
  ? `\n  The button was dealt ${btnRange.share.toFixed(1)}%: ${describeRange(btnRange)}.`
  : '\n  No range was preset: both seats were still to act, so both strategies are solved.');
