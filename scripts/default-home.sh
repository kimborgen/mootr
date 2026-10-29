# Sourced, not run (S-3347, S-4335). default_home prints the default data home: ~/.local/share/stam when it is a real
# folder, else ~/.local/share/mootr (src/default-home.ts has the full rule). An error other than "not found" on the stam
# path (EACCES) prints it to stderr and returns 1, never mootr.
# The function text equals DEFAULT_HOME_SH in src/default-home.ts; scripts/storage-checkout-guard.sh and scripts/ensure-deps.sh inline it.
default_home() {
  s="$HOME/.local/share/stam"; m="$HOME/.local/share/mootr"
  if [ -d "$s" ] && [ ! -L "$s" ]; then
    [ ! -e "$m" ] || echo "default home: $s and $m are both real folders; using $s" >&2
    echo "$s"; return 0
  fi
  if [ -e "$m" ] || [ -L "$s" ]; then echo "$m"; return 0; fi
  err=$(LC_ALL=C stat -c %F -- "$s" 2>&1 >/dev/null) || case $err in
    *"No such file"*|*"Not a directory"*) ;;
    *) echo "default home: $err" >&2; return 1 ;;
  esac
  echo "$m"
}
