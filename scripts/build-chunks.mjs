// Build the Flow kit's CHUNKS. `XY` — React Flow's framework-independent core (`@xyflow/system`, MIT) and the d3
// modules it drives (ISC; d3-ease BSD-3-Clause), bundled to ONE self-contained ES module.
//
// Why a chunk rather than inlined into the shim: it is ~75 KB minified of third-party code that changes on ITS
// schedule, not the shim's. As a chunk it is content-addressed on its own, so a shim edit re-ships 10 KB, not 85, and
// a browser that already holds this build keeps it across every shim release.
//
// ⚠ ONE FILE, bundled. A single-file chunk is served at its own content address with no directory around it, so a
//   bare specifier (`d3-zoom`) inside it would have nothing to resolve against — bundling is what makes it legal.
import { execFileSync } from 'node:child_process';
import { statSync, writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const kit = join(here, '..');

// The surface the shim uses — and ONLY that, so the chunk carries no code nothing calls. `flow.ts` declares the same
// names structurally (see `XyModule` there); adding one here without adding it there is a type error in the shim.
const entry = join(mkdtempSync(join(tmpdir(), 'osy-flow-')), 'entry.js');
writeFileSync(entry, `export {
  XYPanZoom, XYDrag, XYHandle, XYMinimap,
  adoptUserNodes, updateNodeInternals, updateAbsolutePositions,
  getBezierPath, getSmoothStepPath, getStraightPath, getHandlePosition,
  fitViewport, getNodesBounds, panBy, infiniteExtent, Position, ConnectionMode, PanOnScrollMode,
} from ${JSON.stringify(join(kit, 'node_modules', '@xyflow', 'system', 'dist', 'esm', 'index.js'))};
`);

const version = JSON.parse(readFileSync(join(kit, 'node_modules', '@xyflow', 'system', 'package.json'), 'utf8')).version;
// The licences travel WITH the bytes: MIT and ISC both require the notice to accompany copies, and a chunk is a copy.
const banner = `/*! @xyflow/system ${version} (MIT, (c) 2019-2025 webkid GmbH) + d3-selection/-zoom/-drag/-interpolate/`
  + `-transition/-dispatch/-timer/-color (ISC, (c) 2010-2022 Mike Bostock) + d3-ease (BSD-3-Clause, (c) 2010-2021 `
  + `Mike Bostock, (c) 2001 Robert Penner). Full texts: kits/diagrams/LICENSE. */`;
const out = join(kit, 'xyflow-system.js');
execFileSync(join(kit, 'node_modules', '.bin', 'esbuild'), [
  entry, '--bundle', '--format=esm', '--minify', '--legal-comments=eof', `--outfile=${out}`, `--banner:js=${banner}`,
], { stdio: 'inherit' });

console.log(`XY  ${(statSync(out).size / 1024).toFixed(1)} KB  (xyflow-system.js, @xyflow/system ${version} + d3)`);

// ── chunk `Layout` — the kit's OWN layered layout and edge router (`layout.ts`); no third-party code in it. A SEPARATE
// chunk because a canvas whose nodes already have positions never asks for it: a page that only draws what the app
// stored downloads none of it.
const layoutOut = join(kit, 'layered-layout.js');
execFileSync(join(kit, 'node_modules', '.bin', 'esbuild'), [
  join(kit, 'layout.ts'), '--bundle', '--format=esm', '--minify', '--target=es2022', `--outfile=${layoutOut}`,
  '--banner:js=/*! Osysharp.Diagrams layered layout (MIT). Source: kits/diagrams/layout.ts. */',
], { stdio: 'inherit' });
console.log(`Layout  ${(statSync(layoutOut).size / 1024).toFixed(1)} KB  (layered-layout.js, the kit's own)`);
