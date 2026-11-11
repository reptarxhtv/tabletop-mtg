# Tabletop (MTG)

Tablet = board, phone = hand. Cards you play on the phone appear on the tablet.
It is a small Python server plus a web app, so it runs the same on Android and iPhone (no App Store, no Mac).

## First-time setup (Windows PC)

1. Install Python from python.org. On the first installer screen, check **Add python.exe to PATH**.
2. Unzip this folder anywhere.
3. Open the unzipped folder in File Explorer, click the address bar, type `cmd` and press Enter. A black window opens in that folder.
4. Run these two commands, one at a time:
   - `python -m pip install -r requirements.txt` (only the first time)
   - `python server.py`
   - If Windows Firewall asks, click **Allow access** and tick **Private networks**.
5. The window prints two addresses, for example:
   - `http://192.168.1.20:8080/?role=board&room=table` (open on the tablet)
   - `http://192.168.1.20:8080/?role=hand&room=table` (open on the iPhone)
6. Keep the PC, tablet and iPhone on the same Wi-Fi. Leave the black window open while you play. Next time, only step 3 and `python server.py` are needed.

**Port busy?** If the window says the address is in use, or you still see an old version, close old server
windows and run `set PORT=8090` then `python server.py` (use :8090 in the addresses).

**Old version showing?** The server tells every device its version. A device with an old cached copy reloads
itself once; if it still looks old, close the app (or clear the browser cache) and open it again.
The version is shown in the **...** menu title.

**Updating:** when you get a new zip, unzip it over the old folder (or into a new one and copy the `data` folder across to keep your table).

## Play without your PC

`ONLINE_GUIDE.md` explains how to put the app on a free online server (Render) so only the tablet and the
iPhone are needed. Every room has its own password (whoever opens a new room first sets it), the server keeps itself awake while you play, and your
devices keep a copy of the table in case the free server forgets it.

## iPhone: make it look like an app

In Safari: **Share > Add to Home Screen**. It opens full screen with its own icon.

## Start a game

On the tablet, tap **New game** (also in **Menu > New game**).
- Commander(s): one name per line (max 2).
- Decklist: paste a text export from Moxfield or Archidekt (`1 Sol Ring`, `1x Sol Ring (c21) 263`, ...).

**Set commander** (same dialog): write the commander name(s) in the Commander box and press it to change the
commander of the table you already have, without reloading or reshuffling. A name that is in the deck is pulled
out of it (even from the table); a name that is not in the deck is imported from Scryfall. The commander it
replaces goes back into the library and the tax resets to 0. Undo takes it back.

The deck is shuffled and 7 cards are dealt. On the phone, buttons float in the middle of the screen
(they never cover a card name):
- First time: **Mulligan 7** or **Keep hand**. The first mulligan always draws a fresh seven.
- After that: **Mulligan 7** again, or one fewer than your current hand (**Mulligan 6**, **Mulligan 5**, ...),
  or **Keep hand**. A counter shows how many mulligans you took. At one card the hand is kept.

Land detection comes from the card data, so reload your deck once after updating.
Card data and images come from Scryfall, so the PC needs internet when you load a deck.
The first time the server starts it also downloads the Magic card back (`static/cardback.jpg`).
If that fails (no internet) a drawn card back is shown, and the download is retried next start.

## Phone (hand)

- Swipe left / right: browse your hand. Swipe up on a card: play it face up.
- Tap (or hold) a card to open its menu:
  - **Play** > Face up, Face down, Tapped face up
  - **Move to** > Graveyard, Exile, Exile face down, Top of library, Bottom of library
  - **Zoom**
- **Draw X**: pick a number in the box next to **Draw**, then tap Draw.
- The same first row has the turn controls: **Turn** (tap +1, hold for back/reset), **Untap** and
  **Next ▸** (turn +1, untap all, draw a card).
- **Scry / Surveil**: hold the library on the tablet > Scry or Surveil > number
  (or use the **...** menu on the phone). Your hand goes dark and is replaced by the cards you are looking at.
  - Every card has its own buttons above it: **To top** / **To bottom** for Scry,
    **To top** / **To graveyard** for Surveil. Tapping a card also opens the same choices (and Zoom).
    Surveil cannot send a card to the bottom.
  - **Show hand** lets you peek at your hand; it stays locked until the scry is finished.
  - **Cancel** puts the remaining cards back on top in their original order.

## Tablet (board)

On a PC, the **right mouse button** does what holding a finger does: it opens the menu of a card, a zone,
an empty spot of the table, the Turn counter and the cards in the Search windows.

- Tap a card: tap / untap. Drag a card: move it. Magnifier button: zoom to read it.
- **Drag a card onto Graveyard, Exile or a Commander slot** to send it there (the zone lights up).
  Only a commander can go to the command zone; anything else snaps back.
- Hold a card: **Move to** (same list as above), **Flip**, **Add counter**.
- **Double-faced cards** (for example Sundering Eruption): on the table, **Flip** shows the other face
  (the land) and flips back. The magnifier shows the face that is showing. Hold the card >
  **Cover back side** and Flip turns it face down instead; **Uncover back side** undoes that.
  In the library, hand, graveyard and exile (even face down) the card always shows its front.
  Cards already in a saved table need the deck loaded again to get their other face.
- **Drag a card onto the Library** to put it on top of the library.
- Cards in the zones can be dragged out too: drag the top of the library, graveyard or exile, or a commander,
  onto the table (it is played face up), or onto another zone.
