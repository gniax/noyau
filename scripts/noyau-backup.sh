#!/usr/bin/env bash
# Backup Noyau -> NAS (partage SMB backup): noyau/backup/{todo,data,files}; noyau/files = archives deplacees du PC.
#   noyau-backup.sh todo   snapshot horodate des todos si modifiees (timer 15 min)
#   noyau-backup.sh data   archive quotidienne de l'etat .data + miroir des fichiers
# Mot de passe lu depuis NOYAU_BACKUP_PASSWORD_FILE, jamais affiche ni passe en argument.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${NOYAU_DATA_DIR:-$ROOT/.data}"
NAS_HOST="${NOYAU_BACKUP_HOST:-nas.lan}"
NAS_SHARE="${NOYAU_BACKUP_SHARE:-backup}"
NAS_USER="${NOYAU_BACKUP_USER:-ia}"
NAS_DIR="${NOYAU_BACKUP_DIR:-noyau}"
PASSWORD_FILE="${NOYAU_BACKUP_PASSWORD_FILE:-$HOME/.config/noyau-backup/password}"
TODO_KEEP_DAYS="${NOYAU_BACKUP_TODO_DAYS:-30}"
DATA_KEEP_DAYS="${NOYAU_BACKUP_DATA_DAYS:-14}"
FILES_KEEP_DAYS="${NOYAU_BACKUP_FILES_DAYS:-30}"
MOUNT="/run/user/$(id -u)/gvfs/smb-share:server=${NAS_HOST},share=${NAS_SHARE},user=${NAS_USER}"
TARGET="$MOUNT/$NAS_DIR"

log() { echo "[$(date '+%F %T')] $*"; }

mount_nas() {
  [[ -d "$MOUNT" ]] && return 0
  [[ -r "$PASSWORD_FILE" ]] || { log "mot de passe introuvable: $PASSWORD_FILE"; exit 1; }
  # gio demande domaine puis mot de passe quand l'utilisateur est dans l'URI.
  { printf 'WORKGROUP\n'; tr -d '\r\n' < "$PASSWORD_FILE"; printf '\n'; } \
    | timeout 30 gio mount "smb://${NAS_USER}@${NAS_HOST}/${NAS_SHARE}" >/dev/null 2>&1 || true
  [[ -d "$MOUNT" ]] || { log "montage SMB refuse pour ${NAS_USER}@${NAS_HOST}/${NAS_SHARE}"; exit 1; }
}

todo_sources() {
  [[ -n "${NOYAU_TODO_FILE:-}" ]] && printf 'main\t%s\n' "$NOYAU_TODO_FILE"
  for file in "$DATA"/profiles/*/"TO DO.md"; do
    [[ -f "$file" ]] && printf '%s\t%s\n' "$(basename "$(dirname "$file")")" "$file"
  done
}

backup_todo() {
  local stamp day profile file dest last
  stamp="$(date '+%Y%m%d-%H%M')"
  day="$(date '+%Y-%m-%d')"
  while IFS=$'\t' read -r profile file; do
    # Une todo vide ou illisible ne doit jamais devenir le dernier snapshot de reference.
    [[ -s "$file" ]] || { log "$profile: todo absente ou vide, ignoree"; continue; }
    dest="$TARGET/backup/todo/$profile"
    mkdir -p "$dest/$day"
    last="$(cat "$dest/.last-sha" 2>/dev/null || true)"
    local sha
    sha="$(sha256sum "$file" | cut -d' ' -f1)"
    [[ "$sha" == "$last" ]] && continue
    cp "$file" "$dest/$day/TO DO-$stamp.md"
    printf '%s\n' "$sha" > "$dest/.last-sha"
    log "$profile: snapshot $day/TO DO-$stamp.md ($(stat -c %s "$file") octets)"
  done < <(todo_sources)
  find "$TARGET/backup/todo" -mindepth 2 -maxdepth 2 -type d -name '20*' -mtime +"$TODO_KEEP_DAYS" -exec rm -rf {} + 2>/dev/null || true
}

backup_data() {
  local stamp archive
  stamp="$(date '+%Y%m%d')"
  mkdir -p "$TARGET/backup/data" "$TARGET/backup/files"
  archive="$(mktemp --suffix=.tar.gz)"
  trap 'rm -f "$archive"' RETURN
  # Modeles et moteurs vocaux se reinstallent; uploads et fichiers projet partent dans le miroir.
  tar -C "$DATA" -czf "$archive" \
    --exclude='./llm' --exclude='./voice' --exclude='./uploads' --exclude='./project-files' \
    --exclude='./tmp*' --exclude='*/cache' --exclude='*.log' .
  cp "$archive" "$TARGET/backup/data/noyau-data-$stamp.tar.gz.part"
  mv -f "$TARGET/backup/data/noyau-data-$stamp.tar.gz.part" "$TARGET/backup/data/noyau-data-$stamp.tar.gz"
  log "data: noyau-data-$stamp.tar.gz ($(stat -c %s "$archive") octets)"
  find "$TARGET/backup/data" -maxdepth 1 -name 'noyau-data-*.tar.gz' -mtime +"$DATA_KEEP_DAYS" -delete 2>/dev/null || true

  # Miroir: une version remplacee ou supprimee part dans changed/<jour> au lieu d'etre perdue.
  for dir in uploads project-files; do
    [[ -d "$DATA/$dir" ]] || continue
    nice -n 10 ionice -c3 rsync -rt --delete --inplace --no-perms --no-owner --no-group \
      --backup --backup-dir="$TARGET/backup/files/changed/$stamp/$dir" \
      "$DATA/$dir/" "$TARGET/backup/files/current/$dir/"
    log "files: $dir synchronise"
  done
  find "$TARGET/backup/files/changed" -mindepth 1 -maxdepth 1 -type d -mtime +"$FILES_KEEP_DAYS" -exec rm -rf {} + 2>/dev/null || true
}

case "${1:-}" in
  todo) mount_nas; backup_todo ;;
  data) mount_nas; backup_todo; backup_data ;;
  *) echo "usage: $0 todo|data" >&2; exit 2 ;;
esac
