// Fails unless the tag, package.json, server.json and the MCPB manifest all name one version.
import { readFileSync } from 'node:fs';

const tag = (process.argv[2] ?? '').replace(/^v/, '');
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const versions = {
  tag,
  'package.json': read('package.json').version,
  'server.json': read('server.json').version,
  'server.json package': read('server.json').packages[0].version,
  'packaging/mcpb/manifest.json': read('packaging/mcpb/manifest.json').version,
};
const distinct = new Set(Object.values(versions));
if (distinct.size !== 1) {
  console.error('Versions disagree:', versions);
  process.exit(1);
}
console.log(`All at ${tag}.`);
