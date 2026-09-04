import type { Metadata } from 'next';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '@config/paths';
import { CoveragePage, type Verification } from '@/components/coverage/CoveragePage';

export const metadata: Metadata = { title: 'Coverage' };
export const dynamic = 'force-dynamic';

export default function Page() {
  const file = path.join(DATA_DIR(), 'master', 'verification.json');
  const data: Verification | null = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  return <div className="container"><CoveragePage data={data} /></div>;
}
