// Import collection files. JSON: { files: [{name, text}], preview?, asDecks?, format?, mode?, commanders?: {file: oracleId|null}, bundled? }
// or multipart/form-data with one or more "files" parts. `bundled: true` imports every decks/*.csv in the repository.
import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from '@config/paths';
import { getCollection, getDecks } from '@/lib/db';
import type { ImportFile, ImportRequest } from '@/lib/collection/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function bundledFiles(): ImportFile[] {
  const dir = path.join(projectRoot(), 'decks');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.csv')).sort().map(f => ({ name: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }));
}

export async function POST(req: Request) {
  let body: ImportRequest = {};
  let files: ImportFile[] = [];
  const ct = req.headers.get('content-type') ?? '';
  if (ct.includes('multipart/form-data')) {
    const fd = await req.formData();
    for (const [k, v] of fd.entries()) {
      if (v instanceof File) files.push({ name: v.name, text: await v.text() });
      else if (k === 'options') { try { body = JSON.parse(String(v)); } catch { /* ignore */ } }
    }
  } else {
    body = (await req.json().catch(() => ({}))) as ImportRequest;
    files = Array.isArray(body.files) ? body.files.filter(f => f && typeof f.name === 'string' && typeof f.text === 'string') : [];
  }
  if (body.bundled) files = [...files, ...bundledFiles()];
  if (!files.length) return Response.json({ error: 'no files' }, { status: 400 });
  if (files.some(f => f.text.length > 5_000_000)) return Response.json({ error: 'file too large' }, { status: 413 });
  const store = getCollection();
  if (body.preview) {
    const previews = files.map(f => ({ name: f.name, ...store.previewText(f.text, f.name) }));
    return Response.json({ previews, version: store.version(), summary: store.summary() });
  }
  const results = files.map(f => {
    const base = f.name.replace(/\\/g, '/').split('/').pop()!;
    const commander = body.commanders && base in body.commanders ? body.commanders[base] : undefined;
    return store.importText(f.text, f.name, { mode: body.mode ?? 'replace', asDeck: body.asDecks ? { format: body.format ?? 'commander', role: 'mine', commander } : null });
  });
  // keep the deck list fresh for the play setup / library
  getDecks();
  return Response.json({ results, version: store.version(), summary: store.summary() }, { status: 201 });
}
