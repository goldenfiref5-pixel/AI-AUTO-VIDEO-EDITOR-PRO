# Run AI Auto Editor Pro on your PC

Everything the platform needs — PostgreSQL, Redis, FFmpeg, Node — runs inside
Docker. **Docker Desktop is the only thing you install yourself.**

---

## 1. Install Docker Desktop

<https://www.docker.com/products/docker-desktop/>

Install it, launch it, and wait until the whale icon in your system tray stops
animating. On Windows it will ask to enable WSL2 — say yes, and reboot if
prompted.

## 2. Start the platform

| Your system | What to do |
| --- | --- |
| **Windows** | Double-click **`START-WINDOWS.bat`** |
| **macOS / Linux** | Open a terminal in this folder and run `chmod +x start.sh && ./start.sh` |

The first run downloads base images and compiles both apps — **expect 5 to 10
minutes**. It is not stuck. Later runs take a few seconds.

The script generates your `.env` secrets automatically, waits until the app
actually answers, then opens your browser at <http://localhost:3000>.

## 3. Create your account

The **first account you create becomes the administrator**. Any email works —
it is your own machine, and nothing is sent anywhere.

## 4. Add a Gemini API key — required

Nothing can be transcribed or generated without one.

1. Get a key at <https://aistudio.google.com/apikey> (free tier available)
2. In the app, open **API management** → **Add key**
3. Paste it and click **Add and test**

The key is tested against Google immediately. A green **Valid** badge means you
are ready. It is encrypted before it is stored and is never shown again.

> Add two or three keys if you have them. The pool fails over automatically when
> one hits its rate limit, which makes long jobs far more reliable.

---

## 5. Your first test — read this before you start

**Turn off motion clips for your first run.** In the project's
**Captions & export settings** tab, switch **Generate motion clips** off.

This matters for cost. Video generation runs about **$0.35 per second of
output**, so a 60-second video can cost **$20–40** in one click. With motion off,
each scene is a still image with a cinematic camera move — the result still looks
like a real edit, costs a few cents, and renders in a fraction of the time.
Turn it on later, on one scene, once you know you like the storyboard.

**Use a short voiceover.** 15–30 seconds is plenty to see every stage work.
Any MP3, WAV, M4A, AAC or FLAC file will do — record one on your phone.

### The flow

1. **New project** — pick vertical, horizontal or square
2. **Upload your voiceover** — transcription starts by itself
3. **Review the transcript** — edit anything wrong; timings follow your edits
4. **References** *(optional)* — add 2–20 images to define the visual style
5. **Proceed to video generation** — characters, locations and scenes are planned
6. **Storyboard** — review the scenes, then **Generate**
7. **Export** — render and download

Progress streams live at every stage.

---

## Stopping and starting

| Action | Windows | macOS / Linux |
| --- | --- | --- |
| Stop (keeps your data) | `STOP-WINDOWS.bat` | `./stop.sh` |
| Start again | `START-WINDOWS.bat` | `./start.sh` |

Your projects, media and account survive a stop. Restarting takes seconds
because the images are already built.

---

## If something goes wrong

**See what happened.** Open a terminal in this folder:

```bash
docker compose logs --tail=80          # everything
docker compose logs api --tail=80      # just the API
docker compose logs worker --tail=80   # just the pipeline
```

**"Port is already allocated"** — something else is using 3000, 4000, 5432 or
6379. Either stop it, or move this stack: see
[Running on different ports](#running-on-different-ports) below.

**"Docker Desktop is not running"** — launch it and wait for the tray icon to
settle before retrying.

**Site can't be reached / connection refused** — run the doctor. It checks every
common cause and prints the exact command to fix it:

```bash
./doctor.sh            # macOS and Linux
```

On Windows, double-click **DOCTOR-WINDOWS.bat**.

**A job failed** — open the **Job queue** page. Each failure shows its reason,
and most have a **Retry** button. The usual cause is an exhausted API key, which
**API management** will show as `quota_exceeded` or `rate_limited`.

**Start completely fresh** — this erases all projects, media and accounts:

```bash
docker compose down -v
```

---

## Prefer not to install anything?

Run it in **GitHub Codespaces** instead — it works entirely in the browser and
cannot collide with anything on your machine. See *Quick start (GitHub
Codespaces)* in `README.md`.

---

## What is running

| Service | Default port | Purpose |
| --- | --- | --- |
| Web app | 3000 | The interface you use |
| API | 4000 | REST API and live progress streams |
| PostgreSQL | 5432 | Projects, transcripts, scenes, jobs |
| Redis | 6379 | Job queues and progress fan-out |
| Worker | — | Transcription, generation and rendering |

### Running on different ports

To run this beside another tool that already owns those ports, set these in
`.env` — only the host side moves, so the containers keep talking to each other
exactly as before:

```bash
WEB_PORT=3100
API_PORT=4100
POSTGRES_PORT=5433
REDIS_PORT=6380

# These three must match, or sign-in and uploads fail on CORS.
API_PUBLIC_URL=http://localhost:4100
WEB_PUBLIC_URL=http://localhost:3100
CORS_ORIGINS=http://localhost:3100
```

Then start it as usual. The launchers read these values, so they wait on the
right ports and open the right URL.

One caveat: the browser bundle has the API URL compiled into it, so after
changing `API_PORT` rebuild rather than just restarting:

```bash
docker compose up -d --build web
```

Everything stays on your machine. The only outbound calls are to Google's Gemini
API, using the key you supply.

For architecture and configuration detail, see `README.md` and
`docs/ARCHITECTURE.md`.
