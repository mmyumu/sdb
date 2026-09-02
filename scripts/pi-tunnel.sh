#!/bin/sh
# Tunnel SSH inverse : publie le serveur de développement sur une machine à
# adresse fixe (Raspberry, VPS). L'adresse ne changeant plus, un favori posé une
# fois dans le casque reste valable.
#
#   SDB_SSH_HOST=raspberry npm run pi
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

host="${SDB_SSH_HOST:-}"
port="${PORT:-${SDB_PORT:-5173}}"

if [ -z "$host" ]; then
  echo "SDB_SSH_HOST n'est pas défini. Copie .env.example en .env et renseigne" >&2
  echo "l'hôte SSH vers lequel ouvrir le tunnel." >&2
  exit 1
fi

if ! curl -sk --max-time 3 "https://127.0.0.1:$port/" -o /dev/null 2>/dev/null &&
   ! curl -s --max-time 3 "http://127.0.0.1:$port/" -o /dev/null 2>/dev/null; then
  echo "Rien n'écoute sur le port $port — lance 'npm run dev' dans un autre terminal." >&2
  exit 1
fi

# Sans GatewayPorts, -R n'écoute que sur la boucle locale de l'hôte distant : le
# tunnel a l'air de monter et le casque n'atteint rien. Autant le dire tout de suite.
gateway="$(ssh -o BatchMode=yes -o ConnectTimeout=8 "$host" \
  'sudo -n sshd -T 2>/dev/null | sed -n "s/^gatewayports //p"' 2>/dev/null || true)"

case "$gateway" in
  clientspecified | yes) ;;
  '')
    echo "Impossible de lire la configuration de $host — je tente quand même." >&2
    ;;
  *)
    cat >&2 <<MSG
$host a GatewayPorts=$gateway : le port ne serait ouvert que sur sa boucle locale,
et le casque n'atteindrait rien. À poser une fois, sur $host :

  printf 'GatewayPorts clientspecified\n' | sudo tee /etc/ssh/sshd_config.d/10-sdb-gatewayports.conf
  sudo sshd -t && sudo systemctl reload ssh

MSG
    exit 1
    ;;
esac

address="$(ssh -o BatchMode=yes -G "$host" | sed -n 's/^hostname //p' | head -1)"
scheme="http"
[ -f "$(dirname "$0")/../certs/dev-cert.pem" ] && scheme="https"

echo "Tunnel inverse : $host:$port  ->  ce poste:$port"
echo "Dans le casque : $scheme://${address:-$host}:$port"
echo "Ctrl+C pour arrêter."
echo

# autossh remonte le tunnel après une coupure ; ssh simple sinon.
if command -v autossh >/dev/null 2>&1; then
  exec autossh -M 0 -N -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    -R "0.0.0.0:$port:localhost:$port" "$host"
fi
exec ssh -N -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -R "0.0.0.0:$port:localhost:$port" "$host"
