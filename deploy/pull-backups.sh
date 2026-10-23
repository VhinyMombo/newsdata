#!/bin/bash
# Le Kiosque — copy the server's nightly backups to this Mac (~/Backups/lekiosque),
# so they survive the server. Installed as ~/Backups/pull-lekiosque.sh (launchd may
# not read the Desktop) and run daily at 10:00 by
# ~/Library/LaunchAgents/fr.hodologic.lekiosque-backups.plist; a day missed while
# the Mac sleeps is caught up at the next run.
set -euo pipefail
mkdir -p "$HOME/Backups/lekiosque"
chmod 700 "$HOME/Backups/lekiosque"
rsync -a -e "ssh -i $HOME/.ssh/id_ed25519 -o ConnectTimeout=20 -o BatchMode=yes" \
  ubuntu@187.126.9.83:backups/ "$HOME/Backups/lekiosque/"
# Keep two months here, longer than the server's two weeks
find "$HOME/Backups/lekiosque" -name 'lekiosque-*.tar.gz' -mtime +60 -delete
echo "$(date '+%F %T')  $(ls "$HOME/Backups/lekiosque" | wc -l | tr -d ' ') archives"
