'use client';
// Drop or paste collection files, see what resolves (and which commander was guessed), then import.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { FileUp, X } from 'lucide-react';
import { collectionApi, type ImportFile, type ImportPreviewFile } from '@/lib/collection/api';
import { useInvalidateCollection } from '@/lib/collection/useCollection';
import { useDebouncedValue } from '@/lib/hooks/useDebounced';
import { toast } from '@/lib/stores/ui';
import { Button, IconButton } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Select } from '@/components/ui/Select';
import { Badge, Callout, Skeleton } from '@/components/ui/Display';
import styles from './collection.module.css';

export function ImportCollectionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const invalidate = useInvalidateCollection();
  const [files, setFiles] = useState<ImportFile[]>([]);
  const [pasted, setPasted] = useState('');
  const [asDecks, setAsDecks] = useState(true);
  const [commanders, setCommanders] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setFiles([]); setPasted(''); setCommanders({}); setBusy(false); } }, [open]);

  const dpasted = useDebouncedValue(pasted, 400);
  const all = useMemo<ImportFile[]>(() => dpasted.trim() ? [...files, { name: 'pasted.csv', text: dpasted }] : files, [files, dpasted]);
  const preview = useQuery({
    queryKey: ['collection-import-preview', all.map(f => f.name + ':' + f.text.length + ':' + f.text.slice(0, 64))],
    queryFn: ({ signal }) => collectionApi.import({ files: all, preview: true }, signal),
    enabled: open && all.length > 0, staleTime: 60_000,
  });
  const previews: ImportPreviewFile[] = preview.data?.previews ?? [];

  const addFiles = useCallback(async (list: FileList | File[]) => {
    const next: ImportFile[] = [];
    for (const f of Array.from(list)) { if (f.size > 5_000_000) { toast({ title: `${f.name} is too large`, kind: 'warn' }); continue; } next.push({ name: f.name, text: await f.text() }); }
    setFiles(prev => [...prev.filter(p => !next.some(n => n.name === p.name)), ...next]);
  }, []);

  const run = async () => {
    if (!all.length || busy) return;
    setBusy(true);
    try {
      const r = await collectionApi.import({ files: all, asDecks, format: 'commander', commanders });
      await invalidate();
      const n = r.results?.length ?? 0; const unresolved = r.results?.reduce((a, x) => a + x.unresolved.length, 0) ?? 0;
      toast({ title: `Imported ${n} file${n === 1 ? '' : 's'}`, body: `${r.summary.distinct} distinct cards, ${r.summary.copies} copies${unresolved ? ` · ${unresolved} name${unresolved === 1 ? '' : 's'} not found` : ''}`, kind: unresolved ? 'warn' : 'ok' });
      onClose(); router.refresh();
    } catch (e) { toast({ title: 'Import failed', body: (e as Error).message, kind: 'danger' }); setBusy(false); }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Import collection files" width={680}
      footer={<div className={styles.formActions}><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!all.length || busy || preview.isFetching} onClick={run} data-testid="collection-import-run">{busy ? 'Importing…' : `Import ${all.length || ''} file${all.length === 1 ? '' : 's'}`}</Button></div>}>
      <div className={styles.form}>
        <label className={styles.dropzone} data-over={over || undefined} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={(e) => { e.preventDefault(); setOver(false); void addFiles(e.dataTransfer.files); }}>
          <FileUp aria-hidden />
          <span><b>Drop files here</b> or click to choose — <code>count,name</code> CSVs, Moxfield / Archidekt exports, Arena lists</span>
          <input ref={input} type="file" multiple accept=".csv,.txt,.dec,.dek,text/csv,text/plain" onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ''; }} data-testid="collection-file-input" />
        </label>
        <div>
          <label htmlFor="collection-paste" className="faint small" style={{ display: 'block', marginBottom: 6 }}>…or paste a list</label>
          <textarea id="collection-paste" className={styles.textarea} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder={'1,Arcane Signet\n1,"Betor, Kin to All"\n7,Forest'} spellCheck={false} />
        </div>
        <label className={styles.toggle}>
          <input type="checkbox" checked={asDecks} onChange={(e) => setAsDecks(e.target.checked)} />
          <span><b>Also register each file as a Commander deck</b><br /><span className={styles.toggleHint}>The deck name comes from the file name; the commander is guessed from it and can be changed below or later in the builder.</span></span>
        </label>
        {all.length > 0 && (
          <div className={styles.fileList} aria-live="polite">
            {preview.isFetching && !preview.data && <Skeleton kind="text" width="50%" />}
            {preview.isError && <Callout variant="danger" title="Could not read the files">{(preview.error as Error).message}</Callout>}
            {previews.map(p => {
              const chosen = p.name in commanders ? commanders[p.name] : (p.commander.pick?.oracleId ?? null);
              return (
                <div key={p.name} className={styles.file} data-testid="collection-import-file">
                  <div className={styles.fileMain}>
                    <b>{p.label} <span className="faint">· {p.name}</span></b>
                    <div className={styles.fileMeta}>
                      <Badge tone="mute">{p.format}</Badge>
                      <Badge tone="ok" dot>{p.resolved} cards · {p.copies} copies</Badge>
                      {p.unresolved.length > 0 && <Badge tone="danger" dot title={p.unresolved.map(u => `line ${u.line}: ${u.name}`).join('\n')}>{p.unresolved.length} not found</Badge>}
                      {p.errors.length > 0 && <Badge tone="warn" dot title={p.errors.map(e => `line ${e.line}: ${e.reason}`).join('\n')}>{p.errors.length} bad line{p.errors.length === 1 ? '' : 's'}</Badge>}
                      {p.existing && <Badge tone="info">replaces the earlier import</Badge>}
                    </div>
                    {asDecks && (
                      <div className={styles.fileCmd}>
                        <span className="faint small">Commander</span>
                        <Select size="sm" aria-label={`Commander for ${p.label}`} value={chosen ?? ''} placeholder={p.commander.candidates.length ? 'None yet' : 'No legendary creatures'} onChange={(e) => setCommanders(c => ({ ...c, [p.name]: e.target.value || null }))}
                          options={p.commander.candidates.map(c => ({ value: c.oracleId, label: c.name }))} />
                        {p.commander.confidence === 'ambiguous' && !(p.name in commanders) && <span className="faint small">several match — pick one</span>}
                      </div>
                    )}
                  </div>
                  {p.name !== 'pasted.csv' && <IconButton label={`Remove ${p.name}`} size="sm" onClick={() => setFiles(fs => fs.filter(f => f.name !== p.name))}><X /></IconButton>}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Dialog>
  );
}
