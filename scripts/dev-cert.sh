#!/bin/sh
# Certificat auto-signé pour servir l'app en HTTPS sur le réseau local.
# Le casque exige un contexte sécurisé pour donner accès à WebXR.
#
# Sous WSL, l'adresse que verra le casque est celle de Windows, pas celle de la
# machine virtuelle : c'est elle qui doit figurer dans le certificat.
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

dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)/certs"
mkdir -p "$dir"

is_wsl() {
  grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null
}

# IP de l'interface qui porte la route par défaut, côté Windows.
windows_ip() {
  powershell.exe -NoProfile -Command \
    '(Get-NetIPConfiguration | Where-Object {$_.IPv4DefaultGateway -ne $null}).IPv4Address.IPAddress' \
    2>/dev/null | tr -d '\r\n '
}

vm_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
win_ip=""
is_wsl && win_ip="$(windows_ip || true)"

# SDB_HOST_IP accepte une liste : l'app peut être atteinte par plusieurs chemins
# (réseau local, tunnel SSH inverse vers un Pi), et un seul certificat doit tous
# les couvrir. Le premier sert d'adresse affichée.
extra="$(printf '%s' "${SDB_HOST_IP:-}" | tr ',' ' ')"
host_ip="$(printf '%s' "$extra" | awk '{print $1}')"
[ -n "$host_ip" ] || host_ip="$win_ip"
[ -n "$host_ip" ] || host_ip="$vm_ip"

san="DNS:localhost,IP:127.0.0.1"
seen=" 127.0.0.1 "
for ip in $extra $win_ip $vm_ip; do
  case "$seen" in *" $ip "*) continue ;; esac
  seen="$seen$ip "
  san="$san,IP:$ip"
done

openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout "$dir/dev-key.pem" -out "$dir/dev-cert.pem" \
  -subj "/CN=sdb-dev" -addext "subjectAltName=$san" 2>/dev/null

echo "Certificat écrit dans certs/ (valable pour $san)."
echo
echo "Depuis le casque : https://$host_ip:5173"
echo "Le navigateur affichera un avertissement : « Avancé » puis « Continuer »."

if is_wsl && [ "$vm_ip" != "$host_ip" ]; then
  cat <<MSG

WSL est derrière un NAT : sans redirection, le casque n'atteindra pas $vm_ip.
Une fois, dans un PowerShell **administrateur** sur Windows :

  netsh interface portproxy add v4tov4 listenport=5173 listenaddress=0.0.0.0 connectport=5173 connectaddress=$vm_ip
  New-NetFirewallRule -DisplayName "sdb 5173" -Direction Inbound -LocalPort 5173 -Protocol TCP -Action Allow

L'adresse $vm_ip change à chaque redémarrage de WSL : relancer alors la
première commande, précédée de
  netsh interface portproxy delete v4tov4 listenport=5173 listenaddress=0.0.0.0
MSG
fi
