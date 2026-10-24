# Run Swaram on a cloud GPU (for the mobile app)

The Swaram mobile app does no voice processing on the phone. It records,
uploads and plays audio; a GPU server does the cloning. That way any phone
works, with the same quality as a powerful PC. This guide sets that server up.

## 1. Rent a GPU server

Any provider that gives you an **Ubuntu 22.04 or 24.04 machine with an NVIDIA
GPU and the NVIDIA driver installed** works. Look for:

- **GPU:** 16 GB of GPU memory is comfortable (for example an NVIDIA T4, L4 or
  A10). IndicF5 itself is small; the extra room lets Whisper load alongside it.
- **Disk:** 60 GB or more (Docker image plus models).
- **Billing:** hourly, so you can stop it when nobody is using the app.

Indian providers bill in rupees and keep latency low for Indian users; global
ones (Lambda, Google Cloud, AWS, Azure) work the same way. Compare current
prices yourself, as they change often.

Pick an image described as "Ubuntu + NVIDIA driver" or "Deep Learning".

## 2. Get a Hugging Face token (free, once)

1. Make an account at https://huggingface.co.
2. Open https://huggingface.co/ai4bharat/IndicF5 and accept the terms.
3. Create a **read** token at https://huggingface.co/settings/tokens.

## 3. Run the setup script

SSH into the server and run:

```bash
curl -fsSL https://raw.githubusercontent.com/Dattaharshithreddy/Swaram/main/deploy/setup-gpu-vm.sh | bash
```

It asks for the Hugging Face token, then installs Docker, builds Swaram (10–20
minutes the first time), starts it, downloads the models, and prints:

```
Server URL : https://something-random.trycloudflare.com
API key    : <40 random characters>
```

Type both into the app under **Settings**.

## 4. Day-to-day

| Task | Command (inside `~/Swaram`) |
|---|---|
| See the URL and key again | `bash deploy/setup-gpu-vm.sh` (keeps your key) |
| Logs | `docker compose -f docker-compose.yml -f docker-compose.cloud.yml logs -f voicebox` |
| Stop | `docker compose -f docker-compose.yml -f docker-compose.cloud.yml down` |
| Update to the latest code | `git pull && bash deploy/setup-gpu-vm.sh` |

Stop or pause the server from your provider's dashboard when you're not using
it. Voices and settings live in Docker volumes and survive restarts.

## The tunnel URL

The free Cloudflare quick tunnel needs no domain and no open ports, but its URL
changes whenever the tunnel restarts. For a permanent address:

- **Your own domain:** create a named Cloudflare Tunnel
  (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
  and replace the `tunnel` service command with your tunnel token, or
- put Caddy or nginx with HTTPS in front of port 17493.

The app needs **https**; Android blocks plain http to remote servers.

## Security

- `SWARAM_API_KEY` (in `.env`) is required on every request except `/health`.
  Anyone with the URL **and** the key can use your GPU and voices, so share the
  key only with people you trust, and change it if it leaks (edit `.env`, then
  re-run the script).
- Voice samples are biometric data. Clone only voices you have written consent
  for, and delete profiles you no longer need.
