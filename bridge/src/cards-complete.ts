/** Image producer completion boundary: validates before atomic publication. */
import { readFile } from 'node:fs/promises';
import { writeCardsReadyMarker, type CardsReadyMarker } from './cards-ready.ts';
const draft = process.argv[2];
if (!draft) throw new Error('usage: cards-complete <draft.json>');
const marker = JSON.parse(await readFile(draft, 'utf8')) as CardsReadyMarker;
const path = await writeCardsReadyMarker({ ...marker, readyAt: new Date().toISOString() });
console.log(JSON.stringify({ event: 'cards_ready_published', batchId: marker.batchId, path }));
