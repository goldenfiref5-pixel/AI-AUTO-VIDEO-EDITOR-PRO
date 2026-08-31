# Removing AI Auto Editor Pro and Docker

Everything the Docker setup puts on your machine, and how to get the space back.

If you later move to the Docker-free build, work through this in order —
**step 1 first**, because steps 2 onward destroy your projects.

---

## What is on your disk

| Item | Where | Rough size |
| --- | --- | --- |
| Docker Desktop program | `C:\Program Files\Docker` | 2–3 GB |
| WSL virtual disk (images, containers, volumes) | `%LOCALAPPDATA%\Docker\wsl` | 5–15 GB |
| Docker settings and cache | `%APPDATA%\Docker`, `%LOCALAPPDATA%\Docker` | 0.5–2 GB |
| This app's files | `%LOCALAPPDATA%\AIAutoEditorPro` | ~2 MB |

The WSL virtual disk is almost all of it. It holds the PostgreSQL, Redis and
Node base images plus the two images built from this project.

---

## 1. Save your work first

Skip this only if you have nothing you want to keep. Everything lives inside
Docker volumes, so removing Docker removes your projects, transcripts and
rendered videos with it.

```bat
cd /d "%LOCALAPPDATA%\AIAutoEditorPro"

REM The database: projects, transcripts, scenes, API keys
docker compose exec -T postgres pg_dump -U postgres aiedit > "%USERPROFILE%\Desktop\aiedit-backup.sql"

REM The media: uploads, generated images and clips, rendered videos
docker compose cp api:/app/storage "%USERPROFILE%\Desktop\aiedit-media"
```

Keep both. The Docker-free build can import them.

---

## 2. Remove this app's containers and data

```bat
cd /d "%LOCALAPPDATA%\AIAutoEditorPro"
docker compose down -v
```

`-v` deletes the volumes, which is the point — it is also irreversible.

Then uninstall the app itself: **Settings > Apps > AI Auto Editor Pro >
Uninstall**.

---

## 3. Reclaim everything else Docker is holding

Only if you use Docker for nothing else — this wipes every image and volume on
the machine, not just this project's.

```bat
docker system prune -a --volumes
```

Usually returns 5–15 GB on its own.

---

## 4. Uninstall Docker Desktop

**Settings > Apps > Docker Desktop > Uninstall.**

The uninstaller leaves things behind. Delete these afterwards if they exist:

```
%LOCALAPPDATA%\Docker
%APPDATA%\Docker
%APPDATA%\Docker Desktop
%PROGRAMDATA%\DockerDesktop
```

---

## 5. Remove the WSL distributions Docker created

Docker registers its own Linux distributions. They survive the uninstall and
keep their disk space.

```powershell
wsl --list --verbose
```

Anything named `docker-desktop` or `docker-desktop-data` belongs to Docker:

```powershell
wsl --unregister docker-desktop
wsl --unregister docker-desktop-data
```

**Only unregister those two.** Any other distribution in that list is yours.

---

## 6. Optional: remove WSL itself

Only if nothing else on your machine uses it — some editors, terminals and
Android tooling do.

**Control Panel > Programs > Turn Windows features on or off**, then untick:

- Windows Subsystem for Linux
- Virtual Machine Platform

Restart when asked.

---

## Keeping Docker but reducing its footprint

If you would rather keep it, these help without removing anything.

**Stop it reserving memory when idle.** Docker Desktop >
**Settings > General > untick "Start Docker Desktop when you sign in"**. Then
quit it from the tray when you are not using the app. The WSL VM shuts down
with it.

**Cap how much memory WSL may take.** Create `C:\Users\<you>\.wslconfig`:

```ini
[wsl2]
memory=4GB
processors=2
swap=0
```

Then `wsl --shutdown` and start Docker again.

**Clear build leftovers without touching your projects:**

```bat
docker builder prune -a
```

Returns a few GB and only removes build cache.
