import re,sys
# Resolves test/run.sh merge conflicts in the FREE and SMOKE lists (one name per line, sorted).
# A hunk whose two sides are only name lines is resolved to their sorted union; a hunk with
# the old one-line form (FREE="a b") on both sides is unioned into that form. Any other hunk
# keeps HEAD's and warns about the other side's lines it drops.
p='test/run.sh'; s=open(p).read()
warn=[]
NAME=re.compile(r'^[a-z0-9-]+$')
ONE=re.compile(r'^(FREE|SMOKE)="([^"\n]*)"$')
def f(m):
    a,b=m.group(1),m.group(2)
    al,bl=a.splitlines(),b.splitlines()
    if all(not l or NAME.match(l) for l in al+bl):
        names=sorted(set(l for l in al+bl if l))
        return '\n'.join(names)+'\n'
    if len(al)==1 and len(bl)==1 and ONE.match(al[0]) and ONE.match(bl[0]) and ONE.match(al[0]).group(1)==ONE.match(bl[0]).group(1):
        var=ONE.match(al[0]).group(1)
        names=ONE.match(al[0]).group(2).split()
        for n in ONE.match(bl[0]).group(2).split():
            if n not in names: names.append(n)
        return '%s="%s"\n' % (var,' '.join(names))
    for l in bl:
        if l not in set(al): warn.append(l)
    return a
s=re.sub(r'<<<<<<< HEAD\n(.*?)=======\n(.*?)>>>>>>> [^\n]*\n', f, s, flags=re.S)
open(p,'w').write(s)
for l in warn: print('DROPPED, merge by hand:', l, file=sys.stderr)
sys.exit(1 if warn else 0)
