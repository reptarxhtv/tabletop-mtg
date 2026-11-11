# Play without your PC: free online server (Render)

You put the app on the internet once. After that, the tablet and the iPhone only need internet,
and your PC can stay off. It is free. Setup takes about 15 minutes.

How it works: the server runs on Render (a hosting service). Every room (table) has its own password, so several groups can play at the same time.
A free Render server falls asleep after 15 minutes without anyone connected and forgets its files, so
**each of your devices keeps a copy of the table** and gives it back when the server wakes up.

## Part A: put the files on GitHub (once)

1. Go to github.com and create a free account (or sign in).
2. Click **+** (top right) > **New repository**.
   - Name: `tabletop-mtg`
   - Choose **Public** (nobody can see your table; the files contain no password).
   - Click **Create repository**.
3. On the new page click **uploading an existing file**.
4. Open the unzipped `tabletop-mtg` folder on your PC. Select **everything inside it**
   (the files and the `static` folder) and drag it into the GitHub page.
   Do not drag the `tabletop-mtg` folder itself, only what is inside it.
   If you do not see `.gitignore` and `.python-version`, turn on "Hidden items" in File Explorer > View.
5. Click **Commit changes**.
6. Check that the repository's first page shows `server.py`, `render.yaml`, `requirements.txt` and the
   `static` folder.

## Part B: start the server on Render (once)

1. Go to render.com and click **Get Started**. Sign up **with GitHub** and allow it to see your
   `tabletop-mtg` repository.
2. Click **New +** > **Blueprint**, choose the `tabletop-mtg` repository and click **Connect**.
3. Render reads `render.yaml`. It needs no password here: passwords belong to each room (Part C).
4. Click **Apply** (or **Deploy**) and wait a few minutes until the service says **Live**.
5. Copy the address at the top of the service page. It looks like `https://tabletop-mtg-abcd.onrender.com`.

If Render asks for a credit card at step 2 or 4, stop there. Use **New +** > **Web Service** instead:
the same repository, Language **Python 3**, Build Command `pip install -r requirements.txt`,
Start Command `python server.py`, Instance Type **Free** and Health Check Path `/healthz`.
If it still asks for a card, tell me what the page says.

## Part C: use it on your devices

Open your Render address (`https://tabletop-mtg-abcd.onrender.com`) on each device.

1. Type a **Room code** (any name, for example `friday`) and a **Room password**.
   The first device to open a new room sets its password. Every other device must type the same one.
2. Tap **Board** on the tablet and **Hand** on the iPhone. The device remembers the password for that room.
3. Another group can use a different room code and its own password: the tables never mix.
4. iPhone: Safari > **Share > Add to Home Screen**. Tablet: Chrome menu > **Add to Home screen** / **Install app**.
5. Load your deck on the tablet as usual (**New game**).

Tip: a free server forgets everything after it sleeps, including which room has which password. Open your room
first when you come back, so nobody else can claim the name.

## Every game night

- **Open the page 2 minutes before you start.** If the server was asleep it needs about a minute to wake up.
  While it wakes, the page may show a loading screen, then connect by itself.
- While you play, the devices keep the server awake. If nobody is connected for 15 minutes it sleeps again.
- If the server woke up empty, your table comes back on its own (a message says it was restored).
  The undo history is not kept, everything else is.
- **Do not clear the browser data** of the tablet and the iPhone: that is where the table copy lives.
- **Reset table** deletes the table and the copies on the connected devices.

## Updating the app later

On GitHub open your repository > **Add file > Upload files**, drag the new files in (same names replace the old
ones) and **Commit changes**. Render updates the server by itself in a few minutes.

## If something goes wrong

- **The page keeps asking for the room password:** it is not the one the room was created with. Ask whoever
  opened the room first, or use a new room code.
- **A message says the device shows an old copy:** close the app or clear that browser's cache and open it again.
- **The page never loads:** Render > your service > **Logs** shows what happened. Send me what it says.
- **Cards have no pictures:** the devices load pictures from Scryfall, so they need internet.
- **A free server can be slow, suspended or changed by Render.** Free plans change, so check
  render.com/docs/free if something stops working. Your PC version still works the way it did.