- Tap (or hold) a zone slot to open its menu:
  - Graveyard: the menu of the top card, plus **Search**.
  - Exile: two sideways cards in the same slot. The top one is the **face-up** pile and the bottom one
    the **face-down** pile, each with its own count. Tap one for the menu of its top card, plus **Search**
    (which shows both piles). Drag either one out like any other zone.
    Dropping a card on the upper half exiles it face up and on the lower half face down; each half
    lights up while you hover. Drag the top card of one half onto the other to turn the pile over.
  - Commander: the menu of that commander.
  - Library: **Search**, Scry, Surveil, **Mill** (the top 1-10 cards, or **Other...** for your own number,
    go to the graveyard), Shuffle, Draw 1.
- **Search window** (graveyard, exile or library): tap a card for its menu (Play / Move to / Zoom).
  With a finger: a vertical swipe scrolls the list, a sideways or diagonal move picks the card up right away
  (no hold needed), and holding still opens its menu. A mouse drags at once.
  While you drag, the window turns see-through so you can see where you are dropping, and it stays open.
- The row of card backs under the table shows how many cards are in your hand (`x7`).
  At its far right is the turn bar:
  - **Turn**: starts at 0 (your opening seven cards are turn 0). Tap to add 1. Hold for **Back one turn**
    or **Reset to turn 0** (in case of a mis-tap).
  - **Untap all**: untaps every card on the table.
  - **Next turn**: turn +1 (0 becomes 1), untap all and draw a card.
  - **Undo**: takes back the last 10 changes on the table (moves, taps, draws, counters...). It shows how
    many steps are left and is greyed out when there is nothing to undo. There is no Undo on the phone.
- Whenever cards are drawn or milled, a grey **DREW N CARDS** or **MILLED N CARDS** text shows on the table
  and fades out over 3 seconds. It only announces what happens while the page is open.
- Lands: when you play a land from the hand (swipe up or the menu), it goes to a row along the bottom
  of the table. Everything else goes to the top. Dragging a card puts it where you drop it.
- While you scry or surveil, a big see-through **SCRYING** or **SURVEILING** shows on the table so the
  others know what you are doing.
- Commander tax: the - / + buttons change it by 2. It also goes up by 2 by itself whenever a commander
  leaves the command zone for the table (by dragging or from the menu).
- **Copy**: hold a card on the table > **Copy** makes a copy token next to it. A copy has a floating
  **COPY** label and a slightly greyed picture (10% less colour). It works like any token and disappears when it leaves the table.
- Hold an empty spot on the table:
  - **Create token / card**: choose **Token** or **Card**, type a name, then tap a result
    (it appears where you held) or **drag it onto the table** right away, no hold needed.
    A double-faced card made here flips and covers like one from your deck.
    **Token** search also finds emblems, the Monarch, the Initiative and dungeons.
    To get one exact card (for example a Plot card), paste its Scryfall link
    (`https://scryfall.com/card/totj/20/plot`) in the box, or type its set code and number (`totj 20`,
    the two parts after `/card/` in the link). Plot and Adventure cards are not found by name:
    use a link, or put the real card in a custom zone.
    Tokens, cards made here and copies disappear when they leave the table.
  - **Add zone**: your own zone for plotted cards, adventure cards or emblems (Plotted, Adventure,
    Foretold, Emblems, or type a name; up to 6). Zones sit at the top right of the table. Drag cards onto
    them, tap one for its menu (**Search** and **Shuffle**, which reorders that zone's cards at random), and use the X to remove it (its cards go to the graveyard,
    tokens disappear). They also appear in every **Move to** menu.
    Real cards (plot cards, adventure cards) stay in a zone. Tokens and copies vanish when they enter one,
    like exile, but emblems, the Monarch, the Initiative, dungeons and Plot cards can stay there.
  - **Add P/T tracker**: a box with `[power] [/] [toughness]` on top and a **+** and **-** button under it
    (one of them is lit). Tap a number to add or subtract 1, depending on the lit button.
    The **/** button changes both at once. Drag it by its top bar; the circular arrow resets it and the X removes it.
  - **Add counter**: a table counter with a name and a number, with + and - buttons.
    Pick a mana symbol (W, U, B, R, G, C), Storm, Energy, Experience, Poison, or type your own name.
    Drag it by its top bar; the circular arrow sets it to zero and the X removes it.

Card counters (tap the badges on a card, or hold the card > Add counter). The dialog shows
a box per counter, the same as the table counters: a name, a big number and - / + buttons.
- +1/+1 and -1/-1 are one total (they cancel each other). Like the P/T tracker, it has a **/** button
  (power and toughness together), plus **power only** and **toughness only**, with **+** and **-**.
  The card badge shows the result, e.g. `+2/+1`.
  Tap a **+** or **-** once to light it; tap the lit one again (and again...) to add or subtract to power
  and toughness together. The P/T tracker on the table works the same way.
- Other counters: tap a keyword (Flying, Trample, ...) or type your own. Names start with a capital letter.
  A custom name replaces the least used keyword in the list.

## Menu (tablet)

- **New game**: load a different deck. **Restart game**: same deck, reshuffle and deal again.
- **Reset table**: clears everything, including the deck.

## Your table is saved

Everything is written to the `data` folder after each action, so a crash or restart does not lose the table:
- `table.json` is the current table (`table.json.bak` is the version before).
- `table.actions.log` lists every action, one per line.
- `server.log` has errors and warnings.

When the server starts it loads the saved tables again. To wipe a table, use **Reset table**.
Several tables can run at once: use a different room code (`room=` in the address).
