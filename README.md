# RealityChecking Games — Trivia Challenge App

A full-stack web app for hosting live, in-person trivia games. Players answer on their phones, reveal answers together, and the host controls pacing from a big screen.

---

## Quick Start (Local)

### Prerequisites
- **Node.js 18+** — download at https://nodejs.org

### 1. Install & Run

```bash
# From the rcg-app folder:
npm install
npm start
```

The app starts at **http://localhost:3000**

### 2. Open the Three Screens

| Screen | URL | Who uses it |
|--------|-----|-------------|
| **Home** | http://localhost:3000 | Navigation hub |
| **Admin** | http://localhost:3000/admin | You (game setup) |
| **Host** | http://localhost:3000/host?game=GAME_ID | The big display screen |
| **Player** | http://localhost:3000/player | Each player's phone |

---

## How to Run a Game — Step by Step

### Before the Event

**1. Create a Game**
- Go to `/admin`
- Click **+ Create** and name your game

**2. Import Questions**
- Click your game → go to **Questions** tab
- Upload your `.xlsx` or `.csv` spreadsheet
- Required columns: `Question`, `Correct Answer`
- Optional columns: `A`, `B`, `C`, `D` (for multiple choice)
- If no A/B/C/D columns, it becomes an open-answer question

**3. Import Players**
- Go to **Players** tab
- Upload a spreadsheet with a `Name` column (one player per row)
- Or add players manually, one at a time
- Support for 12–18 players (tested up to 50)

**4. Get the Join Info**
- Go to **Launch** tab
- Note the **6-character game code** (e.g. `A3F9C2`)
- Click **Open Host Screen** to open the display in a new tab

---

### During the Event

**5. Players Join**
- Each player opens `http://YOUR_IP:3000/player` on their phone
- They enter the game code + their name (must match exactly what you entered)
- Their name lights up green on the host lobby screen when connected

**6. Start the Game**
- When ready, click **▶ START GAME** on the host lobby screen

**7. Each Question Round**

  a. Host screen shows the question (and multiple choice options if applicable)
  
  b. Players see the question on their phones and tap their answer
  
  c. Host screen shows how many players have answered (no names, no leaderboard)
  
  d. When ready, host clicks **🔍 REVEAL ANSWER**
  
  e. **Players flip their phones face-down, then everyone flips at the same time** — the in-person reveal moment
  
  f. Host screen shows the correct answer + names of everyone who got it right
  
  g. Host clicks **NEXT QUESTION** to advance

**8. Winner Reveal**
- After the last question, the host screen shows a Winner screen
- Click **Auto-Calculate Winner** to find highest scorer automatically
- OR use the dropdown to **manually set any winner**
- The winner's name flashes with confetti 🎉

---

## Spreadsheet Format

### Questions Spreadsheet

| Column | Required | Notes |
|--------|----------|-------|
| `Question` | ✅ | The question text |
| `A` | Optional | Option A (multiple choice) |
| `B` | Optional | Option B |
| `C` | Optional | Option C |
| `D` | Optional | Option D |
| `Correct Answer` | ✅ | For MC: `A`, `B`, `C`, or `D`. For open: the exact answer text |

**Also accepted:** `question`, `Q`, `question_text` for the question column.  
**Also accepted:** `Answer`, `correct`, `Correct` for the answer column.

Example with multiple choice:
```
Question,A,B,C,D,Correct Answer
What is the capital of France?,Berlin,Madrid,Paris,Rome,C
```

Example without options (open answer):
```
Question,Correct Answer
What year did WWII end?,1945
Name the tallest mountain on Earth,Everest
```

### Players Spreadsheet

```
Name
Alex Johnson
Sam Rivera
Jordan Lee
```

---

## Deployment Options

### Option A: Local Network (Recommended for in-person events)

Run on a laptop connected to the same WiFi as players' phones.

```bash
# Find your local IP
# Mac/Linux:
ifconfig | grep "inet "
# Windows:
ipconfig

# Players connect to:
http://192.168.1.XXX:3000/player
```

Make sure your firewall allows port 3000.

---

### Option B: Railway (Free cloud hosting, ~2 min setup)

1. Push this folder to a GitHub repo
2. Go to https://railway.app and click **New Project → Deploy from GitHub**
3. Select your repo — Railway auto-detects Node.js
4. Set environment variable: `PORT=3000`
5. Your app gets a public URL like `https://rcg-app.up.railway.app`

Players worldwide can join from their phones.

---

### Option C: Render (Free tier)

1. Push to GitHub
2. Go to https://render.com → **New Web Service**
3. Connect your repo
4. Build command: `npm install`
5. Start command: `node backend/server.js`
6. Free tier URL: `https://rcg-app.onrender.com`

**Note:** Render free tier spins down after inactivity — use a paid tier for events.

---

### Option D: VPS / DigitalOcean / AWS

```bash
# On your server:
git clone YOUR_REPO
cd rcg-app
npm install
npm install -g pm2
pm2 start backend/server.js --name rcg
pm2 save

# Optional: Nginx reverse proxy on port 80
```

---

### Option E: ngrok (Quick public URL for local server)

```bash
# Run locally, then expose publicly:
npm start &
npx ngrok http 3000
# Players use the ngrok URL
```

---

## Data & Persistence

- All data is stored in `data/rcg.db` (SQLite, single file)
- Games persist across restarts
- Back up this file to save all game data
- To reset everything: delete `data/rcg.db`

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Port to run on |

---

## Troubleshooting

**Players can't connect on local network**
- Make sure all devices are on the same WiFi network
- Check firewall: `sudo ufw allow 3000` (Linux)
- Use your local IP address, not `localhost`

**"Player name not found" error**
- Player names must match exactly what was imported (case-insensitive)
- Add the player manually in Admin → Players tab

**Questions not importing**
- Check column names match: `Question` and `Correct Answer`
- For multiple choice, use `A`, `B`, `C`, `D` as column headers
- Save as `.xlsx` or `.csv` — `.ods` not supported

**SSE connection drops**
- The app auto-reconnects every 2 seconds
- On mobile, keep the screen on and the browser open

**Correct answer not matching**
- Matching is case-insensitive and trims whitespace
- For open answers: the player's response must match the stored correct answer exactly (after trim/lowercase)
- Multiple choice: store `A`, `B`, `C`, or `D` as the correct answer

---

## File Structure

```
rcg-app/
├── backend/
│   └── server.js          # Express API + SSE + SQLite
├── frontend/
│   ├── index.html         # Home / navigation
│   ├── admin/index.html   # Game management
│   ├── host/index.html    # Host display screen
│   └── player/index.html  # Player phone UI
├── data/
│   └── rcg.db             # SQLite database (auto-created)
├── sample-questions-template.csv
├── sample-players-template.csv
├── package.json
└── README.md
```

---

## Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Backend | Node.js + Express | Lightweight, no build step |
| Database | SQLite (better-sqlite3) | Zero-config, single file, fast |
| Real-time | Server-Sent Events (SSE) | Simple, reliable, no WebSocket library needed |
| Spreadsheet | xlsx library | Reads .xlsx and .csv natively |
| Frontend | Vanilla HTML/JS/CSS | No build tools, loads instantly on mobile |

---

*Built for RealityChecking Games — in-person trivia that feels like a show.*
