#!/usr/bin/env python3
# build-done-monitor: check for newly done kanban cards, notify via Bot API.
# No LLM. Reads tokens from store files only -- never logs secret values.
import sqlite3, time, subprocess, os, json, sys

DB = os.path.expanduser('~/marveen/store/claudeclaw.db')
TOKEN_FILE = os.path.expanduser('~/marveen/store/.dashboard-token')
ENV_FILE = os.path.expanduser('~/.claude/channels/telegram/.env')
CHAT_ID = '8942301795'
WINDOW_SEC = 35 * 60

def read_bot_token():
    try:
        with open(ENV_FILE) as f:
            for line in f:
                if 'BOT_TOKEN' in line and '=' in line:
                    return line.split('=', 1)[1].strip().strip('"').strip("'")
    except Exception:
        pass
    return None

bot_token = read_bot_token()
if not bot_token:
    sys.exit(0)

now = int(time.time())
cutoff = now - WINDOW_SEC

db = sqlite3.connect(DB)
db.row_factory = sqlite3.Row

# 2026-07-07 (deliverylead gate-integrity flag): don't send a "Kész" notification
# for a FLOOR GATE / FINAL GATE card just because an agent flipped it to done --
# those gates need multiple independent sign-offs and are owned by deliverylead;
# a premature "done" here would read to Istvan as a passed gate. Skip them.
cards = db.execute(
    "SELECT id, title, assignee, updated_at FROM kanban_cards "
    "WHERE status='done' AND updated_at > ? AND archived_at IS NULL "
    "AND title NOT LIKE '%FLOOR GATE%' AND title NOT LIKE '%FINAL GATE%' "
    "ORDER BY updated_at DESC",
    (cutoff,)
).fetchall()

for card in cards:
    notif = db.execute(
        "SELECT id FROM kanban_comments "
        "WHERE card_id LIKE ? AND content LIKE '%notification%sent%' "
        "ORDER BY created_at DESC LIMIT 1",
        (card['id'] + '%',)
    ).fetchone()
    if notif:
        continue

    age_min = (now - card['updated_at']) // 60
    title = (card['title'] or '')[:80]
    assignee = card['assignee'] or '?'
    text = f"Kész: {title} ({assignee}, {age_min} perce)"

    subprocess.run(
        ['curl', '-s', '-X', 'POST',
         f'https://api.telegram.org/bot{bot_token}/sendMessage',
         '-H', 'Content-Type: application/json',
         '-d', json.dumps({'chat_id': CHAT_ID, 'text': text})],
        timeout=15, capture_output=True
    )

    # Card d2d949c3: this string makes NO claim about the card data -- it
    # only records the emitter's own action. Its literalness IS a safety
    # property: an interpolated string could silently contaminate the probe
    # surface (path tokens, absence words). PINNED literal -- do not convert
    # to an f-string or any other interpolated form without removing the
    # "literal safety" marker in the corresponding test.
    db.execute(
        "INSERT INTO kanban_comments (card_id, author, content, created_at) "
        "VALUES (?, 'marveen', 'build-done-monitor: notification sent (command task)', ?)",
        (card['id'], now)
    )
    db.commit()

db.close()
sys.exit(0)
