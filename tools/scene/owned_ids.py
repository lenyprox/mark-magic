"""List the printing faces the owner's cards display, for a scene-pack batch.

Reads data/user.db (collection_cards and deck_cards, which store oracle ids and only rarely a printing id) and
resolves each oracle id to the printing the app shows: the explicit printing_id when a deck pins one, else
card_index.rep_printing_id from data/master/master.db. Back faces are included when the card has one.

  tools/scene/.venv/Scripts/python tools/scene/owned_ids.py > tools/scene/ids-owned.txt
  tools/scene/.venv/Scripts/python tools/scene/analyze.py --ids-file tools/scene/ids-owned.txt --sheet
"""
from __future__ import annotations

import os
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = Path(os.environ.get('MTG_DATA_DIR') or ROOT / 'data')


def main() -> None:
    user = sqlite3.connect(f'file:{(DATA / "user.db").as_posix()}?mode=ro', uri=True)
    master = sqlite3.connect(f'file:{(DATA / "master" / "master.db").as_posix()}?mode=ro', uri=True)
    oracle_ids: dict[str, str | None] = {}
    for oid, pid in user.execute("SELECT oracle_id, printing_id FROM collection_cards"):
        oracle_ids.setdefault(oid, None)
        if pid:
            oracle_ids[oid] = pid
    for oid, pid in user.execute("SELECT oracle_id, printing_id FROM deck_cards"):
        oracle_ids.setdefault(oid, None)
        if pid:
            oracle_ids[oid] = pid
    out: list[str] = []
    missing = 0
    for oid, pid in oracle_ids.items():
        row = master.execute('SELECT rep_printing_id, has_back FROM card_index WHERE oracle_id = ?', (oid,)).fetchone()
        if not row:
            missing += 1
            continue
        printing = pid or row[0]
        out.append(f'{printing}:0')
        if row[1]:
            out.append(f'{printing}:1')
    print('\n'.join(sorted(set(out))))
    print(f'# {len(oracle_ids)} owned cards -> {len(set(out))} faces ({missing} without an index row)', flush=True)


if __name__ == '__main__':
    main()
