# Slotboard

A sign-up sheet site with no accounts or emails.

- **Create** an event with slots → you get a **master code** (and a master link containing it) plus an **invite link**.
- **Invite link**: people see the event, sign up for a slot, and can cancel only their own sign-up (from the same device). They can't edit anything else.
- **Master link / code**: edit details and slots, remove anyone, close sign-ups, hide names, download a CSV, replace the invite link, change the master code, or delete the event.

The website is plain HTML/JS, hosted free on **GitHub Pages**. Events and sign-ups are saved in a **Cloudflare D1** database, behind a small **Cloudflare Worker** (the `api` folder). Both are on Cloudflare's free plan.

## Files

```
index.html             page shell
app.js                 create / invite / organizer views
styles.css             styling
config.js              the address of your API (already filled in)
api/src/index.ts       the API: every action, the master-code checks, the database tables
api/cloudflare.config.ts  Worker name and its D1 database binding
```

## Where things live

- API: https://slotboard-api.johnludovilch.workers.dev
- Database: D1 database `slotboard-db` in your Cloudflare account (dashboard → Storage & databases → D1).

The tables are created automatically on the API's first request.

## Put the website on GitHub Pages

1. Create a repository on github.com (public, for free Pages).
2. Click **uploading an existing file** and drag in `index.html`, `app.js`, `styles.css`, `config.js`, `README.md`, and the `api` folder. **Don't** upload `api/node_modules` or `api/.cloudflare` (they're rebuilt automatically and are large). Commit.
3. **Settings** → **Pages** → Source **Deploy from a branch**, branch **main**, folder **/ (root)**, Save.
4. After a minute Pages shows your address, like `https://yourname.github.io/your-repo/`.

Links look like `…/your-repo/#/e/abc123` (invite) and `…/your-repo/#/manage/xyz789/CODE` (master).

## Changing the API

Needs Node 22.18+ and the `cf` CLI (`npm install -g cf`, then `cf auth login`).

```
cd api
npm install
cf dev       # local test server at http://localhost:5173 with a local database
cf deploy    # publish changes
```

To try the website against the local API, temporarily set `apiUrl` in `config.js` to `http://localhost:5173` and serve the folder with any static server (for example `npx serve .`).

To look at the data: `cf d1 query <database-id> --sql "SELECT * FROM events"` (find the id with `cf d1 list`), or open the database in the Cloudflare dashboard.

## Good to know

- Master codes are stored as salted PBKDF2 hashes; nobody, including you, can look one up. Save it when you create the event.
- 10 wrong master codes lock that event's dashboard for 15 minutes.
- Invitees only ever receive names and slot counts, never contact info or codes.
- Free plan limits are far above what a sign-up site needs (100,000 API requests a day, 5 GB of database storage), and nothing pauses when idle.
