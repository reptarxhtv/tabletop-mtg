#!/usr/bin/env python3
"""Tabletop MTG: game server + static file host.

Run:  python server.py
The server keeps the whole game state per room, relays every change to all
connected devices (tablet board, phone hand) over WebSocket, and saves the
state to the data/ folder after every change so a crash or restart never
loses the table.
"""
import asyncio
import json
import logging
import os
import random
import re
import shutil
import socket
import time
import urllib.request
import uuid
from pathlib import Path

from aiohttp import ClientSession, ClientTimeout, WSMsgType, web

ROOT = Path(__file__).parent
STATIC = ROOT / "static"
DATA = Path(os.environ.get("TT_DATA") or (ROOT / "data"))
PORT = int(os.environ.get("PORT", "8080"))

ZONES = ("hand", "battlefield", "graveyard", "exile", "library", "command", "look")

# Images for tokens may only come from Scryfall.
IMG_PREFIXES = ("https://cards.scryfall.io/",)
# The standard Magic card back (the "card_back_id" Scryfall uses for normal cards).
CARD_BACK_ID = "0aeebaf5-8c7d-4636-9e82-8c27447861f7"
CARD_BACK_URLS = [
    f"https://backs.scryfall.io/{size}/{CARD_BACK_ID[0]}/{CARD_BACK_ID[1]}/{CARD_BACK_ID}.jpg"
    for size in ("large", "normal")
]

SECTION_NAMES = {
    "commander": "commander",
    "commanders": "commander",
    "deck": "main",
    "main": "main",
    "mainboard": "main",
    "main deck": "main",
    "sideboard": "skip",
    "maybeboard": "skip",
    "companion": "skip",
    "considering": "skip",
}

LINE_RE = re.compile(r"^(?:(\d+)\s*x?\s+)?(.+)$", re.IGNORECASE)

log = logging.getLogger("tabletop")
rooms = {}


def setup_logging():
    DATA.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    fh = logging.FileHandler(DATA / "server.log", encoding="utf-8")
    fh.setFormatter(fmt)
    sh = logging.StreamHandler()
    sh.setFormatter(fmt)
    log.setLevel(logging.INFO)
    log.addHandler(fh)
    log.addHandler(sh)


# ----------------------------------------------------------------------------
# Small helpers
# ----------------------------------------------------------------------------

