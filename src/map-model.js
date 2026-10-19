import { geoAlbersUsa } from 'd3-geo';
import { PLACES } from './geography.js';
import { coordinate, sourceTime } from './locations.js';

const projection = geoAlbersUsa().scale(1300).translate([487.5, 305]);
const norm = v => String(v || '').toLowerCase().replace(/[.']/g, '').replace(/\s+/g, ' ').trim();
const places = new Map();
function cityPoint(city, state) {
  const st = String(state || '').trim().toUpperCase();
  if (!places.has(st)) places.set(st, new Map((PLACES[st] || '').split(';').map(record => {
    const [name, lat, lng] = record.split(','); return [name, { latitude: Number(lat), longitude: Number(lng) }];
  })));
  return places.get(st).get(norm(city)) || null;
}
export function projected(point) {
  if (!coordinate(point?.latitude, point?.longitude)) return { ...point, xy: null };
  const xy = projection([point.longitude, point.latitude]);
  return { ...point, xy: xy?.map(n => Math.round(n * 100) / 100) || null };
}
export function fallbackLocation(row) {
  const coords = coordinate(row.latitude, row.longitude);
  const reportedAt = sourceTime(row.last_location_update);
  return row.location_string || coords ? projected({ location: row.location_string || '', reportedAt, ...(coords || {}) }) : null;
}
export function mapStops(row) {
  // No address geocoding, no inferred GPS. City centers provide context only.
  return [['pickup', row.origin_city, row.origin_state], ['destination', row.dest_city, row.dest_state]].map(([kind, city, state]) => {
    const coords = cityPoint(city, state);
    return projected({ kind, location: [city, state].filter(Boolean).join(', '), approximate: true, ...(coords || {}) });
  });
}
export function mapHistory(history) {
  return history ? { ...history, points: history.points.map(projected), latest: history.latest ? projected(history.latest) : null, untimed: history.untimed ? projected(history.untimed) : null } : null;
}
// Orientation labels, never alleged shipment stops. Every coordinate comes from
// the same Census city data, selected only when it lies in the fitted map area.
export const CITIES = [
  ['Chicago', 'IL'], ['Indianapolis', 'IN'], ['Louisville', 'KY'], ['Nashville-Davidson metropolitan government', 'TN'],
  ['Atlanta', 'GA'], ['Charlotte', 'NC'], ['Memphis', 'TN'], ['Columbus', 'OH'], ['Cincinnati', 'OH'],
  ['Detroit', 'MI'], ['Milwaukee', 'WI'], ['St Louis', 'MO'], ['Kansas City', 'MO'], ['Dallas', 'TX'],
  ['Houston', 'TX'], ['Denver', 'CO'], ['Phoenix', 'AZ'], ['Los Angeles', 'CA'], ['San Francisco', 'CA'],
  ['Seattle', 'WA'], ['Portland', 'OR'], ['Minneapolis', 'MN'], ['Omaha', 'NE'], ['New York', 'NY'],
  ['Boston', 'MA'], ['Philadelphia', 'PA'], ['Baltimore', 'MD'], ['Richmond', 'VA'], ['Jacksonville', 'FL'],
  ['Miami', 'FL'], ['Birmingham', 'AL'], ['New Orleans', 'LA'], ['Oklahoma City', 'OK'], ['Little Rock', 'AR'],
].flatMap(([city, state]) => {
  let coords = cityPoint(city, state);
  if (!coords && city.startsWith('Nashville')) {
    const name = [...places.get(state).keys()].find(name => name.startsWith('nashville'));
    coords = cityPoint(name, state);
  }
  return coords ? [projected({ location: city.startsWith('Nashville') ? 'Nashville' : city, ...coords })] : [];
});
