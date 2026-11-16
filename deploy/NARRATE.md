# Voiceover in your own voice, from any Claude session

This is the routine for getting a narration out of a Swaram GPU server on AWS
that is kept stopped between uses. Tell Claude:

> Use my voice "Datta" for the voiceover. Follow `deploy/NARRATE.md`.

Claude needs the AWS connector for the account the server is in. A Claude Code
cloud session also needs its environment to allow the media bucket's host
(`<bucket>.s3.<region>.amazonaws.com`) so it can download the audio.

## The script

One sentence per line. Write Indian-language text in its own script.

```
(story) అనగనగా ఒక చిన్న పల్లెటూరు. [pause 0.7]
(fear, slow) ఇల్లంతా చీకటి. [pause 1]
(happy) నానమ్మ చిన్నగా నవ్వింది.
```

| Mark | Meaning |
|---|---|
| `(story)` `(talk)` `(happy)` `(sad)` `(fear)` `(surprise)` `(anger)` `(disgust)` | Mood of the line. No mark means `story`. |
| `(fear, slow)` `(story, fast)` `(talk, speed 0.92)` | Pace, with or without a mood. |
| `[pause 0.8]` | Silence after the line, in seconds. Without it the gap is 0.45 s. |
| blank line | A longer gap (0.9 s). |

Moods work for a voice that has mood clips (`python -m backend.tools.mood_clips
--profile NAME --list` inside the container). Other voices are read in their
normal tone. Keep lines short: one thought each.

## Steps for Claude

1. **Find the server and the bucket.** The instance is tagged `Name=swaram-gpu`;
   the private media bucket is named `swaram-media-<account id>`. Both are in
   the region the user names (ask if unknown).
2. **Start the instance** and wait until SSM reports it online. If it was
   stopped seconds ago, wait for `stopped` first.
3. **Get a presigned upload URL** for `narration/<name>.wav` in the bucket.
   Do this right before step 4: the URLs stop working after a few minutes.
4. **Run the narration** with SSM (`AWS-RunShellScript`). Send the script as
   base64 so the text survives quoting:

   ```bash
   cd /home/ubuntu/Swaram
   echo '<base64 of the script>' | base64 -d > /tmp/script.txt
   HOME=/root bash deploy/narrate.sh "Datta" /tmp/script.txt 50 '<presigned PUT URL>'
   ```

   The third argument fits the recording to a length by changing pauses only;
   leave it empty (`''`) for the natural length. The first run after a start
   takes 2-4 minutes while the voice loads, so poll the command rather than
   waiting on it in one call.
5. **Read the reply.** It gives `duration` and, for every line, `start` and
   `end` in seconds. Use these to time captions.
6. **Download the WAV** with a presigned download URL for the same key.
7. **Stop the instance, unless someone else is using it.** See the next section.
   If you started it and nobody else is on it, stop it, including when a step failed.

## Sharing the server with other sessions

More than one session may use the same server (one narrating, another rendering
a video). Stopping it under another session breaks that session's work.

- **Before starting:** note whether the instance was already `running`. If it
  was, someone else started it: you do not own the shutdown.
- **Before stopping:** check for other activity, and leave the server running if
  you find any.
  - SSM command history for the instance (`ListCommands`): any command from the
    last 15 minutes that you did not send, or any command still `InProgress`.
  - On the server: `nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader`
    above 10%, or busy jobs in `ps -eo etimes,pcpu,args --sort=-pcpu | head`.
- **If you leave it running,** tell the user plainly that the server is still on,
  who seems to be using it, and that it costs money until someone stops it.
- **If it was already running when you arrived** and nothing else is active when
  you finish, ask the user before stopping it.
- Do not restart the app (`docker compose up`, `restart`) while another session
  is active, and avoid heavy GPU work at the same time: narration slows down and
  the other job may run out of memory.

The API key stays on the server: `deploy/narrate.sh` reads it from `.env`.
Never print it or copy it into the conversation.

## If something goes wrong

| What you see | What to do |
|---|---|
| `deploy/narrate.sh: No such file` | The checkout on the server is older. Run `sudo -u ubuntu git pull --ff-only origin main` in `/home/ubuntu/Swaram`. If the reply is then `404 Not Found`, the running app is older too: rebuild with `docker compose -f docker-compose.yml -f docker-compose.cloud.yml up -d --build`. |
| `Voice not found` | Use the voice's exact name (`/profiles` lists them). |
| `Unknown mood (...)` | Use one of the moods in the table. |
| `moods_missing` in the reply | Those lines were read in the normal tone; the voice has no clip for that mood. |
| Upload returns 400 or 403 | The presigned URL expired. Get a new one and upload `output/narrations/<file>` again. |
| `VcpuLimitExceeded` on start | The instance is still stopping. Wait for `stopped`, then start. |
| A command fails with the server suddenly gone | Another session may have stopped it. Start it again and repeat the step. |
