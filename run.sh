#!/bin/bash
# Local conformance loop: start the kit's env, run the entry, print a per-check summary.
set -u
KIT=/tmp/gcc-kit/github-core-clone-01-kit
STATE=/tmp/gccenv/state
LOG=/tmp/gccenv/env.log
BOTLOG=/tmp/gccenv/bot.log
PORT=${PORT:-8080}

if [ -f /tmp/gccenv/env.pid ]; then
  OLD=$(cat /tmp/gccenv/env.pid)
  kill "$OLD" 2>/dev/null
  sleep 0.5
fi
rm -rf "$STATE"
mkdir -p "$STATE"

cd "$KIT" || exit 1
MAKEFUN_STATE_DIR="$STATE" MAKEFUN_ENV_HOST=127.0.0.1 MAKEFUN_ENV_PORT="$PORT" \
  MAKEFUN_SHOP_TOKEN=testtoken123 nohup node program/env/server.mjs > "$LOG" 2>&1 &
echo $! > /tmp/gccenv/env.pid

for i in $(seq 1 40); do
  if grep -q "listening on" "$LOG" 2>/dev/null; then break; fi
  sleep 0.25
done

cd /root/gcc || exit 1
MAKEFUN_ENV_URL="http://127.0.0.1:$PORT" timeout 280 node main.ts > "$BOTLOG" 2>&1
RC=$?
kill "$(cat /tmp/gccenv/env.pid)" 2>/dev/null
sleep 0.3

python3 - "$LOG" "$RC" <<'PY'
import re, sys
path, rc = sys.argv[1], sys.argv[2]
text = open(path, errors='replace').read()
groups = {}
fails = []
for line in text.split('\n'):
    m = re.match(r'\[env\] ([a-z]+)\.([a-z0-9-]+) (pass|fail)', line)
    if not m:
        continue
    g = m.group(1)
    d = groups.setdefault(g, [0, 0])
    if m.group(3) == 'pass':
        d[0] += 1
    else:
        d[1] += 1
        fails.append(line[6:])
total_p = sum(v[0] for v in groups.values())
total_f = sum(v[1] for v in groups.values())
print(f'bot rc={rc}  pass={total_p} fail={total_f}  (feature={round(600*total_p/max(total_p+total_f,1))})')
for g, (p, f) in groups.items():
    print(f'  {g:9s} pass {p:3d}  fail {f:3d}')
print('--- failures ---')
for line in fails:
    print(line[:230])
PY