def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def to_int(v, default=0):
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def to_float(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f and abs(f) != float("inf") else None


def cap(name):
    """Counter names: collapse spaces, max 20 chars, first letter upper-case."""
    name = re.sub(r"\s+", " ", str(name or "")).strip()[:20]
    return name[:1].upper() + name[1:]


# ----------------------------------------------------------------------------
# Deck parsing + Scryfall
# ----------------------------------------------------------------------------

def clean_name(name):
    name = re.sub(r"\s*\[[^\]]*\]", "", name)  # [Category] tags (Archidekt)
    name = re.sub(r"\s*\^[^^]*\^", "", name)  # ^tags^
    name = re.sub(r"\s+\*[A-Za-z]+\*\s*$", "", name)  # *F* foil marker
    name = re.sub(r"\s+\([A-Za-z0-9]{2,6}\)(\s+\S+)?\s*$", "", name)  # (SET) 123
    return name.strip()


def parse_deck(text, default):
    """Return a list of (section, qty, name). Sections: commander / main."""
    section = default
    out = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        key = line.rstrip(":").strip().lower()
        if key in SECTION_NAMES:
            section = SECTION_NAMES[key]
            continue
        if line.upper().startswith("SB:"):
            continue
        m = LINE_RE.match(line)
        if not m:
            continue
        qty_str, name = m.group(1), clean_name(m.group(2))
        if qty_str is None and section != "commander":
            continue  # bare lines are only valid for commanders
        qty = max(1, min(int(qty_str or 1), 99))
        if name and section in ("commander", "main"):
            out.append((section, qty, name))
    return out


def fname(name):
    """Front-face name of a card ('A // B' -> 'A')."""
    return name.split("//")[0].strip()


def card_images(card):
    def pick(uris):
        uris = uris or {}
        return uris.get("normal"), uris.get("small")

    normal, small = pick(card.get("image_uris"))
    if not normal:
        for face in card.get("card_faces", []):
            normal, small = pick(face.get("image_uris"))
            if normal:
                break
    return normal, small


def back_images(card):
    """The other face of a double-faced card (transform, modal DFC...): (normal, small), or (None, None).
    Split, flip and adventure cards have one picture for both halves, so they have no back."""
    faces = card.get("card_faces") or []
    if card.get("image_uris") or len(faces) < 2:
        return None, None
    normal, small = (faces[1].get("image_uris") or {}).get("normal"), (faces[1].get("image_uris") or {}).get("small")
    return (normal, small or normal) if normal else (None, None)


SCRYFALL_HEADERS = {"User-Agent": "PersonalTabletopMTG/0.2", "Accept": "application/json"}


async def _collection(session, names):
    found, missing = {}, []
    for i in range(0, len(names), 75):
        chunk = names[i:i + 75]
        async with session.post(
            "https://api.scryfall.com/cards/collection",
            json={"identifiers": [{"name": n} for n in chunk]},
        ) as r:
            if r.status != 200:
                raise RuntimeError(f"Scryfall answered HTTP {r.status}")
            data = await r.json()
        for card in data.get("data", []):
            normal, small = card_images(card)
            front_type = (card.get("type_line") or "").split("//")[0]
            img2, thumb2 = back_images(card)
            found[fname(card["name"]).lower()] = {
                "name": card["name"], "img": normal, "thumb": small or normal,
                "land": "land" in front_type.lower(),
                "img2": img2 or "", "thumb2": thumb2 or "",
            }
        for nf in data.get("not_found", []):
            missing.append(nf.get("name", "?"))
        await asyncio.sleep(0.12)  # be polite to Scryfall
    return found, missing


async def fetch_cards(names):
    """Look cards up on Scryfall. Returns ({front_name_lower: info}, [missing])."""
    originals = {}
    for n in names:
        originals.setdefault(fname(n).lower(), n)
    async with ClientSession(headers=SCRYFALL_HEADERS, timeout=ClientTimeout(total=40)) as s:
        found, missing = await _collection(s, [fname(n) for n in originals.values()])
        retry = [n for n in originals.values() if "//" in n and fname(n).lower() not in found]
        if retry:  # split cards ("Fire // Ice") may need the full name
            f2, _ = await _collection(s, retry)
            found.update(f2)
            missing = [m for m in missing if fname(m).lower() not in found]
    return found, missing


SPECIAL_NAMES = ("the monarch", "the initiative")


def search_query(name, kind):
    """The Scryfall query: real cards, or tokens plus emblems, dungeons, the Monarch and the Initiative."""
    if kind == "card":
        return f'name:"{name}" -t:token'
    return f'name:"{name}" (t:token or t:emblem or t:dungeon or name:"The Monarch" or name:"The Initiative")'


CARD_REF = re.compile(
    r"^(?:https?://)?(?:www\.)?scryfall\.com/card/([a-z0-9]{2,6})/([0-9]+[a-z\u2605]*)(?:/.*)?$"
    r"|^([a-z0-9]{2,6})[ /]+([0-9]+[a-z\u2605]*)$",
    re.I,
)


def parse_card_ref(text):
    """A pasted Scryfall link ('scryfall.com/card/totj/20/plot') or 'set number' ('totj 20') -> (set, number)."""
    m = CARD_REF.match(str(text or "").strip().split("?")[0].rstrip("/"))
    if not m:
        return None
    return (m.group(1) or m.group(3)).lower(), (m.group(2) or m.group(4)).lower()


def is_special_card(card):
    tl = (card.get("type_line") or "").lower()
    name = (card.get("name") or "").lower()
    if "emblem" in tl or "dungeon" in tl or "plot" in tl or name in SPECIAL_NAMES:
        return True
    # helper cards whose whole type line is just "Card" (markers, not real cards)
    return tl.split("\u2014")[0].strip() == "card" and card.get("layout") in ("token", "emblem", "planar", None)


def result_from_card(card):
    normal, small = card_images(card)
    if not normal:
        return None
    p, t = card.get("power"), card.get("toughness")
    img2, thumb2 = back_images(card)  # a double-faced card made here can flip too
    return {
        "img2": img2 or "",
        "thumb2": thumb2 or "",
        "special": is_special_card(card),
        "name": card.get("name", "Token"),
        "img": normal,
        "thumb": small or normal,
        "pt": f"{p}/{t}" if p is not None and t is not None else "",
        "type": card.get("type_line", ""),
    }


async def _scry_get(session, url, params=None):
    """GET from Scryfall: the JSON, or None for 404 (nothing found)."""
    async with session.get(url, params=params) as r:
        if r.status == 404:
            return None
        if r.status != 200:
            raise RuntimeError(f"Scryfall answered HTTP {r.status}")
        return await r.json()


async def search_cards(name, kind="token"):
    """Search Scryfall for tokens (kind="token": also emblems, the Monarch, the Initiative and
    dungeons) or for real cards (kind="card") by name. A pasted Scryfall link or 'set number' finds that card."""
    raw = str(name or "").strip()
    ref = parse_card_ref(raw)
    name = re.sub(r'["\\]', " ", raw).strip()[:40]
    if not name and not ref:
        return []
    async with ClientSession(headers=SCRYFALL_HEADERS, timeout=ClientTimeout(total=20)) as s:
        if ref:
            card = await _scry_get(s, f"https://api.scryfall.com/cards/{ref[0]}/{ref[1]}")
            r = result_from_card(card) if card else None
            if r or "scryfall.com" in raw.lower():
                return [r] if r else []
            # "goblin 2" is not a set code after all: fall through to the name search
        data = await _scry_get(s, "https://api.scryfall.com/cards/search", {
            "q": search_query(name, kind),
            "unique": "cards",
            "order": "name",
            "include_extras": "false" if kind == "card" else "true",
        })
        cards = (data or {}).get("data", [])
    out = [r for r in (result_from_card(c) for c in cards[:24]) if r]
    # exact name matches first (a search for "Sol Ring" should not bury Sol Ring)
    out.sort(key=lambda r: r["name"].lower() != name.lower())
    return out


def ensure_card_back():
    """Download the standard Magic card back once (Scryfall hosts it)."""
    path = STATIC / "cardback.jpg"
    if path.exists():
        return
    last = None
    for url in CARD_BACK_URLS:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": SCRYFALL_HEADERS["User-Agent"]})
            with urllib.request.urlopen(req, timeout=12) as r:
                data = r.read()
            if len(data) > 5000 and data[:2] == b"\xff\xd8":  # a real JPEG
                path.write_bytes(data)
                log.info("Downloaded the card back image")
                return
            last = "unexpected data"
        except Exception as exc:
            last = exc
    log.warning("Could not download the card back image (%s). A drawn one is used instead; "
                "it is retried the next time the server starts.", last)


# ----------------------------------------------------------------------------
# Game state
# ----------------------------------------------------------------------------

def new_card(info, commander=False, slot=0, token=False, copy=False, special=False):
    # token: ceases to exist when it leaves the battlefield (tokens, created cards, emblems, copies).
    # copy: a token made with "Copy"; the table shows a "Copy" label on it.
    # special: an emblem, the Monarch, the Initiative or a dungeon: it may rest in a custom zone.
    return {
        "id": uuid.uuid4().hex[:8],
        "name": info["name"],
        "img": info["img"],
        "thumb": info["thumb"],
        "img2": info.get("img2") or "",      # the other face of a double-faced card ("" = none)
        "thumb2": info.get("thumb2") or "",
        "face": 0,                           # 1 = the other face is showing (only on the table)
        "cover": False,                      # True = Flip turns it face down instead of showing the other face
        "zone": "library",
        "x": 0.0,
        "y": 0.0,
        "tapped": False,
        "down": False,
        "p": 0,           # net power from +1/+1 and -1/-1 counters
        "t": 0,           # net toughness
        "counters": {},   # named counters
        "commander": commander,
        "slot": slot,
        "token": token,
        "copy": copy,
        "special": special,
        "land": bool(info.get("land")),
    }


def reset_card(c):
    c["tapped"] = False
    c["down"] = False
    c["face"] = 0  # a double-faced card shows its front everywhere except when flipped on the table
    c["cover"] = False
    c["p"] = 0
    c["t"] = 0
    c["counters"] = {}


class Room:
    def __init__(self, code):
        self.code = code
        self.cards = {}
        self.zones = {z: [] for z in ZONES}
        self.tax = [0, 0]
        # phase: None / "mull" (opening hand); size: cards in the current hand
        self.setup = {"phase": None, "mull": 0, "size": 7}
        self.look = None                          # {"mode", "n", "tops"} while scrying
        self.trackers = {}                        # P/T trackers placed on the table
        self.ctrs = {}                            # generic counters (label + number) on the table
        self.czones = {}                          # custom zones: {"z_ab12": "Plotted"}; cards in them have zone "z_ab12"
        self.turn = 0
        self.hist = []                            # undo: JSON snapshots of the table, newest last (memory only)
        self.drew = {"n": 0, "seq": 0}            # the last draw, so the board can announce it
        self.milled = {"n": 0, "seq": 0}          # the last mill, announced the same way
        self.clients = set()
        self.loading = False

    def to_dict(self):
        return {"cards": self.cards, "zones": self.zones, "tax": self.tax,
                "setup": self.setup, "look": self.look, "trackers": self.trackers,
                "ctrs": self.ctrs, "czones": self.czones, "turn": self.turn}

    def snapshot(self):
        d = self.to_dict()
        d["type"] = "state"
        d["room"] = self.code
        d["undo"] = len(self.hist)
        d["drew"] = self.drew
        d["milled"] = self.milled
        d["ver"] = VERSION
        return d

    def restore(self, d):
        """Put a saved table back (used by undo); clients and the undo history stay."""
        r = Room.from_dict(self.code, d)
        for k in ("cards", "zones", "tax", "setup", "look", "trackers", "ctrs", "czones", "turn"):
            setattr(self, k, getattr(r, k))

    @classmethod
    def from_dict(cls, code, d):
        r = cls(code)
        r.cards = {k: v for k, v in (d.get("cards") or {}).items() if isinstance(v, dict)}
        for c in r.cards.values():
            c.setdefault("token", False)
            c.setdefault("counters", {})
            c.setdefault("copy", False)
            c.setdefault("special", False)
            c.setdefault("land", False)
            c.setdefault("img2", "")
            c.setdefault("thumb2", "")
            c.setdefault("face", 0)
            c.setdefault("cover", False)
            if "pt" in c:  # older saves: one number for both power and toughness
                c["p"] = c["t"] = to_int(c.pop("pt"))
            c.setdefault("p", 0)
            c.setdefault("t", 0)
            if c.pop("extra", False):
                c["token"] = True  # older saves: created cards now behave like tokens
        zones = d.get("zones") or {}
        for z in ZONES:
            r.zones[z] = [i for i in zones.get(z, []) if i in r.cards]
        tax = d.get("tax")
        r.tax = tax if isinstance(tax, list) and len(tax) == 2 else [0, 0]
        setup = d.get("setup")
        setup = setup if isinstance(setup, dict) else {}
        r.setup = {
            "phase": "mull" if setup.get("phase") == "mull" else None,  # older saves may say "bottom"
            "mull": to_int(setup.get("mull")),
            "size": clamp(to_int(setup.get("size"), 7), 1, 7),
        }
        r.look = d.get("look") if isinstance(d.get("look"), dict) else None
        r.trackers = d.get("trackers") if isinstance(d.get("trackers"), dict) else {}
        for tr in r.trackers.values():
            if isinstance(tr, dict):
                tr.setdefault("m", 1)
        r.ctrs = d.get("ctrs") if isinstance(d.get("ctrs"), dict) else {}
        cz = d.get("czones") if isinstance(d.get("czones"), dict) else {}
        r.czones = {k: cap(v) or "Zone" for k, v in cz.items() if isinstance(k, str) and k.startswith("z_")}
        for k in r.czones:
            r.zones[k] = [i for i in zones.get(k, []) if i in r.cards]
        r.turn = clamp(to_int(d.get("turn"), 0), 0, 999)
        return r


def save_room(room):
    """Atomic write of the room state, keeping the previous version as .bak."""
    try:
        DATA.mkdir(parents=True, exist_ok=True)
        path = DATA / f"{room.code}.json"
        tmp = DATA / f"{room.code}.json.tmp"
        tmp.write_text(json.dumps(room.to_dict()), encoding="utf-8")
        if path.exists():
            shutil.copyfile(path, DATA / f"{room.code}.json.bak")
        os.replace(tmp, path)
    except Exception:
        log.exception("Could not save room %s", room.code)


def log_action(room, d):
    """Append every action to data/<room>.actions.log (one JSON object per line)."""
    try:
        entry = dict(d)
        for k in ("commander", "deck"):
            if k in entry:
                entry[k] = str(entry[k])[:6000]
        with open(DATA / f"{room.code}.actions.log", "a", encoding="utf-8") as f:
            f.write(json.dumps({"ts": round(time.time(), 1), "a": entry}) + "\n")
    except Exception:
        log.exception("Could not write the action log for room %s", room.code)


def load_rooms():
    """Restore every saved table when the server starts."""
    if not DATA.exists():
        return
    for p in sorted(DATA.glob("*.json")):
        code = p.stem
        for src in (p, DATA / f"{code}.json.bak"):
            try:
                d = json.loads(src.read_text(encoding="utf-8"))
                rooms[code] = Room.from_dict(code, d)
                log.info("Restored table '%s' (%d cards)%s", code, len(rooms[code].cards),
                         " from the backup file" if src != p else "")
                break
            except Exception:
                log.exception("Could not read %s", src)


def find_slot(room):
    taken = [(room.cards[i]["x"], room.cards[i]["y"]) for i in room.zones["battlefield"]]
    for row in range(4):
        for col in range(8):
            x = 0.03 + col * 0.12
            y = 0.06 + row * 0.24
            if all(abs(x - tx) > 0.05 or abs(y - ty) > 0.1 for tx, ty in taken):
                return round(x, 3), round(y, 3)
    return round(random.uniform(0.03, 0.85), 3), round(random.uniform(0.05, 0.7), 3)


def find_land_slot(room):
    """Lands go in a row along the bottom of the table; None when that row is full."""
    y = 0.78
    taken = [(room.cards[i]["x"], room.cards[i]["y"]) for i in room.zones["battlefield"]]
    for col in range(12):
        x = round(0.03 + col * 0.075, 3)
        if all(abs(x - tx) > 0.03 or abs(y - ty) > 0.1 for tx, ty in taken):
            return x, y
    return None


def drop_from_zones(room, cid):
    for lst in room.zones.values():
        while cid in lst:
            lst.remove(cid)


def after_look_change(room):
    if room.look and not room.zones["look"]:
        room.look = None


def do_move(room, c, to, down=False, where=None, x=None, y=None, tapped=False):
    custom = to in room.czones
    if (to not in ZONES and not custom) or to == "look":
        return
    if to == "command" and not c["commander"]:
        return
    cid = c["id"]
    was_look = c["zone"] == "look"
    if c.get("token") and to != "battlefield" and not (custom and c.get("special")):
        # tokens cease to exist when they leave the table; only emblems, the Monarch, the Initiative
        # and dungeons ("special") may rest in a custom zone
        drop_from_zones(room, cid)
        room.cards.pop(cid, None)
        return
    drop_from_zones(room, cid)
    reset_card(c)
    c["zone"] = to
    if to == "battlefield":
        c["down"] = bool(down)
        c["tapped"] = bool(tapped)
        if x is None or y is None:
            c["x"], c["y"] = (c.get("land") and find_land_slot(room)) or find_slot(room)
        else:
            c["x"], c["y"] = clamp(x, 0.0, 1.0), clamp(y, 0.0, 1.0)
        room.zones[to].append(cid)
    elif to == "library":
        if where == "bottom":
            room.zones[to].append(cid)
        else:
            idx = 0
            if was_look and room.look:
                # first card sent to the top ends up on top, the next one under it...
                idx = min(room.look.get("tops", 0), len(room.zones["library"]))
                room.look["tops"] = room.look.get("tops", 0) + 1
            room.zones[to].insert(idx, cid)
    elif to == "exile":
        c["down"] = bool(down)
        room.zones[to].append(cid)
    elif to == "command":
        room.zones[to].append(cid)
        room.zones[to].sort(key=lambda i: room.cards[i]["slot"])
    else:
        room.zones[to].append(cid)
    after_look_change(room)


def do_counter(c, kind, delta, name, dp=None, dt=None):
    delta = clamp(delta, -5, 5)
    if kind == "pt":
        if dp is None and dt is None:
            dp = dt = delta  # older clients: one number for both
        c["p"] = clamp(c["p"] + clamp(dp or 0, -5, 5), -99, 99)
        c["t"] = clamp(c["t"] + clamp(dt or 0, -5, 5), -99, 99)
    elif kind == "named":
        name = cap(name)
        if not name:
            return
        key = next((k for k in c["counters"] if k.lower() == name.lower()), name)
        n = c["counters"].get(key, 0) + delta
        if n <= 0:
            c["counters"].pop(key, None)
        else:
            c["counters"][key] = n


def do_draw(room, n, announce=False):
    drawn = 0
    for _ in range(n):
        if not room.zones["library"]:
            break
        cid = room.zones["library"].pop(0)
        room.zones["hand"].append(cid)
        room.cards[cid]["zone"] = "hand"
        reset_card(room.cards[cid])
        drawn += 1
    if announce and drawn:
        room.drew = {"n": drawn, "seq": room.drew["seq"] + 1}  # the board shows "Drew N cards"


def do_mill(room, n):
    """Put the top n cards of the library into the graveyard; returns how many were milled."""
    done = 0
    for _ in range(n):
        if not room.zones["library"]:
            break
        cid = room.zones["library"].pop(0)
        room.zones["graveyard"].append(cid)
        c = room.cards[cid]
        c["zone"] = "graveyard"
        reset_card(c)
        done += 1
    return done


def demote_commander(room, c):
    """A card stops being a commander. If it sits in the command zone it is shuffled into the library."""
    c["commander"] = False
    if c["zone"] == "command":
        drop_from_zones(room, c["id"])
        c["zone"] = "library"
        lib = room.zones["library"]
        lib.insert(random.randint(0, len(lib)), c["id"])


def make_commander(room, c, slot):
    """Make c the commander in slot 0 or 1. The commander that was there stops being one."""
    for other in list(room.cards.values()):
        if other["commander"] and other.get("slot") == slot and other["id"] != c["id"]:
            demote_commander(room, other)
    c["commander"] = True
    c["slot"] = slot
    room.tax[slot] = 0
    if c["zone"] != "battlefield":  # one already in play just gets its command-zone slot
        do_move(room, c, "command")


async def set_commanders(room, ws, text):
    """The New game dialog's "Set commander" button: the names written there become the commander(s) of
    the table as it is. A name that is already in the deck is pulled out of it, otherwise it is imported."""
    if room.loading:
        await notice(ws, "A deck is already loading...")
        return
    if room.look:
        await notice(ws, "Finish the current scry/surveil first.")
        return
    names = [e[2] for e in parse_deck(text, "commander")][:2]
    if not names:
        await notice(ws, "Write the commander name(s) first.")
        return
    if not any(not c.get("token") for c in room.cards.values()):
        await notice(ws, "Load a deck first (Start game), then set the commander.")
        return
    keys = [fname(n).lower() for n in names]
    have = {}
    for c in room.cards.values():
        if not c.get("token") and not c.get("copy"):
            have.setdefault(fname(c["name"]).lower(), []).append(c)
    need = [n for n, k in zip(names, keys) if k not in have]
    found, missing = {}, []
    if need:
        room.loading = True
        try:
            await notice(ws, "Loading the commander from Scryfall...")
            found, missing = await fetch_cards(need)
        except Exception as exc:
            log.warning("Commander lookup failed: %s", exc)
            await notice(ws, "Could not reach Scryfall. Is the PC online?")
            return
        finally:
            room.loading = False
    chosen = []  # (slot, card)
    for slot, k in enumerate(keys):
        pool = have.get(k)
        if pool:
            pool.sort(key=lambda c: (c["commander"], c["zone"] == "battlefield"))  # prefer a card that is not one yet
            chosen.append((slot, pool.pop(0)))
        elif k in found:
            card = new_card(found[k])
            room.cards[card["id"]] = card
            card["zone"] = "library"  # a new card starts in the library; make_commander moves it
            room.zones["library"].append(card["id"])
            chosen.append((slot, card))
    if not chosen:
        await notice(ws, "Not found: " + ", ".join(sorted(set(missing or need))[:4]) + ".")
        return
    keep = {c["id"] for _, c in chosen}
    for c in list(room.cards.values()):  # whoever was commander before and is not in the new list stops being one
        if c["commander"] and c["id"] not in keep:
            demote_commander(room, c)
    for slot, card in chosen:
        if card["commander"] and card.get("slot") == slot:
            continue  # already the commander there
        make_commander(room, card, slot)
    if missing:
        await notice(ws, "Not found: " + ", ".join(sorted(set(missing))[:4]) + ".")


def start_game(room):
    """Shuffle everything back, deal 7 and open the mulligan phase."""
    for cid in [i for i, c in room.cards.items() if c.get("token")]:
        del room.cards[cid]
    room.zones = {z: [] for z in ZONES}
    room.czones = {}
    room.turn = 0
    for c in room.cards.values():
        reset_card(c)
        if c["commander"]:
            c["zone"] = "command"
            room.zones["command"].append(c["id"])
        else:
            c["zone"] = "library"
            room.zones["library"].append(c["id"])
    room.zones["command"].sort(key=lambda i: room.cards[i]["slot"])
    random.shuffle(room.zones["library"])
    room.tax = [0, 0]
    room.look = None
    room.trackers = {}
    room.ctrs = {}
    do_draw(room, 7)
    room.setup = {"phase": "mull", "mull": 0, "size": 7}


def reset_all(room):
    room.cards = {}
    room.zones = {z: [] for z in ZONES}
    room.czones = {}
    room.turn = 0
    room.tax = [0, 0]
    room.look = None
    room.trackers = {}
    room.ctrs = {}
    room.setup = {"phase": None, "mull": 0, "size": 7}


def do_mulligan(room, n):
    """Shuffle the hand back and draw n cards.

    The first mulligan is free: it always draws a fresh seven. After that there are two
    choices, a fresh seven again (the casual "infinite mulligan" house rule) or one card
    fewer than the current hand (the official rule). At one card there is nothing left to
    mulligan, so the hand is kept.
    """
    s = room.setup
    if s.get("phase") != "mull":
        return
    size = s.get("size", 7)
    first = s.get("mull", 0) == 0
    if not (n == 7 or (not first and 1 <= n == size - 1)):
        return
    for cid in room.zones["hand"]:
        room.zones["library"].append(cid)
        room.cards[cid]["zone"] = "library"
        reset_card(room.cards[cid])
    room.zones["hand"] = []
    random.shuffle(room.zones["library"])
    do_draw(room, n, True)
    s["mull"] = s.get("mull", 0) + 1
    s["size"] = n
    if n == 1:
        s["phase"] = None


def do_keep(room):
    if room.setup.get("phase") == "mull":
        room.setup["phase"] = None


def do_look(room, mode, n):
    """Start a scry/surveil. Returns an error message or None."""
    if mode not in ("scry", "surveil"):
        return "Unknown action."
    if room.look:
        return "Finish the current scry/surveil first."
    n = min(clamp(n, 1, 10), len(room.zones["library"]))
    if n == 0:
        return "The library is empty."
    ids = room.zones["library"][:n]
    del room.zones["library"][:n]
    for i in ids:
        room.cards[i]["zone"] = "look"
    room.zones["look"] = ids
    room.look = {"mode": mode, "n": n, "tops": 0}
    return None


def do_look_cancel(room):
    if not room.look:
        return
    tops = room.look.get("tops", 0)
    for k, cid in enumerate(room.zones["look"]):
        room.zones["library"].insert(min(tops + k, len(room.zones["library"])), cid)
        room.cards[cid]["zone"] = "library"
    room.zones["look"] = []
    room.look = None


async def notice(ws, text):
    try:
        await ws.send_json({"type": "notice", "text": text})
    except Exception:
        pass


async def do_load(room, ws, d):
    if room.loading:
        await notice(ws, "A deck is already loading...")
        return
    room.loading = True
    try:
        await notice(ws, "Loading cards from Scryfall...")
        entries = parse_deck(d.get("commander", ""), "commander") + parse_deck(d.get("deck", ""), "main")
        if not entries:
            await notice(ws, "No cards found in the text.")
            return
        found, missing = await fetch_cards([e[2] for e in entries])

        new_cards, slot, extra_cmd = {}, 0, 0
        for section, qty, name in entries:
            info = found.get(fname(name).lower())
            if not info:
                continue
            if section == "commander":
                if slot >= 2:
                    extra_cmd += 1
                    continue
                c = new_card(info, True, slot)
                slot += 1
                new_cards[c["id"]] = c
            else:
                for _ in range(qty):
                    c = new_card(info)
                    new_cards[c["id"]] = c
        if not new_cards:
            await notice(ws, "None of those cards were found on Scryfall.")
            return

        room.cards = new_cards
        start_game(room)
        room.hist.clear()
        await broadcast(room)

        msg = f"Loaded {len(room.cards)} cards."
        if missing:
            msg += " Not found: " + ", ".join(sorted(set(missing))[:8]) + "."
        if extra_cmd:
            msg += " Only 2 commanders are supported; extra ones were skipped."
        await notice(ws, msg)
    except Exception as exc:  # network problems etc.
        log.exception("Deck load failed")
        await notice(ws, f"Could not load deck: {exc or type(exc).__name__}")
    finally:
        room.loading = False


async def broadcast(room):
    save_room(room)
    payload = json.dumps(room.snapshot())
    dead = []
    for client in list(room.clients):
        try:
            await client.send_str(payload)
        except Exception:
            dead.append(client)
    for client in dead:
        room.clients.discard(client)


UNDOABLE = {
    "move", "pos", "tap", "flip", "cover", "mill", "set_commanders", "counter", "copy_token", "token_create", "tax", "draw", "shuffle",
    "mulligan", "keep", "look", "look_cancel", "czone_add", "czone_del", "turn_set", "untap_all",
    "next_turn", "tracker_add", "tracker_pos", "tracker_mod", "tracker_mode", "tracker_reset",
    "tracker_del", "ctr_add", "ctr_pos", "ctr_mod", "ctr_reset", "ctr_del",
}
UNDO_STEPS = 10
VERSION = "v6.4"  # the app version; clients that run an older cached copy reload themselves


async def handle(room, ws, d):
    t = d.get("t")
    cid = d.get("id")
    c = room.cards.get(cid) if isinstance(cid, str) else None
    on_field = bool(c) and c["zone"] == "battlefield"
    if t != "token_search":
        log_action(room, d)
    before = json.dumps(room.to_dict()) if t in UNDOABLE else None

    if t == "move" and c:
        if c["zone"] == "look" and room.look:
            # while scrying a card may only go back on top or bottom; surveil: top or graveyard
            to, where = str(d.get("to")), d.get("where")
            ok = (to == "library" and (room.look["mode"] == "scry" or where != "bottom")) or \
                 (to == "graveyard" and room.look["mode"] == "surveil")
            if not ok:
                await notice(ws, "Scry: top or bottom of the library. Surveil: top of the library or graveyard.")
                return
        from_hand = c["zone"] == "hand"
        from_command = c["zone"] == "command"
        do_move(room, c, str(d.get("to")), bool(d.get("down")), d.get("where"),
                to_float(d.get("x")), to_float(d.get("y")), bool(d.get("tapped")))
        if from_command and c["zone"] == "battlefield" and c.get("slot") in (0, 1):
            room.tax[c["slot"]] += 2  # casting the commander again costs 2 more
        if from_hand and room.setup["phase"] == "mull":
            room.setup["phase"] = None  # started playing: the opening hand is kept
    elif t == "pos" and on_field:
        x, y = to_float(d.get("x")), to_float(d.get("y"))
        if x is None or y is None:
            return
        c["x"], c["y"] = clamp(x, 0.0, 1.0), clamp(y, 0.0, 1.0)
        lst = room.zones["battlefield"]
        lst.remove(cid)
        lst.append(cid)  # bring to front
    elif t == "tap" and on_field:
        c["tapped"] = not c["tapped"]
    elif t == "flip" and on_field:
        if c.get("img2") and not c.get("cover"):
            c["face"] = 0 if c.get("face") else 1  # a double-faced card: Flip shows its other face
        else:
            c["down"] = not c["down"]              # everything else (or a covered back side): face down
    elif t == "set_commanders":
        await set_commanders(room, ws, str(d.get("commander", "")))
    elif t == "cover" and on_field and c.get("img2"):
        # "Cover back side": Flip turns the card face down instead of showing the other face
        c["cover"] = not c.get("cover")
        c["face"] = 0
        c["down"] = False
    elif t == "mill":
        if room.look:
            await notice(ws, "Finish the current scry/surveil first.")
            return
        milled = do_mill(room, clamp(to_int(d.get("n"), 1), 1, 99))
        if milled:
            room.milled = {"n": milled, "seq": room.milled["seq"] + 1}  # the board shows "Milled N cards"
    elif t == "counter" and on_field:
        do_counter(c, d.get("kind"), to_int(d.get("delta")), d.get("name"),
                   to_int(d["dp"]) if "dp" in d else None, to_int(d["dt"]) if "dt" in d else None)
    elif t == "copy_token" and on_field:
        if len(room.zones["battlefield"]) >= 150:
            await notice(ws, "The table is full.")
            return
        cp = new_card({"name": c["name"], "img": c["img"], "thumb": c["thumb"],
                       "img2": c.get("img2"), "thumb2": c.get("thumb2")}, token=True, copy=True)
        cp["face"] = c.get("face", 0)
        cp["cover"] = c.get("cover", False)
        cp["zone"] = "battlefield"
        cp["x"], cp["y"] = clamp(c["x"] + 0.03, 0.0, 0.95), clamp(c["y"] + 0.05, 0.0, 0.9)
        room.cards[cp["id"]] = cp
        room.zones["battlefield"].append(cp["id"])
    elif t == "czone_add":
        name = cap(d.get("name"))
        if not name:
            return
        if len(room.czones) >= 6:
            await notice(ws, "That is enough zones for one table.")
            return
        zid = "z_" + uuid.uuid4().hex[:4]
        room.czones[zid] = name
        room.zones[zid] = []
    elif t == "czone_del":
        zid = d.get("zone")
        if zid not in room.czones:
            return
        for k in list(room.zones[zid]):
            card = room.cards[k]
            if card.get("token"):
                drop_from_zones(room, k)
                room.cards.pop(k, None)
            else:
                do_move(room, card, "command" if card["commander"] else "graveyard")
        del room.czones[zid]
        room.zones.pop(zid, None)
    elif t == "turn_set":
        room.turn = 0 if d.get("reset") else clamp(room.turn + clamp(to_int(d.get("delta")), -1, 1), 0, 999)
    elif t == "untap_all":
        for k in room.zones["battlefield"]:
            room.cards[k]["tapped"] = False
    elif t == "next_turn":
        if room.look:
            await notice(ws, "Finish the scry/surveil first.")
            return
        room.turn = clamp(room.turn + 1, 1, 999)
        for k in room.zones["battlefield"]:
            room.cards[k]["tapped"] = False
        if room.setup["phase"] == "mull":
            room.setup["phase"] = None
        do_draw(room, 1, True)
    elif t == "tax":
        slot = to_int(d.get("slot"), -1)
        if slot in (0, 1):
            room.tax[slot] = max(0, room.tax[slot] + to_int(d.get("delta")))
    elif t == "draw":
        if room.look:
            await notice(ws, "Finish the scry/surveil first.")
            return
        if room.setup["phase"] == "mull":
            room.setup["phase"] = None
        do_draw(room, clamp(to_int(d.get("n"), 1), 1, 20), True)
    elif t == "shuffle":
        if room.look:
            await notice(ws, "Finish the scry/surveil first.")
            return
        zone = d.get("zone")
        if zone in room.czones:
            random.shuffle(room.zones[zone])  # one of the table's own zones
        else:
            random.shuffle(room.zones["library"])
    elif t == "restart":
        if not room.cards:
            return
        start_game(room)
        room.hist.clear()
    elif t == "reset_all":
        reset_all(room)
        room.hist.clear()
    elif t == "undo":
        if not room.hist:
            await notice(ws, "Nothing to undo.")
            return
        room.restore(json.loads(room.hist.pop()))
    elif t == "mulligan":
        do_mulligan(room, to_int(d.get("n")))
    elif t == "keep":
        do_keep(room)
    elif t == "look":
        msg = do_look(room, d.get("mode"), to_int(d.get("n"), 1))
        if msg:
            await notice(ws, msg)
            return
    elif t == "look_cancel":
        do_look_cancel(room)
    elif t == "load":
        await do_load(room, ws, d)
        return
    elif t == "token_search":
        name = str(d.get("name", ""))
        kind = "card" if d.get("kind") == "card" else "token"
        results = []
        try:
            results = await search_cards(name, kind)
        except Exception as exc:
            log.warning("%s search failed: %s", kind, exc)
            await notice(ws, f"Could not search Scryfall: {exc or type(exc).__name__}")
        try:
            await ws.send_json({"type": "token_results", "kind": kind, "query": name, "results": results})
        except Exception:
            pass
        return
    elif t == "token_create":
        img = str(d.get("img", ""))
        if not img.startswith(IMG_PREFIXES):
            return
        thumb = str(d.get("thumb", ""))
        if not thumb.startswith(IMG_PREFIXES):
            thumb = img
        # tokens, created cards and emblems all vanish when they leave the table
        img2 = str(d.get("img2", ""))
        if not img2.startswith(IMG_PREFIXES):
            img2 = ""  # no (or a foreign) back picture: a one-faced card
        thumb2 = str(d.get("thumb2", ""))
        if not img2 or not thumb2.startswith(IMG_PREFIXES):
            thumb2 = img2
        tok = new_card({"name": str(d.get("name", "Token"))[:60], "img": img, "thumb": thumb,
                        "img2": img2, "thumb2": thumb2},
                       token=True, special=bool(d.get("special")))
        tok["zone"] = "battlefield"
        x, y = to_float(d.get("x")), to_float(d.get("y"))
        if x is None or y is None:
            tok["x"], tok["y"] = find_slot(room)
        else:
            tok["x"], tok["y"] = clamp(x, 0.0, 1.0), clamp(y, 0.0, 1.0)
        room.cards[tok["id"]] = tok
        room.zones["battlefield"].append(tok["id"])
    elif t == "tracker_add":
        if len(room.trackers) >= 8:
            await notice(ws, "That is enough trackers for one table.")
            return
        tid = uuid.uuid4().hex[:6]
        x, y = to_float(d.get("x")), to_float(d.get("y"))
        # "m" is the tracker's operation: 1 = the buttons add, -1 = they subtract
        room.trackers[tid] = {"id": tid, "p": 0, "t": 0, "m": 1,
                              "x": clamp(x if x is not None else 0.4, 0.0, 0.9),
                              "y": clamp(y if y is not None else 0.3, 0.0, 0.8)}
    elif t in ("tracker_pos", "tracker_mod", "tracker_mode", "tracker_reset", "tracker_del") and isinstance(cid, str):
        tr = room.trackers.get(cid)
        if not tr:
            return
        if t == "tracker_pos":
            x, y = to_float(d.get("x")), to_float(d.get("y"))
            if x is None or y is None:
                return
            tr["x"], tr["y"] = clamp(x, 0.0, 0.9), clamp(y, 0.0, 0.8)
        elif t == "tracker_mod":
            tr["p"] = clamp(tr["p"] + clamp(to_int(d.get("dp")), -5, 5), -99, 99)
            tr["t"] = clamp(tr["t"] + clamp(to_int(d.get("dt")), -5, 5), -99, 99)
        elif t == "tracker_mode":
            tr["m"] = -1 if to_int(d.get("m"), 1) < 0 else 1
        elif t == "tracker_reset":
            tr["p"] = tr["t"] = 0
        else:
            del room.trackers[cid]
    elif t == "ctr_add":
        if len(room.ctrs) >= 12:
            await notice(ws, "That is enough counters for one table.")
            return
        label = cap(d.get("label"))
        if not label:
            return
        mana = str(d.get("mana", "")).upper()
        x, y = to_float(d.get("x")), to_float(d.get("y"))
        kid = uuid.uuid4().hex[:6]
        room.ctrs[kid] = {"id": kid, "label": label, "mana": mana if mana in tuple("WUBRGC") else "",
                          "n": clamp(to_int(d.get("n")), 0, 999),
                          "x": clamp(x if x is not None else 0.4, 0.0, 0.9),
                          "y": clamp(y if y is not None else 0.3, 0.0, 0.8)}
    elif t in ("ctr_pos", "ctr_mod", "ctr_reset", "ctr_del") and isinstance(cid, str):
        k = room.ctrs.get(cid)
        if not k:
            return
        if t == "ctr_pos":
            x, y = to_float(d.get("x")), to_float(d.get("y"))
            if x is None or y is None:
                return
            k["x"], k["y"] = clamp(x, 0.0, 0.9), clamp(y, 0.0, 0.8)
        elif t == "ctr_mod":
            k["n"] = clamp(k["n"] + clamp(to_int(d.get("delta")), -5, 5), 0, 999)
        elif t == "ctr_reset":
            k["n"] = 0
        else:
            del room.ctrs[cid]
    else:
        return
    if before is not None and json.dumps(room.to_dict()) != before:
        room.hist.append(before)
        del room.hist[:-UNDO_STEPS]
    await broadcast(room)


# ----------------------------------------------------------------------------
# HTTP / WebSocket
# ----------------------------------------------------------------------------

async def ws_handler(request):
    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(request)
    code = re.sub(r"[^a-z0-9_-]", "", request.query.get("room", "table").lower())[:24] or "table"
    room = rooms.setdefault(code, Room(code))
    room.clients.add(ws)
    await ws.send_str(json.dumps(room.snapshot()))
    try:
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            try:
                data = json.loads(msg.data)
                if isinstance(data, dict):
                    await handle(room, ws, data)
            except Exception:
                # one bad message must never take the server (or the table) down
                log.exception("Error handling a message in room %s: %.200r", room.code, msg.data)
                await notice(ws, "Something went wrong on the server (details in data/server.log).")
    finally:
        room.clients.discard(ws)
    return ws


async def index(request):
    return web.FileResponse(STATIC / "index.html")


@web.middleware
async def nocache(request, handler):
    resp = await handler(request)
    resp.headers["Cache-Control"] = "no-store"
    return resp


def make_app():
    app = web.Application(middlewares=[nocache])
    app.router.add_get("/", index)
    app.router.add_get("/ws", ws_handler)
    app.router.add_static("/static/", STATIC)
    return app


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


if __name__ == "__main__":
    setup_logging()
    ensure_card_back()
    load_rooms()
    ip = lan_ip()
    print("")
    print(f"Tabletop {VERSION} server is running. Open these on your devices (same Wi-Fi):")
    print(f"  Tablet (Board): http://{ip}:{PORT}/?role=board&room=table")
    print(f"  Phone  (Hand) : http://{ip}:{PORT}/?role=hand&room=table")
    print(f"Tables are saved in: {DATA}")
    print("Press Ctrl+C to stop.")
    print("")
    web.run_app(make_app(), host="0.0.0.0", port=PORT, print=None)
