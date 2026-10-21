#!/bin/bash
# Le Kiosque — create the Oracle Cloud Always Free instance, retrying until
# Ampere capacity frees up ("Out of host capacity" is the usual answer).
#
#   caffeinate -i nohup deploy/oci-launch-retry.sh >> logs/oci-retry.log 2>&1 &
#
# Needs the OCI CLI configured (~/.oci/config, an API key from the console)
# and jq. Idempotent: the network is created once and reused by name, and the
# script stops at once if an instance called "lekiosque" already exists.
#
# Knobs (environment):
#   SHAPES         shapes to try each round, "OCPUS:GB …"  (default "4:24 2:12")
#   RETRY_SECONDS  pause between rounds                    (default 120)
#   SSH_KEY        public key for the ubuntu user          (default ~/.ssh/id_ed25519.pub)

set -euo pipefail

NAME=lekiosque
SHAPE=VM.Standard.A1.Flex
SHAPES=${SHAPES:-"4:24 2:12"}
RETRY_SECONDS=${RETRY_SECONDS:-120}
SSH_KEY=${SSH_KEY:-$HOME/.ssh/id_ed25519.pub}
BOOT_GB=100

log() { echo "$(date '+%Y-%m-%d %H:%M:%S')  $*"; }
notify() { osascript -e "display notification \"$1\" with title \"Le Kiosque — Oracle\"" 2>/dev/null || true; }

# The root compartment is the tenancy itself
TENANCY=$(awk -F= '/^tenancy/ {gsub(/ /, "", $2); print $2; exit}' "${OCI_CLI_CONFIG_FILE:-$HOME/.oci/config}")
[ -n "$TENANCY" ] || { log "Pas de tenancy dans ~/.oci/config"; exit 1; }
[ -f "$SSH_KEY" ] || { log "Clé SSH introuvable : $SSH_KEY"; exit 1; }

existing=$(oci compute instance list --compartment-id "$TENANCY" --display-name "$NAME" --all \
  | jq -r '[.data[]? | select(."lifecycle-state" != "TERMINATED" and ."lifecycle-state" != "TERMINATING")][0].id // empty')
if [ -n "$existing" ]; then
  log "Une instance « $NAME » existe déjà : $existing"
  exit 0
fi

AD=$(oci iam availability-domain list --compartment-id "$TENANCY" | jq -r '.data[0].name')
log "Domaine de disponibilité : $AD"

# ---------------------------------------------------------------- network ---
VCN=$(oci network vcn list --compartment-id "$TENANCY" --display-name "$NAME-vcn" --lifecycle-state AVAILABLE --all \
  | jq -r '.data[0].id // empty')
if [ -z "$VCN" ]; then
  log "Création du réseau $NAME-vcn"
  vcn_json=$(oci network vcn create --compartment-id "$TENANCY" --display-name "$NAME-vcn" \
    --cidr-blocks '["10.0.0.0/16"]' --dns-label "$NAME" --wait-for-state AVAILABLE)
  VCN=$(jq -r '.data.id' <<<"$vcn_json")
  RT=$(jq -r '.data."default-route-table-id"' <<<"$vcn_json")
  SL=$(jq -r '.data."default-security-list-id"' <<<"$vcn_json")

  IGW=$(oci network internet-gateway create --compartment-id "$TENANCY" --vcn-id "$VCN" \
    --display-name "$NAME-igw" --is-enabled true --wait-for-state AVAILABLE | jq -r '.data.id')
  oci network route-table update --rt-id "$RT" --force --route-rules \
    "[{\"destination\":\"0.0.0.0/0\",\"destinationType\":\"CIDR_BLOCK\",\"networkEntityId\":\"$IGW\"}]" >/dev/null

  # SSH, HTTP, HTTPS (and HTTP/3 over UDP), plus the ICMP rules OCI ships by default
  oci network security-list update --security-list-id "$SL" --force --ingress-security-rules '[
    {"source":"0.0.0.0/0","protocol":"6","tcpOptions":{"destinationPortRange":{"min":22,"max":22}}},
    {"source":"0.0.0.0/0","protocol":"6","tcpOptions":{"destinationPortRange":{"min":80,"max":80}}},
    {"source":"0.0.0.0/0","protocol":"6","tcpOptions":{"destinationPortRange":{"min":443,"max":443}}},
    {"source":"0.0.0.0/0","protocol":"17","udpOptions":{"destinationPortRange":{"min":443,"max":443}}},
    {"source":"0.0.0.0/0","protocol":"1","icmpOptions":{"type":3,"code":4}},
    {"source":"10.0.0.0/16","protocol":"1","icmpOptions":{"type":3}}
  ]' >/dev/null
