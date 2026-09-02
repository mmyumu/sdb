#!/bin/sh
# Expose le serveur de développement sur internet, le temps d'une session.
#
# Intérêt par rapport au réseau local : le tunnel fournit un vrai certificat, donc
# aucun avertissement de sécurité dans le casque, et il traverse le NAT de WSL sans
# redirection de port à maintenir.
#
# L'URL étant tirée au hasard à chaque lancement, la saisir au clavier virtuel
# serait pénible : le script fabrique un lien Web Launch, que Meta utilise pour
# pousser une page vers le navigateur du casque, et l'ouvre sur le poste.
set -eu

# Configuration locale : adresses de la machine et du reseau. Absente du depot,
# d'ou le modele `.env.example`.
#
# Lu ligne a ligne plutot que source : une variable deja presente dans
# l'environnement doit l'emporter, pour que `SDB_SSH_HOST=vps npm run pi` marche.
root="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
load_env() {
  [ -f "$1" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '' | \#*) continue ;; esac
    key="${line%%=*}"
    case "$key" in *[!A-Za-z0-9_]* | '') continue ;; esac
    eval "existing=\${$key-}"
    if [ -z "${existing:-}" ]; then
      export "$key=${line#*=}"
    fi
  done < "$1"
}
load_env "$root/.env"

port="${PORT:-${SDB_PORT:-5173}}"
max=5

is_wsl() {
  grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null
}

if ! command -v cloudflared >/dev/null 2>&1; then
  cat >&2 <<'MSG'
cloudflared est absent. Installation, sans droits administrateur :

  mkdir -p ~/.local/bin
  curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
    -o ~/.local/bin/cloudflared && chmod +x ~/.local/bin/cloudflared
MSG
  exit 1
fi

# Le serveur tourne en HTTPS dès que certs/ existe : le tunnel doit s'y adapter,
# et ne pas vérifier un certificat auto-signé qu'il sait déjà être le nôtre.
if curl -sk --max-time 3 "https://127.0.0.1:$port/" -o /dev/null 2>/dev/null; then
  origin="https://127.0.0.1:$port"
  set -- --no-tls-verify
elif curl -s --max-time 3 "http://127.0.0.1:$port/" -o /dev/null 2>/dev/null; then
  origin="http://127.0.0.1:$port"
  set --
else
  echo "Rien n'écoute sur le port $port — lance 'npm run dev' dans un autre terminal." >&2
  exit 1
fi

# Node est forcément là (c'est un projet npm) et encode correctement, contrairement
# à un bricolage sed.
urlencode() {
  node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"
}

announce() {
  target="$1"
  launch="https://www.oculus.com/open_url/?url=$(urlencode "$target")"
  cat <<MSG

  ╭─ Ouvrir dans le casque, sans rien taper ────────────────────────────
  │  $launch
  ╰─────────────────────────────────────────────────────────────────────

  Ce lien pousse la page vers le navigateur du Quest (même compte Meta sur
  le poste et sur le casque). Mets le casque, la page y est déjà ouverte.

  À taper à la main, si besoin : $target

MSG
  if [ -z "${SDB_NO_OPEN:-}" ] && is_wsl && command -v explorer.exe >/dev/null 2>&1; then
    echo "  Ouverture du lien sur Windows…"
    echo
    # explorer.exe rend un statut non nul même quand il a réussi.
    explorer.exe "$launch" >/dev/null 2>&1 || true
  fi
}

echo "Tunnel vers $origin"
echo "L'URL est publique le temps de la session, et disparaît à l'arrêt (Ctrl+C)."

# L'API des tunnels sans compte renvoie par intermittence une reponse vide, et
# cloudflared s'arrete alors sur « invalid UUID length: 0 ». L'echec est immediat
# et sans consequence : on retente. Un tunnel qui a publie son URL puis s'arrete
# est en revanche un arret voulu, d'ou le temoin sur disque — la boucle de lecture
# tourne dans un sous-shell et ne peut rien remonter autrement.
trap 'exit 130' INT TERM

attempt=1
while :; do
  marker="$(mktemp)"
  cloudflared tunnel --url "$origin" "$@" 2>&1 | while IFS= read -r line; do
    printf '%s\n' "$line"
    case "$line" in
      *.trycloudflare.com*)
        if [ ! -s "$marker" ]; then
          url="$(printf '%s' "$line" | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' || true)"
          if [ -n "$url" ]; then
            printf '%s' "$url" > "$marker"
            announce "$url"
          fi
        fi
        ;;
    esac
  done

  established=0
  [ -s "$marker" ] && established=1
  rm -f "$marker"

  [ "$established" -eq 1 ] && exit 0
  if [ "$attempt" -ge "$max" ]; then
    echo >&2
    echo "Échec après $max tentatives." >&2
    echo "Le service trycloudflare.com est parfois indisponible ; réessaie dans quelques" >&2
    echo "minutes, ou passe par le réseau local : npm run cert" >&2
    exit 1
  fi
  echo >&2
  echo "Tunnel refusé par Cloudflare (tentative $attempt/$max) — nouvelle tentative…" >&2
  attempt=$((attempt + 1))
  sleep 3
done
