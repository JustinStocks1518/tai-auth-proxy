// One-time import of the same public-domain map sources used by BOS Field.
import fs from 'node:fs';
const bos = process.argv[2];
if (!bos) throw new Error('Pass the local BOS repo path');
const svg = fs.readFileSync(bos + '/public/maps/us-albers.svg', 'utf8');
const paths = [...svg.matchAll(/<path\b[^>]*>\s*<title>[^<]+<\/title>\s*<\/path>/g)].map(m => m[0]).join('');
if (paths.length < 50000) throw new Error('Missing state geometry');
const places = fs.readFileSync(bos + '/src/lib/us-places-data.js', 'utf8').match(/export const PLACES = (.*);/)[1];
fs.writeFileSync(new URL('../src/geography.js', import.meta.url), '// Imported from BOS Field: us-atlas 3 state geometry and Census Gazetteer 2024 city centers. Public domain.\nexport const GEOGRAPHY = ' + JSON.stringify(paths) + ';\nexport const PLACES = ' + places + ';\n');