fi

SUBNET=$(oci network subnet list --compartment-id "$TENANCY" --vcn-id "$VCN" --display-name "$NAME-subnet" --all \
  | jq -r '.data[0].id // empty')
if [ -z "$SUBNET" ]; then
  log "Création du sous-réseau public $NAME-subnet"
  SUBNET=$(oci network subnet create --compartment-id "$TENANCY" --vcn-id "$VCN" --display-name "$NAME-subnet" \
    --cidr-block 10.0.0.0/24 --dns-label web --wait-for-state AVAILABLE | jq -r '.data.id')
fi

# ------------------------------------------------------------------ image ---
IMAGE=$(oci compute image list --compartment-id "$TENANCY" --operating-system "Canonical Ubuntu" \
  --operating-system-version "24.04" --shape "$SHAPE" --sort-by TIMECREATED --sort-order DESC --all \
  | jq -r '[.data[] | select(."display-name" | test("Minimal") | not)][0].id // empty')
[ -n "$IMAGE" ] || { log "Image Ubuntu 24.04 ARM introuvable"; exit 1; }
log "Image : $IMAGE"

# ------------------------------------------------------------------ retry ---
# One launch per round, cycling through the shapes: two launches back to back
# trip Oracle's rate limit (429), so the second shape would never be tried
read -ra shapes <<<"$SHAPES"
attempt=0
while true; do
  for s in "${shapes[$((attempt % ${#shapes[@]}))]}"; do
    ocpus=${s%%:*}; mem=${s##*:}
    attempt=$((attempt + 1))
    if out=$(oci compute instance launch --compartment-id "$TENANCY" --availability-domain "$AD" \
        --display-name "$NAME" --shape "$SHAPE" --shape-config "{\"ocpus\":$ocpus,\"memoryInGBs\":$mem}" \
        --image-id "$IMAGE" --subnet-id "$SUBNET" --assign-public-ip true \
        --ssh-authorized-keys-file "$SSH_KEY" --boot-volume-size-in-gbs "$BOOT_GB" 2>&1); then
      ID=$(sed -n '/^{/,$p' <<<"$out" | jq -r '.data.id')
      log "Instance créée ($ocpus OCPU, $mem Go) : $ID — attente du démarrage"
      oci compute instance get --instance-id "$ID" --wait-for-state RUNNING >/dev/null
      IP=$(oci compute instance list-vnics --instance-id "$ID" | jq -r '.data[0]."public-ip"')
      log "PRÊT — ssh ubuntu@$IP"
      notify "Machine créée : $IP"
      exit 0
    fi
    if grep -qi "capacity" <<<"$out"; then
      log "Essai $attempt ($ocpus OCPU, $mem Go) : pas de place"
    elif grep -qiE "TooManyRequests|429" <<<"$out"; then
      log "Essai $attempt : trop de requêtes, pause plus longue"
      sleep 300
    else
      log "Erreur inattendue, arrêt :"
      echo "$out"
      notify "Erreur inattendue, voir logs/oci-retry.log"
      exit 1
    fi
  done
  sleep "$RETRY_SECONDS"
done
