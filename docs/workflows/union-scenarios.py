"""Resolve a merge conflict in test/scenarios.test.ts by UNION: main's file plus the import line(s) and suites
entries the branch added. Usage: python union-scenarios.py <branch>  (run from the repo root, mid-merge)."""
import re, subprocess, sys
branch = sys.argv[1]
def show(rev):
    return subprocess.run(['git', 'show', f'{rev}:test/scenarios.test.ts'], capture_output=True, text=True, check=True, encoding='utf-8').stdout
ours, theirs = show('HEAD'), show(branch)
imp = re.compile(r"^import \{[^}]+\} from '\./scenarios/[^']+';$", re.M)
ours_imports, theirs_imports = imp.findall(ours), imp.findall(theirs)
new_imports = [l for l in theirs_imports if l not in ours_imports]
ent = re.compile(r"\{ file: '[^']+', scenarios: \w+ \}")
ours_entries, theirs_entries = ent.findall(ours), ent.findall(theirs)
new_entries = [e for e in theirs_entries if e not in ours_entries]
if not new_imports and not new_entries:
    print('union: branch adds nothing; keeping main'); out = ours
else:
    last_import = ours_imports[-1]
    out = ours.replace(last_import, last_import + ('\n' + '\n'.join(new_imports) if new_imports else ''), 1)
    m = re.search(r"const suites: [^\n]*?\];", out)
    if not m: sys.exit('union: suites array not found')
    arr = m.group(0)
    out = out.replace(arr, arr[:-2] + ''.join(', ' + e for e in new_entries) + '];', 1)
open('test/scenarios.test.ts', 'w', encoding='utf-8', newline='\n').write(out)
print(f'union: +{len(new_imports)} import(s), +{len(new_entries)} suite entr(y/ies): {new_entries}')
