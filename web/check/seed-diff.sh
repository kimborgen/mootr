#!/bin/sh
# A small git repo with a PR for the diff view's browser checks (S-1531), made the way test/diff-api.test.mjs makes one:
# a bare "origin" with main and a refs/pull/7/head, and a clone of it as the checkout `settings.itsa.repos` names.
#   sh web/check/seed-diff.sh DIR     prints the checkout's path
# The PR changes one file twice far apart (so the unchanged middle collapses), adds, deletes and renames a file, changes
# a binary, a test, a lockfile and a protected file. For go to declaration (S-1532) the changed lines of src/a.ts name
# `added` (declared in the PR's new file), `helper` (declared once, in a file the PR doesn't touch) and `dup` (twice).
set -e
D=$1
g() { git -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false "$@"; }
mkdir -p "$D"
g init -q --bare -b main "$D/origin.git"
g init -q -b main "$D/work"
W="$D/work"
mkdir -p "$W/src" "$W/test" "$W/docs"
seq 1 60 | sed 's/^/const line = /' >"$W/src/a.ts"
seq 1 12 | sed 's/^/export const b = /' >"$W/src/b.ts"
seq 1 8 | sed 's/^/gone /' >"$W/src/gone.ts"
seq 1 25 | sed 's/^/old name /' >"$W/old-name.txt"
printf 'it one\nit two\n' >"$W/test/a.test.ts"
printf '{"v":1}\n' >"$W/package-lock.json"
printf 'S=1\n' >"$W/.env"
printf '# Doc\n\nold\n' >"$W/docs/x.md"
printf '\001\002\000\003' >"$W/logo.bin"
printf 'export function helper(n: number) {\n  return n * 2\n}\nexport function dup() {}\n' >"$W/src/lib.ts"
printf 'export function dup() {}\n' >"$W/src/other.ts"
g -C "$W" add -A
g -C "$W" commit -q -m base
g -C "$W" remote add origin "$D/origin.git"
g -C "$W" push -q origin main
g -C "$W" checkout -q -b pr
sed -i 's/^const line = 8$/const line = added/; s/^const line = 52$/const line = helper(dup)/' "$W/src/a.ts"
printf 'export const added = 1\n' >"$W/src/new.ts"
rm "$W/src/gone.ts"
mv "$W/old-name.txt" "$W/new-name.txt"
printf 'extra\n' >>"$W/new-name.txt"
printf 'it one\nit TWO\nit three\n' >"$W/test/a.test.ts"
printf '{"v":2}\n' >"$W/package-lock.json"
printf 'S=2\n' >"$W/.env"
printf '# Doc\n\nnew\n' >"$W/docs/x.md"
printf '\011\002\000\003\004' >"$W/logo.bin"
g -C "$W" add -A
g -C "$W" commit -q -m pr
g -C "$W" push -q origin pr:refs/pull/7/head
g clone -q "$D/origin.git" "$D/checkout"
echo "$D/checkout"
